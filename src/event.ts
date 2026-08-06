/**
 * append 요청 본문 게이트 — 이벤트 봉투 검증(`0002 §1.3`) + 배열 계약(`§2.1`) +
 * **`payload` 바이트 슬라이스**.
 *
 * `request.ts`가 *"본문을 읽지 않는다 — append의 이벤트 봉투 검증(`§1.3`·`§2.1`)은
 * 라우트의 몫이다"* 로 남겨 둔 자리가 여기다. 이 모듈도 같은 형태다: **순수 함수 하나.**
 * 서버도 저장소도 여기 없고, HTTP 응답을 쓰지 않는다 — 판정 결과(검증된 이벤트 목록,
 * 또는 `§1.5`의 에러 봉투 + 상태코드)를 **반환**할 뿐이다.
 *
 * ## 이 파일이 존재하는 이유 — `JSON.parse` 왕복이 바이트 보존을 깬다
 *
 * `§1.3` L96-101이 **MUST**로 못박았다: 서버는 `payload`를 **받은 바이트 그대로** 저장하고
 * 돌려준다. 키 재정렬·숫자 재표기(`1.0`→`1`)·유니코드 이스케이프 정규화·공백 제거 중
 * 어느 것도 하지 않는다. `JSON.parse` → 값 → `JSON.stringify` 왕복은 그 넷을 전부 한다.
 * 즉 **파싱된 값을 `payload`로 쓰는 순간 MUST가 깨지고, 깨진 바이트는 복구되지 않는다**
 * (클라이언트가 payload에 걸어 둔 서명·MAC이 그 자리에서 무효가 된다 — `0001 §1.1`).
 *
 * 그래서 이 게이트의 입력은 **요청 본문 원문 문자열**이고, 여기서 하는 일 하나가
 * *"이미 유효하다고 판정된 본문에서 각 `payload` 값의 원문 범위를 찾는 것"* 이다.
 * 유효성 판정은 `parseBody`의 `JSON.parse`가 이미 했다 — 이 파일에 **JSON 파서는 없다.**
 *
 * 원문 문자열이 UTF-8 바이트와 왕복한다는 것까지가 부르는 쪽의 몫이다: 서버 조각이
 * 본문 바이트를 손실 없이(UTF-8) 디코드해 넘기면, 여기서 잘라낸 조각을 UTF-8로 다시
 * 인코드한 것이 원래 바이트 구간과 같다. 이 게이트는 바이트를 **보지 않으므로** 그 성질을
 * 깨뜨릴 자리가 없다 — 자르기만 한다.
 */

import { ErrorCodes, errorResponse, type ErrorResponse } from './errors.js'
import { parseBody } from './body.js'

/**
 * `0002 §1.3` L86: `id := ^[A-Za-z0-9_.:-]{1,256}$`.
 *
 * **`logId`(`§1.1`)의 정규식과 다르다** — `.`과 `:`이 허용되고 상한이 256이다. 두 정규식이
 * 같아 보인다고 `request.ts`의 `LOG_ID_PATTERN`을 재사용하지 않는 것은, 재사용하면 한쪽
 * 규칙이 바뀌는 날 다른 쪽이 조용히 따라 바뀌기 때문이다. 이벤트 id는 클라이언트가 만들고
 * `logId`는 제어 평면이 발급한다 — 애초에 같은 계약이 아니다.
 */
const EVENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/

/**
 * `0002 §1.3` L103-104의 계약 하한 — `maxEventBytes ≥ 1 MiB`(MUST). 1 MiB = 2^20바이트.
 *
 * **기본값이지 배포값이 아니다** (`§8` 미결 8). {@link parseAppendRequest}를 `maxEventBytes`
 * 없이 부르면 이 값을 쓴다 — 한도를 모르는 호출자(예: 이 한도를 다루지 않는 기존 테스트)가
 * 계약 하한 아래에서 그대로 동작하게 하기 위해서다. 실제 배포 한도는
 * `server.ts`의 `TransportServerOptions.maxEventBytes`로 주입한다.
 */
