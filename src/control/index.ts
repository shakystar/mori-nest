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
 * 나머지 여섯 행은 아직 없다 — 로그 폐기(`§2.6`·`§3.5`)와 작업공간 계열 다섯(개시·하트비트·
 * 종료·폐기·조회, `§4`). 자격증명의 **발급 HTTP 라우트**도 여전히 없다(`§1.1` — "오늘은
 * 운영자가 손으로 발급하는 것으로 족하다"). 발급에 필요한 나머지 설정(서명 키의 `keyId`,
 * 토큰 수명 등)도 그것을 쓰는 라우트와 함께 온다 — 쓰는 코드가 없는 필드를 스키마에 미리
 * 만들지 않는다. 그래서 아래 {@link parseControlConfig}가 오늘 아는 필드는 여전히
 * `signingKey` 하나다: 라우트가 셋 섰어도 그 셋 중 서명하는 것은 없다.
 *
 * `§4` 라우트의 **선행 조각**으로 작업공간 토큰 발급자(`./token.js` · #94)가 먼저 섰다 —
 * `0003 §3.2`의 와이어 형식으로 토큰 문자열을 짓는 함수 하나이고, 작업공간을 모른다.
 * 그것이 `keyId`와 두 시각을 **인자로** 받는 이유가 바로 위 관례다: 그 값을 정하는
 * 라우트(`POST /v1/workspaces`)가 아직 없으므로 설정 자리도 아직 없다. 위 문장은 그대로
 * 참이다 — 서명 **능력**이 이 평면에 들어왔지만, 오늘 서 있는 라우트 중 그것을 부르는
 * 것은 없다.
 *
 * 같은 이유로 작업공간 생애 추적의 스토어(`./workspace-store.js` · #97 조각 1/3, #98 조각
 * 2/3)도 라우트 없이 먼저 섰다 — 개시(`openWorkspace`)·단건 조회(`getWorkspace`)·세
 * 전이(`heartbeat`·`closeWorkspace`·`revokeWorkspace`)까지고, 목록 조회(조각 3/3)는 아직
 * 없다. `gracePeriod`·조회 시각·전이 시각도 이 스토어의 메서드 인자이지 `parseControlConfig`의
 * 필드가 아니다 — 그 값을 정하는 라우트가 아직 없다.
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
const CONTROL_CONFIG_FIELDS = ['signingKey'] as const

/**
 * `0003 §3.2`가 고정한 서명 알고리즘. 와이어 버전 리터럴 `mnw1`이 이것과 클레임
 * 레이아웃을 함께 고정하므로, 다른 곡선의 키는 이 평면이 쓸 수 없는 키다.
 */
const SIGNING_KEY_TYPE = 'ed25519'

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
}

/**
 * 설정 파싱 결과. 전송 쪽과 같은 모양이다 — 두 엔트리의 부트스트랩이 갈리지 않게.
 */
export type ControlConfigResult =
  | { ok: true; config: ControlConfig }
  | { ok: false; problems: readonly string[] }

/**
 * `unknown`을 제어 평면 설정으로 파싱한다.
 *
 * 전송 쪽과 같은 규율이다: **정의되지 않은 최상위 필드를 조용히 무시하지 않는다**
 * (`0003 §1.3`의 MUST NOT을 설정 로드에 적용). 여기서는 그 규율이 한 방향 더 있다 —
 * public key를 넘기면 거부한다. 넘어온 것이 공개키인데 통과시키면 이 평면은 자기가
 * 서명할 수 있다고 믿은 채로 뜨고, 실패는 첫 발급 시점까지 미뤄진다.
 */
export function parseControlConfig(input: unknown): ControlConfigResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, problems: ['control config must be an object'] }
  }

  const problems: string[] = []

  const defined = new Set<string>(CONTROL_CONFIG_FIELDS)
  const unknownFields = Object.keys(input).filter((key) => !defined.has(key))
  if (unknownFields.length > 0) {
    problems.push(`control config has fields not defined by the schema: ${unknownFields.join(', ')}`)
  }

  const signingKey = (input as Record<string, unknown>)['signingKey']
  if (!(signingKey instanceof KeyObject)) {
    problems.push('control config field "signingKey" must be a KeyObject')
  } else if (signingKey.type !== 'private') {
    problems.push(`control config field "signingKey" must be a private key, got "${signingKey.type}"`)
  } else if (signingKey.asymmetricKeyType !== SIGNING_KEY_TYPE) {
    problems.push(
      `control config field "signingKey" must be ${SIGNING_KEY_TYPE} (0003 §3.2), got "${String(signingKey.asymmetricKeyType)}"`,
    )
  }

  if (problems.length > 0) {
    return { ok: false, problems }
  }

  return { ok: true, config: { signingKey: signingKey as KeyObject } }
}
