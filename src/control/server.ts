/**
 * 제어 평면 라우트 배선 + 최소 HTTP 서버 (`node:http`, 빌트인). 런타임 의존성 0을 유지한다
 * (`0002 §4.1-3`).
 *
 * `POST /v1/logs`(`0003 §2.1`) · `GET /v1/logs`·`GET /v1/logs/{logId}`(`§2.4`) 셋을 배선한다.
 * **판정은 이 파일에 없다** — 자격 게이트·라우트 판별·본문/쿼리 검사는 `./request.js`의
 * {@link verifyControlRequest}가 이미 끝냈고(mori-nest #83), 여기서는 그 산출물을 스토어
 * 호출로 잇는다. 페이지네이션도 마찬가지다: 판정 → 정렬 → `limit` 적용과 `hasMore` 판정은
 * `listLogsForSubject`가 이미 답했으므로 이 파일이 **다시 자르지 않는다** (자르면 `hasMore`가
 * 거짓말이 된다, `§2.4`).
 *
 * `src/transport/server.ts`의 모양을 선례로 따르되 **그 파일을 import하지 않는다** — 두 배포
 * 단위가 코드에서 다시 하나가 되지 않게 하는 규율이다(`./index.js` 머리말).
 *
 * ## 이 조각의 어려운 자리 — `§1.4`의 원자성
 *
 * *"키 기록과 자원 생성은 원자적이다. 같은 키를 담은 요청 두 건이 동시에 도착해도 자원은
 * 정확히 하나만 생긴다"* (MUST). 멱등 계층(`./idempotency.js`, #73)이 그 절반을 이미 갖고
 * 있다 — **`reserve`가 `'reserved'`를 돌려주는 호출은 동시에 최대 하나다.** 그래서 이 파일이
 * 지는 규율은 하나뿐이다: **`'reserved'`가 아닌 결과에서는 로그를 만들지 않는다.**
 *
 * 순서는 `reserve` → `createLog` → `complete`이고, 이 셋의 순서가 곧 계약이다. 뒤집으면
 * (예약 없이 먼저 생성, 또는 `complete` 없이 응답) 재시도가 로그를 둘 만든다. 계층이
 * 핸들러를 감싸지 않고 **핸들러가 계층을 부른다** — 응답(상태코드·본문)이 자원을 만든
 * 뒤에야 정해지기 때문이다(`./idempotency.js` 머리말).
 *
 * ## 이 조각의 비범위 (mori-nest #84 이슈 본문)
 *
 * 유량 제한(`429`)·본문 크기 한도(`413`)·진단 훅·SSE, 그리고 `§2.6` 폐기 라우트와 `§4`
 * 작업공간 계열. 특히 **본문 크기 한도가 없다는 것은 {@link readBody}가 상한 없이 읽는다는
 * 뜻이다** — 전송 평면의 `maxRequestBytes`(`0002 §1.3` L103)에 해당하는 자리가 이 평면에는
 * 아직 배선되지 않았다(`0003 §1.3` 표에 `413 request_too_large`가 있으므로 자리는 열려 있고,
 * 값을 정하는 것은 이 조각이 아니다). 그 라우트를 여는 다음 조각이 이 함수에 상한을 준다.
 *
 * 진단 훅(`src/transport/server.ts`의 `onDiagnostic`)도 비범위라, 아래 `catch`들이 삼킨
 * 예외는 상태코드 말고는 아무 흔적을 남기지 않는다 — 전송 평면이 #38·#51에서 닫은 자리가
 * 이 평면에는 아직 열려 있다. 예외 `message`를 봉투에 싣지 않는 규율(`§1.3`)은 그것과
 * 무관하게 지킨다: 아래에서 쓰는 메시지는 전부 고정 문자열이다.
 *
 * ## Node 타입이 이 디렉터리에 들어오지 않는다
 *
 * `src/control/`은 `node:http`의 요청·응답 클래스 이름을 **한 글자도 들이지 않는다** —
 * #83 완료 조건이 `rg`로 0건을 못박은 그 두 이름이고, 주석에도 적지 않는 것까지가 그
 * 규율이다(그래서 이 문단도 이름 대신 이렇게 부른다). HTTP 서버를 세우는 이 파일이 그
 * 경계가 가장 깨지기 쉬운 자리라, 요청·응답은 `./request.js`의 `RawRequest`와 같은 규율로
 * **모양만 맞는 독립 타입**({@link ServerRequest}·{@link ResponseWriter})으로 받는다.
 * `createServer` 콜백이 넘겨주는 Node 객체는 구조적으로 그 타입을 만족하므로 배선 지점에서
 * 그대로 흘러든다. `node:http`에서 가져오는 것은 `createServer`와 반환 타입 `Server`
 * 둘뿐이다.
 */

