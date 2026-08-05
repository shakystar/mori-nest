/**
 * 전송 평면의 **공통 요청 게이트** — `0002 §0`의 라우트 해석 + 세 라우트가 전부 요구하는
 * 사전 판정들 (`§1.1`·`§1.2`·`§4.2`).
 *
 * 이 모듈은 `token.js`와 같은 형태다: **순수 함수 하나.** 서버도 저장소도 여기 없고, HTTP
 * 응답을 쓰지 않는다 — 판정 결과(해석된 요청, 또는 `§1.5`의 에러 봉투 + 상태코드)를
 * **반환**할 뿐이다. 그렇게 설 수 있는 이유는 아래 판정 중 **어느 것도 로그의 내용을 보지
 * 않기** 때문이다: `logId`는 전송 평면이 **주어진 것**으로 받고(`§1.1`), 스코프 판정은 토큰
 * 안에서 끝난다(`§1.2` — 멤버십·계정 상태를 조회하지 않고 판정할 수 있어야 한다, MUST).
 *
 * 입력은 Node 표준 HTTP 서버의 `IncomingMessage`와 **모양만** 맞는 평범한 값이다. 그 타입을
 * import하지 않는 것은 이 게이트를 서버 프레임워크에 묶지 않기 위해서다 — 나중에 서버가
 * 생기면 `IncomingMessage`가 그대로 {@link RawRequest}로 들어간다. 이 파일에는 HTTP 서버도
 * 파일 시스템도 없다 (mori-nest #14의 완료 조건이 grep으로 그것을 고정한다).
 *
 * `logId`는 **prefix-blind**하게 다룬다 (`§1.1`). 이 파일에 접두사 리터럴이 하나도 없는 것이
 * 그 성질이고, 여기서 `logId`에 하는 일은 정규식 검증과 스코프 대조뿐이다.
 */

import { ErrorCodes, errorResponse, type ErrorResponse } from './errors.js'
import { checkMethod } from './method.js'
import {
  checkLogScope,
  verifyWorkspaceToken,
  type VerificationKeySet,
  type VerifiedWorkspaceToken,
} from './token.js'

/** `0002 §1.1`: `logId := ^[A-Za-z0-9_-]{1,128}$`. 이 정규식이 traversal 차단을 겸한다. */
const LOG_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/**
 * `Authorization: Bearer <token>` (`0002 §1.2`).
 *
 * 스킴 이름은 **대소문자를 구분하지 않는다** (RFC 9110 §11.1 — `auth-scheme`은
 * case-insensitive). 메서드(`method.ts`)와 반대인 것은 두 토큰의 RFC 정의가 반대이기
 * 때문이지 여기만 관대하게 두는 것이 아니다. 나머지는 엄격하다: 구분자는 SP 하나이고,
 * 토큰부는 공백 없는 비어 있지 않은 문자열이어야 한다.
 */
const BEARER_CREDENTIALS = /^Bearer (\S+)$/i

/** `0002 §4.2`: subscribe가 요구하는 미디어 타입. */
const SSE_MEDIA_TYPE = 'text/event-stream'

/** 전송 평면의 라우트 이름. `0002 §0`의 표에 있는 셋뿐이다. */
export type TransportRoute = 'append' | 'pull' | 'subscribe'

/**
 * `0002 §0` L21-23의 라우트 표. **이 표는 이 파일이 갖는다** — `method.ts`의 doc이
 * *"라우트 테이블은 여기에 없다"*로 그어 둔 경계의 반대쪽이 여기다.
 *
 * `tail`은 `/v1/logs/{logId}/` 뒤에 오는 마지막 세그먼트다. 표에 없는 경로는 이 셋 중
 * 어느 것도 아니고, `/v1/logs/`로 시작한다는 이유로 통과하지 않는다 (`§0` L25).
 */
const ROUTE_TABLE = [
  { route: 'append', method: 'POST', tail: 'events' },
  { route: 'pull', method: 'GET', tail: 'events' },
  { route: 'subscribe', method: 'GET', tail: 'subscribe' },
] as const satisfies readonly { route: TransportRoute; method: string; tail: string }[]

/** 경로 앞부분. `/v1/logs/{logId}/{tail}`을 세그먼트로 쪼갠 뒤 대조하는 상수다. */
const PATH_PREFIX = ['', 'v1', 'logs'] as const

/**
 * Node 표준 HTTP 서버의 `IncomingMessage`와 모양만 맞는 요청 입력.
 *
 * `url`은 **경로 + 쿼리스트링**이고 오리진이 없다 (`IncomingMessage.url`이 그렇다).
 * `headers`의 값이 배열인 것은 같은 헤더가 여러 번 온 경우다.
 */
