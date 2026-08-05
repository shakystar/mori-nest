/**
 * 두 평면(전송 · 제어)이 공유하는 계약.
 *
 * 여기 있는 것은 **어느 평면에도 속하지 않고 라우트를 하나도 모르는 것들뿐이다.**
 * 라우트 핸들러·서버 리슨·저장소는 이 패키지에 없다 (mori-nest #7).
 */

export { ErrorCodes, errorResponse, type ErrorCode, type ErrorResponse } from './errors.js'
export { parseBody, type BodyParseResult } from './body.js'
export { checkMethod, type MethodCheckResult } from './method.js'
