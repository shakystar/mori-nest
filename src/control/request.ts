/**
 * 제어 평면의 요청 판정 — 런처 자격 게이트 + 로그 라우트 4종 + 작업공간 라우트 6종 판별
 * (`0003 §1.1`·`§1.2`·`§1.3`·`§1.4`·`§2.1`·`§2.2`·`§2.4`·`§2.6`·`§4.2`~`§4.6`·`§4.9`, mori-nest
 * #68 라우트 조각 1/2 · #83 · #93 · #102 · #112 · #115).
 *
 * `src/transport/request.ts`와 같은 모양이다: **판정 함수 하나.** HTTP 응답을 쓰지 않고,
 * 판정 결과(해석된 요청, 또는 `§1.3`의 에러 봉투 + 상태코드)를 **반환**할 뿐이다. 다른 점
 * 하나: 런처 자격증명 판정은 서명을 푸는 순수 계산이 아니라 **조회**이므로(`§1.1` — "제어
 * 평면에는 [내구성 단일 장애점] 제약이 없다"), 이 함수는 async이고 {@link LauncherCredentialStore}를
 * 주입받는다.
 *
 * 이 파일이 판별하는 라우트는 `§0` 표의 여덟 경로 **전부**다 — `POST /v1/logs`(`§2.1`),
 * `GET /v1/logs`·`GET /v1/logs/{logId}`(`§2.4`), `POST /v1/logs/{logId}/revoke`(`§2.6`),
 * `POST /v1/workspaces`(`§4.2`), `POST /v1/workspaces/{workspaceId}/heartbeat`·`/close`·
 * `/revoke`(`§4.3`~`§4.5`, mori-nest #112), `GET /v1/workspaces`·
 * `GET /v1/workspaces/{workspaceId}`(`§4.6`, mori-nest #115).
 *
 * 이 파일에는 HTTP 서버도 스토어 호출(`isGranted`·`createLog`·`revoke`·`openWorkspace`·
 * `issueWorkspaceToken`·`heartbeat`·`closeWorkspace`·`revokeWorkspace`·`listWorkspaces`·
 * `getWorkspace`)도 없다 — 그것은 라우트 배선(`./server.js`, mori-nest #83 이슈 본문 "후속")의
 * 몫이다. `src/transport/`를 import하지 않는 것도 같은 경계 규율이다 (`src/control/index.ts`
 * 상단 doc) — 아래 헬퍼들이 `src/transport/request.ts`의 것과 모양이 겹치는 것은 우연이 아니라
 * 같은 문제를 각 평면이 독립적으로 풀기 때문이다.
 */

import { parseBody } from '../body.js'
import { ErrorCodes, errorResponse, type ErrorResponse } from '../errors.js'
import { checkMethod } from '../method.js'
import type { LauncherCredentialStore } from './credential.js'
import { parseIdempotencyKey } from './idempotency.js'

/** `0002 §1.1`: `logId := ^[A-Za-z0-9_-]{1,128}$`. `after` 커서 형식 검증에도 재사용한다
 * (아래 {@link parseAfter} doc). */
const LOG_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** `Authorization: Bearer <token>`. `src/transport/request.ts`의 같은 정규식과 같은 근거
 * (RFC 9110 §11.1 — 스킴 이름은 case-insensitive, 나머지는 엄격하다). */
const BEARER_CREDENTIALS = /^Bearer (\S+)$/i

/** `0003 §3.1`과 같은 형식(양의 정수만) — `limit` 쿼리의 값 형식. */
const LIMIT_PATTERN = /^[1-9][0-9]*$/

/** `0003 §2.2`: 서버가 발급할 식별자를 제안하는 것으로 읽히는 최상위 필드 이름들. 로그와
 * 작업공간 둘 다 서버 mint이므로 `workspaceId`도 이 집합에 든다(`§2.2`·`§4.2` MUST). */
const CLIENT_MINTED_ID_FIELDS = new Set(['logId', 'id', 'name', 'workspaceId'])

/** `0003 §4.9`: `replicaId := ^[A-Za-z0-9_-]{1,128}$` — `0002 §1.1`의 `logId`와 같은
 * 모양이지만 축이 다르므로(§4.9) `LOG_ID_PATTERN`과 별도로 옮겨 적는다. */
const REPLICA_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** `/v1/logs` 경로의 세그먼트. */
const PATH_PREFIX = ['', 'v1', 'logs'] as const

/** `POST /v1/logs/{logId}/revoke`(`§2.6`)의 마지막 세그먼트. */
const REVOKE_SUFFIX = 'revoke'

/** `§2.6`의 `RevokeLogRequest` 본문에서 게이트가 아는 최상위 필드. */
const REVOKE_BODY_FIELDS = ['reason']

/** `/v1/workspaces` 경로의 세그먼트(`§4.2`). 컬렉션 경로(개시·목록 조회, `§4.2`·`§4.6`)·단건
 * 경로(조회, `§4.6`)·하위 경로(하트비트·종료·폐기, `§4.3`~`§4.5`, mori-nest #112) 판별 셋 다
 * 이 접두사를 쓴다. */
const WORKSPACE_PATH_PREFIX = ['', 'v1', 'workspaces'] as const

/** `§4.2`의 `OpenWorkspaceRequest` 본문에서 게이트가 아는 최상위 필드. */
const OPEN_WORKSPACE_BODY_FIELDS = ['logs', 'supersedes', 'replicaId']

/** `POST /v1/workspaces/{workspaceId}/heartbeat`(`§4.3`)의 마지막 세그먼트. */
const HEARTBEAT_SUFFIX = 'heartbeat'

/** `POST /v1/workspaces/{workspaceId}/close`(`§4.4`)의 마지막 세그먼트. */
const CLOSE_SUFFIX = 'close'