export type RawRequest = {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
}

/**
 * 읽기 시작 위치 (`0002 §3.1`·`§4.2`).
 *
 * `"지금부터"를 뜻하는 값은 이 스펙에 없다` (`§4.2` L374) — 그래서 이 유니온에도 없다.
 * `cursor`는 **불투명 문자열**이고 이 게이트는 그것을 해석하지 않는다: 해석에는 저장소가
 * 필요하고, 해석되지 않는 커서는 에러가 아니라 `from: "unknown"` 정상 응답이다
 * (`§3.2` L322, MUST NOT).
 */
export type CursorStart =
  | { readonly kind: 'beginning' }
  | { readonly kind: 'after'; readonly cursor: string }

/**
 * 게이트를 통과한 요청. 라우트별로 갈리는 자리가 있으므로 `route`로 판별하는 유니온이다.
 *
 * append에 `start`가 없는 것은 append가 `after`를 계약에 갖지 않기 때문이다 (`§2.1`).
 */
export type TransportRequest =
  | {
      readonly route: 'append'
      readonly logId: string
      readonly token: VerifiedWorkspaceToken
    }
  | {
      readonly route: 'pull'
      readonly logId: string
      readonly token: VerifiedWorkspaceToken
      readonly start: CursorStart
    }
  | {
      readonly route: 'subscribe'
      readonly logId: string
      readonly token: VerifiedWorkspaceToken
      readonly start: CursorStart
    }

/** 이 게이트가 낼 수 있는 상태코드. 전부 `0002 §1.5` 표(L148-163)에 있는 것뿐이다. */
export type TransportErrorStatus = 400 | 401 | 403 | 405 | 406 | 500

export type TransportRequestResult =
  | { readonly ok: true; readonly request: TransportRequest }
  | {
      readonly ok: false
      readonly status: TransportErrorStatus
      readonly error: ErrorResponse
      /**
       * 응답에 함께 실을 헤더. `405`의 `Allow` 말고는 비어 있다 — `Allow`는 RFC 9110
       * §10.2.1이 `405`에 요구하는 헤더이고, 그 값을 만들 수 있는 것은 라우트 표를 가진
       * 이 파일뿐이다 (`method.ts`의 doc이 그렇게 지시한다).
       */
      readonly headers: Readonly<Record<string, string>>
    }

const NO_HEADERS: Readonly<Record<string, string>> = Object.freeze({})

function reject(
  status: TransportErrorStatus,
  error: ErrorResponse,
  headers: Readonly<Record<string, string>> = NO_HEADERS,
): TransportRequestResult {
  return { ok: false, status, error, headers }
}

/**
 * 요청 타깃을 경로와 쿼리스트링으로 가른다.
 *
 * **퍼센트 디코딩을 하지 않는다.** 디코딩을 먼저 하면 `%2e%2e%2f`가 `../`가 된 뒤에
 * 검증을 받게 되고, 그 순서에서는 `logId` 정규식이 traversal 차단을 겸한다는 `§1.1` L45가
 * 성립하지 않는다. 여기서는 **원문 세그먼트를 그대로** 정규식에 건다 — 정규식이 허용하는
 * 문자 집합(`A-Za-z0-9_-`)에는 `%`가 없으므로, 통과한 `logId`에 대해서는 디코딩이 항등이다.
 * 즉 이 게이트에는 디코딩 단계 자체가 없다.
 *
 * `URL`(WHATWG)을 쓰지 않는 이유도 같다 — 그 파서는 경로의 `..` 세그먼트를 **조용히
 * 정규화해서 없앤다.** 정규화된 경로는 검증을 통과하지만 원래 요청이 무엇이었는지는
 * 사라진다.
 */
function splitTarget(url: string): { readonly path: string; readonly query: string } {
  const queryStart = url.indexOf('?')
  return queryStart === -1
    ? { path: url, query: '' }
    : { path: url.slice(0, queryStart), query: url.slice(queryStart + 1) }
}

/**
 * 이름이 같은 헤더의 값 전부. 대소문자를 구분하지 않고 모으고, 배열 값은 펼친다.
 *
 * **하나로 합치지 않는다.** 중복 헤더를 "둘 중 하나"로 접는 순간 프록시와 서버가 서로
 * 다른 값을 볼 수 있고, 그게 자격 헤더면 서로 다른 주체를 보는 것이 된다. 몇 개가
 * 왔는지를 부르는 쪽이 그대로 보고 판정한다.
 */
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