export const MIN_MAX_EVENT_BYTES = 1024 * 1024

/**
 * 이벤트 봉투가 정의한 필드. `§1.3` L84-88의 `Event`가 가진 것이 이 둘뿐이다.
 *
 * 비어 있지 않은 상수다 — 비면 모든 이벤트가 거부된다(fail-closed). 그 반대,
 * "목록이 비었으니 전부 허용"으로 무너지는 경로는 이 파일에 없다.
 */
const ENVELOPE_FIELDS: ReadonlySet<string> = new Set(['id', 'payload'])

/**
 * `details.unknownFields`에 싣는 이름의 최대 개수. `body.ts`의 같은 이름 상수와 같은
 * 이유·같은 값이다 (필드 **이름**은 스펙이 에러에 실어도 된다고 했지만 — `§1.5` L145-146 —
 * 이름을 만드는 것은 클라이언트다). `body.ts`를 고치지 않기로 한 이슈라 상수를 옮기지 않고
 * 여기에 따로 둔다. 잘라내더라도 `unknownFieldCount`는 자르기 전 전체 개수다.
 */
const MAX_REPORTED_UNKNOWN_FIELDS = 10

/**
 * 검증을 통과한 이벤트 하나.
 *
 * `payload`가 `unknown`이 아니라 `string`인 것이 이 조각의 핵심 결정이다 —
 * {@link parseAppendRequest}의 doc *"`payload`를 무엇으로 돌려주는가"* 를 보라.
 */
export type AppendEvent = {
  /** `§1.3` L86 정규식을 통과한 id. **파싱된 값**이다 (`"e1"`은 `"e1"`으로 온다). */
  readonly id: string
  /**
   * `payload` 값의 **요청 본문 원문 조각**. 파싱된 값이 아니고, JSON 문자열 값도 아니다 —
   * 본문에서 그 값이 차지하던 구간을 그대로 잘라낸 **JSON 텍스트**다.
   *
   * 예: 본문이 `{"events":[{"id":"e1","payload":{ "a" : 1.0 }}]}`이면 이 값은
   * `{ "a" : 1.0 }`이다 — 공백도 `1.0`도 그대로다.
   *
   * 그러므로 이 값을 응답에 실을 때 **다시 파싱하거나 `JSON.stringify`하지 않는다.**
   * 나가는 JSON 문서에 그대로 이어 붙인다 (`JSON.stringify(payload)`를 부르면 JSON 텍스트가
   * 문자열 리터럴로 한 번 더 감싸지고, 왕복하면 `§1.3` L96의 MUST가 깨진다).
   */
  readonly payload: string
}

/**
 * 이 게이트가 낼 수 있는 상태코드.
 *
 * `400`은 `§1.5` 표(L150·L152)의 두 code(`malformed_request`·`invalid_event`)가 쓰고,
 * `413`은 단일 이벤트가 `maxEventBytes`를 넘었을 때(`event_too_large`, L158),
 * `500`은 스캐너와 `JSON.parse`의 판정이 갈라졌을 때뿐이다 ({@link parseAppendRequest}의
 * *"fail-closed"* 절).
 */
export type AppendRequestErrorStatus = 400 | 413 | 500

/**
 * append 본문 게이트의 판정 결과.
 *
 * **부분 성공을 표현하는 모양이 없다.** `§2.1` L207-208이 all-or-nothing을 MUST로 적었고,
 * 부분 성공 필드가 존재하면 다음 사람이 그것을 쓴다 — 그래서 실패 쪽에는 통과한 이벤트를
 * 실을 자리 자체를 두지 않았다.
 */
export type AppendRequestResult =
  | { readonly ok: true; readonly events: readonly AppendEvent[] }
  | {
      readonly ok: false
      readonly status: AppendRequestErrorStatus
      readonly error: ErrorResponse
    }