/** `POST /v1/workspaces/{workspaceId}/revoke`(`§4.5`)의 마지막 세그먼트. `REVOKE_SUFFIX`와
 * 값은 같지만(둘 다 `'revoke'`) 축이 다른 경로(로그 대 작업공간)를 판별하므로 별도 상수로
 * 옮겨 적는다 — `REPLICA_ID_PATTERN`이 `LOG_ID_PATTERN`과 같은 이유로 분리된 것과 같다. */
const WORKSPACE_REVOKE_SUFFIX = 'revoke'

/** `§4.4`의 `CloseWorkspaceRequest` 본문에서 게이트가 아는 최상위 필드. */
const CLOSE_WORKSPACE_BODY_FIELDS = ['outcome']

/** `§4.4` MUST: 종료 선언의 `outcome`이 가질 수 있는 값 둘. */
const CLOSE_OUTCOMES = new Set(['flushed', 'discarded'])

/** `§4.5`의 `RevokeWorkspaceRequest` 본문에서 게이트가 아는 최상위 필드. */
const REVOKE_WORKSPACE_BODY_FIELDS = ['reason']

/** `GET /v1/workspaces`(`§4.6`)의 쿼리 파라미터 이름 전부. `§1.3`의 "정의되지 않은 최상위
 * 필드" 규율을 쿼리에 적용한다(이슈 mori-nest #115 본문) — 이 셋 밖의 이름이 있으면
 * `400 malformed_request`다. */
const LIST_WORKSPACES_QUERY_FIELDS = new Set(['state', 'after', 'limit'])

/** Node 표준 HTTP 서버가 넘겨주는 요청 객체와 모양만 맞는 요청 입력. `src/transport/request.ts`의
 * `RawRequest`와 같은 모양이지만 독립적으로 정의한다 — import하면 그 자체로 평면 경계가 깨진다. */
export type RawRequest = {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
}

/** 이 게이트가 판별하는 라우트 셋. `ControlStore`의 메서드 이름과 나란히 둔다
 * (`createLog`·`listLogsForSubject`). 셋 중 `heartbeatWorkspace`만 `WorkspaceStore`의 메서드
 * 이름(`heartbeat`)과 다르다 — 라우트 이름은 이슈(mori-nest #112)가 적은 그대로 옮긴다. */
export type ControlRoute =
  | 'createLog'
  | 'listLogs'
  | 'getLog'
  | 'revokeLog'
  | 'openWorkspace'
  | 'heartbeatWorkspace'
  | 'closeWorkspace'
  | 'revokeWorkspace'
  | 'listWorkspaces'
  | 'getWorkspace'

/**
 * 게이트를 통과한 요청. `subject`는 항상 런처 자격증명 조회로만 해석된다(`§1.2` MUST NOT —
 * 본문·쿼리·헤더로 주체를 지정하는 경로가 이 파일에 없다).
 *
 * 멱등이 요구되는 두 라우트(`createLog`·`openWorkspace`, `§1.4`)가 `idempotencyKey`와
 * `requestBody`(원본 본문 문자열)를 함께 싣는 것은 다음 조각이 그대로
 * `IdempotencyStore.reserve(subject, key, requestBody)`에 넘길 수 있게 하기 위해서다 —
 * 이 게이트가 다이제스트를 미리 계산하지 않는다.
 */
export type ControlRequest =
  | {
      readonly route: 'createLog'
      readonly subject: string
      readonly idempotencyKey: string
      readonly requestBody: string
    }
  | {
      readonly route: 'listLogs'
      readonly subject: string
      readonly after?: string
      readonly limit?: number
    }
  | {
      readonly route: 'getLog'
      readonly subject: string
      readonly logId: string
    }
  | {
      readonly route: 'revokeLog'
      readonly subject: string
      readonly logId: string
      readonly reason?: string
    }
  | {
      readonly route: 'openWorkspace'
      readonly subject: string
      readonly logs: readonly string[]
      readonly supersedes?: string
      readonly replicaId?: string
      readonly idempotencyKey: string
      /** `createLog`와 같은 이유로 원본 본문을 그대로 싣는다 — 다음 계층이
       *  `IdempotencyStore.reserve(subject, key, requestBody)`에 넘길 값이고, 다이제스트는
       *  **바이트**에 대한 것이라 파싱된 필드로 되짓지 못한다 (`§1.4`의 «같은 키·다른 본문»). */
      readonly requestBody: string
    }
  | {
      readonly route: 'heartbeatWorkspace'
      readonly subject: string
      readonly workspaceId: string
    }
  | {
      readonly route: 'closeWorkspace'
      readonly subject: string
      readonly workspaceId: string
      readonly outcome: 'flushed' | 'discarded'
    }
  | {
      readonly route: 'revokeWorkspace'
      readonly subject: string
      readonly workspaceId: string
    }
  | {
      readonly route: 'listWorkspaces'
      readonly subject: string
      readonly state?: string
      readonly after?: string
      readonly limit?: number
    }
  | {
      readonly route: 'getWorkspace'
      readonly subject: string
      readonly workspaceId: string
    }

/** 이 게이트가 낼 수 있는 상태코드. 전부 `0003 §1.3` 표에 있는 것뿐이다. */
export type ControlErrorStatus = 400 | 401 | 405

export type ControlRequestResult =
  | { readonly ok: true; readonly request: ControlRequest }
  | {
      readonly ok: false
      readonly status: ControlErrorStatus
      readonly error: ErrorResponse
      /** `405`의 `Allow` 말고는 비어 있다 — `src/transport/request.ts`와 같은 규율. */
      readonly headers: Readonly<Record<string, string>>
    }

