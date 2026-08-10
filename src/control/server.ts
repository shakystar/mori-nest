/**
 * 제어 평면 라우트 배선 + 최소 HTTP 서버 (`node:http`, 빌트인). 런타임 의존성 0을 유지한다
 * (`0002 §4.1-3`).
 *
 * `POST /v1/logs`(`0003 §2.1`) · `GET /v1/logs`·`GET /v1/logs/{logId}`(`§2.4`) ·
 * `POST /v1/logs/{logId}/revoke`(`§2.6`) · `POST /v1/workspaces`(`§4.2`) ·
 * `POST /v1/workspaces/{workspaceId}/heartbeat`(`§4.3`) ·
 * `POST /v1/workspaces/{workspaceId}/close`(`§4.4`) ·
 * `POST /v1/workspaces/{workspaceId}/revoke`(`§4.5`) ·
 * `GET /v1/workspaces`·`GET /v1/workspaces/{workspaceId}`(`§4.6`, mori-nest #115) 열을 배선한다 —
 * `§0` 표의 여덟 행이 이제 전부 응답한다.
 *
 * **판정은 이 파일에 없다** — 자격 게이트·라우트 판별·본문/쿼리 검사는 `./request.js`의
 * {@link verifyControlRequest}가 이미 끝냈고(mori-nest #83 · #93 · #102), 여기서는 그 산출물을
 * 스토어 호출로 잇는다. 페이지네이션도 마찬가지다: 판정 → 정렬 → `limit` 적용과 `hasMore` 판정은
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
 * 개시 라우트(`§4.2`)가 그 위에 얹히면서 이 파일은 **토큰을 발급하는 첫 배선**이 됐다
 * (mori-nest #103). 세 계층이 한 응답 안에서 순서를 지켜야 하는 자리라 그 순서를
 * {@link handleOpenWorkspace}의 doc이 따로 적는다: 멱등 예약(`§1.4`) → grant fail-closed
 * (`§3.6`) → 상태 판정과 발급의 원자성(`§4.1`·`§4.2`).
 *
 * 하트비트(`§4.3`, mori-nest #113)가 그 위에 **갱신**을 얹는다. 발급 경로는 여전히 하나이고
 * ({@link issueToken}), 갈리는 것은 스코프의 출처다: 개시는 요청한 `logs`를 그대로 싣지만
 * 갱신은 **개시 시 스코프를 다시 판정해 좁힌 결과**를 싣는다 (`§3.4` MUST). 그 순서가 왜
 * 재판정 → 전이인지는 {@link handleHeartbeatWorkspace}의 doc이 적는다.
 *
 * **`§3.8`**: 토큰 문자열이 남는 곳은 개시·갱신의 응답 본문뿐이다 — 로그도 에러 봉투도 멱등
 * 저장분도 그것을 싣지 않는다(멱등 저장분이 무엇을 담는지는
 * {@link OpenWorkspaceReservation} doc).
 *
 * 종료(`§4.4`)·폐기(`§4.5`, mori-nest #114)는 발급 경로에 얹지 않는다 — 종단 전이라 새 토큰이
 * 나가지 않는다. 대신 **멱등을 새로 구현하지 않는다**: `WorkspaceStore.closeWorkspace`·
 * `revokeWorkspace`가 이미 갖고 있는 성질(같은 `outcome`으로 다시 닫으면 첫 `endedAt`이 그대로
 * 다시 나온다)을 {@link handleCloseWorkspace}·{@link handleRevokeWorkspace}가 응답으로 그대로
 * 흘려보내고, 실패 매핑은 {@link handleHeartbeatWorkspace}가 세운 것과 같은 모양을 재사용한다
 * ({@link writeWorkspaceTransitionFailure}).
 *
 * ## 이 조각의 비범위 (mori-nest #84 · #93 · #103 · #112 · #113 · #114 · #115 이슈 본문)
 *
 * 유량 제한(`429`)·본문 크기 한도(`413`)·SSE, 폐기 사유(`reason`)의 저장.
 * 특히 **본문 크기 한도가 없다는 것은 {@link readBody}가 상한 없이 읽는다는
 * 뜻이다** — 전송 평면의 `maxRequestBytes`(`0002 §1.3` L103)에 해당하는 자리가 이 평면에는
 * 아직 배선되지 않았다(`0003 §1.3` 표에 `413 request_too_large`가 있으므로 자리는 열려 있고,
 * 값을 정하는 것은 이 조각이 아니다). 그 라우트를 여는 다음 조각이 이 함수에 상한을 준다.
 *
 * `§4.10` 포크 감지·재발급 지시(하트비트 **응답**의 `forkAdvisory`)는 mori-nest #117(판정,
 * 스토어 단위)이 이미 세웠고, {@link handleHeartbeatWorkspace}가 `heartbeat` 성공 뒤에
 * `WorkspaceStore.findForkAdvisory`를 불러 배선한다(mori-nest #118).
 *
 * 진단 훅(`src/transport/server.ts`의 `onDiagnostic`과 같은 모양, `ControlServerOptions.onDiagnostic`)이
 * 이 평면에도 있다(mori-nest #126, PR #125 후속) — 하지만 아직 배선된 자리는
 * {@link handleHeartbeatWorkspace}의 `forkAdvisory` 판정 실패 하나뿐이다
 * ({@link ControlDiagnosticSite}). 나머지 `catch`들이 삼킨 예외는 여전히 상태코드 말고는 아무
 * 흔적을 남기지 않는다 — 그 자리들에 훅을 태우는 것은 이 조각이 아니라 그 자리가 실제로
 * 필요해진 조각이 한다(전송 평면 doc의 증분 확장 규율, 「리포 전역 관례」 문단). 예외 `message`를
 * 봉투에 싣지 않는 규율(`§1.3`)은 그것과 무관하게 지킨다: 아래에서 쓰는 메시지는 전부 고정
 * 문자열이다. `forkAdvisory` 판정 실패가 첫 자리로 뽑힌 이유는 상태코드에조차 흔적을 남기지
 * 않기 때문이다(`200`을 그대로 쓴다, `§4.10` MUST NOT) — 훅을 주입하지 않은 배포에서는 여전히
 * 아무 흔적도 남지 않는다(no-op 기본값, {@link diagnosticSink}).
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
import { ControlDatabaseError } from './db.js'
import type { IdempotencyStore } from './idempotency.js'
// **타입 전용 import다** — 런타임 그래프에는 이 간선이 없다(`verbatimModuleSyntax`가 지운다).
// 설정 스키마의 집이 `./index.js` 하나라는 것이 이 평면의 규율이라(그 파일 머리말), 그 모양을
// 여기에 다시 적는 대신 이름으로 가리킨다.
import type { ControlConfig } from './index.js'
import { verifyControlRequest, type ControlRequest, type RawRequest } from './request.js'
import { ControlStoreError, DEFAULT_PAGE_LIMIT, type ControlStore } from './store.js'
import { issueWorkspaceToken, mintTokenId } from './token.js'
import { WorkspaceStoreError, type ForkOverlap, type WorkspaceStore } from './workspace-store.js'

/**
 * `GET /v1/logs`의 `limit` 천장 ({@link handleListLogs} doc). 스토어가 `limit` 없이 쓰는
 * 페이지 크기를 그대로 재사용한다 — 이 자리에 새 숫자를 지어내지 않는다.
 */