/** 본문 안의 반열린 구간 `[start, end)`. */
type TextRange = { readonly start: number; readonly end: number }

/** 스캐너의 실패. 인덱스와 섞이지 않는 값이어야 하므로 `-1`이다. */
const NOT_FOUND = -1

function isWhitespace(c: string | undefined): boolean {
  // JSON의 공백은 이 넷뿐이다 (RFC 8259 §2).
  return c === ' ' || c === '\t' || c === '\n' || c === '\r'
}

function skipWhitespace(raw: string, from: number): number {
  let i = from
  while (i < raw.length && isWhitespace(raw[i])) {
    i++
  }
  return i
}

/**
 * `raw[from]`의 `"`로 시작하는 문자열 리터럴의 **닫는 따옴표 다음** 인덱스.
 *
 * 이스케이프(`\"`·`\\`)를 정확히 다루는 것이 이 함수의 전부다 — `\"`를 종료로 오인하면
 * payload 범위가 문자열 한가운데서 끊긴다. `\uXXXX`의 네 자리는 따로 셀 필요가 없다:
 * 역슬래시 다음 한 글자를 건너뛰면 남은 `XXXX`에는 `"`도 `\`도 없다.
 */
function scanString(raw: string, from: number): number {
  let i = from + 1
  while (i < raw.length) {
    const c = raw[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '"') {
      return i + 1
    }
    i++
  }
  return NOT_FOUND
}

/**
 * `raw[from]`에서 시작하는 JSON 값의 **끝 다음** 인덱스.
 *
 * 값이 유효한지는 판정하지 않는다 — `parseBody`의 `JSON.parse`가 이미 했다. 여기서 하는
 * 것은 **경계 찾기**뿐이고, 그러려면 문자열 리터럴과 `{}`·`[]` 깊이만 정확하면 된다.
 *
 * 재귀가 아니라 깊이 카운터인 것은 의도적이다. 재귀로 쓰면 깊게 중첩된 payload에서
 * `RangeError`(스택 초과)가 이 함수 밖으로 튀어나가는데, 그 예외를 받는 곳이 없다.
 * 반복문에는 그 실패 모드가 아예 없다.
 */
function scanValue(raw: string, from: number): number {
  const first = raw[from]
  if (first === '"') {
    return scanString(raw, from)
  }
  if (first !== '{' && first !== '[') {
    // 스칼라(number·true·false·null). 다음 구조 구분자나 공백까지가 값이다.
    let i = from
    while (i < raw.length) {
      const c = raw[i]
      if (c === ',' || c === '}' || c === ']' || isWhitespace(c)) {
        break
      }
      i++
    }
    return i === from ? NOT_FOUND : i
  }
  let depth = 0
  let i = from
  while (i < raw.length) {
    const c = raw[i]
    if (c === '"') {
      i = scanString(raw, i)
      if (i === NOT_FOUND) {
        return NOT_FOUND
      }
      continue
    }
    if (c === '{' || c === '[') {
      depth++
      i++
      continue
    }
    if (c === '}' || c === ']') {
      depth--
      i++
      if (depth === 0) {
        return i
      }
      continue
    }
    i++
  }
  return NOT_FOUND
}

/**
 * 객체 키를 읽는다. 값을 **`JSON.parse`로** 푸는 것이 요점이다 — 키에도 이스케이프가 올 수
 * 있고(`{"events":[]}`), 원문 그대로 비교하면 그런 본문에서 스캐너만 키를 못 알아본다.
 * 본문을 판정한 것과 같은 디코더를 쓰면 두 판정이 갈라질 자리가 없다.
 */
function readKey(raw: string, from: number): { readonly key: string; readonly next: number } | null {
  if (raw[from] !== '"') {
    return null
  }
  const next = scanString(raw, from)
  if (next === NOT_FOUND) {
    return null
  }
  let key: unknown
  try {
    key = JSON.parse(raw.slice(from, next))
  } catch {
    return null
  }
  return typeof key === 'string' ? { key, next } : null
}

