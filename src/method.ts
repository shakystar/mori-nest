/**
 * `405` 판정.
 *
 * *"위 표에 없는 메서드는 `405`"* 가 두 스펙에 다 있다 (`0002 §0` · `0003 §0`).
 *
 * **라우트 테이블은 여기에 없다.** 어떤 경로가 어떤 메서드를 받는지는 각 평면이 자기
 * 스펙대로 정하고, 이 함수는 그 결과로 나온 **허용 메서드 집합을 받아서** 판정만 한다.
 * 테이블을 여기 두면 스캐폴드가 두 평면의 라우트를 알게 되고, 그건 이 계층이 평면에
 * 속하지 않는다는 전제를 깬다.
 */

import { ErrorCodes, errorResponse, type ErrorResponse } from './errors.js'

export type MethodCheckResult = { ok: true } | { ok: false; error: ErrorResponse }

/**
 * 메서드가 허용 집합 안에 있는지 판정한다.
 *
 * 비교는 **대소문자를 구분한다** — HTTP 메서드는 대소문자 구분 토큰이고 (RFC 9110 §9.1),
 * `get`을 `GET`으로 받아주면 스펙 표에 없는 메서드를 통과시키는 것이 된다.
 *
 * `allowedMethods`가 비어 있으면 모든 메서드가 `405`다. 허용 집합이 비었을 때 판정이
 * 통째로 꺼져 전면 허용이 되는 것이 이 종류 검사의 전형적인 실패 방식이므로 fail-closed로 둔다.
 */
export function checkMethod(method: string, allowedMethods: Iterable<string>): MethodCheckResult {
  const allowed = new Set(allowedMethods)
  if (allowed.has(method)) {
    return { ok: true }
  }
  // 허용 메서드 목록은 부르는 쪽이 이미 가지고 있다 (인자로 준 것이다).
  // `Allow` 헤더는 거기서 만든다 — 봉투에 중복해 싣지 않는다.
  return {
    ok: false,
    error: errorResponse(ErrorCodes.method_not_allowed, 'method is not allowed for this route'),
  }
}