const NO_HEADERS: Readonly<Record<string, string>> = Object.freeze({})

function reject(
  status: ControlErrorStatus,
  error: ErrorResponse,
  headers: Readonly<Record<string, string>> = NO_HEADERS,
): Extract<ControlRequestResult, { readonly ok: false }> {
  return { ok: false, status, error, headers }
}

/** `src/transport/request.ts`의 같은 이름 함수와 같다 — 퍼센트 디코딩을 하지 않고 원문
 * 세그먼트를 그대로 판정에 건다. */
function splitTarget(url: string): { readonly path: string; readonly query: string } {
  const queryStart = url.indexOf('?')
  return queryStart === -1
    ? { path: url, query: '' }
    : { path: url.slice(0, queryStart), query: url.slice(queryStart + 1) }
}

/** 이름이 같은 헤더의 값 전부 — 대소문자 무시, 배열 값은 펼친다. `src/transport/request.ts`의
 * 같은 이름 함수와 같다. */
function headerValues(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): readonly string[] {
  const wanted = name.toLowerCase()
  const values: string[] = []
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value === undefined) {
      continue
    }
    if (Array.isArray(value)) {
      values.push(...value)
    } else {
      values.push(value)
    }
  }
  return values
}

type OptionalValue = { readonly ok: true; readonly value: string | null } | { readonly ok: false }

/** 0개 또는 1개여야 하는 값. 2개 이상이면 `ok: false`다 — 부르는 쪽이 그 자리에 맞는 코드로
 * 옮긴다(`src/transport/request.ts`와 같은 규율). */
function atMostOne(values: readonly string[]): OptionalValue {
  if (values.length > 1) {
    return { ok: false }
  }
  return { ok: true, value: values[0] ?? null }
}

function queryValue(query: string, name: string): OptionalValue {
  return atMostOne(new URLSearchParams(query).getAll(name))
}

/**
 * `after` 커서 (`§2.4`). 값이 있는데 `0002 §1.1` 정규식(`logId`의 모양)을 만족하지 못하면
 * 해석 불가로 본다 — 이 커서가 실제로 뜻하는 값은 항상 이전 페이지 마지막 항목의 `logId`
 * (`ListLogsResponse.cursor`, `§2.4`)이므로, 그 모양을 벗어난 문자열은 이 서버가 발급한
 * 적이 없는 커서라고 판정할 수 있다. 반복 쿼리도 같은 결과로 합류한다(단일 값을 정할 수
 * 없다는 점이 같다).
 *
 * 전송 평면의 "미지 커서 → 조용히 처음부터"(`0002 §3.2`)를 여기로 옮기지 않는다 — `0003
 * §2.4` L370이 그 규칙을 명시적으로 끊었다.
 */
function parseAfter(query: string): { readonly ok: true; readonly value?: string } | { readonly ok: false } {
  const raw = queryValue(query, 'after')
  if (!raw.ok) {
    return { ok: false }
  }
  if (raw.value === null) {
    return { ok: true }
  }
  if (!LOG_ID_PATTERN.test(raw.value)) {
    return { ok: false }
  }
  return { ok: true, value: raw.value }
}

/**
 * `limit` 쿼리 (`§2.4`). **거부하지 않는다** — `0003 §1.3`의 표에 이 판정을 위한 code가
 * 없다(이슈 본문의 owner 판단). 형식이 깨졌거나(비숫자·음수·소수·`0`) 반복 쿼리면 값이
 * 없는 것으로 접는다 — 부르는 쪽(다음 조각의 `listLogsForSubject` 호출)이 `undefined`를
 * 받으면 `DEFAULT_PAGE_LIMIT`을 적용하므로(`src/control/store.ts`의 `resolveLimit`), 여기서
 * 새 에러 code를 만들어 스펙이 아직 정하지 않은 자리를 앞질러 정하지 않는다.
 */
function parseLimit(query: string): number | undefined {
  const raw = queryValue(query, 'limit')
  if (!raw.ok || raw.value === null || !LIMIT_PATTERN.test(raw.value)) {
    return undefined
  }
  return Number(raw.value)
}

/** `listLogs`의 판정 결과를 짓는다. `exactOptionalPropertyTypes`(tsconfig) 아래서는
 * `after: undefined`를 명시적으로 실어도 "필드가 있다"로 카운트되므로, 부재인 필드는
 * 아예 키 자체를 만들지 않는다. */
function listLogsRequest(subject: string, after: string | undefined, limit: number | undefined): ControlRequest {
  return {
    route: 'listLogs',
    subject,
    ...(after === undefined ? {} : { after }),
    ...(limit === undefined ? {} : { limit }),
  }
}

/**
 * `GET /v1/workspaces`의 쿼리 (`§4.6`) — `listLogs`의 `after`·`limit`과 다른 점 셋(이슈
 * mori-nest #115 본문):
 *
 * 1. **정의되지 않은 파라미터가 있으면 `400 malformed_request`다** ({@link LIST_WORKSPACES_QUERY_FIELDS}
 *    — `§1.3`의 최상위 필드 규율을 쿼리에 적용한다).
 * 2. **`limit`이 십진 정수 문자열이 아니면 거부한다** (`400 malformed_request`) — {@link parseLimit}
 *    처럼 조용히 접지 않는다. 이 조각의 판단이다.
 * 3. **`state`·`after`는 값을 판정하지 않는다** — 형식이 무엇이든 문자열로 그대로 싣는다.
 *    유효성은 스토어가 `invalid_state_filter`·`invalid_cursor`로 답한다(`./workspace-store.js`)
 *    — 판정을 두 곳에 두면 갈린다.
 *
 * 반복 쿼리(같은 이름이 둘 이상)는 값을 하나로 정할 수 없다는 점이 {@link atMostOne}의
 * 판정과 같지만, code는 파라미터별로 갈린다: `state`는 `400 invalid_state_filter`, `after`는
 * `400 invalid_cursor` — 둘 다 `§1.3` 표에 이미 있는 code라 그 표를 따른다. `limit`만
 * `400 malformed_request`다 — `§1.3`에 `limit` 전용 code가 없다.
 */