/**
 * 멤버 하나를 만났을 때 불린다. 값의 **끝 다음** 인덱스를 돌려주거나 {@link NOT_FOUND}.
 *
 * 값을 직접 훑지 않는 방문자는 {@link scanValue}를 불러 그 결과를 그대로 돌려준다.
 * 값을 훑는 방문자(= `events`)는 자기가 도달한 위치를 돌려준다 — 그래야 같은 구간을 두 번
 * 훑지 않는다.
 */
type MemberVisitor = (key: string, valueStart: number) => number

/** `raw[from]`의 `{`로 시작하는 객체를 훑는다. 반환은 닫는 `}` 다음 인덱스. */
function scanObject(raw: string, from: number, visit: MemberVisitor): number {
  if (raw[from] !== '{') {
    return NOT_FOUND
  }
  let i = skipWhitespace(raw, from + 1)
  if (raw[i] === '}') {
    return i + 1
  }
  for (;;) {
    const key = readKey(raw, i)
    if (key === null) {
      return NOT_FOUND
    }
    i = skipWhitespace(raw, key.next)
    if (raw[i] !== ':') {
      return NOT_FOUND
    }
    i = skipWhitespace(raw, i + 1)
    const valueEnd = visit(key.key, i)
    if (valueEnd === NOT_FOUND) {
      return NOT_FOUND
    }
    i = skipWhitespace(raw, valueEnd)
    const c = raw[i]
    if (c === ',') {
      i = skipWhitespace(raw, i + 1)
      continue
    }
    if (c === '}') {
      return i + 1
    }
    return NOT_FOUND
  }
}

/**
 * 원소 하나의 스캔 결과. `event`는 그 원소가 차지하는 원문 구간 전체다(`§1.3` L103의
 * `maxEventBytes` 판정이 이 구간의 바이트 길이를 잰다) — 원소가 배열 안에 있는 한 언제나
 * 있다. `payload`는 원소가 객체가 아니거나 `payload` 멤버가 없으면 `null`이다.
 */
type EventScan = { readonly event: TextRange; readonly payload: TextRange | null }

/**
 * `events` 배열을 훑어 원소마다 원문 구간 전체와 `payload` 값의 범위를 모은다.
 *
 * 원소가 객체가 아니거나 `payload` 멤버가 없으면 `payload`는 `null`이다 — 그 판정(=거부)은
 * 여기가 아니라 {@link parseAppendRequest}의 검증 루프가 한다. 스캐너는 **찾기만 한다.**
 */
function scanEventsArray(
  raw: string,
  from: number,
): { readonly scans: readonly EventScan[]; readonly next: number } | null {
  if (raw[from] !== '[') {
    return null
  }
  const scans: EventScan[] = []
  let i = skipWhitespace(raw, from + 1)
  if (raw[i] === ']') {
    return { scans, next: i + 1 }
  }
  for (;;) {
    const elementStart = i
    if (raw[i] === '{') {
      // 방문자가 쓰는 자리. 지역 변수 대신 홀더인 것은 콜백 안의 대입이 밖의 좁히기를
      // 되돌리지 않기 때문이다 (타입이 아니라 사실을 정확히 적기 위한 것).
      const found: { range: TextRange | null } = { range: null }
      const end = scanObject(raw, i, (key, valueStart) => {
        const valueEnd = scanValue(raw, valueStart)
        if (valueEnd === NOT_FOUND) {
          return NOT_FOUND
        }
        if (key === 'payload') {
          // 같은 키가 두 번 오면 `JSON.parse`는 **뒤엣것**을 남긴다. 덮어써서 그 규칙을
          // 그대로 따른다 — 앞엣것을 남기면 파싱된 값과 원문 조각이 서로 다른 것을 가리킨다.
          found.range = { start: valueStart, end: valueEnd }
        }
        return valueEnd
      })
      if (end === NOT_FOUND) {
        return null
      }
      scans.push({ event: { start: elementStart, end }, payload: found.range })
      i = end
    } else {
      const end = scanValue(raw, i)
      if (end === NOT_FOUND) {
        return null
      }
      scans.push({ event: { start: elementStart, end }, payload: null })
      i = end
    }
    i = skipWhitespace(raw, i)
    const c = raw[i]
    if (c === ',') {
      i = skipWhitespace(raw, i + 1)
      continue
    }
    if (c === ']') {
      return { scans, next: i + 1 }
    }
    return null
  }
}

