/**
 * 제어 평면의 요청 판정 — 런처 자격 게이트 + 로그 라우트 3종 판별
 * (`0003 §1.1`·`§1.2`·`§1.3`·`§1.4`·`§2.1`·`§2.2`·`§2.4`, mori-nest #68 라우트 조각 1/2 · #83).
 *
 * `src/transport/request.ts`와 같은 모양이다: **판정 함수 하나.** HTTP 응답을 쓰지 않고,
 * 판정 결과(해석된 요청, 또는 `§1.3`의 에러 봉투 + 상태코드)를 **반환**할 뿐이다. 다른 점
 * 하나: 런처 자격증명 판정은 서명을 푸는 순수 계산이 아니라 **조회**이므로(`§1.1` — "제어
 * 평면에는 [내구성 단일 장애점] 제약이 없다"), 이 함수는 async이고 {@link LauncherCredentialStore}를
 * 주입받는다.
 *
 * 이 파일이 판별하는 라우트는 `§0` 표의 여덟 중 셋뿐이다 — `POST /v1/logs`(`§2.1`),
 * `GET /v1/logs`·`GET /v1/logs/{logId}`(`§2.4`). 나머지 다섯(작업공간 개시·하트비트·종료·
 * 폐기·조회, 로그 폐기)은 이 조각의 비범위다.
 *
 * 이 파일에는 HTTP 서버도 스토어 호출(`isGranted`·`createLog`)도 없다 — 그것은 다음 조각
 * (라우트 배선, mori-nest #83 이슈 본문 "후속")의 몫이다. `src/transport/`를 import하지
 * 않는 것도 같은 경계 규율이다(`src/control/index.ts` 상단 doc) — 아래 헬퍼들이
 * `src/transport/request.ts`의 것과 모양이 겹치는 것은 우연이 아니라 같은 문제를 각 평면이
 * 독립적으로 풀기 때문이다.
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

/** `0003 §2.2`: 서버가 발급할 식별자를 제안하는 것으로 읽히는 최상위 필드 이름들. */
const CLIENT_MINTED_ID_FIELDS = new Set(['logId', 'id', 'name'])

/** `/v1/logs` 경로의 세그먼트. */
const PATH_PREFIX = ['', 'v1', 'logs'] as const

/** Node 표준 HTTP 서버의 `IncomingMessage`와 모양만 맞는 요청 입력. `src/transport/request.ts`의
 * `RawRequest`와 같은 모양이지만 독립적으로 정의한다 — import하면 그 자체로 평면 경계가 깨진다. */
export type RawRequest = {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
}

/** 이 게이트가 판별하는 라우트 셋. `ControlStore`의 메서드 이름과 나란히 둔다
 * (`createLog`·`listLogsForSubject`). */
export type ControlRoute = 'createLog' | 'listLogs' | 'getLog'

/**
 * 게이트를 통과한 요청. `subject`는 항상 런처 자격증명 조회로만 해석된다(`§1.2` MUST NOT —
 * 본문·쿼리·헤더로 주체를 지정하는 경로가 이 파일에 없다).
 *
 * `createLog`가 `idempotencyKey`와 `requestBody`(원본 본문 문자열)를 함께 싣는 것은 다음
 * 조각이 그대로 `IdempotencyStore.reserve(subject, key, requestBody)`에 넘길 수 있게
 * 하기 위해서다 — 이 게이트가 다이제스트를 미리 계산하지 않는다.
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

/** 자격 부재·형식 오류의 고정 `401`. `src/transport/request.ts`의 같은 이름 함수와 같은
 * 이유로 `details`가 없다 — 받은 헤더 값을 되비추지 않는다. */
function unauthenticated(): Extract<ControlRequestResult, { readonly ok: false }> {
  return reject(
    401,
    errorResponse(ErrorCodes.unauthenticated, 'a valid Authorization: Bearer credential is required'),
  )
}

/**
 * 제어 평면 세 라우트의 공통 게이트. 통과하면 해석된 요청을, 아니면 `§1.3`의 봉투와
 * 상태코드를 반환한다.
 *
 * ## 검사 순서
 *
 * `src/transport/request.ts`와 같은 원칙(문법 검사가 자격 검사보다 앞선다 — 응답이
 * 알려주는 것이 스펙을 읽은 사람이 이미 아는 것뿐이게 한다)을 따른다:
 *
 * 1. **라우트 해석** — 경로가 `/v1/logs` 또는 `/v1/logs/{logId}`인가. 아니면 `400 malformed_request`.
 * 2. **메서드** — `checkMethod`. 아니면 `405` + `Allow`.
 * 3. **라우트별 문법**:
 *    - `listLogs`: `after` 형식(`§2.4`) — 해석 불가면 `400 invalid_cursor`. `limit`은
 *      거부하지 않는다({@link parseLimit} doc).
 *    - `createLog`: 본문 형태(`§2.1`·`§2.2`) 그다음 `Idempotency-Key` 형식(`§1.4`).
 *    - `getLog`: 없음 — 경로의 `logId`를 그대로 싣는다. grant 판정은 이 게이트의 일이
 *      아니다(다음 조각).
 * 4. **자격** — `Authorization: Bearer <런처 자격증명>` → `credentials.verify`. 아니면 `401`.
 *    작업공간 토큰이 이 자리에서 걸린다: 그 값은 이 스토어에 조회되는 해시와 절대
 *    일치하지 않으므로 `verify`가 그대로 `401`을 낸다(`§1.1`) — 이 파일에 작업공간 토큰을
 *    식별하는 별도 분기가 없다.
 *
 * ## 이 게이트가 하지 않는 것
 *
 * - **스토어를 보지 않는다** (자격증명 조회는 예외 — `§1.1`이 그 형태를 요구한다).
 *   `isGranted`·`createLog`·`listLogsForSubject`는 다음 조각(라우트 배선)의 것이다.
 * - **`limit` 상한을 적용하지 않는다.** 형식이 유효한 값을 그대로 싣는다 — 서버 상한이
 *   생기면 그 판정도 다음 조각의 것이다(이 조각의 비범위, `§3.1`급 `maxLimit` 개념이
 *   `0003`에는 아직 없다).
 * - **본문의 필드 타입을 검증하지 않는다** — `CreateLogRequest`는 필드가 없으므로 볼
 *   타입이 없다.
 *
 * @param request `IncomingMessage`와 모양이 같은 요청.
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

  // ── 1: 라우트 해석. `/v1/logs`(다섯 세그먼트 아님, 셋) 또는 `/v1/logs/{logId}`(넷)뿐이다.
  const segments = path.split('/')
  const prefixMatches = PATH_PREFIX.every((expected, index) => segments[index] === expected)
  const isCollection = prefixMatches && segments.length === PATH_PREFIX.length
  const logIdSegment = prefixMatches && segments.length === PATH_PREFIX.length + 1 ? (segments[PATH_PREFIX.length] ?? '') : ''
  const hasLogId = logIdSegment !== ''

  if (!isCollection && !hasLogId) {
    return reject(400, errorResponse(ErrorCodes.malformed_request, 'request target is not a control route'))
  }

  // ── 2: 메서드.
  const allowedMethods = hasLogId ? ['GET'] : ['POST', 'GET']
  const allowHeader: Readonly<Record<string, string>> = { Allow: allowedMethods.join(', ') }
  const methodCheck = checkMethod(request.method, allowedMethods)
  if (!methodCheck.ok) {
    return reject(405, methodCheck.error, allowHeader)
  }

  // ── 3: 라우트별 문법.
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