/**
 * 0개 또는 1개여야 하는 값. 2개 이상이면 `ok: false`이고, 부르는 쪽이 그 자리에 맞는
 * 코드로 옮긴다 — "여러 개 중 하나를 고른다"는 선택지는 여기에 없다.
 */
type OptionalValue = { readonly ok: true; readonly value: string | null } | { readonly ok: false }

function atMostOne(values: readonly string[]): OptionalValue {
  if (values.length > 1) {
    return { ok: false }
  }
  return { ok: true, value: values[0] ?? null }
}

/**
 * 쿼리스트링에서 값 하나를 읽는다.
 *
 * **읽는 이름은 부르는 쪽이 준 것뿐이다.** 이 게이트가 쿼리에서 읽는 이름은 `after`
 * 하나이고, 자격에 해당하는 이름(`token` 류)을 읽는 경로는 이 파일에 **존재하지 않는다** —
 * 읽어서 거부하는 것이 아니라 그 코드가 없다 (`§1.2` L60 MUST NOT).
 *
 * 디코딩은 `application/x-www-form-urlencoded` 표준을 따른다 — 즉 `+`는 공백이 된다.
 * 커서를 **발급하는** 쪽(저장소)이 이 왕복을 견디는 알파벳을 골라야 한다는 뜻이다.
 * 여기서 관례를 벗어나 `+`를 그대로 두면 클라이언트가 표준 인코더로 만든 쿼리와 어긋난다.
 */
function queryValue(query: string, name: string): OptionalValue {
  return atMostOne(new URLSearchParams(query).getAll(name))
}

/** 커서 시작 위치. `null`이면 로그의 처음부터다 (`§3.2`·`§4.2` L373). */
function startFrom(cursor: string | null): CursorStart {
  return cursor === null ? { kind: 'beginning' } : { kind: 'after', cursor }
}

/**
 * `Accept`가 `text/event-stream`을 요구하는가 (`§4.2` L370).
 *
 * **와일드카드(`star/star`)는 통과시키지 않는다.** L370이 요구한 것은 그 미디어 타입이고,
 * 와일드카드는 "아무거나"이지 SSE를 받겠다는 선언이 아니다. `Accept`를 아예 안 보낸
 * 클라이언트와 와일드카드만 보낸 클라이언트는 SSE를 다룰 줄 아는지에 대해 같은 정보를 준다
 * (=없음). 스트림을 열어 놓고 상대가 파싱하지 못하는 쪽이, 열지 않고 `406`을 주는 쪽보다
 * 나쁘다 — 이미 `200`을 보낸 뒤에는 상태코드를 바꿀 수 없다 (`§4.2` L385).
 *
 * 파라미터(`;q=`, `;charset=`)는 해석하지 않는다 — 판정의 근거는 미디어 타입의 **존재**다.
 */
function acceptsEventStream(values: readonly string[]): boolean {
  for (const value of values) {
    for (const entry of value.split(',')) {
      const mediaType = (entry.split(';')[0] ?? '').trim().toLowerCase()
      if (mediaType === SSE_MEDIA_TYPE) {
        return true
      }
    }
  }
  return false
}