/**
 * 본문을 **1회 순회**하며 `events` 원소별 스캔 결과(원문 구간 전체 + `payload` 원문 범위)를
 * 모은다. 구조가 예상과 다르면 `null` — 부르는 쪽이 fail-closed로 처리한다.
 */
function scanEventScans(raw: string): readonly EventScan[] | null {
  const collected: { scans: readonly EventScan[] | null } = { scans: null }
  const start = skipWhitespace(raw, 0)
  const end = scanObject(raw, start, (key, valueStart) => {
    if (key !== 'events') {
      return scanValue(raw, valueStart)
    }
    const scanned = scanEventsArray(raw, valueStart)
    if (scanned === null) {
      return NOT_FOUND
    }
    // 최상위에도 같은 키가 두 번 올 수 있다(`{"events":[…],"events":[…]}` — `parseBody`의
    // `Object.keys`에는 한 번만 보인다). 여기서도 뒤엣것이 이긴다.
    collected.scans = scanned.scans
    return scanned.next
  })
  if (end === NOT_FOUND || skipWhitespace(raw, end) !== raw.length) {
    return null
  }
  return collected.scans
}

function malformed(message: string): AppendRequestResult {
  return { ok: false, status: 400, error: errorResponse(ErrorCodes.malformed_request, message) }
}

/**
 * `400 invalid_event`. `details`에 실리는 것은 **위치와 id까지**다 — `message`는 고정
 * 문자열이고 `payload` 원문은 어느 필드에도 실리지 않는다 (`§1.5` L145-146 MUST NOT).
 *
 * @param id 검증을 통과한 id, 또는 `null`(= 아직 id를 신뢰할 수 없는 실패).
 */
function invalidEvent(
  index: number,
  id: string | null,
  message: string,
  extra?: Readonly<Record<string, unknown>>,
): AppendRequestResult {
  const details: Record<string, unknown> = { eventIndex: index, ...extra }
  if (id !== null) {
    details['eventId'] = id
  }
  return { ok: false, status: 400, error: errorResponse(ErrorCodes.invalid_event, message, details) }
}

/**
 * `413 event_too_large` (`§1.5` L158). 크기 판정은 `id` 검증보다 먼저 도므로 다른 사전
 * 실패들(예: `event must be a JSON object`)과 같은 이유로 `eventId`를 싣지 않는다 —
 * 검증을 통과한 id가 아직 없다. `eventIndex`만으로 클라이언트가 어느 원소인지 짚을 수 있다.
 */
function eventTooLarge(index: number, maxEventBytes: number): AppendRequestResult {
  return {
    ok: false,
    status: 413,
    error: errorResponse(ErrorCodes.event_too_large, 'event exceeds the maximum allowed size', {
      eventIndex: index,
      maxEventBytes,
    }),
  }
}

/**
 * 스캐너와 `JSON.parse`의 판정이 갈라졌다. **통과시키지 않는다.**
 *
 * `request.ts`가 라우트 표와 메서드 판정이 갈라지는 자리에 쓴 것과 같은 규율이다 — 도달하지
 * 않아야 하는 상태이고, 도달했다면 그 요청은 "검사를 통과했는데 근거가 없는" 요청이다.
 * 그런 요청에 `200`을 주면 정규화되지 않았다는 보장 없이 payload가 기록된다.
 */
