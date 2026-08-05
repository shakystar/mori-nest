/**
 * 두 평면(전송 · 제어)이 공유하는 계약.
 *
 * 여기 있는 것은 **어느 평면에도 속하지 않고 라우트를 하나도 모르는 것들뿐이다.**
 * 라우트 핸들러·서버 리슨·저장소는 이 패키지에 없다 (mori-nest #7).
 *
 * 예외는 `token.js`와 `request.js`다 — 전송 평면의 게이트(0003 §3.3 · 0002 §1.2)이므로
 * 평면에 속하지만, 서버도 저장소도 모르는 순수 함수라 여기서 함께 나간다
 * (mori-nest #11 · #14). `request.js`는 라우트 **표**를 갖지만 라우트 **핸들러**는 갖지
 * 않는다 — 판정 결과를 반환할 뿐 HTTP 응답을 쓰지 않는다.
 */

export { ErrorCodes, errorResponse, type ErrorCode, type ErrorResponse } from './errors.js'
export { parseBody, type BodyParseResult } from './body.js'
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