import { createServer, type Server } from 'node:http'

import { ErrorCodes, errorResponse, type ErrorResponse } from '../errors.js'
import type { LauncherCredentialStore } from './credential.js'
import { IdempotencyStoreError, type IdempotencyStore } from './idempotency.js'
import { verifyControlRequest, type ControlRequest, type RawRequest } from './request.js'
import { DEFAULT_PAGE_LIMIT, type ControlStore } from './store.js'

/**
 * `GET /v1/logs`의 `limit` 천장 ({@link handleListLogs} doc). 스토어가 `limit` 없이 쓰는
 * 페이지 크기를 그대로 재사용한다 — 이 자리에 새 숫자를 지어내지 않는다.
 */
const MAX_PAGE_LIMIT = DEFAULT_PAGE_LIMIT

/**
 * 요청 객체 — Node 표준 HTTP 서버가 넘겨주는 것과 **모양만** 맞는 독립 타입 (파일 상단 doc).
 * 본문은 `AsyncIterable<Uint8Array>`로만 본다: 스트림 API 전체가 아니라 이 파일이 실제로
 * 쓰는 능력 하나다.
 */
type ServerRequest = AsyncIterable<Uint8Array> & {
  readonly method?: string | undefined
  readonly url?: string | undefined
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
}

/** 응답 객체 — 같은 규율의 독립 타입. 이 파일이 쓰는 것은 헤더 쓰기·본문 종료·종료 여부뿐이다. */
type ResponseWriter = {
  writeHead(status: number, headers: Readonly<Record<string, string>>): unknown
  end(body: string): unknown
  readonly writableEnded: boolean
}

export type ControlServerOptions = {
  /** `logId` mint와 (주체, 로그) 관계 (`./store.js`, #72). */
  readonly store: ControlStore
  /** `Idempotency-Key` 예약·재생·충돌 판정 (`./idempotency.js`, #73). */
  readonly idempotency: IdempotencyStore
  /** 런처 자격증명 조회 (`./credential.js`, #74). 게이트가 `verify`만 쓴다. */
  readonly credentials: LauncherCredentialStore
}

/**
 * SQLite 확장 결과코드의 하위 8비트가 기본 코드다 (`errcode`는 확장 코드로 온다 —
 * `./store.js`가 `1555`(`SQLITE_CONSTRAINT_PRIMARYKEY`)를 그대로 보는 것과 같은 값).
 */
const SQLITE_PRIMARY_CODE_MASK = 0xff

/**
 * **내구화 불가**로 읽는 기본 코드 — 쓰기가 디스크에 남았다고 말할 수 없는 실패들
 * (`§1.3` `503 not_durable`).
 */
const NOT_DURABLE_CODES = new Set([
  8, // SQLITE_READONLY — 쓸 수 없는 DB
  10, // SQLITE_IOERR — 디스크 I/O 실패
  13, // SQLITE_FULL — 디스크가 찼다
])

/**
 * **저장소에 닿을 수 없음**으로 읽는 기본 코드 (`§1.3` `503 unavailable`). 요청 자체는
 * 멀쩡하고 다시 시도하면 될 수 있다는 점이 위 집합과 같고, 갈리는 것은 "쓰다 실패했나"가
 * 아니라 "애초에 닿지 못했나"다.
 */