function scannerDisagrees(): AppendRequestResult {
  return {
    ok: false,
    status: 500,
    error: errorResponse(ErrorCodes.internal, 'payload range scanner and JSON parser disagree'),
  }
}

/**
 * append 요청 본문을 검증하고 이벤트 목록을 돌려준다 (`0002 §1.3`·`§2.1`).
 *
 * @param rawBody 요청 본문 **원문**. 파싱된 객체를 받지 않는다 — 받는 순간 바이트가 이미
 *   없다 (파일 상단 doc).
 * @param options.maxEventBytes 단일 이벤트(원소 전체의 원문 구간)의 바이트 상한(`§1.3` L103
 *   MUST). 부재면 {@link MIN_MAX_EVENT_BYTES}(계약 하한 1 MiB)를 쓴다 — 배포 한도는
 *   `server.ts`가 `TransportServerOptions.maxEventBytes`로 주입해서 넘긴다.
 *
 * ## 검사 순서
 *
 * 1. **최상위 형태** — `parseBody(rawBody, ['events'])`. JSON 여부·객체 여부·정의되지 않은
 *    최상위 필드는 그 함수가 이미 `400 malformed_request`로 판정한다. 여기서 다시 구현하지
 *    않고 그 봉투를 그대로 옮긴다.
 * 2. **배열 계약** — `events`가 배열이고 길이 ≥ 1. 아니면 `400 malformed_request`
 *    (`§2.1` L204-206 MUST: *"빈 요청을 `200`으로 돌려주면 클라이언트의 flush 경로가
 *    '밀었다'고 오인한다"*).
 * 3. **원문 범위 스캔** — 본문 1회 순회로 원소별 원문 구간 전체와 `payload` 범위를 모은다.
 * 4. **이벤트별 검증** — 배열 순서대로 크기(`maxEventBytes`, `413`) → `id` → `payload` 키 →
 *    미정의 필드 → 요청 내 중복 id. **하나라도 실패하면 통과분을 돌려주지 않는다**
 *    (`§2.1` L207-208 MUST — 크기 실패는 `413`, 나머지는 `400`이지만 all-or-nothing은 같다).
 *
 * 통과한 이벤트는 **요청 배열 순서를 보존한다** (`§2.1` L193 — `accepted`가 그 순서를 쓴다).
 *
 * ## `payload`를 무엇으로 돌려주는가 — **원문 부분 문자열**
 *
 * 후보는 셋이었다: 원문 부분 문자열 / `{offset, length}` 범위 / 그 둘. 고른 것은 **부분
 * 문자열 하나**이고, 판단 기준은 *"뒤따르는 조각이 이 값을 다시 파싱하지 않고 그대로 실어
 * 나를 수 있는가"* 다.
 *
 * - **범위는 본문 없이 뜻이 없다.** `{offset, length}`를 저장소나 SSE 프레임까지 들고 가려면
 *   **요청 본문 전체**를 그 값의 수명 내내 함께 들고 가야 한다. 이벤트 하나를 저장하는 데
 *   요청 전체(다른 이벤트의 payload 포함)가 딸려 오는 구조이고, 그 본문이 사라지는 순간
 *   범위는 해석 불가능한 숫자 두 개가 된다.
 * - **부분 문자열은 자기충족적이다.** pull 응답 조립(`§3.1`)·SSE `append` 프레임(`§4.3`)·
 *   저장소(#15)는 이 값을 나가는 JSON 문서에 **그대로 이어 붙이기만** 하면 된다. 파싱도
 *   재직렬화도 없으므로 `§1.3` L96의 관찰 조건(요청 원문 조각 ≡ 응답 조각)이 **구조로**
 *   성립한다 — 정규화할 코드 경로가 존재하지 않는다.
 * - **둘 다 돌려주지 않는 이유**: 같은 사실의 표현이 둘이면 다음 사람이 둘 중 하나를 고르고,
 *   고르는 순간 위의 "본문을 함께 들고 가야 한다"가 조용히 계약에 들어온다.
 *
 * ## 이벤트 객체의 미정의 필드 — **거부한다** (`400 invalid_event`)
 *
 * `§1.3` L84-88은 *"와이어에 실리는 이벤트는 이것뿐이다"* 라고 적었고, `0003 §1.3`은
 * 최상위에 대해 *"정의되지 않은 필드를 조용히 무시하지 않는다 (MUST NOT)"* 로 못박았다.
 * 봉투 안이라고 그 근거가 달라지지 않는다 — 무시하면 `{"id":…,"payload":…,"ts":…}`를 보낸
 * 클라이언트는 `ts`가 기록됐다고 믿고, 그것을 확인할 방법이 없다. 게다가 이 판정은 한쪽으로만
 * 되돌릴 수 있다: 지금 거부해 두면 나중에 필드를 **정의하면서** 푸는 것이 하위호환이지만,
 * 지금 무시하면 나중에 조이는 것이 이미 성공하던 요청을 깨뜨린다.
 *
 * 이것은 `payload` **안**을 보는 것과 무관하다 — `payload`의 내부는 여전히 아무것도 읽지
 * 않는다 (`§1.3` L91-93 MUST NOT). 보는 것은 봉투의 키 이름뿐이다.
 *
 * ## `details.eventId`를 채울 수 없을 때 — **생략하고 `eventIndex`로 짚는다**
 *
 * `§2.1` L208은 `details.eventId`에 첫 번째 실패 이벤트의 id를 실으라고 했지만, `id`가
 * 없거나 문자열이 아니거나 정규식을 위반한 경우엔 **실을 id가 없다.** 그래서:
 *
 * - `details.eventIndex`(요청 배열의 0-기반 위치)는 **항상** 싣는다. 클라이언트가 어느
 *   이벤트인지 짚는 것은 이 값 하나로 충분하고, 이 값은 클라이언트가 보낸 배열의 위치일 뿐
 *   내용이 아니다.
 * - `details.eventId`는 **id가 검증을 통과한 실패에만** 싣는다 (payload 키 부재, 미정의 필드,
 *   중복 id). id 자체가 실패 원인일 때 그 값을 되싣지 않는 것은, 그것이 길이도 문자 집합도
 *   검증되지 않은 클라이언트 문자열이기 때문이다 — 검증 전 원문을 에러 봉투에 옮기는 것은
 *   `body.ts`가 파서 예외 메시지를 버린 것과 같은 이유로 하지 않는다.
 * - 어느 경우에도 `payload` 원문은 싣지 않는다 (`§1.5` L145-146 MUST NOT).
 *
 * ## 요청 **내** 중복 id ≠ 저장소 dedup
 *
 * 여기서 보는 중복은 **한 요청 안**의 중복이고 `400 invalid_event`다 (`§2.1` L209-210 MUST —
 * *"한 요청 안에서 first-write-wins를 적용하면 클라이언트가 무엇이 버려졌는지 모른 채 성공을
 * 받는다"*). 요청 **간** dedup(같은 id가 로그에 이미 있으면 `duplicate`로 분류, `§2.1`
 * L195-203)은 **전혀 다른 판정**이고 저장소의 몫이다 — 에러가 아니라 정상 응답이다.
 * 저장소가 생겼다고 이 검사를 "중복 처리는 저장소가 하니까"라며 지우면 L209의 MUST가 깨진다.
 *
 * ## fail-closed
 *
 * 스캐너가 범위를 찾지 못하면(구조를 못 훑거나, 원소 수가 파싱된 배열과 다르거나, 통과한
 * 이벤트의 범위가 비었으면) `500 internal`이다. `JSON.parse`가 받아들인 본문을 스캐너가
 * 못 훑는 것은 이 파일의 결함이지 클라이언트의 잘못이 아니고, 그때 `200`을 주면 바이트
 * 보존의 근거 없이 payload가 기록된다. 통과시키는 쪽으로 무너지지 않는다.
 */
