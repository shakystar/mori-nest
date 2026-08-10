/**
 * 제어 평면 엔트리 — **private key가 나타나는 유일한 설정 스키마.**
 *
 * ## 왜 이 파일이 하나뿐이어야 하는가
 *
 * *"전송 평면은 서명하지 못한다"*를 지키는 것은 코드 배치가 아니라 **키 배포**다
 * (mori-nest #68 사람 결정 ① 정정 · #71). Ed25519는 서명과 검증이 `node:crypto`라는
 * 같은 빌트인에 있으므로 디렉터리로는 능력을 뺏을 수 없고, 능력은 **키에 붙어 있다.**
 * 그래서 감사해야 하는 것은 "누가 `sign`을 import할 수 있는가"가 아니라 **"private key가
 * 어느 설정으로 들어오는가"**이고, 그 자리를 하나로 줄이는 것이 이 파일의 존재 이유다.
 * 리포 전체에서 `KeyObject.type === 'private'`를 **요구**하는 스키마는 아래
 * {@link parseControlConfig} 하나다. 전송 쪽(`src/transport/index.ts`)은 반대로 private
 * 키를 거부한다.
 *
 * ## 오늘 이 평면에 선 것은 로그 라우트 셋이다
 *
 * `0003 §8-2`(런처 자격의 형태)·`§8-3`((주체, 로그) 관계)의 스펙 미결이 mori-nest #68 사람
 * 결정으로 닫히면서, 그 위에 설 계층들이 차례로 섰다: `logId` mint와 (주체, 로그) 관계가
 * `./store.js`로(mori-nest #68 조각 3/5 · #72), `Idempotency-Key` 계층(조각 4/5, `0003 §1.4`)이
 * `./idempotency.js`로 — 두 라우트(`POST /v1/logs`·`POST /v1/workspaces`)가 공유해서 탈
 * 재사용 가능한 계층이고, 자원 스토어와 독립이라 먼저 설 수 있었다 —, 런처 자격증명의
 * 발급·조회 판정·즉시 폐기가 `./credential.js`로(조각 5/5 · #74) 섰다.
 *
 * 그 위에 요청 판정(`./request.js`, 라우트 조각 1/2 · #83)과 HTTP 서버·라우트 배선
 * (`./server.js`, 라우트 조각 2/2 · #84)이 얹히면서 **로그 라우트 셋이 실제로 응답한다** —
 * `POST /v1/logs`(`§2.1`) · `GET /v1/logs` · `GET /v1/logs/{logId}`(`§2.4`). `§0` 표의 여덟
 * 행 중 둘(로그 발급·로그 조회)이 이것이다.
 *
 * 그 위에 로그 폐기(`§2.6`·#93)와 **작업공간 개시**(`§4.2` · 조각 1/2 #102 판정 + 조각 2/2
 * #103 배선)가 얹혔다 — `§0` 표 여덟 행 중 넷이 응답했다. 그 위에 작업공간 전이 셋(하트비트·
 * 종료·폐기, `§4.3`~`§4.5`, #112·#113·#114)과 조회 라우트 둘(목록·단건, `§4.6`, #115)이 마저
 * 얹히면서 **여덟 행이 전부 응답한다.** 자격증명의 **발급 HTTP 라우트**만 여전히 없다
 * (`§1.1` — "오늘은 운영자가 손으로 발급하는 것으로 족하다").
 *
 * `§4` 라우트의 **선행 조각**으로 작업공간 토큰 발급자(`./token.js` · #94)가 먼저 섰다 —
 * `0003 §3.2`의 와이어 형식으로 토큰 문자열을 짓는 함수 하나이고, 작업공간을 모른다.
 * 그것이 `keyId`와 두 시각을 **인자로** 받는 이유는 *"쓰는 코드가 없는 필드를 스키마에
 * 미리 만들지 않는다"*였다. **그 조건이 이제 충족됐다**: `POST /v1/workspaces`(#103)가 그
 * 값들을 실제로 쓰는 첫 코드이므로, 아래 {@link parseControlConfig}가 `signingKey` 곁에
 * 발급 파라미터 넷(`keyId`·`tokenTtlSeconds`·`heartbeatIntervalSeconds`·`gracePeriodSeconds`)을
 * 함께 안다. 넷의 **관계**를 강제하는 자리도 여기다 (`§3.4` — 아래 파서 doc).
 *
 * 같은 이유로 작업공간 생애 추적의 스토어(`./workspace-store.js` · #97 조각 1/3, #98 조각
 * 2/3, #99 조각 3/3)도 라우트 없이 먼저 섰다 — 개시(`openWorkspace`)·단건 조회(`getWorkspace`)·
 * 세 전이(`heartbeat`·`closeWorkspace`·`revokeWorkspace`)·목록 조회(`listWorkspaces`)까지다.
 * `gracePeriod`·조회 시각·전이 시각은 여전히 그 스토어의 메서드 **인자**다 — 값을 정하는
 * 것은 설정이고(`gracePeriodSeconds`), 그것을 ms로 환산하는 자리는 `./server.js`의
 * {@link resolveGracePeriodMs} 하나뿐이다. 개시·전이 셋·조회 둘, 그 값을 쓰는 라우트 여섯
 * 전부가 이 헬퍼를 부른다 — 호출마다 `× 1000`을 다시 적으면 그 값이 갈릴 여지가 생긴다.
 *
 * ## 한 앱 두 포트로도, 두 앱으로도
 *
 * 전송 엔트리와 같은 이유로 이 모듈도 **프로세스를 모른다** — env를 읽지 않고,
 * `listen`하지 않는다. 설정은 호출자가 `unknown`으로 넘긴다. 두 엔트리를 한 프로세스가
 * 두 포트로 띄우든 두 프로세스로 가르든 **이 모듈의 코드는 0줄 바뀐다.** 그리고 이
 * 모듈은 `src/transport/`를 import하지 않는다 — import하면 제어를 띄우는 것만으로 전송
 * 평면의 코드가 함께 적재되어, 두 배포 단위가 코드에서 다시 하나가 된다.
 */