const UNAVAILABLE_CODES = new Set([
  5, // SQLITE_BUSY — 잠금 대기 상한(`busy_timeout`)을 넘겼다
  6, // SQLITE_LOCKED
  14, // SQLITE_CANTOPEN — DB 파일을 열 수 없다
])

/** 이 파일이 낼 수 있는 실패 응답 하나 (상태코드 + `§1.3` 봉투). */
type Failure = {
  readonly status: number
  readonly error: ErrorResponse
  readonly headers: Readonly<Record<string, string>>
}

const NO_HEADERS: Readonly<Record<string, string>> = Object.freeze({})

/** `503`에 권장되는 `Retry-After` (`§1.3` 표). 초 단위 최솟값 하나 — 배포가 정할 값이 아니다. */
const RETRY_AFTER: Readonly<Record<string, string>> = Object.freeze({ 'Retry-After': '1' })

function toRawRequest(request: ServerRequest): RawRequest {
  return {
    method: request.method ?? '',
    url: request.url ?? '',
    headers: request.headers,
  }
}

/**
 * 본문을 문자열로 읽는다. **상한이 없다** — 본문 크기 한도(`413`)가 이 조각의 비범위이기
 * 때문이고, 그 자리를 지금 임의값으로 채우지 않는다(파일 상단 doc). 스트림 오류는 그대로
 * 올라가 {@link createControlServer}의 마지막 `catch`가 `500`으로 닫는다.
 */
async function readBody(request: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of request) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function writeJson(
  response: ResponseWriter,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = NO_HEADERS,
): void {
  response.writeHead(status, { ...headers, 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

/**
 * 이미 와이어 텍스트인 본문을 그대로 내보낸다. {@link writeJson}과 갈라 두는 이유는 멱등
 * 재생 하나다 — 저장된 응답은 첫 응답의 **바이트**이므로(`./idempotency.js`), 그것을 다시
 * `JSON.stringify`에 넣으면 문자열 리터럴로 한 번 더 감싸진다.
 */
function writeRaw(response: ResponseWriter, status: number, body: string): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(body)
}

function writeFailure(response: ResponseWriter, failure: Failure): void {
  writeJson(response, failure.status, failure.error, failure.headers)
}

/** 확장 결과코드를 들고 있는 예외에서 기본 코드를 뽑는다. 없으면 `null`. */
function sqlitePrimaryCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null
  }
  const errcode = (error as { errcode?: unknown }).errcode
  return typeof errcode === 'number' ? errcode & SQLITE_PRIMARY_CODE_MASK : null
}

/** 닫힌 DB 핸들에 대고 부른 경우 Node가 내는 코드 — 이 프로세스가 이미 내려가고 있다는 뜻이다. */
function isClosedResource(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ERR_INVALID_STATE'
}

/**
 * 스토어가 던진 예외를 `§1.3` 표의 상태코드로 옮긴다 (이슈 #84 작업 범위 5).
 *
 * 세 갈래다:
 * - **`503 not_durable`** — 내구화를 보장할 수 없다. 디스크 I/O·읽기전용·디스크 참
 *   ({@link NOT_DURABLE_CODES}), 그리고 멱등 저장소가 내구성 PRAGMA를 걸지 못한 경우.
 * - **`503 unavailable`** — 셧다운 중이거나 저장소에 닿을 수 없다 ({@link UNAVAILABLE_CODES},
 *   닫힌 핸들).
 * - **`500 internal`** — 그 외 전부. 제약 위반·행 모양 이상·mint 고갈처럼 **서버 쪽 결함**이라
 *   재시도가 답이 아닌 것들이 여기로 모인다.
 *
 * 예외의 `message`를 봉투에 싣지 않는다 (`§1.3`) — 아래 메시지는 전부 고정 문자열이고,
 * 자격증명 값이 실릴 자리가 없다.
 */