export function parseAppendRequest(
  rawBody: string,
  options: { readonly maxEventBytes?: number } = {},
): AppendRequestResult {
  const maxEventBytes = options.maxEventBytes ?? MIN_MAX_EVENT_BYTES

  // ── 1: 최상위 형태. `parseBody`의 경계 — "최상위 형태까지" — 가 그대로 맞는 자리다.
  const parsed = parseBody(rawBody, ['events'])
  if (!parsed.ok) {
    return { ok: false, status: 400, error: parsed.error }
  }

  // ── 2: 배열 계약 (`§2.1` L204-206).
  const events = parsed.body['events']
  if (!Array.isArray(events)) {
    return malformed('events must be a JSON array')
  }
  if (events.length === 0) {
    return malformed('events must contain at least one event')
  }

  // ── 3: 원문 범위 스캔. 본문 1회 순회이고, 이벤트마다 본문을 다시 훑지 않는다.
  const scans = scanEventScans(rawBody)
  if (scans === null || scans.length !== events.length) {
    return scannerDisagrees()
  }

  // ── 4: 이벤트별 검증. 배열 순서대로 보고, 첫 실패에서 끝난다 (all-or-nothing).
  const seenIds = new Set<string>()
  const accepted: AppendEvent[] = []
  for (let index = 0; index < events.length; index++) {
    const scan = scans[index]
    if (scan === undefined) {
      // 길이는 위에서 맞춰 봤으니 도달하지 않는다 — `noUncheckedIndexedAccess`가 요구하는
      // 형식적 좁히기다.
      return scannerDisagrees()
    }

    // 크기 판정이 구조 판정보다 먼저 온다 — 원소가 유효한 봉투인지와 무관하게 원문 구간의
    // 바이트 길이만 보므로, 다른 검사보다 먼저 걸어도 결과가 달라지지 않고 큰 원소에 대한
    // 나머지 검증(키 순회 등)을 아낀다.
    const eventBytes = Buffer.byteLength(rawBody.slice(scan.event.start, scan.event.end), 'utf8')
    if (eventBytes > maxEventBytes) {
      return eventTooLarge(index, maxEventBytes)
    }

    const event: unknown = events[index]
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      return invalidEvent(index, null, 'event must be a JSON object')
    }
    const envelope = event as Record<string, unknown>

    const id = envelope['id']
    if (typeof id !== 'string' || !EVENT_ID_PATTERN.test(id)) {
      return invalidEvent(index, null, 'event id is missing or does not match the required format')
    }

    // 값이 아니라 **키의 존재**만 본다 — `null`도 `false`도 `0`도 유효한 JSON 값이다
    // (`§1.3` L87). 참거짓으로 판정하면 `"payload":null`인 이벤트가 거부된다.
    // `in`이 아니라 `Object.hasOwn`인 것은 프로토타입 체인을 보지 않기 위해서다.
    if (!Object.hasOwn(envelope, 'payload')) {
      return invalidEvent(index, id, 'event has no payload field')
    }

    const unknownFields = Object.keys(envelope).filter((key) => !ENVELOPE_FIELDS.has(key))
    if (unknownFields.length > 0) {
      return invalidEvent(index, id, 'event has fields not defined by the envelope', {
        unknownFields: unknownFields.slice(0, MAX_REPORTED_UNKNOWN_FIELDS),
        unknownFieldCount: unknownFields.length,
      })
    }

    if (seenIds.has(id)) {
      return invalidEvent(index, id, 'events contains the same id more than once')
    }
    seenIds.add(id)

    const payloadRange = scan.payload
    if (payloadRange === null) {
      // 파싱된 이벤트에는 `payload` 키가 있는데 스캐너는 그 범위를 못 찾았다 — 갈라졌다.
      return scannerDisagrees()
    }
    accepted.push({ id, payload: rawBody.slice(payloadRange.start, payloadRange.end) })
  }

  return { ok: true, events: accepted }
}