const MAX_PAGE_LIMIT = DEFAULT_PAGE_LIMIT

/**
 * `GET /v1/workspaces`의 `limit` 천장 ({@link handleListWorkspaces} doc). `MAX_PAGE_LIMIT`과
 * 같은 값이지만 축이 다른 자원(로그 대 작업공간)의 천장이므로 별도 상수로 옮겨 적는다 —
 * `WORKSPACE_REVOKE_SUFFIX`가 `./request.js`의 `REVOKE_SUFFIX`와 같은 이유로 분리된 것과 같다.
 */
const MAX_WORKSPACE_PAGE_LIMIT = DEFAULT_PAGE_LIMIT

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

/**
 * 진단 훅이 배선된 자리 (`src/transport/server.ts`의 {@link TransportDiagnosticSite}와 같은
 * 역할). **이 조각은 `'fork_advisory'` 하나만 연다** — 나머지 `catch`는 파일 상단 doc이 적은
 * 대로 아직 이 훅을 타지 않는다. 새 자리를 열 때는 전송 평면과 같은 규율을 따른다: 이 자리에
 * 이름을 하나 더하고 그 자리에서 `emit`을 부른다.
 */
export type ControlDiagnosticSite = 'fork_advisory'

/**
 * 진단 훅이 받는 사건 하나. `src/transport/server.ts`의 {@link TransportDiagnostic}과 같은
 * 모양이다 — 와이어에 나가는 값이 아니다.
 */
export type ControlDiagnostic = {
  /** 결함을 고정 문자열로 덮은 자리. */
  readonly site: ControlDiagnosticSite
  /** 삼킨 예외 원문. `Error`라는 보장은 없다 — 던지는 쪽이 무엇이든 던질 수 있다. */
  readonly error: unknown
}

export type ControlServerOptions = {
  /** `logId` mint와 (주체, 로그) 관계 (`./store.js`, #72). */
  readonly store: ControlStore
  /** `Idempotency-Key` 예약·재생·충돌 판정 (`./idempotency.js`, #73). */
  readonly idempotency: IdempotencyStore
  /** 런처 자격증명 조회 (`./credential.js`, #74). 게이트가 `verify`만 쓴다. */
  readonly credentials: LauncherCredentialStore
  /** 작업공간 생애 추적 (`./workspace-store.js`, #97·#98). */
  readonly workspaces: WorkspaceStore
  /**
   * `parseControlConfig`(`./index.js`)를 통과한 설정. **선택 필드가 아니다** — 발급
   * 파라미터가 없는 채로 뜬 서버는 `POST /v1/workspaces`에 답할 수 없고, 그 사실이
   * 첫 요청까지 미뤄지면 `§3.4` 강제를 파싱 시점에 둔 이유가 사라진다.
   */
  readonly config: ControlConfig
  /**
   * 삼킨 예외 하나를 배포의 진단 평면으로 넘기는 훅 (`src/transport/server.ts`의
   * `TransportServerOptions.onDiagnostic`과 같은 규율). 부재면 no-op이다 — **부재가 곧 지금까지의
   * 동작**이고, 주입해도 응답 봉투는 한 글자도 바뀌지 않는다.
   *
   * 이 훅은 응답을 쓰기 전에, 동기로 불린다. **던져도 된다** — 이 파일이 그 예외를 받아 삼키고
   * 응답 경로를 그대로 이어간다 ({@link diagnosticSink}). 진단 실패가 요청 실패로 번지지 않는다.
   */
  readonly onDiagnostic?: (diagnostic: ControlDiagnostic) => void
}

/** 삼킨 예외 하나를 진단 훅으로 넘긴다. 주입이 없으면 아무것도 하지 않는다. */
type DiagnosticSink = (diagnostic: ControlDiagnostic) => void

/**
 * 주입된 훅을 {@link DiagnosticSink}로 감싼다. `src/transport/server.ts`의 동명 함수와 같은
 * 이유 하나뿐이다: **훅이 던져도 요청 경로가 그것 때문에 무너지지 않아야 한다.**
 */