function checkListWorkspacesQuery(
  query: string,
):
  | { readonly ok: true; readonly state?: string; readonly after?: string; readonly limit?: number }
  | { readonly ok: false; readonly error: ErrorResponse } {
  const unknownFields = [...new Set(new URLSearchParams(query).keys())].filter(
    (key) => !LIST_WORKSPACES_QUERY_FIELDS.has(key),
  )
  if (unknownFields.length > 0) {
    return { ok: false, error: errorResponse(ErrorCodes.malformed_request, 'unrecognized query parameter') }
  }

  const state = queryValue(query, 'state')
  if (!state.ok) {
    return { ok: false, error: errorResponse(ErrorCodes.invalid_state_filter, 'state query parameter repeated') }
  }
  const after = queryValue(query, 'after')
  if (!after.ok) {
    return { ok: false, error: errorResponse(ErrorCodes.invalid_cursor, 'after query parameter repeated') }
  }
  const limitRaw = queryValue(query, 'limit')
  if (!limitRaw.ok) {
    return { ok: false, error: errorResponse(ErrorCodes.malformed_request, 'limit query parameter repeated') }
  }

  let limit: number | undefined
  if (limitRaw.value !== null) {
    if (!LIMIT_PATTERN.test(limitRaw.value)) {
      return {
        ok: false,
        error: errorResponse(ErrorCodes.malformed_request, 'limit must be a positive decimal integer'),
      }
    }
    limit = Number(limitRaw.value)
  }

  return {
    ok: true,
    ...(state.value === null ? {} : { state: state.value }),
    ...(after.value === null ? {} : { after: after.value }),
    ...(limit === undefined ? {} : { limit }),
  }
}

/**
 * `POST /v1/logs`의 본문 (`§2.1`) — `CreateLogRequest = Record<string, never>`.
 *
 * `client_minted_id`가 `malformed_request`보다 우선한다(`§2.2`) — `parseBody`가 최상위
 * 형태 위반을 전부 `malformed_request`로 판정하므로, 그 실패의 `unknownFields`를 다시 봐서
 * 식별자 제안으로 읽히는 이름이 섞여 있으면 코드를 바꿔 낸다. `parseBody`가 JSON 파싱
 * 자체에 실패했을 때는 `details`가 없으므로 이 재판정이 걸리지 않고 `malformed_request`
 * 그대로 나간다.
 */
function checkCreateLogBody(raw: string): { readonly ok: true } | { readonly ok: false; readonly error: ErrorResponse } {
  const parsed = parseBody(raw, [])
  if (parsed.ok) {
    return { ok: true }
  }
  const unknownFields = parsed.error.error.details?.['unknownFields']
  const proposesIdentifier =
    Array.isArray(unknownFields) &&
    unknownFields.some((field) => typeof field === 'string' && CLIENT_MINTED_ID_FIELDS.has(field))
  if (proposesIdentifier) {
    return {
      ok: false,
      error: errorResponse(ErrorCodes.client_minted_id, 'request body proposes a server-minted identifier'),
    }
  }
  return { ok: false, error: parsed.error }
}

/**
 * `POST /v1/logs/{logId}/revoke`의 본문 (`§2.6`) — `{ reason?: string }`. `reason`이 있는데
 * 문자열이 아니면 `400 malformed_request`; 없으면(필드 자체가 없어도) 통과한다 — 응답에도
 * 저장에도 싣지 않으므로 형식 검사가 이 게이트가 하는 전부다(이슈 #93 비범위).
 */
function checkRevokeLogBody(raw: string): { readonly ok: true; readonly reason?: string } | { readonly ok: false; readonly error: ErrorResponse } {
  const parsed = parseBody(raw, REVOKE_BODY_FIELDS)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error }
  }
  const reason = parsed.body['reason']
  if (reason === undefined) {
    return { ok: true }
  }
  if (typeof reason !== 'string') {
    return { ok: false, error: errorResponse(ErrorCodes.malformed_request, 'reason must be a string') }
  }
  return { ok: true, reason }
}

/**
 * `POST /v1/workspaces`의 본문 (`§4.2`) — `OpenWorkspaceRequest`.
 *
 * `client_minted_id`가 `malformed_request`보다 우선하는 것은 {@link checkCreateLogBody}와
 * 같은 이유다(`§2.2`) — `workspaceId`도 `CLIENT_MINTED_ID_FIELDS`에 들어 있으므로 이 재판정이
 * 그대로 걸린다. 그다음 `logs` 형식(`empty_scope`·`invalid_log_id`), 그다음 `replicaId` 형식
 * (`invalid_replica_id`, `§4.9`), 마지막으로 `supersedes`는 타입만 본다(문자열인가) — 가리키는
 * 것이 존재하는지·같은 주체의 것인지는 스토어가 답한다(이 조각의 비범위, 이슈 #102 본문).
 */