function storeFailure(error: unknown): Failure {
  if (error instanceof IdempotencyStoreError && error.reason === 'durability_pragmas_not_applied') {
    return {
      status: 503,
      error: errorResponse(ErrorCodes.not_durable, 'the request could not be durably recorded'),
      headers: RETRY_AFTER,
    }
  }

  const primary = sqlitePrimaryCode(error)
  if (primary !== null && NOT_DURABLE_CODES.has(primary)) {
    return {
      status: 503,
      error: errorResponse(ErrorCodes.not_durable, 'the request could not be durably recorded'),
      headers: RETRY_AFTER,
    }
  }
  if (isClosedResource(error) || (primary !== null && UNAVAILABLE_CODES.has(primary))) {
    return {
      status: 503,
      error: errorResponse(ErrorCodes.unavailable, 'the backing store is not reachable'),
      headers: RETRY_AFTER,
    }
  }

  return {
    status: 500,
    error: errorResponse(ErrorCodes.internal, 'the request could not be served'),
    headers: NO_HEADERS,
  }
}

/**
 * `POST /v1/logs` (`§2.1`·`§1.4`) — `reserve` → `createLog` → `complete`.
 *
 * `reserve`의 네 판정이 이 라우트에서 갈리는 곳:
 *
 * | 판정 | 응답 | 근거 |
 * |---|---|---|
 * | `'reserved'` | 로그를 만들고 `201` | 자원을 만들어도 되는 유일한 판정 (`./idempotency.js`) |
 * | `'replay'` | 저장된 상태코드·본문 그대로 | `§1.4` MUST — 같은 상태코드, 같은 본문 |
 * | `'conflict'` | `409 idempotency_key_reused` | `§1.4` — 같은 키, 다른 본문 |
 * | `'in_progress'` | `503 unavailable` + `Retry-After` | 아래 |
 *
 * **`'in_progress'`를 `503`으로 옮긴 것은 이 조각의 판단이다** (`./idempotency.js`가 "라우트
 * 배선의 몫"으로 남긴 자리). 첫 요청이 아직 자원을 만드는 중이라 돌려줄 첫 결과가 **아직
 * 없고**, 그렇다고 자원을 새로 만들 수도 없다(그 순간 `§1.4`의 원자성 MUST가 깨진다). 그래서
 * 클라이언트에게 "지금은 답할 수 없다, 다시 오라"를 말해야 하는데, `§1.3` 표에서 그 뜻을 가진
 * 것은 `503`뿐이다. 다른 후보는 전부 거짓말이 된다 — `409 idempotency_key_reused`는 본문이
 * 같은데 다르다고 말하는 것이고, `500 internal`은 정상 경합을 서버 결함이라고 말하는 것이며,
 * 첫 요청이 끝나기를 기다렸다 응답하는 것은 이 파일에 없는 대기 정책(타임아웃·유량)을 여기서
 * 새로 정하는 것이다.
 *
 * **`complete`가 실패하면 `201`을 쓰지 않는다.** 그 시점에 로그는 이미 만들어져 있지만,
 * 저장된 응답이 없으므로 «재시도는 첫 결과 그대로»(`§1.4` MUST)를 지킬 근거가 사라진다 —
 * `201`을 쓰고 나면 같은 키의 재시도가 무엇을 돌려줘야 하는지 서버가 모른다. 실패를 그대로
 * 알리는 쪽이 fail-closed다: 그 예약은 완료되지 않은 채 남아 재시도가 `'in_progress'`로
 * 걸리므로 **로그가 둘 생기는 일은 어느 쪽으로도 없고**, 만들어진 로그는 `GET /v1/logs`로
 * 여전히 보인다.
 */