function diagnosticSink(hook: ((diagnostic: ControlDiagnostic) => void) | undefined): DiagnosticSink {
  if (hook === undefined) {
    return () => {
      // no-op — 주입하지 않은 배포의 동작은 이 이슈 이전과 같다.
    }
  }
  return (diagnostic) => {
    try {
      hook(diagnostic)
    } catch {
      // 진단 실패가 요청 실패로 번지지 않는다 (위 doc).
    }
  }
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
 *   ({@link NOT_DURABLE_CODES}), 그리고 제어 평면 DB가 내구성 PRAGMA를 걸지 못한 경우
 *   (그 사유를 내는 자리가 멱등 저장소에서 `./db.ts`로 옮겨갔다 — mori-nest #130. 문자열도
 *   상태코드도 그대로다).
 * - **`503 unavailable`** — 셧다운 중이거나 저장소에 닿을 수 없다 ({@link UNAVAILABLE_CODES},
 *   닫힌 핸들).
 * - **`500 internal`** — 그 외 전부. 제약 위반·행 모양 이상·mint 고갈처럼 **서버 쪽 결함**이라
 *   재시도가 답이 아닌 것들이 여기로 모인다.
 *
 * 예외의 `message`를 봉투에 싣지 않는다 (`§1.3`) — 아래 메시지는 전부 고정 문자열이고,
 * 자격증명 값이 실릴 자리가 없다.
 */
function storeFailure(error: unknown): Failure {
  if (error instanceof ControlDatabaseError && error.reason === 'durability_pragmas_not_applied') {
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
 * `POST /v1/logs/{logId}/revoke` (`§2.6`) — `store.revoke`가 폐기 이전의 자격만 보고 판정한다
 * (`log_subjects` 관계 행이 있었는가). 관계가 없으면 `ControlStoreError('log_not_found')`를
 * 던지고, 이 핸들러가 그것을 `404`로 옮긴다 — 없는 로그와 이 주체가 애초에 grant받지 못한
 * 로그를 구분하지 않는다({@link handleGetLog}와 같은 열거 오라클 금지).
 *
 * **`§2.6` MUST**: 이미 `revoked`인 로그에 대한 재폐기가 바이트 단위로 같은 `200`이다.
 * `store.revoke`가 `COALESCE`로 첫 폐기 시각을 그대로 돌려주므로(`./store.js`), 이 핸들러가
 * 매번 같은 필드 순서로 짓는 것 외에는 아무것도 하지 않아도 그 성질이 유지된다.
 *
 * `reason`은 게이트(`./request.js`)가 형식만 봤다 — 이 핸들러도 저장도 응답도 하지 않는다
 * (`§2.6`의 응답 타입에 자리가 없다, 이슈 #93 비범위).
 */
async function handleRevokeLog(
  options: ControlServerOptions,
  request: Extract<ControlRequest, { route: 'revokeLog' }>,
  response: ResponseWriter,
): Promise<void> {
  let revoked
  try {
    revoked = await options.store.revoke(request.subject, request.logId)
  } catch (error) {
    if (error instanceof ControlStoreError && error.reason === 'log_not_found') {
      writeJson(response, 404, errorResponse(ErrorCodes.log_not_found, 'log not found'))
      return
    }
    writeFailure(response, storeFailure(error))
    return
  }
  writeJson(response, 200, { logId: request.logId, state: 'revoked', revokedAt: revoked.revokedAt })
}

/**
 * 멱등 레코드에 저장하는 것 — **응답 본문이 아니라 재구성에 필요한 둘뿐이다.**
 *
 * `handleCreateLog`는 첫 응답의 바이트를 그대로 저장해 그대로 재생하지만(`§1.4` MUST),
 * 이 라우트는 그럴 수 없다: `§4.2` MUST가 재시도에 **새 토큰**을 요구하므로
 * (`token`·`tokenId`·`expiresAt`이 첫 응답과 달라야 한다) 저장분을 되쓰면 그 셋이 첫 값으로
 * 굳는다 — 그리고 토큰 문자열을 저장하는 것 자체가 `§3.8` MUST NOT이다. 그래서 저장하는
 * 것은 «어느 작업공간에·어떤 스코프로» 둘이고, 나머지는 재시도 때 다시 짓는다.
 */
type OpenWorkspaceReservation = {
  readonly workspaceId: string
  readonly scope: readonly string[]
}

/** `§3.2` 클레임 표: 이 버전에서 `audience`는 리터럴 `transport` 고정 (`§1.1`·`§3.7`). */
const TOKEN_AUDIENCE = 'transport'

const MS_PER_SECOND = 1000

/**
 * `gracePeriodSeconds → ms` 환산 — 이 리포에서 **이 함수 하나뿐**이다 (`./index.js`의
 * `gracePeriodSeconds` doc). 조회(`getWorkspace`)와 전이 셋(`heartbeat`·`closeWorkspace`·
 * `revokeWorkspace`)이 같은 값을 봐야 유기 판정이 갈리지 않는다 — 호출마다 `× 1000`을 다시
 * 적으면 그 값이 갈릴 여지가 생긴다.
 */
function resolveGracePeriodMs(config: ControlConfig): number {
  return config.gracePeriodSeconds * MS_PER_SECOND
}

/**
 * `§3.2`의 고정 20바이트 `YYYY-MM-DDTHH:MM:SSZ`.
 *
 * 초 미만을 **버린다**. 발급자(`./token.js`)는 그 자리를 가진 문자열을 아예 거부하므로
 * (`timestamp_not_canonical`) 여기서 자르지 않으면 정상 요청이 `500`이 된다.
 */
function rfc3339Seconds(time: Date): string {
  return `${time.toISOString().slice(0, 19)}Z`
}

/** 발급 결과 — 재시도마다 새로 나는 세 값이다 (`§4.2` MUST). */
type IssuedToken = {
  readonly token: string
  readonly tokenId: string
  readonly expiresAt: string
}

/**
 * 작업공간 하나에 대한 토큰을 발급한다 (`§3.2`·`§3.4`).
 *
 * `issuedAt`을 **초로 내린 뒤에** `tokenTtl`을 더한다 — `now`를 그대로 더하고 나중에 자르면
 * 초 미만이 잘리는 방향 때문에 실제 수명이 `tokenTtl`보다 최대 1초 길어지고, 그 1초는
 * `§3.4`가 상한으로 못박은 값을 넘는 구간이다.
 *
 * `§3.4`의 네 제약은 여기서 다시 보지 않는다 — `parseControlConfig`가 파싱 시점에 이미
 * 강제했고, 판정을 두 곳에 두면 갈린다.
 */
function issueToken(config: ControlConfig, workspaceId: string, scope: readonly string[]): IssuedToken {
  const issuedAtMs = Math.floor(Date.now() / MS_PER_SECOND) * MS_PER_SECOND
  const issuedAt = rfc3339Seconds(new Date(issuedAtMs))
  const expiresAt = rfc3339Seconds(new Date(issuedAtMs + config.tokenTtlSeconds * MS_PER_SECOND))
  const tokenId = mintTokenId()

  const token = issueWorkspaceToken({
    signingKey: config.signingKey,
    keyId: config.keyId,
    claims: { tokenId, workspaceId, audience: TOKEN_AUDIENCE, issuedAt, expiresAt, scope },
  })
  return { token, tokenId, expiresAt }
}

/** `§4.2`의 `OpenWorkspaceResponse` 여섯 필드. 첫 응답과 재시도가 같은 함수로 지어진다. */
function writeOpenWorkspace(
  response: ResponseWriter,
  config: ControlConfig,
  reservation: OpenWorkspaceReservation,
  issued: IssuedToken,
): void {
  writeJson(response, 201, {
    workspaceId: reservation.workspaceId,
    token: issued.token,
    tokenId: issued.tokenId,
    scope: reservation.scope,
    expiresAt: issued.expiresAt,
    heartbeatIntervalSeconds: config.heartbeatIntervalSeconds,
  })
}

/** 저장분을 되읽는다. 이 서버가 쓴 바이트이므로 모양이 어긋나면 서버 결함이다(`500`). */
function readReservation(body: string): OpenWorkspaceReservation {
  const parsed: unknown = JSON.parse(body)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new TypeError('stored idempotency record is not an object')
  }
  const { workspaceId, scope } = parsed as Record<string, unknown>
  if (typeof workspaceId !== 'string' || !Array.isArray(scope) || !scope.every((log) => typeof log === 'string')) {
    throw new TypeError('stored idempotency record does not carry a workspace reservation')
  }
  return { workspaceId, scope: scope as readonly string[] }
}

/**
 * 멱등 재시도 경로 (`§4.2`·`§1.4`) — **저장분을 그대로 되쓰지 않는다** (위
 * {@link OpenWorkspaceReservation} doc).
 *
 * **발급은 언제나 상태 판정을 통과한다** (`§4.2` MUST). 그래서 새 토큰을 짓기 전에
 * `getWorkspace`로 조회 시각 기준의 상태를 다시 묻는다 — 그 작업공간이 종단 상태(`§4.1`의
 * `active` 아닌 넷)면 첫 결과를 돌려주지 않고 `409 workspace_not_active`다. 이 거부가 없으면
 * 폐기된 작업공간에 `tokenTtl`짜리 새 토큰이 나가고, `§3.5`가 약속한 수렴 시간 ≤ `tokenTtl`이
 * 이 경로에서 성립하지 않는다.
 *
 * `abandoned`도 종단이고, 그것은 **저장된 값이 아니라 조회 시각에 계산되는 값**이다(#97) —
 * `gracePeriod`가 설정으로 오는 이유가 이것이다. 초→ms 환산은 {@link resolveGracePeriodMs}
 * 하나로 모여 있다 (`./index.js`의 `gracePeriodSeconds` doc).
 *
 * 조회가 비면(`undefined`) `404 workspace_not_found`다 — 저장분이 가리키는 작업공간이 이
 * 주체에게 더는 보이지 않는다는 뜻이고, 다른 라우트가 같은 상황에 내는 코드가 그것이다.
 */
async function replayOpenWorkspace(
  options: ControlServerOptions,
  subject: string,
  record: { readonly body: string },
  response: ResponseWriter,
): Promise<void> {
  let reservation: OpenWorkspaceReservation
  let workspace
  try {
    reservation = readReservation(record.body)
    workspace = await options.workspaces.getWorkspace(subject, reservation.workspaceId, {
      gracePeriodMs: resolveGracePeriodMs(options.config),
    })
  } catch (error) {
    writeFailure(response, storeFailure(error))
    return
  }

  if (workspace === undefined) {
    writeJson(response, 404, errorResponse(ErrorCodes.workspace_not_found, 'workspace not found'))
    return
  }
  if (workspace.state !== 'active') {
    // `details`의 둘은 `§4.2` MUST다. 열거 오라클이 아니다 — 같은 주체가 자기 멱등성 키로
    // 자기가 만든 자원을 되묻는 것이고, 이것이 없으면 응답을 잃은 런처가 `supersedes`로
    // 이어붙일 대상을 알 수 없다 (`§4.7`).
    writeJson(
      response,
      409,
      errorResponse(ErrorCodes.workspace_not_active, 'this workspace is no longer active', {
        workspaceId: reservation.workspaceId,
        state: workspace.state,
      }),
    )
    return
  }

  let issued: IssuedToken
  try {
    issued = issueToken(options.config, reservation.workspaceId, reservation.scope)
  } catch (error) {
    writeFailure(response, storeFailure(error))
    return
  }
  writeOpenWorkspace(response, options.config, reservation, issued)
}

/**
 * `POST /v1/workspaces` (`§4.2`) — 멱등 예약(`§1.4`) → grant 판정(`§3.6`) → 개시 → 발급 → `201`.
 *
 * 이 순서가 계약이다. `handleCreateLog`가 세운 «계층이 핸들러를 감싸지 않고 핸들러가 계층을
 * 부른다»를 그대로 따르고, 갈리는 것은 저장분과 재시도 경로 둘이다(위 두 doc).
 *
 * ## grant 판정은 all-or-nothing이다 (`§3.6` MUST)
 *
 * 요청한 로그 중 **하나라도** 이 주체가 grant할 수 없으면 전부 거부다 —
 * `403 not_grantable`, **작업공간은 만들어지지 않는다.** 첫 하나에서 멈추지 않고 전부 모아
 * `details.logIds`에 싣는 것은 클라이언트가 한 번에 고칠 수 있게 하기 위해서다.
 *
 * **폐기된 로그를 위한 분기가 여기 없다** (`§3.6` MUST NOT의 짝). 폐기는 `isGranted`의
 * **입력**이므로(#92), 폐기된 로그는 이 루프에서 자연히 거부 목록에 든다.
 *
 * 판정이 예약보다 **뒤**인 것은 `§1.4`가 «키 기록과 자원 생성이 원자적»을 요구하기 때문이다
 * (이슈 #103 작업 범위 2의 순서). 그래서 `403`으로 끝난 예약은 완료되지 않은 채 남고, 같은
 * 키·같은 본문의 재시도는 `'in_progress'`로 걸린다 — 스코프를 고쳐 다시 오는 요청은 본문이
 * 달라졌으므로 `409 idempotency_key_reused`이고, **어느 쪽도 작업공간을 만들지 않는다.**
 */
async function handleOpenWorkspace(
  options: ControlServerOptions,
  request: Extract<ControlRequest, { route: 'openWorkspace' }>,
  response: ResponseWriter,
): Promise<void> {
  const { subject, idempotencyKey, requestBody, logs } = request

  let reservation
  try {
    reservation = await options.idempotency.reserve(subject, idempotencyKey, requestBody)
  } catch (error) {
    writeFailure(response, storeFailure(error))
    return
  }

  if (reservation.kind === 'replay') {
    await replayOpenWorkspace(options, subject, reservation.record, response)
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
    // `handleCreateLog`와 같은 판단이고 근거도 같다 (그 doc의 표).
    writeJson(
      response,
      503,
      errorResponse(ErrorCodes.unavailable, 'a request with this Idempotency-Key is still in progress'),
      RETRY_AFTER,
    )
    return
  }

  // `'reserved'` — 자원을 만들어도 되는 유일한 판정이다.
  let rejected: string[]
  try {
    const granted = await Promise.all(logs.map((logId) => options.store.isGranted(subject, logId)))
    rejected = logs.filter((_, index) => granted[index] !== true)
  } catch (error) {
    writeFailure(response, storeFailure(error))
    return
  }
  if (rejected.length > 0) {
    writeJson(
      response,
      403,
      errorResponse(ErrorCodes.not_grantable, 'the requested scope contains logs this subject cannot grant', {
        logIds: rejected,
      }),
    )
    return
  }

  let opened
  try {
    opened = await options.workspaces.openWorkspace(subject, {
      logs,
      ...(request.supersedes === undefined ? {} : { supersedes: request.supersedes }),
      ...(request.replicaId === undefined ? {} : { replicaId: request.replicaId }),
    })
  } catch (error) {
    if (error instanceof WorkspaceStoreError && error.reason === 'workspace_not_found') {
      // `supersedes`가 없는 id이거나 다른 주체의 것이다 (`§4.2` MUST). 스토어가 이미 그
      // 판정에서 개시를 롤백했으므로 작업공간은 만들어지지 않았다.
      writeJson(response, 404, errorResponse(ErrorCodes.workspace_not_found, 'workspace not found'))
      return
    }
    writeFailure(response, storeFailure(error))
    return
  }

  // `scope`는 요청한 `logs` 그대로다 — 서버가 넓히지도 조용히 좁히지도 않는다 (`§3.6` MUST).
  const stored: OpenWorkspaceReservation = { workspaceId: opened.workspaceId, scope: logs }

  let issued: IssuedToken
  try {
    issued = issueToken(options.config, stored.workspaceId, stored.scope)
  } catch (error) {
    writeFailure(response, storeFailure(error))
    return
  }

  try {
    // `handleCreateLog`와 같은 이유로 응답보다 **먼저** 완료를 기록한다. 저장되는 바이트에
    // 토큰이 없다는 것이 `§3.8`이 걸리는 자리다.
    await options.idempotency.complete(subject, idempotencyKey, { status: 201, body: JSON.stringify(stored) })
  } catch (error) {
    writeFailure(response, storeFailure(error))
    return
  }

  writeOpenWorkspace(response, options.config, stored, issued)
}

/**
 * `POST /v1/workspaces/{workspaceId}/heartbeat` (`§4.3`) — 조회 → 스코프 재판정 → 전이 →
 * 토큰 갱신 → 포크 advisory(`§4.10`) → `200`.
 *
 * ## 포크 advisory는 전이 뒤, 응답 쓰기 직전이다 (`§4.10`, mori-nest #118)
 *
 * `heartbeat`가 성공한 **뒤에만** `WorkspaceStore.findForkAdvisory`를 부른다 — 그 전에 부르면
 * 유기를 확정하는 호출(`workspace_not_active`로 이미 끝난)에도 판정을 시도하게 된다. 결과가
 * 있으면 응답에 `forkAdvisory`를 얹지만 **그 존재가 상태코드도, 다른 필드도 바꾸지 않는다**
 * (MUST) — advisory가 요청의 성패를 바꾸면 그 순간 advisory가 아니라 강제다. 같은 이유로
 * 판정이 던져도 `catch`가 `200`을 그대로 쓴다 (MUST NOT, 아래 `catch` 참고). 자세한 이유·버린
 * 후보는 `0003-control-plane-spec.md` §4.10 "재발급 지시가 실리는 자리"가 표로 적어 뒀다.
 *
 * ## 재판정은 좁힌다 — 개시의 all-or-nothing이 여기 오지 않는다 (`§3.4` MUST)
 *
 * 갱신 시점에 grant 자격을 다시 판정하되, 자격을 잃은 로그는 **스코프에서 빠지고 빠진 결과가
 * 응답 `scope`에 그대로 실린다.** 전부 거부하면 아직 자격이 남은 로그로의 flush 경로까지
 * 끊기고, 미flush 기억을 잃는 쪽이 더 나쁘다. **응답이 실제 스코프를 말하지 않으면 그게 조용한
 * 좁힘이다.** 재판정 결과가 전부 비면 갱신하지 않고 `403 not_grantable`이다 (MUST) — 스코프가
 * 빈 토큰을 만들 수 있는 경로는 존재하지 않는다 (`§3.6`).
 *
 * **폐기된 로그를 위한 분기가 여기 없다** (`§3.4` MUST NOT). 폐기는 `isGranted`의 **입력**이므로
 * (#92) 이 재판정이 그대로 처리한다 — {@link handleOpenWorkspace}가 같은 이유로 두지 않은 분기다.
 *
 * ## 재판정의 입력은 개시 시 스코프이고, 좁아진 결과는 저장하지 않는다
 *
 * 토큰에 실렸던 스코프를 서버가 보관하지 않으므로(`§3.8`), 입력은 `WorkspaceRecord.logs`
 * (개시 시 스코프, `§4.6`)다. 좁아진 결과를 되쓰지 않는 것은 스토어에 그 자리가 없어서만이
 * 아니다 — `§4.6`이 *"갱신으로 좁아진 현재 스코프는 조회에 싣지 않는다"*로 이미 답했다.
 * **매 갱신이 개시 시 스코프를 다시 판정한다.**
 *
 * ## `403`은 전이를 남기지 않는다 — 그래서 재판정이 전이보다 먼저다
 *
 * 뒤집으면 자격을 전부 잃은 런처가 하트비트를 보낼 때마다 `lastHeartbeatAt`이 앞으로 가고,
 * 그 작업공간은 **토큰도 못 받으면서 영영 `abandoned`가 되지 않는다** — `§4.7`이 보이게 하려던
 * «flush 없이 죽은 작업공간»이 정확히 그 자리에서 안 보이게 된다.
 *
 * 대가는 상태 판정이 두 번 일어난다는 것이다(`getWorkspace`의 조회 시각 판정 + `heartbeat`의
 * 원자적 판정). **원본은 `heartbeat`다** — 그 사이 작업공간이 종단으로 갔으면 `heartbeat`가
 * `workspace_not_active`를 던지고 그것이 `409`가 된다. 아래 `getWorkspace`의 판정은 재판정
 * 대상(`logs`)을 얻기 위한 읽기이지 게이트가 아니다.
 */
async function handleHeartbeatWorkspace(
  options: ControlServerOptions,
  request: Extract<ControlRequest, { route: 'heartbeatWorkspace' }>,
  response: ResponseWriter,
  emit: DiagnosticSink,
): Promise<void> {
  const { subject, workspaceId } = request
  const gracePeriodMs = resolveGracePeriodMs(options.config)

  let workspace
  try {
    workspace = await options.workspaces.getWorkspace(subject, workspaceId, { gracePeriodMs })
  } catch (error) {
    writeFailure(response, storeFailure(error))
    return
  }
  if (workspace === undefined) {
    writeJson(response, 404, errorResponse(ErrorCodes.workspace_not_found, 'workspace not found'))
    return
  }
  if (workspace.state !== 'active') {
    writeJson(response, 409, errorResponse(ErrorCodes.workspace_not_active, 'this workspace is no longer active'))
    return
  }

  let scope: readonly string[]
  let dropped: string[]
  try {
    const granted = await Promise.all(workspace.logs.map((logId) => options.store.isGranted(subject, logId)))
    // 순서 보존 — 좁아진 스코프도 개시 시 스코프의 부분열이다.
    scope = workspace.logs.filter((_, index) => granted[index] === true)
    dropped = workspace.logs.filter((_, index) => granted[index] !== true)
  } catch (error) {
    writeFailure(response, storeFailure(error))
    return
  }
  if (scope.length === 0) {
    // 여기서 끝난다 — `heartbeat`를 부르지 않으므로 `lastHeartbeatAt`이 옮겨지지 않는다(위 doc).
    // `details.logIds`의 모양은 `§4.2` 개시의 `403`과 같다: 빠진 로그를 **전부** 싣는다.
    writeJson(
      response,
      403,
      errorResponse(ErrorCodes.not_grantable, 'the requested scope contains logs this subject cannot grant', {
        logIds: dropped,
      }),
    )
    return
  }

  let beat
  try {
    beat = await options.workspaces.heartbeat(subject, workspaceId, { gracePeriodMs })
  } catch (error) {
    if (error instanceof WorkspaceStoreError && error.reason === 'workspace_not_found') {
      writeJson(response, 404, errorResponse(ErrorCodes.workspace_not_found, 'workspace not found'))
      return
    }
    if (error instanceof WorkspaceStoreError && error.reason === 'workspace_not_active') {
      // 위 `getWorkspace`가 `active`를 봤어도 여기 닿을 수 있다 — 그 사이 종단으로 갔거나
      // 이 호출이 유기를 확정한 경우다. 새 매핑을 만들지 않는다: 조회 경로와 같은 `409`다.
      writeJson(response, 409, errorResponse(ErrorCodes.workspace_not_active, 'this workspace is no longer active'))
      return
    }
    writeFailure(response, storeFailure(error))
    return
  }

  let issued: IssuedToken
  try {
    // 발급 경로는 하나다 — `§4.2`가 세운 {@link issueToken}을 그대로 쓴다. 좁아진 `scope`가
    // 토큰의 클레임과 응답에 **같이** 실려야 클라이언트가 토큰을 파싱하지 않고도 실제 권한을 안다.
    issued = issueToken(options.config, workspaceId, scope)
  } catch (error) {
    writeFailure(response, storeFailure(error))
    return
  }

  // 포크 advisory (`§4.10`, mori-nest #117·#118) — `heartbeat` 성공 **뒤**에만 부른다: 그 전엔
  // 유기가 확정되는 호출(§4.1)일 수 있고 그러면 `workspace_not_active`로 이미 끝나 판정할
  // 대상이 없다. **던져도 하트비트는 그대로 `200`이다** (MUST NOT — advisory가 갱신 경로를
  // 끊으면 그 순간 advisory가 아니라 강제가 된다). `findForkOverlap`을 직접 부르지 않고 반드시
  // `findForkAdvisory`를 통해 부른다 — self·others를 한 `options`로 파생시키지 않고 다른
  // 시각으로 조회한 레코드를 섞으면 `unexpected_row_shape`가 실사용 중 튈 수 있다.
  let forkAdvisory: ForkOverlap | undefined
  try {
    forkAdvisory = await options.workspaces.findForkAdvisory(subject, workspaceId, { gracePeriodMs, now: new Date() })
  } catch (error) {
    // 조용히 삼키지 않는다 — 주입된 진단 훅으로 운영자가 볼 수 있는 흔적을 남긴다(이슈 #126,
    // PR #125 후속). 클라이언트로는 아무것도 새지 않는다: 아래 응답에는 `forkAdvisory` 키가
    // 그냥 빠진다. 훅을 주입하지 않은 배포에서는 이 실패가 여전히 아무 흔적도 남기지 않는다
    // (no-op 기본값, {@link diagnosticSink}) — 그것이 의도된 트레이드오프다.
    emit({ site: 'fork_advisory', error })
  }

  writeJson(response, 200, {
    workspaceId,
    // 위 `getWorkspace`가 본 값이 아니라 **전이가 확정한 값**이다 (`§4.1` — 원본은 `heartbeat`).
    // 여기에 `'active'`를 상수로 적으면 스토어가 다른 상태를 돌려줄 수 있게 되는 날 응답이
    // 조용히 거짓말을 한다.
    state: beat.state,
    token: issued.token,
    tokenId: issued.tokenId,
    scope,
    expiresAt: issued.expiresAt,
    heartbeatIntervalSeconds: options.config.heartbeatIntervalSeconds,
    // `exactOptionalPropertyTypes` — 겹침이 없으면 키 자체가 없다(`undefined`로 메우지 않는다,
    // `WorkspaceRecord`의 `replicaId` 미신고와 같은 규율, `§4.10`).
    ...(forkAdvisory === undefined ? {} : { forkAdvisory }),
  })
}

/**
 * 종료·폐기 실패를 옮기는 공통 매핑 — `handleOpenWorkspace`·{@link handleHeartbeatWorkspace}가
 * 세운 것과 같은 모양이다: `workspace_not_found` → `404`, `workspace_not_active` → `409`,
 * 그 외는 {@link storeFailure}.
 */
function writeWorkspaceTransitionFailure(response: ResponseWriter, error: unknown): void {
  if (error instanceof WorkspaceStoreError && error.reason === 'workspace_not_found') {
    writeJson(response, 404, errorResponse(ErrorCodes.workspace_not_found, 'workspace not found'))
    return
  }
  if (error instanceof WorkspaceStoreError && error.reason === 'workspace_not_active') {
    writeJson(response, 409, errorResponse(ErrorCodes.workspace_not_active, 'this workspace is no longer active'))
    return
  }
  writeFailure(response, storeFailure(error))
}

/**
 * `POST /v1/workspaces/{workspaceId}/close` (`§4.4`) — `WorkspaceStore.closeWorkspace`를 그대로
 * 옮긴다. 본문이 거의 없는 이유는 이 조각의 성격이다: 멱등은 **스토어가 이미 갖고 있다**
 * (`closeWorkspace`의 doc) — 같은 `outcome`으로 다시 닫으면 첫 `endedAt`이 그대로 다시 나온다.
 * 이 핸들러는 그 성질을 새로 구현하지 않고 응답으로 그대로 흘려보낼 뿐이다.
 *
 * 실패 매핑은 {@link writeWorkspaceTransitionFailure}. `outcome`은 게이트(`./request.js`,
 * mori-nest #112)가 이미 `'flushed' | 'discarded'`로 좁혀 왔다.
 */
async function handleCloseWorkspace(
  options: ControlServerOptions,
  request: Extract<ControlRequest, { route: 'closeWorkspace' }>,
  response: ResponseWriter,
): Promise<void> {
  const { subject, workspaceId, outcome } = request

  let result
  try {
    result = await options.workspaces.closeWorkspace(subject, workspaceId, outcome, {
      gracePeriodMs: resolveGracePeriodMs(options.config),
    })
  } catch (error) {
    writeWorkspaceTransitionFailure(response, error)
    return
  }

  writeJson(response, 200, { workspaceId, state: result.state, endedAt: result.endedAt })
}

/**
 * `POST /v1/workspaces/{workspaceId}/revoke` (`§4.5`) — `WorkspaceStore.revokeWorkspace`를
 * 그대로 옮긴다. 멱등 관찰·실패 매핑은 {@link handleCloseWorkspace}와 같다.
 *
 * `reason`은 받지도 싣지도 않는다 (`§4.5` 완료 조건) — 게이트가 형식만 보고 이미 버렸고
 * (`./request.js`), `revokeWorkspace`의 요청 모양에도 그 자리가 없다.
 */
async function handleRevokeWorkspace(
  options: ControlServerOptions,
  request: Extract<ControlRequest, { route: 'revokeWorkspace' }>,
  response: ResponseWriter,
): Promise<void> {
  const { subject, workspaceId } = request

  let result
  try {
    result = await options.workspaces.revokeWorkspace(subject, workspaceId, {
      gracePeriodMs: resolveGracePeriodMs(options.config),
    })
  } catch (error) {
    writeWorkspaceTransitionFailure(response, error)
    return
  }

  writeJson(response, 200, { workspaceId, state: result.state, endedAt: result.endedAt })
}

/**
 * `GET /v1/workspaces` (`§4.6`) — `listWorkspaces`가 답한 페이지를 그대로 옮긴다.
 *
 * 주체 스코프 → `state` 필터 → 정렬 → `limit`은 **스토어가 이미 적용했다**
 * (`./workspace-store.js`의 `#selectPage`: 필터 → 정렬 → `LIMIT`). {@link handleListLogs}가
 * 세운 규율 그대로 여기서 다시 자르거나 거르지 않는다 — 자르면 `hasMore`가 거짓말이 된다.
 *
 * **`limit` 상한은 여기서 선다** ({@link MAX_WORKSPACE_PAGE_LIMIT}) — `./request.js`가
 * `limit`의 **형식**만 보고 값을 그대로 실어 보내므로, 상한이 없으면 스토어가 받지 못하는
 * 크기(`WorkspaceStoreError('invalid_page_limit')`)가 그대로 올라와 클라이언트가 문법적으로
 * 멀쩡한 요청으로 `500`을 만들 수 있다. 깎는 것은 `§4.6`이 이미 허락한 동작이다(쿼리 표의
 * `limit` 설명 — "서버가 더 작게 깎을 수 있다").
 *
 * `state`·`after`의 값 판정은 스토어가 한다(`./request.js`가 형식만 보고 넘긴 값) —
 * `invalid_state_filter`·`invalid_cursor`를 각 code로 옮기고, `invalid_page_limit`은
 * `0003 §1.3`에 그 code가 없으므로(게이트 doc과 같은 이유) `malformed_request`로 옮긴다.
 */
async function handleListWorkspaces(
  options: ControlServerOptions,
  request: Extract<ControlRequest, { route: 'listWorkspaces' }>,
  response: ResponseWriter,
): Promise<void> {
  const query: { state?: string; after?: string; limit?: number; gracePeriodMs: number } = {
    gracePeriodMs: resolveGracePeriodMs(options.config),
  }
  if (request.state !== undefined) {
    query.state = request.state
  }
  if (request.after !== undefined) {
    query.after = request.after
  }
  if (request.limit !== undefined) {
    query.limit = Math.min(request.limit, MAX_WORKSPACE_PAGE_LIMIT)
  }

  let page
  try {
    page = await options.workspaces.listWorkspaces(request.subject, query)
  } catch (error) {
    if (error instanceof WorkspaceStoreError && error.reason === 'invalid_state_filter') {
      writeJson(
        response,
        400,
        errorResponse(ErrorCodes.invalid_state_filter, 'state is not one of the known workspace states'),
      )
      return
    }
    if (error instanceof WorkspaceStoreError && error.reason === 'invalid_cursor') {
      writeJson(response, 400, errorResponse(ErrorCodes.invalid_cursor, 'after cannot be interpreted as a cursor'))
      return
    }
    if (error instanceof WorkspaceStoreError && error.reason === 'invalid_page_limit') {
      writeJson(response, 400, errorResponse(ErrorCodes.malformed_request, 'limit is not a valid page size'))
      return
    }
    writeFailure(response, storeFailure(error))
    return
  }

  writeJson(response, 200, {
    workspaces: page.workspaces,
    ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    hasMore: page.hasMore,
  })
}

/**
 * `GET /v1/workspaces/{workspaceId}` (`§4.6`) — `getWorkspace`가 답하면 `200`, `undefined`면
 * `404 workspace_not_found`.
 *
 * **존재 여부를 묻지 않는다** ({@link handleGetLog}와 같은 규율). 없는 작업공간과 이 주체에게
 * 보이지 않는 작업공간을 스토어가 구분하지 않으므로(`./workspace-store.js`의 `getWorkspace`
 * doc), 이 핸들러에도 그 둘을 가르는 분기가 없다 — 응답이 바이트 단위로 같다는 보장이
 * 여기서 나온다.
 *
 * 응답에는 `WorkspaceRecord`를 그대로 낸다 — 토큰이 실릴 자리가 그 타입에 없으므로 구조적으로
 * `§3.8` MUST NOT을 지킨다.
 */
async function handleGetWorkspace(
  options: ControlServerOptions,
  request: Extract<ControlRequest, { route: 'getWorkspace' }>,
  response: ResponseWriter,
): Promise<void> {
  let workspace
  try {
    workspace = await options.workspaces.getWorkspace(request.subject, request.workspaceId, {
      gracePeriodMs: resolveGracePeriodMs(options.config),
    })
  } catch (error) {
    writeFailure(response, storeFailure(error))
    return
  }

  if (workspace === undefined) {
    writeJson(response, 404, errorResponse(ErrorCodes.workspace_not_found, 'workspace not found'))
    return
  }
  writeJson(response, 200, workspace)
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
  emit: DiagnosticSink,
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
    case 'revokeLog':
      await handleRevokeLog(options, gate.request, response)
      return
    case 'openWorkspace':
      await handleOpenWorkspace(options, gate.request, response)
      return
    case 'heartbeatWorkspace':
      await handleHeartbeatWorkspace(options, gate.request, response, emit)
      return
    case 'closeWorkspace':
      await handleCloseWorkspace(options, gate.request, response)
      return
    case 'revokeWorkspace':
      await handleRevokeWorkspace(options, gate.request, response)
      return
    case 'listWorkspaces':
      await handleListWorkspaces(options, gate.request, response)
      return
    case 'getWorkspace':
      await handleGetWorkspace(options, gate.request, response)
      return
    default: {
      // **도달 불가**다 — 위 case들이 `ControlRoute`를 망라한다. 이 분기를 두는 이유는
      // 런타임이 아니라 **컴파일**이다: case 없는 라우트 값이 생기면 이 `never` 대입이
      // 깨지므로 `pnpm typecheck`가 그 자리에서 멈춘다. 가드가 없던 동안 `switch`는
      // case 없는 값에 대해 `writeJson`도 `writeFailure`도 부르지 않고 그대로 반환했고
      // (반환 타입이 `Promise<void>`라 컴파일도 통과했다), 그 요청은 응답을 받지 못한 채
      // 연결이 걸려 있었다 (mori-nest #103 이슈 코멘트, `§4.3`~`§4.6`을 더할 때마다 재발할
      // 클래스). 아래 `throw`는 새 에러 코드를 만들지 않는다 — 서버 배선의 마지막 `catch`가
      // 이미 `500 internal`로 닫는 자리로 떨어진다.
      const _exhaustive: never = gate.request
      throw new Error(`unhandled control route: ${JSON.stringify(_exhaustive)}`)
    }
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
  const emit = diagnosticSink(options.onDiagnostic)
  return createServer((request, response) => {
    handleRequest(request, response, options, emit).catch(() => {
      // 여기 닿는 것은 라우트 핸들러 **밖**의 예외뿐이다 — 요청 스트림 오류처럼 게이트도
      // 스토어도 아닌 자리. 스토어·게이트의 실패는 위에서 이미 응답으로 끝났다. 이미 끝난
      // 응답에 다시 쓰지 않는다.
      if (!response.writableEnded) {
        writeJson(response, 500, errorResponse(ErrorCodes.internal, 'the request could not be served'))
      }
    })
  })
}