import { KeyObject } from 'node:crypto'

import { KEY_ID_PATTERN } from './token.js'

export {
  parseIdempotencyKey,
  openIdempotencyStore,
  IdempotencyStoreError,
  type IdempotencyKeyResult,
  type IdempotencyRecord,
  type IdempotencyReservation,
  type IdempotencyStore,
  type IdempotencyStoreFailure,
} from './idempotency.js'

export {
  mintLogId,
  openControlStore,
  ControlStoreError,
  DEFAULT_PAGE_LIMIT,
  type ControlStore,
  type ControlStoreFailure,
  type ControlStoreOptions,
  type ListLogsForSubjectOptions,
  type ListLogsForSubjectPage,
  type LogRecord,
  type RandomBytesFn,
} from './store.js'

export {
  openLauncherCredentialStore,
  LauncherCredentialError,
  type IssuedCredential,
  type LauncherCredentialFailure,
  type LauncherCredentialStore,
  type LauncherCredentialStoreOptions,
  type LauncherCredentialVerification,
} from './credential.js'

export {
  issueWorkspaceToken,
  mintTokenId,
  WorkspaceTokenIssueError,
  type WorkspaceTokenClaims,
  type WorkspaceTokenIssueFailure,
  type WorkspaceTokenIssueInput,
} from './token.js'

export {
  mintWorkspaceId,
  openWorkspaceStore,
  resolveActiveState,
  WorkspaceStoreError,
  type CloseOutcome,
  type GetWorkspaceOptions,
  type ListWorkspacesOptions,
  type ListWorkspacesPage,
  type OpenWorkspaceRequest,
  type WorkspaceRecord,
  type WorkspaceState,
  type WorkspaceStore,
  type WorkspaceStoreFailure,
  type WorkspaceStoreOptions,
  type WorkspaceTerminalResult,
  type WorkspaceTransitionOptions,
} from './workspace-store.js'

export {
  verifyControlRequest,
  type ControlErrorStatus,
  type ControlRequest,
  type ControlRequestResult,
  type ControlRoute,
  type RawRequest,
} from './request.js'

export { createControlServer, type ControlServerOptions } from './server.js'

/** 이 평면의 설정 스키마가 정의한 최상위 필드 **전부**. */
const CONTROL_CONFIG_FIELDS = [
  'signingKey',
  'keyId',
  'tokenTtlSeconds',
  'heartbeatIntervalSeconds',
  'gracePeriodSeconds',
] as const

/**
 * `0003 §3.2`가 고정한 서명 알고리즘. 와이어 버전 리터럴 `mnw1`이 이것과 클레임
 * 레이아웃을 함께 고정하므로, 다른 곡선의 키는 이 평면이 쓸 수 없는 키다.
 */