async function handleCreateLog(
  options: ControlServerOptions,
  request: Extract<ControlRequest, { route: 'createLog' }>,
  response: ResponseWriter,
): Promise<void> {
  const { subject, idempotencyKey, requestBody } = request

  let reservation
  try {
    reservation = await options.idempotency.reserve(subject, idempotencyKey, requestBody)
  } catch (error) {
    writeFailure(response, storeFailure(error))
    return
  }

  if (reservation.kind === 'replay') {
    writeRaw(response, reservation.record.status, reservation.record.body)
    return
  }
  if (reservation.kind === 'conflict') {
    writeJson(
      response,
      409,
      errorResponse(ErrorCodes.idempotency_key_reused, 'this Idempotency-Key was used with a different request body'),
    )
    return
  }
  if (reservation.kind === 'in_progress') {
    writeJson(
      response,
      503,
      errorResponse(ErrorCodes.unavailable, 'a request with this Idempotency-Key is still in progress'),
      RETRY_AFTER,
    )
    return
  }

  // `'reserved'` — 자원을 만들어도 되는 유일한 판정이다.
  let created
  try {
    created = await options.store.createLog(subject)
  } catch (error) {
    writeFailure(response, storeFailure(error))
    return
  }

  // `§2.4`: 응답 `LogRecord`에는 `logId` 외의 필드가 없다.
  const record = { status: 201, body: JSON.stringify({ logId: created.logId }) }
  try {
    await options.idempotency.complete(subject, idempotencyKey, record)
  } catch (error) {
    writeFailure(response, storeFailure(error))
    return
  }

  writeRaw(response, record.status, record.body)
}

/**
 * `GET /v1/logs` (`§2.4`) — `listLogsForSubject`가 답한 페이지를 그대로 옮긴다.
 *
 * grant 판정 → `logId` 사전순 정렬 → `limit`은 **스토어가 이미 적용했다** (`./store.js`의
 * `WHERE` → `ORDER BY` → `LIMIT`). 여기서 다시 자르거나 거르지 않는다 — 자르면 `hasMore`가
 * 거짓말이 된다(이슈 #84 완료 조건). 폐기된 로그가 목록에서 빠지는 것도 같은 이유로 이
 * 파일에 코드가 없다: 폐기는 grant 판정의 **입력**이므로(`§2.4` MUST), 판정을 통과하지 못한
 * 로그는 애초에 페이지에 실리지 않는다 — 상태 필드로 표시하지 않는다(MUST NOT).
 *
 * `cursor`는 이 페이지 마지막 항목의 `logId`다 (`§2.4`의 `ListLogsResponse` 주석 — "비면
 * 없음"). 빈 결과도 `200`이다.
 *
 * **`limit` 상한은 여기서 선다** ({@link MAX_PAGE_LIMIT}) — `./request.js`가 "서버 상한이
 * 생기면 그 판정도 다음 조각의 것"이라며 비워 둔 자리다. 게이트는 형식만 보고 값을 그대로
 * 실어 보내므로(`§1.3` 표에 이 판정을 위한 code가 없다), 상한이 없으면 스토어가 받지 못하는
 * 크기(`ControlStoreError('invalid_page_limit')`)가 그대로 올라와 **클라이언트가 문법적으로
 * 멀쩡한 요청으로 `500`을 만들 수 있다.** 깎는 것은 `§2.4`가 이미 허락한 동작이다 — 표의
 * `limit` 설명이 "서버가 더 작게 깎을 수 있다"이다. 새 값을 지어내지 않고 이 리포가 이미
 * 고른 페이지 크기(`DEFAULT_PAGE_LIMIT`)를 천장으로 재사용한다. 깎아도 `hasMore`는 여전히
 * 참이다 — 스토어가 그 값에 한 건을 더 얹어 읽어 판정하기 때문이다.
 */
async function handleListLogs(
  options: ControlServerOptions,
  request: Extract<ControlRequest, { route: 'listLogs' }>,
  response: ResponseWriter,
): Promise<void> {
  const query: { after?: string; limit?: number } = {}
  if (request.after !== undefined) {
    query.after = request.after
  }
  if (request.limit !== undefined) {
    query.limit = Math.min(request.limit, MAX_PAGE_LIMIT)
  }

  let page
  try {
    page = await options.store.listLogsForSubject(request.subject, query)
  } catch (error) {
    writeFailure(response, storeFailure(error))
    return
  }

  const logs = page.logs.map((log) => ({ logId: log.logId }))
  const cursor = logs.at(-1)?.logId
  writeJson(response, 200, {
    logs,
    ...(cursor === undefined ? {} : { cursor }),
    hasMore: page.hasMore,
  })
}

