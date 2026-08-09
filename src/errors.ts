/**
 * 두 평면이 공유하는 에러 봉투와 `code` 상수.
 *
 * `0003 §1.3`이 *"에러 본문은 0002 §1.5의 형태를 그대로 쓴다"* (MUST)로 두 평면을 묶었다.
 * 그래서 이 파일은 어느 평면에도 속하지 않고, 라우트를 하나도 알지 않는다.
 *
 * 아래 code는 `0002 §1.5`와 `0003 §1.3`의 표에 **적힌 것뿐이다.** 표에 없는 code를
 * 여기에 추가하지 않는다 — `code`는 클라이언트가 분기하는 안정된 계약이므로, 구현이
 * 새 code를 만드는 것은 스펙을 고치지 않고 계약을 늘리는 것이다.
 */

/**
 * `0002 §1.5` · `0003 §1.3`의 에러 본문. 필드명까지 스펙 그대로다.
 *
 * `code`의 타입이 `ErrorCode`가 아니라 `string`인 것은 스펙의 형태를 그대로 옮긴 것이다.
 * 와이어에서 읽는 쪽은 모르는 code를 만날 수 있어야 하고(스펙이 늘면 클라이언트가 먼저
 * 깨지지 않아야 한다), **만드는 쪽**은 {@link errorResponse}가 `ErrorCode`로 좁힌다.
 */
export type ErrorResponse = {
  error: {
    /** 기계가 분기하는 안정된 문자열 */
    code: string
    /** 사람이 읽는 설명. 클라이언트가 분기 근거로 삼지 않는다 */
    message: string
    details?: Record<string, unknown>
  }
}

/**
 * 두 스펙의 에러 code 전부. 키와 값이 같다 — 값이 곧 와이어에 나가는 문자열이다.
 *
 * 주석의 상태코드는 스펙 표의 것이고, 상태코드 결정 자체는 각 평면의 몫이다
 * (같은 code가 두 평면에서 같은 상태로 나간다는 것까지가 여기의 계약이다).
 */
export const ErrorCodes = {
  // -- 두 평면 공통 (0002 §1.5 ∩ 0003 §1.3) --
  /** 400 — 본문이 JSON이 아니거나 최상위 형태가 스키마와 다르다 */
  malformed_request: 'malformed_request',
  /** 400 — `logId`가 0002 §1.1 정규식에 맞지 않는다 */
  invalid_log_id: 'invalid_log_id',
  /** 401 — 자격 부재·형식 오류·검증 실패 */
  unauthenticated: 'unauthenticated',
  /** 405 — 라우트 표에 없는 메서드 */
  method_not_allowed: 'method_not_allowed',
  /** 413 — 요청 본문이 한도 초과. `details.maxRequestBytes` 필수 */
  request_too_large: 'request_too_large',
  /** 429 — 유량 제한. `Retry-After` 헤더 필수 */
  rate_limited: 'rate_limited',
  /** 500 — 그 외 서버 결함 */
  internal: 'internal',
  /** 503 — 내구화를 보장할 수 없다 */
  not_durable: 'not_durable',
  /** 503 — 셧다운 중·의존 저장소 접근 불가 */
  unavailable: 'unavailable',

  // -- 전송 평면 고유 (0002 §1.5) --
  /** 400 — 이벤트에 `id`가 없거나 정규식 위반, `payload` 키 부재 */
  invalid_event: 'invalid_event',
  /** 400 — `after`가 문자열이 아니다 (미지 커서와 다르다 — 0002 §3.2) */
  invalid_cursor_format: 'invalid_cursor_format',
  /** 403 — 경로의 `logId`가 토큰 스코프 밖 (존재 여부와 무관) */
  out_of_scope: 'out_of_scope',
  /** 406 — subscribe에 `Accept: text/event-stream`이 없다 */
  not_acceptable: 'not_acceptable',
  /** 413 — 단일 이벤트가 `maxEventBytes` 초과. `details.maxEventBytes` 필수 */
  event_too_large: 'event_too_large',

  // -- 제어 평면 고유 (0003 §1.3) --
  /** 400 — 요청이 서버가 발급할 식별자를 제안했다 */
  client_minted_id: 'client_minted_id',
  /** 400 — `logs`가 없거나 빈 배열 */
  empty_scope: 'empty_scope',
  /** 400 — `state` 쿼리가 0003 §4.1의 상태 이름 중 하나가 아니다 */
  invalid_state_filter: 'invalid_state_filter',
  /** 400 — 목록 조회의 `after`를 해석할 수 없다 */
  invalid_cursor: 'invalid_cursor',
  /** 400 — 멱등성이 요구되는 라우트에 `Idempotency-Key`가 없다 */
  missing_idempotency_key: 'missing_idempotency_key',
  /** 400 — `replicaId`가 있는데 0003 §4.9 정규식에 맞지 않는다 (0003 §1.3, §4.2) */
  invalid_replica_id: 'invalid_replica_id',
  /** 403 — 요청한 로그 중 이 주체가 grant할 수 없는 것이 있다 */
  not_grantable: 'not_grantable',
  /** 404 — 없는 로그 또는 이 주체가 grant 판정을 통과하지 못하는 로그 (구분하지 않는다) */
  log_not_found: 'log_not_found',
  /** 404 — 없는 작업공간 또는 다른 주체의 작업공간 (구분하지 않는다) */
  workspace_not_found: 'workspace_not_found',
  /** 409 — 이미 끝난 작업공간에 대한 하트비트·종료·폐기, 또는 종단 상태에서의 멱등 재시도 */
  workspace_not_active: 'workspace_not_active',
  /** 409 — 같은 `Idempotency-Key`, 다른 요청 본문 */
  idempotency_key_reused: 'idempotency_key_reused',
} as const

/** {@link ErrorCodes}의 값 유니온. 에러를 **만드는** 쪽이 쓴다. */
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

/**
 * 에러 봉투를 만든다.
 *
 * `message`·`details`에 **토큰 값이나 payload 원문을 싣지 않는다** (0002 §1.5 ·
 * 0003 §1.3, MUST NOT). 검증 실패를 설명할 때 실을 수 있는 것은 실패한 필드 **이름**과
 * 이벤트 `id`까지다. 이 함수는 그것을 강제하지 못하므로 부르는 쪽이 지킨다.
 */
export function errorResponse(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ErrorResponse {
  return details === undefined
    ? { error: { code, message } }
    : { error: { code, message, details } }
}
