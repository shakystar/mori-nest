/**
 * 두 평면(전송 · 제어)이 공유하는 계약과, 전송 평면의 HTTP 서버.
 *
 * 여기 있는 것 대부분은 **어느 평면에도 속하지 않고 라우트를 하나도 모르는 것들뿐이다.**
 *
 * 예외는 `token.js`·`request.js`·`event.js`·`sse.js`·`pull.js`다 — 전송 평면의 게이트와 직렬화
 * (0003 §3.3 · 0002 §1.2 · §1.3·§2.1 · §4.3 · §3.1)이므로 평면에 속하지만, 서버도 저장소도 모르는
 * 순수 함수라 여기서 함께 나간다 (mori-nest #11 · #14 · #17 · #21 · #23). `request.js`는 라우트
 * **표**를 갖지만 라우트 **핸들러**는 갖지 않는다 — 판정 결과를 반환할 뿐 HTTP 응답을 쓰지
 * 않는다. `event.js`는 append **본문**의 게이트이고, 그 둘을 잇는 것(요청 게이트 → 본문
 * 게이트)은 서버 조각의 몫이다. `sse.js`는 subscribe 스트림의 프레임을 **문자열로** 만들 뿐
 * 연결도 타이머도 갖지 않는다 — 언제 보낼지는 연결을 가진 조각이 안다. `pull.js`도 같다:
 * 저장소가 고른 페이지를 **JSON 텍스트로** 만들 뿐, 페이지를 고르는 일(커서 해석·정렬·`limit`·
 * `hasMore` 판정)은 로그를 읽는 쪽의 것이다.
 *
 * `store.js`는 그 *"로그를 읽는 쪽"* 이다 (mori-nest #27). 위의 순수 함수들과 달리 파일과
 * 프로세스를 갖지만, **라우트는 여전히 모른다** — HTTP도 서버도 여기 없고, 이벤트를 붙이고
 * 페이지를 고르는 것까지가 전부다.
 *
 * `server.js`가 그 둘(게이트 → 본문 게이트 → 스토어 → 응답)을 처음 잇는 조각이다
 * (mori-nest #28). 지금은 `append` 라우트만 배선됐다 — pull·subscribe는 후속 조각이다.
 */

export { ErrorCodes, errorResponse, type ErrorCode, type ErrorResponse } from './errors.js'
export { parseBody, type BodyParseResult } from './body.js'
export {
  parseAppendRequest,
  type AppendEvent,
  type AppendRequestErrorStatus,
  type AppendRequestResult,
} from './event.js'
export { checkMethod, type MethodCheckResult } from './method.js'
export {
  createVerificationKeySet,
  verifyWorkspaceToken,
  checkLogScope,
  type VerificationKeySet,
  type WorkspaceTokenClaims,
  type VerifiedWorkspaceToken,
  type TokenVerificationResult,
  type ScopeCheckResult,
} from './token.js'
export {
  verifyTransportRequest,
  type RawRequest,
  type CursorStart,
  type TransportRoute,
  type TransportRequest,
  type TransportErrorStatus,
  type TransportRequestResult,
} from './request.js'
export {
  serializeOpenFrame,
  serializeAppendFrame,
  serializeHeartbeatFrame,
  serializeResetFrame,
  type OpenFrom,
  type AppendFrameEvent,
  type AppendFrameFailure,
  type AppendFrameResult,
} from './sse.js'
export {
  serializePullResponse,
  type PullEvent,
  type PullPage,
  type PullResponseFailure,
  type PullResponseResult,
} from './pull.js'
export {
  openEventStore,
  EventStoreError,
  DEFAULT_PAGE_LIMIT,
  type AppendResult,
  type EventStore,
  type EventStoreFailure,
  type StoredEventRef,
} from './store.js'
export { createTransportServer, type TransportServerOptions } from './server.js'
