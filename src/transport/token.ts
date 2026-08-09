/**
 * 작업공간 토큰 검증기 — `0003 §3.2`의 `mnw1` 와이어 파서 + `§3.3`의 검사 1~5.
 *
 * 이 모듈은 **순수 함수 셋이다.** 라우트도 서버도 저장소도 모르고, HTTP 응답을 내보내지
 * 않는다 — 판정 결과(성공 또는 `0002 §1.5`의 에러 봉투)를 **반환**할 뿐이다. `§3.3`이
 * *"요청마다 보는 외부 상태가 없다"*로 못박은 성질이 그대로 파일의 형태가 된 것이고,
 * 그래서 세 전송 라우트가 아직 없는 지금 이 게이트만 먼저 설 수 있다.
 *
 * **이 파일에 서명 능력은 없다** (MUST). Ed25519를 고른 이유가 그것이다 — `§3.2`는
 * HMAC이 *"검증하는 쪽에 서명하는 능력을 함께 넘기므로"* 전송 평면이 자기 앞으로 토큰을
 * 위조할 수 있게 된다는 이유로 기각했다. 전송 평면으로 가는 것은 공개키뿐이고, 테스트용
 * 키쌍과 서명은 `test/` 안에만 있다.
 *
 * 검사 순서는 코드에서 읽혀야 한다 (`§3.2` MUST NOT). 아래 {@link verifyWorkspaceToken}은
 * 구조 검사 → 키 선택 → 서명 검증 → **그 뒤에야** 클레임 값의 의미 해석으로 내려간다.
 */

import { verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { Buffer } from 'node:buffer'

import { ErrorCodes, errorResponse, type ErrorResponse } from '../errors.js'

/** `0003 §3.2` 와이어 형식의 첫 세그먼트. 이 리터럴이 Ed25519와 클레임 레이아웃을 **함께** 고정한다. */
const TOKEN_VERSION = 'mnw1'

/** `0003 §3.2`: `keyId`는 `^[A-Za-z0-9_-]{1,64}$` — 구분자 `.`과 겹치지 않는다. */
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** 패딩 없는 base64url. `=`도 표준 알파벳(`+`·`/`)도 여기에 없다. 빈 세그먼트도 걸린다. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

/** Ed25519 서명은 64바이트 고정이다. */
const SIGNATURE_BYTES = 64

/** `issuedAt`·`expiresAt`은 고정 20바이트 ASCII `YYYY-MM-DDTHH:MM:SSZ` (`0003 §3.2`). */
const TIMESTAMP_BYTES = 20

/** `0003 §3.2`: 초 미만 정밀도와 `Z` 이외의 오프셋은 이 형식에 없다 (MUST NOT). */
const RFC3339_UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/** `0003 §3.3` 검사 2 — 이 버전에서 `audience`는 항상 이 리터럴이고, 바이트 그대로 비교한다. */
const TRANSPORT_AUDIENCE = 'transport'

/**
 * `0003 §3.3` 검사 3의 시계 스큐 허용치.
 *
 * 스펙은 이 값을 **상한**으로 정했다 (MUST NOT exceed). 그래서 호출자가 키울 수 있는
 * 파라미터로 열지 않는다 — 열면 60을 넘기는 값을 거부하는 검사를 다시 만들어야 하고,
 * 그 검사를 빠뜨리는 순간 상한이 상한이 아니게 된다. 짧은 수명으로 폐기를 대신하는
 * 체계에서(`§3.5`) 스큐가 커지면 폐기 수렴 시간이 그만큼 늘어난다.
 */
const MAX_CLOCK_SKEW_MS = 60_000

/**
 * `keyId → Ed25519 공개키` 집합. `0003 §3.3`이 설정으로 주입하라고 한 그 재료다.
 *
 * **항목 단위로 넣고 빼는 API가 없다** (`§3.3` MUST). 회전은 집합 전체를 새로 만들어
 * 참조를 갈아 끼우는 것이고, 그래야 *"빼려던 키가 아직 남아 있는 창"*이 생기지 않는다.
 */
export type VerificationKeySet = {
  /** 알려지지 않은 `keyId`면 `undefined`. 호출자는 다른 키로 재시도하지 않는다 (`§3.2` MUST NOT). */
  readonly get: (keyId: string) => KeyObject | undefined
  /** 주입된 키 개수. 0이면 모든 토큰이 `401`이다 (`§3.3` MUST). */
  readonly size: number
}

/**
 * 검증 키 집합을 만든다 — 만들어진 집합은 불변이다.
 *
 * 인자는 그 자리에서 스냅샷으로 복사되므로, 호출자가 나중에 원본 컬렉션을 바꿔도
 * 이미 판정에 쓰이고 있는 집합은 변하지 않는다 (`§3.3`의 원자적 교체).
 *
 * @param entries `[keyId, 공개키]` 쌍. **공개키만 받는다** — 개인키가 전송 평면의 키
 *   집합에 들어오면 이 평면이 서명할 수 있게 되고, 그건 `§3.2`가 Ed25519를 고른 이유
 *   자체를 무르는 것이다. 그래서 설정 로드 시점에 예외로 끊는다 (fail-closed).
 */
export function createVerificationKeySet(
  entries: Iterable<readonly [string, KeyObject]>,
): VerificationKeySet {
  const keys = new Map<string, KeyObject>()
  for (const [keyId, key] of entries) {
    if (key.type !== 'public') {
      throw new TypeError('verification key set accepts public keys only')
    }
    keys.set(keyId, key)
  }
  return Object.freeze({
    get: (keyId: string): KeyObject | undefined => keys.get(keyId),
    size: keys.size,
  })
}

/**
 * `0003 §3.2` 클레임 표의 6개 필드. `keyId`는 **여기에 없다** — 토큰 문자열의 두 번째
 * 세그먼트가 유일한 자리이고, 중복 적재는 없던 불일치를 만든다 (MUST NOT).
 */
export type WorkspaceTokenClaims = {
  readonly tokenId: string
  readonly workspaceId: string
  readonly audience: string
  readonly issuedAt: string
  readonly expiresAt: string
  readonly scope: readonly string[]
}

/**
 * {@link VerifiedWorkspaceToken}의 브랜드. 값이 아니라 **타입만** 있는 필드이고,
 * export되지 않으므로 이 모듈 밖에서는 이름을 부를 수도 없다.
 *
 * 이유는 하나다: `{ keyId, claims }` 모양의 객체 리터럴을 손으로 만들어
 * {@link checkLogScope}에 넘기는 것이 **구조적 타입만으로는 막히지 않는다.** 검사 5는
 * 검사 1~4를 통과한 토큰에 대해서만 의미가 있는데(서명이 덮지 않은 `scope`를 대조하는 것은
 * 대조가 아니다), 그 전제가 타입에 적혀 있지 않으면 다음 라우트가 게이트를 우회하는 코드를
 * 무심코 쓸 수 있다. 브랜드가 있으면 그 우회는 명시적인 `as` 캐스트로만 가능하고,
 * 캐스트는 리뷰에서 눈에 띈다 (mori-nest #11 리뷰가 후속으로 넘긴 자리다).
 */
declare const verifiedWorkspaceToken: unique symbol

/** 서명과 검사 2~4를 통과한 토큰. `keyId`는 서명 메시지에 덮인 세그먼트에서 온 것이다. */
export type VerifiedWorkspaceToken = {
  readonly [verifiedWorkspaceToken]: true
  readonly keyId: string
  readonly claims: WorkspaceTokenClaims
}

export type TokenVerificationResult =
  | { ok: true; token: VerifiedWorkspaceToken }
  | { ok: false; error: ErrorResponse }

export type ScopeCheckResult = { ok: true } | { ok: false; error: ErrorResponse }

/**
 * 실패한 검사의 이름. `details`에 실을 수 있는 것은 **어디서 떨어졌는지**까지이고,
 * 값은 아니다 (`0002 §1.2` · `0003 §3.8` MUST NOT).
 *
 * 알려지지 않은 `keyId`와 서명 불일치가 같은 `signature`인 것은 의도다 — 둘을 나누면
 * 응답이 "이 `keyId`는 주입돼 있다"를 알려주는 오라클이 된다.
 */
type FailedCheck = 'wire_format' | 'signature' | 'audience' | 'expired' | 'scope'

/**
 * `401` 봉투를 만든다.
 *
 * `message`는 **고정 문자열이다.** 파싱 실패는 받은 문자열을 되비추고 싶어지는 자리이고
 * (`§3.2`), `claims` 세그먼트는 토큰 재료 그 자체다. 서명이 검증되기 전의 `tokenId`도
 * 공격자가 고른 문자열이므로 진단 목적이라도 싣지 않는다 (`§3.8`).
 */
function unauthenticated(failedCheck: FailedCheck): { ok: false; error: ErrorResponse } {
  return {
    ok: false,
    error: errorResponse(ErrorCodes.unauthenticated, 'workspace token is not valid', { failedCheck }),
  }
}

/**
 * 정규 형태의 base64url만 받는다 (`§3.2` "파싱은 엄격하다").
 *
 * 알파벳 검사가 패딩(`=`)과 표준 base64(`+`·`/`)를 거르고, 재인코딩 대조가 **잉여 비트가
 * 0이 아닌** 입력을 거른다 — `Buffer`의 디코더는 잉여 비트를 조용히 버리므로 그것만으로는
 * 같은 바이트열에 대응하는 문자열이 여럿 생긴다.
 */
function decodeBase64UrlStrict(segment: string): Buffer | null {
  if (!BASE64URL_PATTERN.test(segment)) {
    return null
  }
  const decoded = Buffer.from(segment, 'base64url')
  if (decoded.toString('base64url') !== segment) {
    return null
  }
  return decoded
}

/** 클레임 블록을 훑는 커서. 모든 읽기가 경계를 확인하고, 넘으면 `null`이다. */
type Cursor = { offset: number }

function readUint8(block: Buffer, cursor: Cursor): number | null {
  if (cursor.offset + 1 > block.length) {
    return null
  }
  const value = block.readUInt8(cursor.offset)
  cursor.offset += 1
  return value
}

/** 정수는 빅엔디언이다 (`§3.2`). */
function readUint16(block: Buffer, cursor: Cursor): number | null {
  if (cursor.offset + 2 > block.length) {
    return null
  }
  const value = block.readUInt16BE(cursor.offset)
  cursor.offset += 2
  return value
}

/**
 * 고정 길이 ASCII를 읽는다.
 *
 * `§3.2`: *"문자열 필드에 실리는 것은 ASCII뿐이다"* (MUST). 0x7F를 넘는 바이트를
 * latin1으로 관대하게 받아주면 발급자와 검증자가 같은 바이트를 같게 읽는다는 전제가 깨진다.
 */
function readAscii(block: Buffer, cursor: Cursor, length: number): string | null {
  if (cursor.offset + length > block.length) {
    return null
  }
  const bytes = block.subarray(cursor.offset, cursor.offset + length)
  for (const byte of bytes) {
    if (byte > 0x7f) {
      return null
    }
  }
  cursor.offset += length
  return bytes.toString('latin1')
}

/** `u8` 길이 + 그 길이만큼의 ASCII. */
function readLengthPrefixedAscii(block: Buffer, cursor: Cursor): string | null {
  const length = readUint8(block, cursor)
  if (length === null) {
    return null
  }
  return readAscii(block, cursor, length)
}

/**
 * 클레임 블록을 `0003 §3.2` 표의 순서 그대로 읽는다 — 이름 없는 길이 접두사 바이트열이다.
 *
 * 여기는 **구조만** 본다. 값의 의미(만료·audience·scope 대조)는 서명이 검증된 뒤,
 * {@link verifyWorkspaceToken}의 아래쪽에서 해석한다.
 */
function parseClaimBlock(block: Buffer): WorkspaceTokenClaims | null {
  const cursor: Cursor = { offset: 0 }

  const tokenId = readLengthPrefixedAscii(block, cursor)
  if (tokenId === null) {
    return null
  }
  const workspaceId = readLengthPrefixedAscii(block, cursor)
  if (workspaceId === null) {
    return null
  }
  const audience = readLengthPrefixedAscii(block, cursor)
  if (audience === null) {
    return null
  }
  const issuedAt = readAscii(block, cursor, TIMESTAMP_BYTES)
  if (issuedAt === null) {
    return null
  }
  const expiresAt = readAscii(block, cursor, TIMESTAMP_BYTES)
  if (expiresAt === null) {
    return null
  }

  const scopeCount = readUint16(block, cursor)
  if (scopeCount === null) {
    return null
  }
  // `§3.2`: *"`scope`의 원소 수 `0`은 이 형식에 존재하지 않는다"* — 스코프가 빈 토큰은
  // 만들어질 수 있는 경로가 없으므로, 그런 바이트열은 형식 위반이지 빈 스코프가 아니다.
  if (scopeCount === 0) {
    return null
  }
  const scope: string[] = []
  for (let index = 0; index < scopeCount; index += 1) {
    const logId = readLengthPrefixedAscii(block, cursor)
    if (logId === null) {
      return null
    }
    scope.push(logId)
  }

  // *"클레임 블록을 해석한 뒤 남는 바이트가 있으면 `401`"* (`§3.2`).
  if (cursor.offset !== block.length) {
    return null
  }

  return { tokenId, workspaceId, audience, issuedAt, expiresAt, scope }
}

/**
 * `YYYY-MM-DDTHH:MM:SSZ`를 epoch 밀리초로. 형식이 다르거나 존재하지 않는 날짜면 `null`.
 *
 * `Date.parse`만으로는 부족하다 — 관대한 구현은 오프셋이 붙거나 초 미만 정밀도가 있는
 * 문자열도 받아준다. 왕복 대조로 정규 형태만 통과시킨다.
 */
function parseRfc3339Utc(value: string): number | null {
  if (!RFC3339_UTC_SECONDS.test(value)) {
    return null
  }
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    return null
  }
  if (`${new Date(parsed).toISOString().slice(0, 19)}Z` !== value) {
    return null
  }
  return parsed
}

