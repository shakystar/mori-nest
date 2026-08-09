/**
 * 작업공간 토큰 발급자 — `0003 §3.2`의 `mnw1` 와이어 형식 + Ed25519 서명.
 *
 * ## 형식이 계약이다
 *
 * `§3.2`: *"발급자와 전송 평면이 **같은 바이트를 같게 읽어야 하므로** 형식이 계약이다"*
 * (MUST). 그래서 이 모듈이 지키는 것은 «내가 만든 토큰을 내가 읽을 수 있다»가 아니라
 * **«내가 만든 토큰을 이미 있는 검증자(`src/transport/token.ts`)가 읽는다»**이고,
 * `test/control-token.test.ts`의 라운드트립이 그것의 직접 증명이다. 형식은 여기서
 * 새로 정해지지 않는다 — `§3.2`의 「와이어 형식」 절이 정본이고 이 파일은 그것의
 * 쓰는 쪽 구현이다.
 *
 * 그 대칭 때문에 이 파일은 검증자를 **import하지 않는다.** 제어 평면이
 * `src/transport/`에 닿으면 두 배포 단위가 코드에서 다시 하나가 되고
 * (`src/control/index.ts` 머리말), 형식이 한 모듈에 갇히면 «양쪽이 같은 바이트를
 * 같게 읽는가»는 애초에 시험할 수 없는 명제가 된다. 두 구현이 마주 보고,
 * 라운드트립 테스트가 그 사이를 잇는다.
 *
 * ## 이 모듈이 모르는 것
 *
 * **작업공간을 모른다** (`§4` 전부가 비범위다). 여기 있는 것은 «클레임을 받아 토큰
 * 문자열을 짓는 함수 하나»이고, 그 클레임을 어디서 얻는지도 어떤 값이 정당한지도
 * 모른다. 그래서:
 *
 * - `keyId`와 시각은 **인자로** 온다. 설정 스키마(`parseControlConfig`)에 그 필드를
 *   미리 만들지 않는다 — *"쓰는 코드가 없는 필드를 스키마에 미리 만들지 않는다"*
 *   (`src/control/index.ts`). 그 필드들은 그것을 쓰는 라우트(`POST /v1/workspaces`,
 *   `§4.2`)와 함께 온다.
 * - `§3.4`의 **수명 정책**(`tokenTtl ≤ 15분`, `≥ 3 × heartbeatIntervalSeconds`)은 여기
 *   없다. 이 모듈은 주어진 두 시각을 **형식대로 싣는 데까지**이고, 두 시각의 관계와
 *   상한을 정하는 것은 발급 라우트다. 같은 이유로 `audience`도 인자다 — 이 버전에서
 *   그 값이 리터럴 `transport`라는 것(`§3.2` 클레임 표)은 발급 라우트가 정하는
 *   **값의 정책**이고, 형식 층에서 그것을 박아 넣으면 정책이 두 곳에 생긴다.
 *   값이 어긋난 토큰은 검증자의 검사 2가 그 자리에서 `401`로 끊는다 (`§3.3`).
 *
 * 반면 **인코딩이 표현할 수 없는 값**은 여기서 끊는다 (아래 {@link WorkspaceTokenIssueFailure}).
 * `§3.2` MUST NOT: *"인코딩 한계를 넘는 값을 조용히 잘라 싣지 않는다"* — 잘라 실으면
 * `§3.6`의 *"발급된 토큰의 `scope`는 요청한 `logs`와 같다"*가 인코딩 층에서 조용히
 * 깨지고, 클라이언트는 요청한 스코프를 얻었다고 믿는다.
 *
 * 런타임 의존성은 늘지 않는다 (`0002 §4.1-3`) — Ed25519는 `node:crypto`에 있고,
 * 표준 토큰 포맷을 쓰지 않으므로 파서도 들여오지 않는다.
 */

import { sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { Buffer } from 'node:buffer'

/** `0003 §3.2` 와이어 형식의 첫 세그먼트. 이 리터럴이 Ed25519와 클레임 레이아웃을 **함께** 고정한다. */
const TOKEN_VERSION = 'mnw1'

/** `0003 §3.2`: `keyId`는 `^[A-Za-z0-9_-]{1,64}$` — 구분자 `.`과 겹치지 않는다. */
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** `0003 §3.2`: 초 미만 정밀도와 `Z` 이외의 오프셋은 이 형식에 없다 (MUST NOT). */
const RFC3339_UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/** `§3.2`: *"문자열 필드에 실리는 것은 ASCII뿐이다"* (MUST). */
const MAX_ASCII_BYTE = 0x7f

/** `u8` 길이 접두사가 담을 수 있는 최대 바이트 수. */
const MAX_LENGTH_PREFIXED_BYTES = 0xff

/** `u16` 원소 수가 담을 수 있는 최대 `scope` 크기. **상한의 결정이 아니라 인코딩 한계다** (`§3.2`). */
const MAX_SCOPE_ELEMENTS = 0xffff

/**
 * `0003 §3.2` 클레임 표의 6개 필드. `keyId`는 **여기에 없다** — 토큰 문자열의 두 번째
 * 세그먼트가 유일한 자리이고, 클레임 블록에 중복해 실으면 없던 불일치가 생긴다
 * (MUST NOT). 검증자 쪽의 같은 이름 타입(`src/transport/token.ts`)과 모양이 같은 것은
 * 우연이 아니라 계약이지만, 두 평면이 서로를 import하지 않으므로 타입도 각자 선다.
 */
export type WorkspaceTokenClaims = {
  readonly tokenId: string
  readonly workspaceId: string
  readonly audience: string
  readonly issuedAt: string
  readonly expiresAt: string
  readonly scope: readonly string[]
}

/** {@link issueWorkspaceToken}의 입력. 키·`keyId`·시각이 모두 인자로 오는 것이 이 조각의 형태다. */
export type WorkspaceTokenIssueInput = {
  /** 발급자의 Ed25519 private key (`parseControlConfig`의 `signingKey`). */
  readonly signingKey: KeyObject
  /** 검증 키의 식별자. 두 번째 세그먼트로 실리고 **서명 메시지에 덮인다** (`§3.2` 성질 2). */
  readonly keyId: string
  readonly claims: WorkspaceTokenClaims
}

/**
 * 발급이 실패하는 이유. **전부 «형식이 그 값을 표현할 수 없다»이지 정책 판정이 아니다.**
 *
 * 고정 문자열이고, 클레임 값·토큰·키 재료를 담지 않는다 (`§3.8` MUST NOT — 토큰 값은
 * 응답 본문 이외 어디에도 실리지 않고, 에러 `message`도 그 "어디"에 포함된다).
 * {@link WorkspaceTokenIssueError.field}가 함께 실리지만 그것은 **클레임의 이름**이고,
 * 이름은 이 표에 이미 적혀 있는 공개 정보다.
 */
export type WorkspaceTokenIssueFailure =
  /** `keyId`가 `^[A-Za-z0-9_-]{1,64}$`가 아니다 — 구분자 `.`이 섞이면 세그먼트가 갈라진다 */
  | 'invalid_key_id'
  /** 문자열 클레임에 ASCII 아닌 바이트가 있다 */
  | 'claim_not_ascii'
  /** 문자열 클레임이 `u8` 길이 접두사에 담기지 않는다 (> 255바이트) */
  | 'claim_too_long'
  /** 시각이 고정 20바이트 `YYYY-MM-DDTHH:MM:SSZ`가 아니거나 존재하지 않는 날짜다 */
  | 'timestamp_not_canonical'
  /** `scope`가 비었다 (`§3.6` — 스코프가 빈 토큰을 만들 수 있는 경로가 없다) */
  | 'empty_scope'
  /** `scope` 원소 수가 `u16`을 넘는다 */
  | 'scope_too_many_elements'
  /** 주입된 키로 Ed25519 서명을 만들 수 없다 (공개키·다른 곡선·손상된 키) */
  | 'signing_key_not_usable'

export class WorkspaceTokenIssueError extends Error {
  readonly reason: WorkspaceTokenIssueFailure
  /** 걸린 클레임의 **이름**(`scope[3]` 형태 포함). 값은 담지 않는다 (`§3.8`). */
  readonly field: string | undefined

  constructor(reason: WorkspaceTokenIssueFailure, field?: string) {
    super(field === undefined ? reason : `${reason} (${field})`)
    this.name = 'WorkspaceTokenIssueError'
    this.reason = reason
    this.field = field
  }
}

/**
 * ASCII만 통과시킨다 (`§3.2` MUST). 통과한 문자열은 바이트 수가 곧 문자 수이므로
 * latin1이 바이트를 그대로 옮긴다 — 검증자 쪽 `readAscii`가 읽는 것과 같은 바이트다.
 */
function asciiBytes(value: string, field: string): Buffer {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > MAX_ASCII_BYTE) {
      throw new WorkspaceTokenIssueError('claim_not_ascii', field)
    }
  }
  return Buffer.from(value, 'latin1')
}

/**
 * `u8` 길이 + 그 길이만큼의 ASCII.
 *
 * 담기지 않으면 **실패한다** — 여기가 `§3.2`의 *"조용히 잘라 싣지 않는다"*가 실제로
 * 걸리는 자리다. `bytes.length & 0xff`로 접었다면 검증자는 잘린 문자열을 온전한 값으로
 * 읽었을 것이고, 그 불일치는 토큰이 검증을 **통과한 뒤에** 드러난다.
 */
function lengthPrefixedAscii(value: string, field: string): Buffer {
  const bytes = asciiBytes(value, field)
  if (bytes.length > MAX_LENGTH_PREFIXED_BYTES) {
    throw new WorkspaceTokenIssueError('claim_too_long', field)
  }
  return Buffer.concat([Buffer.from([bytes.length]), bytes])
}