function checkOpenWorkspaceBody(
  raw: string,
):
  | {
      readonly ok: true
      readonly logs: readonly string[]
      readonly supersedes?: string
      readonly replicaId?: string
    }
  | { readonly ok: false; readonly error: ErrorResponse } {
  const parsed = parseBody(raw, OPEN_WORKSPACE_BODY_FIELDS)
  if (!parsed.ok) {
    const unknownFields = parsed.error.error.details?.['unknownFields']
    const proposesIdentifier =
      Array.isArray(unknownFields) &&
      unknownFields.some((field) => typeof field === 'string' && CLIENT_MINTED_ID_FIELDS.has(field))
    if (proposesIdentifier) {
      return {
        ok: false,
        error: errorResponse(ErrorCodes.client_minted_id, 'request body proposes a server-minted identifier'),
      }
    }
    return { ok: false, error: parsed.error }
  }

  const logs = parsed.body['logs']
  if (!Array.isArray(logs) || logs.length === 0) {
    return { ok: false, error: errorResponse(ErrorCodes.empty_scope, 'logs must be a non-empty array') }
  }
  const isValidLogId = (logId: unknown): logId is string => typeof logId === 'string' && LOG_ID_PATTERN.test(logId)
  if (!logs.every(isValidLogId)) {
    return { ok: false, error: errorResponse(ErrorCodes.invalid_log_id, 'logs contains an invalid log id') }
  }

  const replicaId = parsed.body['replicaId']
  if (replicaId !== undefined && (typeof replicaId !== 'string' || !REPLICA_ID_PATTERN.test(replicaId))) {
    return {
      ok: false,
      error: errorResponse(ErrorCodes.invalid_replica_id, 'replicaId does not match the required shape'),
    }
  }

  const supersedes = parsed.body['supersedes']
  if (supersedes !== undefined && typeof supersedes !== 'string') {
    return { ok: false, error: errorResponse(ErrorCodes.malformed_request, 'supersedes must be a string') }
  }

  return {
    ok: true,
    logs,
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(replicaId === undefined ? {} : { replicaId }),
  }
}

/**
 * `POST /v1/workspaces/{workspaceId}/heartbeat`의 본문 (`§4.3`) — `Record<string, never>`.
 * 정의된 필드가 없으므로 필드가 하나라도 있으면 `400 malformed_request`다. `createLog`와
 * 달리 `client_minted_id` 재판정이 없다 — 갱신 라우트가 스코프를 넓힐 수 없다는 것을 규칙이
 * 아니라 «받는 자리 자체가 없다»는 구조로 지킨다(`§3.4`·`§4.3`, 이슈 #112 본문).
 */
function checkHeartbeatBody(raw: string): { readonly ok: true } | { readonly ok: false; readonly error: ErrorResponse } {
  const parsed = parseBody(raw, [])
  return parsed.ok ? { ok: true } : { ok: false, error: parsed.error }
}

/**
 * `POST /v1/workspaces/{workspaceId}/close`의 본문 (`§4.4`) — `{ outcome: 'flushed' | 'discarded' }`.
 * `outcome`이 없거나 두 값 밖(타입 불일치 포함)이면 `400 malformed_request`(`§4.4` 실패표) —
 * 표에 이 판정을 위한 전용 code가 없다.
 */
function checkCloseWorkspaceBody(
  raw: string,
): { readonly ok: true; readonly outcome: 'flushed' | 'discarded' } | { readonly ok: false; readonly error: ErrorResponse } {
  const parsed = parseBody(raw, CLOSE_WORKSPACE_BODY_FIELDS)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error }
  }
  const outcome = parsed.body['outcome']
  if (typeof outcome !== 'string' || !CLOSE_OUTCOMES.has(outcome)) {
    return {
      ok: false,
      error: errorResponse(ErrorCodes.malformed_request, 'outcome must be "flushed" or "discarded"'),
    }
  }
  return { ok: true, outcome: outcome as 'flushed' | 'discarded' }
}

/**
 * `POST /v1/workspaces/{workspaceId}/revoke`의 본문 (`§4.5`) — `{ reason?: string }`. `reason`이
 * 있는데 문자열이 아니면 `400 malformed_request`; 없으면(필드 자체가 없어도) 통과한다 —
 * {@link checkRevokeLogBody}(`§2.6`, mori-nest #93)와 같은 문법을 재사용하지만 **반환값에
 * `reason`을 싣지 않는다**: 스토어의 `WorkspaceStore.revokeWorkspace`가 이 값을 받지 않으므로
 * (이슈 #112 본문 — `ControlRequest`에 `reason` 필드를 만들지 않는다는 완료 조건), 문법만
 * 보고 버린다.
 */
function checkRevokeWorkspaceBody(raw: string): { readonly ok: true } | { readonly ok: false; readonly error: ErrorResponse } {
  const parsed = parseBody(raw, REVOKE_WORKSPACE_BODY_FIELDS)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error }
  }
  const reason = parsed.body['reason']
  if (reason !== undefined && typeof reason !== 'string') {
    return { ok: false, error: errorResponse(ErrorCodes.malformed_request, 'reason must be a string') }
  }
  return { ok: true }
}

/** 자격 부재·형식 오류의 고정 `401`. `src/transport/request.ts`의 같은 이름 함수와 같은
 * 이유로 `details`가 없다 — 받은 헤더 값을 되비추지 않는다. */
function unauthenticated(): Extract<ControlRequestResult, { readonly ok: false }> {
  return reject(
    401,
    errorResponse(ErrorCodes.unauthenticated, 'a valid Authorization: Bearer credential is required'),
  )
}