/**
 * 토큰 문자열을 검증한다 — `0003 §3.3`의 검사 1~4.
 *
 * 검사 5(경로의 `logId` ∈ `scope`)는 여기 없다. 그건 자원별 판정이고 실패 코드도
 * `403`으로 갈리므로 {@link checkLogScope}가 따로 받는다.
 *
 * @param token `Authorization: Bearer <token>`의 토큰 부분 (`0002 §1.2`).
 * @param keys 주입된 검증 키 집합. **비어 있으면 모든 토큰이 `401`이다** (`§3.3` MUST) —
 *   "검증할 키가 없으니 통과"는 `§3.7`이 금지한 0건-통과다. 이 함수에서 그 성질은
 *   아래 키 조회가 `undefined`를 돌려주는 것으로 자연히 성립한다.
 * @param options.now 판정 기준 시각. 기본값은 현재 시각이고, 주입 가능한 것은 만료·스큐가
 *   벽시계에 의존하지 않게 하기 위해서다.
 */
export function verifyWorkspaceToken(
  token: string,
  keys: VerificationKeySet,
  options: { readonly now?: Date } = {},
): TokenVerificationResult {
  // ── 1단계: 구조 검사. 여기서 읽어 쓰는 것은 `keyId` 하나뿐이고, 클레임 값에 대한
  //    어떤 분기도 아직 일어나지 않는다 (`§3.2` MUST NOT).
  const segments = token.split('.')
  if (segments.length !== 4) {
    return unauthenticated('wire_format')
  }
  // 기본값은 `noUncheckedIndexedAccess` 때문이고, 위 길이 검사가 있어 실제로 쓰이지 않는다.
  const [version = '', keyId = '', claimsSegment = '', signatureSegment = ''] = segments

  if (version !== TOKEN_VERSION) {
    return unauthenticated('wire_format')
  }
  if (!KEY_ID_PATTERN.test(keyId)) {
    return unauthenticated('wire_format')
  }

  const claimBlock = decodeBase64UrlStrict(claimsSegment)
  if (claimBlock === null) {
    return unauthenticated('wire_format')
  }
  const signature = decodeBase64UrlStrict(signatureSegment)
  if (signature === null || signature.length !== SIGNATURE_BYTES) {
    return unauthenticated('wire_format')
  }

  const claims = parseClaimBlock(claimBlock)
  if (claims === null) {
    return unauthenticated('wire_format')
  }

  // ── 2단계: 키 선택. `keyId`로 하는 일은 이것 하나뿐이다 (`§3.2`). 알려지지 않은
  //    `keyId`는 그 자리에서 `401`이고, 다른 키로 차례로 시도하지 않는다 (MUST NOT).
  const key = keys.get(keyId)
  if (key === undefined) {
    return unauthenticated('signature')
  }

  // ── 3단계: 검사 1 — 서명. 서명 메시지는 *"토큰 문자열에서 마지막 `.`과 `signature`
  //    세그먼트를 뺀 나머지"* 이므로 원문에서 잘라 쓴다 (재조립하면 정규화가 끼어들 수 있다).
  //    위 검사들이 네 세그먼트를 모두 ASCII로 좁혔으므로 latin1은 바이트를 그대로 옮긴다.
  const signedMessage = Buffer.from(token.slice(0, token.lastIndexOf('.')), 'latin1')
  let signatureIsValid: boolean
  try {
    signatureIsValid = verify(null, signedMessage, key, signature)
  } catch {
    // 주입된 키가 Ed25519가 아니면 여기서 예외가 난다. 설정 오류가 통과로 떨어지지
    // 않아야 하므로 (`§3.3`) 거부로 받는다.
    signatureIsValid = false
  }
  if (!signatureIsValid) {
    return unauthenticated('signature')
  }

  // ── 4단계: 검사 2~4 — 의미 해석. 여기서부터 보는 값은 전부 서명이 덮은 것이다.
  if (claims.audience !== TRANSPORT_AUDIENCE) {
    return unauthenticated('audience')
  }

  const expiresAt = parseRfc3339Utc(claims.expiresAt)
  if (expiresAt === null) {
    return unauthenticated('expired')
  }
  const now = options.now ?? new Date()
  if (now.getTime() > expiresAt + MAX_CLOCK_SKEW_MS) {
    return unauthenticated('expired')
  }

  // 검사 4는 `0002 §1.2`의 fail-closed다. 원소 수 0은 이미 파싱에서 떨어지지만, 스코프가
  // 빈 토큰이 통과하는 경로가 나중에라도 열리지 않도록 서명 뒤에 한 번 더 못박는다 —
  // 이 검사가 통째로 꺼졌을 때의 결과가 cross-tenant 유출이다.
  if (claims.scope.length === 0) {
    return unauthenticated('scope')
  }

  // 브랜드를 붙이는 자리는 여기 한 곳뿐이다 — 이 `return`이 `VerifiedWorkspaceToken`을
  // 만드는 유일한 경로이고, 그래서 그 타입이 곧 "검사 1~4를 통과했다"는 증거가 된다.
  return { ok: true, token: { keyId, claims } as VerifiedWorkspaceToken }
}

/**
 * `0003 §3.3` 검사 5 — 요청 경로의 `logId`가 스코프 안에 있는가.
 *
 * `logId` **자체의 형식 검증**(`0002 §1.1`, `400 invalid_log_id`)은 여기가 아니다.
 * 이 함수는 스코프 대조만 하고, 비교는 바이트 그대로다.
 *
 * @param token {@link verifyWorkspaceToken}이 통과시킨 토큰.
 * @param logId 요청 경로에서 온 `logId`.
 */
export function checkLogScope(token: VerifiedWorkspaceToken, logId: string): ScopeCheckResult {
  if (token.claims.scope.includes(logId)) {
    return { ok: true }
  }
  // `0002 §1.2`: 스코프 밖 로그에 대한 응답은 **그 로그의 존재 여부와 무관하게 동일해야
  // 한다** (MUST) — 같은 `403`, 같은 본문. 그래서 `details`에 `logId`를 싣지 않는다.
  return {
    ok: false,
    error: errorResponse(ErrorCodes.out_of_scope, 'log is not in the token scope'),
  }
}