/**
 * 고정 20바이트 `YYYY-MM-DDTHH:MM:SSZ` (`§3.2`).
 *
 * 초 미만 정밀도(`...:00.123Z`)나 `Z` 이외의 오프셋(`+09:00`)은 **반올림하거나 잘라
 * 싣지 않고 실패한다.** 같은 시각의 표현이 둘이면 «발급자와 검증자가 같은 바이트를
 * 읽는다»는 전제가 깨진다 (`§3.2`).
 *
 * 정규식만으로는 부족하다 — `2026-02-31T00:00:00Z`는 정규식을 통과하지만 존재하지 않는
 * 날짜이고, 검증자의 `parseRfc3339Utc`가 같은 왕복 대조로 그것을 떨어뜨린다. 발급 쪽이
 * 그대로 실으면 검증을 **통과할 수 없는 토큰**을 조용히 발급하는 것이 된다.
 */
function timestampBytes(value: string, field: string): Buffer {
  if (!RFC3339_UTC_SECONDS.test(value)) {
    throw new WorkspaceTokenIssueError('timestamp_not_canonical', field)
  }
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed) || `${new Date(parsed).toISOString().slice(0, 19)}Z` !== value) {
    throw new WorkspaceTokenIssueError('timestamp_not_canonical', field)
  }
  return Buffer.from(value, 'latin1')
}

/**
 * 클레임 블록을 `0003 §3.2` 표의 순서 그대로 쓴다 — 이름 없이, 정수는 빅엔디언.
 *
 * 검증자의 `parseClaimBlock`과 마주 보는 함수이고, 두 함수의 필드 순서가 갈리는 순간
 * 라운드트립이 깨진다. 그래서 순서를 바꿀 이유가 생기면 바꾸는 것은 스펙 표가 먼저다.
 */
function encodeClaimBlock(claims: WorkspaceTokenClaims): Buffer {
  // `§3.6`: 스코프가 빈 토큰을 만들 수 있는 경로가 없다. 검증자는 원소 수 `0`을 형식
  // 위반으로 떨어뜨리므로(`§3.2`), 여기서 막지 않으면 «검증을 통과할 수 없는 토큰»이
  // 발급되는 것이고 그 실패는 발급자에게서 멀어진다.
  if (claims.scope.length === 0) {
    throw new WorkspaceTokenIssueError('empty_scope', 'scope')
  }
  if (claims.scope.length > MAX_SCOPE_ELEMENTS) {
    throw new WorkspaceTokenIssueError('scope_too_many_elements', 'scope')
  }

  const scopeCount = Buffer.alloc(2)
  scopeCount.writeUInt16BE(claims.scope.length, 0)

  return Buffer.concat([
    lengthPrefixedAscii(claims.tokenId, 'tokenId'),
    lengthPrefixedAscii(claims.workspaceId, 'workspaceId'),
    lengthPrefixedAscii(claims.audience, 'audience'),
    timestampBytes(claims.issuedAt, 'issuedAt'),
    timestampBytes(claims.expiresAt, 'expiresAt'),
    scopeCount,
    ...claims.scope.map((logId, index) => lengthPrefixedAscii(logId, `scope[${index}]`)),
  ])
}

/**
 * 클레임을 `0003 §3.2` 와이어 형식의 토큰 문자열로 짓는다 — `mnw1.<keyId>.<claims>.<signature>`.
 *
 * 서명 메시지는 *"토큰 문자열에서 마지막 `.`과 `signature` 세그먼트를 뺀 나머지"*
 * (MUST), 즉 `mnw1.<keyId>.<claims>`다 — **`keyId` 세그먼트가 서명에 덮인다** (성질 2).
 * 그래서 서명 뒤에 문자열을 재조립하지 않고, 서명한 그 바이트열에 서명 세그먼트만
 * 이어 붙인다.
 *
 * base64url은 패딩 없는 정규 형태다 (`Buffer#toString('base64url')`) — 검증자의 엄격
 * 파싱이 패딩과 표준 알파벳을 거부한다.
 *
 * @throws {WorkspaceTokenIssueError} 인코딩이 값을 표현할 수 없을 때. **잘린 토큰은
 *   어떤 경우에도 반환되지 않는다** (`§3.2` MUST NOT).
 */
export function issueWorkspaceToken(input: WorkspaceTokenIssueInput): string {
  const { signingKey, keyId, claims } = input

  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new WorkspaceTokenIssueError('invalid_key_id', 'keyId')
  }

  const claimsSegment = encodeClaimBlock(claims).toString('base64url')
  const signedMessage = Buffer.from(`${TOKEN_VERSION}.${keyId}.${claimsSegment}`, 'latin1')

  let signature: Buffer
  try {
    signature = sign(null, signedMessage, signingKey)
  } catch {
    // 공개키·다른 곡선·손상된 키가 여기로 온다. 원래 예외를 그대로 새면 키 재료의
    // 일부(OpenSSL 진단 문자열)가 메시지에 실릴 수 있으므로 고정 이유로 다시 씌운다
    // (`§3.8`). `parseControlConfig`가 이미 private Ed25519만 통과시키지만, 이 함수는
    // 그 파서를 거치지 않은 키로도 불릴 수 있다.
    throw new WorkspaceTokenIssueError('signing_key_not_usable', 'signingKey')
  }

  return `${signedMessage.toString('latin1')}.${signature.toString('base64url')}`
}