/**
 * 제어 평면 여덟 라우트의 공통 게이트. 통과하면 해석된 요청을, 아니면 `§1.3`의 봉투와
 * 상태코드를 반환한다.
 *
 * ## 검사 순서
 *
 * `src/transport/request.ts`와 같은 원칙(문법 검사가 자격 검사보다 앞선다 — 응답이
 * 알려주는 것이 스펙을 읽은 사람이 이미 아는 것뿐이게 한다)을 따른다:
 *
 * 1. **라우트 해석** — 경로가 `/v1/logs`·`/v1/logs/{logId}`·`/v1/logs/{logId}/revoke`·
 *    `/v1/workspaces`·`/v1/workspaces/{workspaceId}`·`/v1/workspaces/{workspaceId}/heartbeat`·
 *    `.../close`·`.../revoke` 중 하나인가. 아니면 `400 malformed_request`.
 * 2. **메서드** — `checkMethod`. 아니면 `405` + `Allow`.
 * 3. **라우트별 문법**:
 *    - `listLogs`: `after` 형식(`§2.4`) — 해석 불가면 `400 invalid_cursor`. `limit`은
 *      거부하지 않는다({@link parseLimit} doc).
 *    - `createLog`: 본문 형태(`§2.1`·`§2.2`) 그다음 `Idempotency-Key` 형식(`§1.4`).
 *    - `getLog`: 없음 — 경로의 `logId`를 그대로 싣는다. grant 판정은 이 게이트의 일이
 *      아니다(다음 조각).
 *    - `revokeLog`: 본문 형태(`§2.6` — `reason`이 있는데 문자열이 아니면
 *      `400 malformed_request`). `Idempotency-Key`를 요구하지 않는다(`§2.6`의 멱등은
 *      연산 자체가 성립시킨다, 이슈 #93 본문).
 *    - `openWorkspace`: 본문 형태(`§4.2` — `client_minted_id` → `logs`(`empty_scope`·
 *      `invalid_log_id`) → `replicaId`(`invalid_replica_id`, `§4.9`) → `supersedes`(타입만,
 *      `malformed_request`)) 그다음 `Idempotency-Key` 형식(`§1.4`).
 *    - `heartbeatWorkspace`: 본문 형태(`§4.3` — 정의되지 않은 필드가 하나라도 있으면
 *      `400 malformed_request`). `Idempotency-Key`를 요구하지 않는다(`§1.4` — 그 두 라우트
 *      밖이다).
 *    - `closeWorkspace`: 본문 형태(`§4.4` — `outcome`이 없거나 `'flushed'`·`'discarded'`
 *      밖이면 `400 malformed_request`). `Idempotency-Key`를 요구하지 않는다.
 *    - `revokeWorkspace`: 본문 형태(`§4.5` — `reason`이 있는데 문자열이 아니면
 *      `400 malformed_request`, `revokeLog`와 같은 문법). `Idempotency-Key`를 요구하지 않는다.
 *    - `listWorkspaces`: 쿼리 문법(`§4.6`, {@link checkListWorkspacesQuery} doc) —
 *      정의되지 않은 파라미터는 `400 malformed_request`. 반복 파라미터는 이름별로 code가
 *      갈린다: `state` 반복은 `400 invalid_state_filter`, `after` 반복은 `400 invalid_cursor`,
 *      `limit` 반복(또는 십진 정수가 아닌 `limit`)은 `400 malformed_request`(`listLogs`의
 *      `limit`과 달리 조용히 접지 않는다, 이 조각의 판단). `state`·`after`의 **값**은 판정하지
 *      않는다 — 유효성은 스토어가 `invalid_state_filter`·`invalid_cursor`로 답한다.
 *    - `getWorkspace`: 없음 — 경로의 `workspaceId`를 그대로 싣는다. 존재 판정은 이 게이트의
 *      일이 아니다(다음 조각).
 *    - **`heartbeatWorkspace`·`closeWorkspace`·`revokeWorkspace`·`getWorkspace` 넷 다
 *      `workspaceId` 형식을 검사하지 않는다** — 없는 id·다른 주체의 id는 스토어가
 *      `404 workspace_not_found`로 답한다(`§4.6` MUST — 열거 오라클 방지, 이슈 #112·#115 본문).
 * 4. **자격** — `Authorization: Bearer <런처 자격증명>` → `credentials.verify`. 아니면 `401`.
 *    작업공간 토큰이 이 자리에서 걸린다: 그 값은 이 스토어에 조회되는 해시와 절대
 *    일치하지 않으므로 `verify`가 그대로 `401`을 낸다(`§1.1`) — 이 파일에 작업공간 토큰을
 *    식별하는 별도 분기가 없다.
 *
 * ## 이 게이트가 하지 않는 것
 *
 * - **스토어를 보지 않는다** (자격증명 조회는 예외 — `§1.1`이 그 형태를 요구한다).
 *   `isGranted`·`createLog`·`listLogsForSubject`·`revoke`·`heartbeat`·`closeWorkspace`·
 *   `revokeWorkspace`·`listWorkspaces`·`getWorkspace`는 라우트 배선의 것이다.
 * - **`limit` 상한을 적용하지 않는다.** 형식이 유효한 값을 그대로 싣는다 — 서버 상한이
 *   생기면 그 판정도 다음 조각의 것이다(이 조각의 비범위, `§3.1`급 `maxLimit` 개념이
 *   `0003`에는 아직 없다). `listWorkspaces`도 같다 — `limit` 값의 **형식**은 거부하지만
 *   **크기**의 천장은 라우트 배선(`./server.js`)이 정한다.
 * - **본문의 필드 타입을 검증하지 않는다** — `CreateLogRequest`·`HeartbeatWorkspaceRequest`는
 *   필드가 없으므로 볼 타입이 없다.
 *
 * @param request Node 표준 HTTP 서버의 요청 객체와 모양이 같은 요청.
 * @param body 요청 본문 원문. GET 라우트에는 쓰이지 않으므로 부르는 쪽이 빈 문자열을
 *   줘도 안전하다.
 * @param credentials 런처 자격증명 스토어. `verify`만 쓴다.
 */