/**
 * 전송 평면 세 라우트의 공통 게이트. 통과하면 해석된 요청을, 아니면 `§1.5`의 봉투와
 * 상태코드를 반환한다.
 *
 * ## 검사 순서와 그 근거
 *
 * 스펙은 순서를 정하지 않았다. 여기서 고정한 순서는 **"이 판정이 무엇에 의존하는가"**
 * 하나로 정렬한 것이고, 뒤집으면 아직 인증되지 않은 요청자에게 더 많이 알려주게 된다.
 *
 * 1. **라우트 해석** — 경로가 `§0` 표의 셋 중 하나인가. 아니면 `400 malformed_request`.
 * 2. **`logId` 형식** — `§1.1` 정규식. 아니면 `400 invalid_log_id`.
 * 3. **메서드** — `checkMethod`. 아니면 `405` + `Allow`.
 * 4. **커서 형식** — `after`(그리고 subscribe의 `Last-Event-ID`)가 문자열 하나인가.
 *    아니면 `400 invalid_cursor_format`.
 * 5. **자격** — `Authorization: Bearer <token>`의 존재·형식·검증. 아니면 `401`.
 * 6. **스코프** — 경로의 `logId` ∈ 토큰 스코프. 아니면 `403 out_of_scope`.
 * 7. **`Accept`** — subscribe 한정. 아니면 `406 not_acceptable`.
 *
 * **1~4가 앞인 이유**: 이 넷은 요청의 **문법**만 본다. 판정에 쓰이는 재료(라우트 표,
 * `logId` 정규식, 허용 메서드)가 전부 스펙에 공개돼 있으므로, 응답이 알려주는 것은
 * 요청자가 스펙을 읽어 이미 아는 것뿐이다 — 서버의 상태도, 로그의 존재 여부도, 토큰에
 * 대한 어떤 것도 여기서 새지 않는다. 반대로 자격 검증을 앞세우면 URL이 잘못된 클라이언트가
 * 그 사실을 알기 위해 먼저 유효한 토큰을 구해야 한다.
 *
 * **6이 5보다 뒤인 이유**: `403 out_of_scope`는 *"당신의 토큰은 유효하지만 이 로그는
 * 스코프 밖"*이라는 뜻이라 토큰의 유효성 자체를 알려준다. 그것이 `401`보다 먼저 나오면
 * 서명 없는 요청자가 스코프 판정을 볼 수 있게 된다.
 *
 * **7이 마지막인 이유**: `Accept`가 가르는 것은 **`200` SSE 스트림의 표현**이다. 게이트가
 * 내는 에러는 스트림을 열기 전의 JSON이므로(`§4.2` L384) `Accept` 협상의 대상이 아니고,
 * 그래서 이 검사는 성공 직전에 온다.
 *
 * ## 이 게이트가 하지 않는 것
 *
 * - **저장소를 보지 않는다.** `403`의 본문이 로그의 존재 여부와 무관하게 같아야 한다는
 *   `§1.2` L75(MUST)는 여기서 **구조로** 성립한다 — 존재 여부를 알 방법이 아예 없다.
 *   다음 사람이 "존재하면 404" 분기를 넣지 않기를 바란다. 애초에 `§1.5`의 상태코드 표에
 *   `404`가 없다.
 * - **커서를 해석하지 않는다.** `after`는 불투명 문자열로 실어 옮길 뿐이다 (`§3.2` L322).
 * - **본문을 읽지 않는다.** append의 이벤트 봉투 검증(`§1.3`·`§2.1`)은 라우트의 몫이다.
 *
 * @param request `IncomingMessage`와 모양이 같은 요청.
 * @param keys 주입된 검증 키 집합. 비어 있으면 모든 요청이 `401`이다 (`0003 §3.3`).
 * @param options.now 판정 기준 시각. `verifyWorkspaceToken`에 그대로 넘어간다.
 */