const SIGNING_KEY_TYPE = 'ed25519'

/** `§3.4` 표: *"`tokenTtl` ≤ 15분"* (MUST). 폐기 수렴 시간의 상한이 곧 이 값이다 (`§3.5`). */
const MAX_TOKEN_TTL_SECONDS = 900

/** `§3.4` 표: *"`tokenTtl` ≥ 3 × `heartbeatIntervalSeconds`"* (MUST). */
const MIN_HEARTBEATS_PER_TTL = 3

/** 파싱을 통과한 제어 평면 설정. */
export type ControlConfig = {
  /**
   * 작업공간 토큰 발급자의 Ed25519 private key (`0003 §3.2`).
   *
   * **이 필드가 리포에서 private key를 담는 유일한 설정 자리다.** 대응하는 공개키는
   * 전송 평면에 `verificationKeys`로 따로 주입된다 (`§3.3`) — 같은 값이 두 스키마를
   * 오가지 않고, 각 평면은 자기가 받은 절반만 안다.
   */
  readonly signingKey: KeyObject

  /**
   * 검증 키의 식별자 (`§3.2` 와이어 형식의 두 번째 세그먼트). `issueWorkspaceToken`이
   * 인자로 받는 값이고, 전송 평면의 `verificationKeys`에 같은 이름으로 들어 있는 공개키를
   * 가리킨다 (`§3.3`). 회전은 이 조각의 비범위다 — 여기 오는 것은 한 개다 (`§3.5`).
   */
  readonly keyId: string

  /** 발급 토큰의 수명, 초 (`§3.4`). */
  readonly tokenTtlSeconds: number

  /** `§4.2` 응답에 그대로 실린다 — 런처는 **이 이하** 주기로 하트비트를 보낸다 (`§3.4`). */
  readonly heartbeatIntervalSeconds: number

  /**
   * 유기(`abandoned`) 판정의 grace 창, 초 (`§4.1`). 스토어는 ms로 받으므로
   * (`GetWorkspaceOptions.gracePeriodMs`) 환산은 **호출 지점 한 곳**에서만 한다
   * (`./server.js`).
   */
  readonly gracePeriodSeconds: number
}

/**
 * 설정 파싱 결과. 전송 쪽과 같은 모양이다 — 두 엔트리의 부트스트랩이 갈리지 않게.
 */
export type ControlConfigResult =
  | { ok: true; config: ControlConfig }
  | { ok: false; problems: readonly string[] }

/**
 * 초 단위 필드 하나. 값을 못 읽으면 `null`을 돌려주고 이유를 `problems`에 적는다.
 *
 * **정수를 요구하지 않는다** — `§3.4`가 고정한 것은 네 관계이지 정수성이 아니고, 스펙에
 * 없는 제약을 파서가 새로 만들면 그것도 배포를 막는 규칙이 된다. 여기서 보는 것은 뒤
 * 산술(`× 1000`, `3 ×`, 비교)이 성립하는가뿐이다: 유한하고 양수인 수.
 */
function readSeconds(input: Record<string, unknown>, field: string, problems: string[]): number | null {
  const value = input[field]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    problems.push(`control config field "${field}" must be a positive finite number of seconds`)
    return null
  }
  return value
}