/**
 * `GET /v1/logs/{logId}` (`§2.4`) — grant 판정을 통과하면 `200 { logId }`, 아니면
 * `404 log_not_found`.
 *
 * **존재 여부를 묻지 않는다.** 이 핸들러가 스토어에 던지는 질문은 `isGranted` 하나뿐이므로,
 * 없는 로그와 이 주체에게 보이지 않는 로그의 응답이 **바이트 단위로 같다** — 두 경우를 가르는
 * 분기가 코드에 없다는 것이 그 보장이다(열거 오라클 금지, `§2.4`). 그래서 아래 `404`의
 * 메시지는 고정 문자열이고 `details`가 없다.
 */
async function handleGetLog(
  options: ControlServerOptions,
  request: Extract<ControlRequest, { route: 'getLog' }>,
  response: ResponseWriter,
): Promise<void> {
  let granted
  try {
    granted = await options.store.isGranted(request.subject, request.logId)
  } catch (error) {
    writeFailure(response, storeFailure(error))
    return
  }

  if (!granted) {
    writeJson(response, 404, errorResponse(ErrorCodes.log_not_found, 'log not found'))
    return
  }
  writeJson(response, 200, { logId: request.logId })
}

/**
 * 게이트 → 라우트. 본문을 **`POST`일 때만** 읽는 것은 전송 평면과 같은 규율이다(GET 라우트는
 * 본문을 쓰지 않는다). 이 분기는 라우트 판별이 아니다 — 경로·메서드·문법의 판정은 그 아래
 * {@link verifyControlRequest}가 처음부터 다시 전부 한다.
 */
async function handleRequest(
  request: ServerRequest,
  response: ResponseWriter,
  options: ControlServerOptions,
): Promise<void> {
  const body = request.method === 'POST' ? await readBody(request) : ''

  let gate
  try {
    gate = await verifyControlRequest(toRawRequest(request), body, options.credentials)
  } catch (error) {
    // 게이트가 던지는 유일한 자리는 자격증명 **조회**다 (`§1.1` — 제어 평면의 자격 판정은
    // 순수 계산이 아니라 스토어 조회다). 그래서 스토어 실패와 같은 표로 옮긴다.
    writeFailure(response, storeFailure(error))
    return
  }

  if (!gate.ok) {
    writeJson(response, gate.status, gate.error, gate.headers)
    return
  }

  switch (gate.request.route) {
    case 'createLog':
      await handleCreateLog(options, gate.request, response)
      return
    case 'listLogs':
      await handleListLogs(options, gate.request, response)
      return
    case 'getLog':
      await handleGetLog(options, gate.request, response)
      return
  }
}

/**
 * 제어 평면 HTTP 서버를 만든다.
 *
 * **`listen`은 부르는 쪽이 한다** — 이 모듈은 프로세스를 모른다(포트도, env도). 한 프로세스가
 * 두 평면을 두 포트로 띄우든 두 프로세스로 가르든 이 함수의 코드는 0줄 바뀐다(`./index.js`
 * 머리말과 같은 규율).
 */
export function createControlServer(options: ControlServerOptions): Server {
  return createServer((request, response) => {
    handleRequest(request, response, options).catch(() => {
      // 여기 닿는 것은 라우트 핸들러 **밖**의 예외뿐이다 — 요청 스트림 오류처럼 게이트도
      // 스토어도 아닌 자리. 스토어·게이트의 실패는 위에서 이미 응답으로 끝났다. 이미 끝난
      // 응답에 다시 쓰지 않는다.
      if (!response.writableEnded) {
        writeJson(response, 500, errorResponse(ErrorCodes.internal, 'the request could not be served'))
      }
    })
  })
}