export function verifyTransportRequest(
  request: RawRequest,
  keys: VerificationKeySet,
  options: { readonly now?: Date } = {},
): TransportRequestResult {
  const { path, query } = splitTarget(request.url)

  // ── 1: 라우트 해석. `/v1/logs/{logId}/{tail}` 정확히 다섯 세그먼트다.
  const segments = path.split('/')
  const prefixMatches =
    segments.length === PATH_PREFIX.length + 2 &&
    PATH_PREFIX.every((expected, index) => segments[index] === expected)
  const logId = segments[PATH_PREFIX.length] ?? ''
  const tail = segments[PATH_PREFIX.length + 1] ?? ''
  const candidates = prefixMatches ? ROUTE_TABLE.filter((entry) => entry.tail === tail) : []

  if (candidates.length === 0) {
    // 스펙 갭: `§1.5`의 표에는 `404`도, 미지 경로에 대한 code도 없다. 표 안에서 고를 수
    // 있는 것 중 `malformed_request`가 유일하게 "요청이 정의된 형태와 다르다"를 뜻한다.
    // `405`를 고르지 않은 것은 두 가지 이유다: (1) RFC 9110 §10.2.1이 `405`에 `Allow`를
    // 요구하는데 라우트가 없는 경로에는 실을 값이 없고, (2) `405`는 "이 경로는 있는데 이
    // 메서드가 아니다"라는 뜻이라 없는 경로에 대해서는 거짓을 말한다.
    return reject(
      400,
      errorResponse(ErrorCodes.malformed_request, 'request target is not a transport route'),
    )
  }

  // ── 2: `logId` 형식. 원문 세그먼트를 그대로 본다 (디코딩 없음 — {@link splitTarget}).
  if (!LOG_ID_PATTERN.test(logId)) {
    return reject(400, errorResponse(ErrorCodes.invalid_log_id, 'logId does not match the required format'))
  }

  // ── 3: 메서드. 판정은 `checkMethod`가 하고, 표와 `Allow` 값은 이 파일이 만든다.
  const allowedMethods = candidates.map((entry) => entry.method)
  const allowHeader: Readonly<Record<string, string>> = { Allow: allowedMethods.join(', ') }
  const methodCheck = checkMethod(request.method, allowedMethods)
  if (!methodCheck.ok) {
    return reject(405, methodCheck.error, allowHeader)
  }

  const matched = candidates.find((entry) => entry.method === request.method)
  if (matched === undefined) {
    // 도달하지 않는다 — `checkMethod`에 넘긴 집합이 바로 이 `candidates`에서 나왔다.
    // 그래도 통과로 떨어뜨리지 않는다: 표와 판정이 갈라지는 날 그 요청은 "메서드 검사를
    // 통과했는데 라우트가 없는" 요청이고, 그건 거부여야 한다 (fail-closed).
    return reject(500, errorResponse(ErrorCodes.internal, 'route table and method check disagree'))
  }
  const route = matched.route

  // ── 4: 커서 형식. `after`가 반복되면 값이 문자열이 아니라 배열이고, 그것이 `§1.5` L153의
  //    `invalid_cursor_format`이 실제로 생기는 경로다. **"해석 안 되는 커서"는 여기가 아니다**
  //    (`§3.2` L322 MUST NOT) — 그건 저장소가 보고 `from: "unknown"`으로 정상 응답한다.
  //    append는 `after`를 계약에 갖지 않으므로(`§2.1`) 쿼리를 읽지 않는다.
  let start: CursorStart = { kind: 'beginning' }
  if (route === 'pull' || route === 'subscribe') {
    const after = queryValue(query, 'after')
    if (!after.ok) {
      return reject(
        400,
        errorResponse(ErrorCodes.invalid_cursor_format, 'after must appear at most once'),
      )
    }
    // `Last-Event-ID`는 subscribe만 읽는다 (`§4.2` L372). 중복 헤더는 반복 쿼리와 같은
    // 이유로 같은 코드다 — 어느 쪽을 고르든 서버가 클라이언트가 뜻한 자리를 모른다.
    let lastEventId: string | null = null
    if (route === 'subscribe') {
      const header = atMostOne(headerValues(request.headers, 'last-event-id'))
      if (!header.ok) {
        return reject(
          400,
          errorResponse(ErrorCodes.invalid_cursor_format, 'Last-Event-ID must appear at most once'),
        )
      }
      lastEventId = header.value
    }
    // 둘 다 있으면 `after`가 이긴다 — 클라이언트가 명시한 쪽이다 (`§4.2` L372).
    start = startFrom(after.value ?? lastEventId)
  }

  // ── 5: 자격. 헤더가 정확히 하나여야 한다 — 0개도, 2개 이상도 `401`이다.
  const authorization = atMostOne(headerValues(request.headers, 'authorization'))
  const credentials = authorization.ok && authorization.value !== null ? authorization.value : null
  const bearer = credentials === null ? null : BEARER_CREDENTIALS.exec(credentials)
  if (bearer === null) {
    return unauthenticated()
  }
  const verification = verifyWorkspaceToken(bearer[1] ?? '', keys, options)
  if (!verification.ok) {
    return reject(401, verification.error)
  }
  const token = verification.token

  // ── 6: 스코프 (`0003 §3.3` 검사 5). 실패 본문은 로그의 존재 여부와 무관하게 같다.
  const scopeCheck = checkLogScope(token, logId)
  if (!scopeCheck.ok) {
    return reject(403, scopeCheck.error)
  }

  // ── 7: subscribe의 `Accept`.
  if (route === 'subscribe') {
    if (!acceptsEventStream(headerValues(request.headers, 'accept'))) {
      return reject(
        406,
        errorResponse(ErrorCodes.not_acceptable, `subscribe requires Accept: ${SSE_MEDIA_TYPE}`),
      )
    }
    return { ok: true, request: { route, logId, token, start } }
  }
  if (route === 'pull') {
    return { ok: true, request: { route, logId, token, start } }
  }
  return { ok: true, request: { route, logId, token } }
}

/**
 * 자격이 없거나 형식이 아닐 때의 `401`.
 *
 * `message`는 고정 문자열이고 `details`가 없다. 받은 헤더를 되비추면 그 값이 곧 토큰이고,
 * 토큰 값은 응답 본문 어디에도 실리지 않는다 (`§1.2` L78 MUST NOT). 헤더 부재·스킴 오류·
 * 중복 헤더를 **구분하지 않는** 것도 같은 이유다 — 구분은 자격을 맞춰 보는 쪽에만 쓸모가 있다.
 */
function unauthenticated(): TransportRequestResult {
  return reject(
    401,
    errorResponse(ErrorCodes.unauthenticated, 'a valid Authorization: Bearer credential is required'),
  )
}
