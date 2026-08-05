/**
 * 요청 본문 파싱 — 정의되지 않은 최상위 필드는 조용히 무시하지 않는다.
 *
 * `0003 §1.3`: *"정의되지 않은 최상위 필드를 조용히 무시하지 않는다 (MUST NOT).
 * 무시하면 클라이언트는 자기가 보낸 것이 반영됐다고 믿는다."*
 * `0002 §1.5`도 최상위 형태가 스키마와 다르면 `400 malformed_request`로 못박았다.
 *
 * 여기가 판정하는 것은 **최상위 형태**까지다 — 필드의 타입·값 검증은 각 라우트의
 * 스키마가 자기 code(`invalid_event`·`empty_scope` 등)로 한다.
 */

import { ErrorCodes, errorResponse, type ErrorResponse } from './errors.js'

export type BodyParseResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: ErrorResponse }

/**
 * `details.unknownFields`에 싣는 이름의 최대 개수.
 *
 * 필드 **이름**은 스펙이 에러에 실어도 된다고 한 것이지만(0002 §1.5), 이름을 만드는
 * 것은 클라이언트다. 한도 없이 되싣으면 최상위 키 수만큼 응답이 부푼다. 잘라내더라도
 * `unknownFieldCount`는 **자르기 전 전체 개수**라 클라이언트가 잘렸음을 알 수 있다.
 */
const MAX_REPORTED_UNKNOWN_FIELDS = 10

/**
 * 본문을 파싱하고 최상위 필드를 스키마와 대조한다.
 *
 * @param raw 요청 본문 원문 (UTF-8 JSON — 0002 §1.3)
 * @param allowedFields 이 라우트의 스키마에 **정의된** 최상위 필드 이름들.
 *   비어 있으면 어떤 필드도 허용되지 않는다 (fail-closed — 스키마 미지정이 전면 허용으로
 *   무너지지 않는다).
 */
export function parseBody(raw: string, allowedFields: Iterable<string>): BodyParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 파서의 예외 메시지에는 본문 조각이 실린다 ("Unexpected token ... in JSON at
    // position N"). 그것을 그대로 message에 넣으면 payload 원문이 에러로 새어 나간다
    // (0002 §1.5 MUST NOT). 그래서 고정 문자열만 쓴다.
    return { ok: false, error: errorResponse(ErrorCodes.malformed_request, 'request body is not valid JSON') }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: errorResponse(ErrorCodes.malformed_request, 'request body must be a JSON object'),
    }
  }

  const allowed = new Set(allowedFields)
  const unknownFields = Object.keys(parsed).filter((key) => !allowed.has(key))
  if (unknownFields.length > 0) {
    return {
      ok: false,
      error: errorResponse(ErrorCodes.malformed_request, 'request body has fields not defined by the schema', {
        unknownFields: unknownFields.slice(0, MAX_REPORTED_UNKNOWN_FIELDS),
        unknownFieldCount: unknownFields.length,
      }),
    }
  }

  return { ok: true, body: parsed as Record<string, unknown> }
}