/**
 * `unknown`을 제어 평면 설정으로 파싱한다.
 *
 * 전송 쪽과 같은 규율이다: **정의되지 않은 최상위 필드를 조용히 무시하지 않는다**
 * (`0003 §1.3`의 MUST NOT을 설정 로드에 적용). 여기서는 그 규율이 한 방향 더 있다 —
 * public key를 넘기면 거부한다. 넘어온 것이 공개키인데 통과시키면 이 평면은 자기가
 * 서명할 수 있다고 믿은 채로 뜨고, 실패는 첫 발급 시점까지 미뤄진다.
 *
 * ## `§3.4`의 네 제약은 **여기서** 강제한다 (요청 시점이 아니다)
 *
 * | 제약 | 근거 |
 * |---|---|
 * | `keyId`가 `§3.2`의 정규식을 만족한다 | 아니면 발급이 `invalid_key_id`로 던진다 — 첫 요청이 `500`이 된다 |
 * | `tokenTtlSeconds ≤ 900` | 폐기 수렴 시간의 상한이 곧 `tokenTtl`이다 (`§3.5`) |
 * | `tokenTtlSeconds ≥ 3 × heartbeatIntervalSeconds` | 하트비트 한 번 놓쳤다고 토큰이 죽으면 안 된다 |
 * | `gracePeriodSeconds > tokenTtlSeconds` | 접근 상실이 유기 판정보다 **먼저** 와야 한다 |
 *
 * 이것을 요청 시점 판정으로 미루면 **제약을 어긴 배포가 첫 요청까지 살아 있고**, 그
 * 사이에 이미 `§3.4`를 어긴 토큰이 나간다. 파싱을 통과한 {@link ControlConfig}는 네
 * 제약을 만족한다는 것이 이 함수의 사후조건이고, 서버를 세우는 경로는 이 파서 하나다.
 *
 * **스코프 판정을 끄는 스위치는 이 스키마에 없다** (`§3.6` MUST NOT). 그런 필드를 여기에
 * 더하지 마라 — 정의되지 않은 필드는 위 규율이 이미 거부한다.
 */
export function parseControlConfig(input: unknown): ControlConfigResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, problems: ['control config must be an object'] }
  }

  const problems: string[] = []
  const fields = input as Record<string, unknown>

  const defined = new Set<string>(CONTROL_CONFIG_FIELDS)
  const unknownFields = Object.keys(input).filter((key) => !defined.has(key))
  if (unknownFields.length > 0) {
    problems.push(`control config has fields not defined by the schema: ${unknownFields.join(', ')}`)
  }

  const signingKey = fields['signingKey']
  if (!(signingKey instanceof KeyObject)) {
    problems.push('control config field "signingKey" must be a KeyObject')
  } else if (signingKey.type !== 'private') {
    problems.push(`control config field "signingKey" must be a private key, got "${signingKey.type}"`)
  } else if (signingKey.asymmetricKeyType !== SIGNING_KEY_TYPE) {
    problems.push(
      `control config field "signingKey" must be ${SIGNING_KEY_TYPE} (0003 §3.2), got "${String(signingKey.asymmetricKeyType)}"`,
    )
  }

  // `keyId` 정규식은 발급자(`./token.js`)의 것을 그대로 쓴다 — 같은 문자열이 그 세그먼트로
  // 나가므로, 여기에 정규식을 다시 적으면 두 벌이 갈릴 수 있는 자리가 생긴다.
  const keyId = fields['keyId']
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
    problems.push(`control config field "keyId" must match ${String(KEY_ID_PATTERN)} (0003 §3.2)`)
  }

  const tokenTtlSeconds = readSeconds(fields, 'tokenTtlSeconds', problems)
  const heartbeatIntervalSeconds = readSeconds(fields, 'heartbeatIntervalSeconds', problems)
  const gracePeriodSeconds = readSeconds(fields, 'gracePeriodSeconds', problems)

  // 관계 셋은 세 값을 다 읽었을 때만 본다 — 못 읽은 값으로 만든 비교는 그 자체가 거짓말이다.
  if (tokenTtlSeconds !== null && heartbeatIntervalSeconds !== null && gracePeriodSeconds !== null) {
    if (tokenTtlSeconds > MAX_TOKEN_TTL_SECONDS) {
      problems.push(`control config field "tokenTtlSeconds" must be <= ${String(MAX_TOKEN_TTL_SECONDS)} (0003 §3.4)`)
    }
    if (tokenTtlSeconds < MIN_HEARTBEATS_PER_TTL * heartbeatIntervalSeconds) {
      problems.push(
        `control config field "tokenTtlSeconds" must be >= ${String(MIN_HEARTBEATS_PER_TTL)} x "heartbeatIntervalSeconds" (0003 §3.4)`,
      )
    }
    if (gracePeriodSeconds <= tokenTtlSeconds) {
      problems.push('control config field "gracePeriodSeconds" must be > "tokenTtlSeconds" (0003 §3.4)')
    }
  }

  if (problems.length > 0) {
    return { ok: false, problems }
  }

  return {
    ok: true,
    config: {
      signingKey: signingKey as KeyObject,
      keyId: keyId as string,
      tokenTtlSeconds: tokenTtlSeconds as number,
      heartbeatIntervalSeconds: heartbeatIntervalSeconds as number,
      gracePeriodSeconds: gracePeriodSeconds as number,
    },
  }
}