export async function verifyControlRequest(
  request: RawRequest,
  body: string,
  credentials: LauncherCredentialStore,
): Promise<ControlRequestResult> {
  const { path, query } = splitTarget(request.url)

  // ── 1: 라우트 해석. `/v1/logs`(셋) · `/v1/logs/{logId}`(넷) · `/v1/logs/{logId}/revoke`(다섯) ·
  // `/v1/workspaces`(셋, 컬렉션 경로) · `/v1/workspaces/{workspaceId}`(넷, mori-nest #115) ·
  // `/v1/workspaces/{workspaceId}/heartbeat`·`/close`·`/revoke`(다섯, mori-nest #112)뿐이다.
  // 그 밖의 세그먼트 수·이름은 아래 어느 것과도 매치되지 않고 `malformed_request`로 떨어진다.
  const segments = path.split('/')
  const prefixMatches = PATH_PREFIX.every((expected, index) => segments[index] === expected)
  const isCollection = prefixMatches && segments.length === PATH_PREFIX.length
  const logIdSegment = prefixMatches && segments.length === PATH_PREFIX.length + 1 ? (segments[PATH_PREFIX.length] ?? '') : ''
  const hasLogId = logIdSegment !== ''
  const revokeLogIdSegment =
    prefixMatches && segments.length === PATH_PREFIX.length + 2 && segments[PATH_PREFIX.length + 1] === REVOKE_SUFFIX
      ? (segments[PATH_PREFIX.length] ?? '')
      : ''
  const isRevoke = revokeLogIdSegment !== ''
  const workspacePrefixMatches = WORKSPACE_PATH_PREFIX.every((expected, index) => segments[index] === expected)
  const isWorkspaceCollection = workspacePrefixMatches && segments.length === WORKSPACE_PATH_PREFIX.length
  const singleWorkspaceIdSegment =
    workspacePrefixMatches && segments.length === WORKSPACE_PATH_PREFIX.length + 1
      ? (segments[WORKSPACE_PATH_PREFIX.length] ?? '')
      : ''
  const isGetWorkspace = singleWorkspaceIdSegment !== ''
  const isWorkspaceSubRoute = workspacePrefixMatches && segments.length === WORKSPACE_PATH_PREFIX.length + 2
  const workspaceIdSegment = isWorkspaceSubRoute ? (segments[WORKSPACE_PATH_PREFIX.length] ?? '') : ''
  const workspaceAction = isWorkspaceSubRoute ? (segments[WORKSPACE_PATH_PREFIX.length + 1] ?? '') : ''
  const isHeartbeatWorkspace = workspaceIdSegment !== '' && workspaceAction === HEARTBEAT_SUFFIX
  const isCloseWorkspace = workspaceIdSegment !== '' && workspaceAction === CLOSE_SUFFIX
  const isRevokeWorkspace = workspaceIdSegment !== '' && workspaceAction === WORKSPACE_REVOKE_SUFFIX

  if (
    !isCollection &&
    !hasLogId &&
    !isRevoke &&
    !isWorkspaceCollection &&
    !isGetWorkspace &&
    !isHeartbeatWorkspace &&
    !isCloseWorkspace &&
    !isRevokeWorkspace
  ) {
    return reject(400, errorResponse(ErrorCodes.malformed_request, 'request target is not a control route'))
  }

  // ── 2: 메서드. 컬렉션 경로 둘(`/v1/logs`·`/v1/workspaces`)은 `POST`(생성·개시)와
  // `GET`(목록 조회) 모두를 허용한다 — 갈리는 것은 아래 ── 3의 메서드 분기다.
  const allowedMethods =
    isRevoke || isHeartbeatWorkspace || isCloseWorkspace || isRevokeWorkspace
      ? ['POST']
      : hasLogId || isGetWorkspace
        ? ['GET']
        : ['POST', 'GET']
  const allowHeader: Readonly<Record<string, string>> = { Allow: allowedMethods.join(', ') }
  const methodCheck = checkMethod(request.method, allowedMethods)
  if (!methodCheck.ok) {
    return reject(405, methodCheck.error, allowHeader)
  }

  // ── 3: 라우트별 문법.
  if (isHeartbeatWorkspace) {
    const bodyCheck = checkHeartbeatBody(body)
    if (!bodyCheck.ok) {
      return reject(400, bodyCheck.error)
    }

    const authResult = await authenticate(request, credentials)
    if (!authResult.ok) {
      return authResult
    }
    return {
      ok: true,
      request: { route: 'heartbeatWorkspace', subject: authResult.subject, workspaceId: workspaceIdSegment },
    }
  }

  if (isCloseWorkspace) {
    const bodyCheck = checkCloseWorkspaceBody(body)
    if (!bodyCheck.ok) {
      return reject(400, bodyCheck.error)
    }

    const authResult = await authenticate(request, credentials)
    if (!authResult.ok) {
      return authResult
    }
    return {
      ok: true,
      request: {
        route: 'closeWorkspace',
        subject: authResult.subject,
        workspaceId: workspaceIdSegment,
        outcome: bodyCheck.outcome,
      },
    }
  }

  if (isRevokeWorkspace) {
    const bodyCheck = checkRevokeWorkspaceBody(body)
    if (!bodyCheck.ok) {
      return reject(400, bodyCheck.error)
    }

    const authResult = await authenticate(request, credentials)
    if (!authResult.ok) {
      return authResult
    }
    return {
      ok: true,
      request: { route: 'revokeWorkspace', subject: authResult.subject, workspaceId: workspaceIdSegment },
    }
  }

  if (isGetWorkspace) {
    // `getWorkspace`에는 이 게이트가 판정할 문법이 없다 — 경로의 `workspaceId`를 그대로
    // 싣는다. 존재 판정(없는 작업공간과 다른 주체의 작업공간을 구분하지 않는다, `§4.6` MUST —
    // 열거 오라클 방지)은 이 게이트의 일이 아니다(다음 조각).
    const authResult = await authenticate(request, credentials)
    if (!authResult.ok) {
      return authResult
    }
    return {
      ok: true,
      request: { route: 'getWorkspace', subject: authResult.subject, workspaceId: singleWorkspaceIdSegment },
    }
  }

  if (isWorkspaceCollection && request.method === 'GET') {
    const queryCheck = checkListWorkspacesQuery(query)
    if (!queryCheck.ok) {
      return reject(400, queryCheck.error)
    }

    const authResult = await authenticate(request, credentials)
    if (!authResult.ok) {
      return authResult
    }
    return {
      ok: true,
      request: {
        route: 'listWorkspaces',
        subject: authResult.subject,
        ...(queryCheck.state === undefined ? {} : { state: queryCheck.state }),
        ...(queryCheck.after === undefined ? {} : { after: queryCheck.after }),
        ...(queryCheck.limit === undefined ? {} : { limit: queryCheck.limit }),
      },
    }
  }

  if (isWorkspaceCollection) {
    const bodyCheck = checkOpenWorkspaceBody(body)
    if (!bodyCheck.ok) {
      return reject(400, bodyCheck.error)
    }
    const idempotencyHeader = atMostOne(headerValues(request.headers, 'idempotency-key'))
    const parsedKey = parseIdempotencyKey(idempotencyHeader.ok ? idempotencyHeader.value : undefined)
    if (!parsedKey.ok) {
      return reject(400, errorResponse(ErrorCodes.missing_idempotency_key, 'a valid Idempotency-Key header is required'))
    }

    const authResult = await authenticate(request, credentials)
    if (!authResult.ok) {
      return authResult
    }
    return {
      ok: true,
      request: {
        route: 'openWorkspace',
        subject: authResult.subject,
        logs: bodyCheck.logs,
        ...(bodyCheck.supersedes === undefined ? {} : { supersedes: bodyCheck.supersedes }),
        ...(bodyCheck.replicaId === undefined ? {} : { replicaId: bodyCheck.replicaId }),
        idempotencyKey: parsedKey.key,
        requestBody: body,
      },
    }
  }

  if (isRevoke) {
    const bodyCheck = checkRevokeLogBody(body)
    if (!bodyCheck.ok) {
      return reject(400, bodyCheck.error)
    }

    const authResult = await authenticate(request, credentials)
    if (!authResult.ok) {
      return authResult
    }
    return {
      ok: true,
      request: {
        route: 'revokeLog',
        subject: authResult.subject,
        logId: revokeLogIdSegment,
        ...(bodyCheck.reason === undefined ? {} : { reason: bodyCheck.reason }),
      },
    }
  }

  if (hasLogId) {
    // getLog에는 이 게이트가 판정할 문법이 없다 — 경로의 logId를 그대로 싣는다.
    // grant 판정(존재하지 않거나 이 주체가 볼 수 없는 로그 → 404)은 다음 조각의 것이다.
    const authResult = await authenticate(request, credentials)
    if (!authResult.ok) {
      return authResult
    }
    return { ok: true, request: { route: 'getLog', subject: authResult.subject, logId: logIdSegment } }
  }

  if (request.method === 'GET') {
    const after = parseAfter(query)
    if (!after.ok) {
      return reject(400, errorResponse(ErrorCodes.invalid_cursor, 'after cannot be interpreted as a cursor'))
    }
    const limit = parseLimit(query)

    const authResult = await authenticate(request, credentials)
    if (!authResult.ok) {
      return authResult
    }
    return { ok: true, request: listLogsRequest(authResult.subject, after.value, limit) }
  }

  // request.method === 'POST' (checkMethod가 이미 POST|GET으로 좁혔다).
  const bodyCheck = checkCreateLogBody(body)
  if (!bodyCheck.ok) {
    return reject(400, bodyCheck.error)
  }
  const idempotencyHeader = atMostOne(headerValues(request.headers, 'idempotency-key'))
  const parsedKey = parseIdempotencyKey(idempotencyHeader.ok ? idempotencyHeader.value : undefined)
  if (!parsedKey.ok) {
    return reject(400, errorResponse(ErrorCodes.missing_idempotency_key, 'a valid Idempotency-Key header is required'))
  }

  const authResult = await authenticate(request, credentials)
  if (!authResult.ok) {
    return authResult
  }
  return {
    ok: true,
    request: {
      route: 'createLog',
      subject: authResult.subject,
      idempotencyKey: parsedKey.key,
      requestBody: body,
    },
  }
}

/** `Authorization` 헤더에서 `Bearer` 자격을 뽑는다. 정확히 하나가 아니거나 스킴이 아니면
 * `null`이다. */
function bearerCredential(request: RawRequest): string | null {
  const authorization = atMostOne(headerValues(request.headers, 'authorization'))
  const value = authorization.ok && authorization.value !== null ? authorization.value : null
  const bearer = value === null ? null : BEARER_CREDENTIALS.exec(value)
  return bearer === null ? null : (bearer[1] ?? null)
}

/** ── 4: 자격. `credentials.verify`가 조회로 판정한다 — 작업공간 토큰·미발급·폐기된
 * 자격증명은 여기서 전부 같은 `401`로 합류한다(`§1.1`). */
async function authenticate(
  request: RawRequest,
  credentials: LauncherCredentialStore,
): Promise<{ readonly ok: true; readonly subject: string } | Extract<ControlRequestResult, { readonly ok: false }>> {
  const token = bearerCredential(request)
  if (token === null) {
    return unauthenticated()
  }
  const verification = await credentials.verify(token)
  if (!verification.ok) {
    return reject(401, verification.error)
  }
  return { ok: true, subject: verification.subject }
}
