/**
 * subscribe 스트림의 **프레임 직렬화** (`0002 §4.3`) — 프레임 하나를 와이어 텍스트로 만드는
 * 순수 함수들.
 *
 * 이 모듈에는 **서버도 연결도 타이머도 없다.** HTTP 서버 모듈도, 응답 스트림에 쓰는 호출도,
 * 주기 타이머도 여기 없고 (mori-nest #21의 완료 조건이 grep으로 그것을 고정한다 —
 * `request.ts`가 같은 방식으로 고정된 것과 같다), 산출물은 문자열 하나다. 그것을 언제
 * 누구에게 쓰는지는 연결을 가진 조각의 몫이다. `request.ts`·`event.ts`와 같은 형태(순수 함수 + 판별 유니온)이고, 커서는
 * `request.ts`의 `CursorStart`가 그런 것처럼 **불투명 문자열로 받는다** — 커서를 만드는 것도
 * 해석하는 것도 저장소이지 이 파일이 아니다.
 *
 * ## 이 파일의 중심 문제 — SSE의 줄 문법과 `§1.3`의 바이트 보존이 부딪힌다
 *
 * `event.ts`가 정한 대로 `AppendEvent.payload`는 **요청 본문의 원문 조각**이고, 그 doc이
 * *"응답에 실을 때 다시 파싱하거나 `JSON.stringify`하지 않는다 — 나가는 JSON 문서에 그대로
 * 이어 붙인다"* 로 못박았다. 이 파일이 그 "나가는 JSON 문서"의 첫 번째다.
 *
 * 그런데 SSE는 **줄 단위** 문법이다: `event:`/`id:`/`data:` 줄과 프레임을 끝내는 빈 줄.
 * `data:` 한 줄은 개행을 담을 수 없으므로 개행이 든 값은 여러 `data:` 줄로 **접고**,
 * 클라이언트가 그 줄들을 `\n`으로 다시 잇는다. 원문 조각은 개행을 담을 수 있다 — 요청 본문이
 * 예쁘게 찍힌 JSON이면 공백과 개행이 슬라이스에 그대로 들어 있다.
 *
 * 접기 자체는 무손실이다. 무손실이 아닌 것이 하나 있고, 그것이 아래 결정 1이다.
 *
 * ## 결정 1 — `\r`를 담은 payload는 **프레임을 만들지 않는다** (fail-closed)
 *
 * JSON의 공백에는 캐리지 리턴이 포함된다 (RFC 8259 §2 — `event.ts`의 `isWhitespace`도 넷을
 * 다 센다). 그래서 CRLF로 찍힌 본문의 payload 슬라이스는 `\r`를 **실제로** 담는다:
 * `{"events":[{"id":"e1","payload":{\r\n  "a": 1\r\n}}]}`를 `parseAppendRequest`에 넣으면
 * 슬라이스가 `{\r\n  "a": 1\r\n}`으로 나온다 (확인함).
 *
 * SSE의 줄 구분자는 `\r\n`·`\r`·`\n` **셋 다**이고, 클라이언트가 접힌 줄을 다시 이을 때 쓰는
 * 것은 `\n` **하나**다. 그러므로 `\r`는 어떻게 접어도 살아 돌아오지 못한다:
 * 줄 끝에 남은 `\r`는 우리가 붙이는 `\n`과 합쳐져 구분자 하나(`\r\n`)로 소비되고, 홀로 선
 * `\r`도 구분자로 읽힌 뒤 `\n`으로 재결합된다. **`\r\n` → `\n` 변환은 복구되지 않는다.**
 *
 * 이것은 `§1.3` L96-101(MUST, *"append 요청 본문에서 잘라낸 payload 슬라이스와, 같은 이벤트를
 * pull/subscribe로 받은 응답의 payload 슬라이스가 바이트 동일하다"*)과 `§4.3`이 정면으로
 * 부딪히는 자리다. 선택지는 둘이었다:
 *
 * - **그대로 접어 보낸다** — 클라이언트는 `200`과 온전해 보이는 프레임을 받고, payload에 걸어
 *   둔 서명·MAC이 그 자리에서 깨진다. 왜 깨졌는지 알 방법이 없다.
 * - **프레임을 만들지 않고 실패를 돌려준다** — 스펙에 이미 그 자리가 있다. `§4.5` L433은
 *   *"재생할 수 없으면 조용히 건너뛰지 말고 `event: reset`을 보내고 스트림을 닫는다"* (MUST)
 *   이고, 클라이언트는 pull로 따라잡는다. **pull은 줄 문법이 아니므로 같은 이벤트를 바이트
 *   그대로 실어 나를 수 있다** — 즉 이 실패는 이벤트의 소실이 아니라 **경로의 강등**이다.
 *
 * 후자를 골랐다. 판단 기준은 *"지킬 수 없는 약속을 `200`으로 내보내는 것과 내보내지 않는 것
 * 중 어느 쪽이 클라이언트에게 정직한가"* 이고, `event.ts`가 스캐너와 파서가 갈라졌을 때
 * `500`을 고른 것과 같은 규율이다. 조용한 손상 대신 명시적 갭 통보를 고른다.
 *
 * **`§8` 미결 4(payload를 임의 JSON으로 둘 것인가, base64로 조일 것인가 — L527-531)를 여기서
 * 닫지 않는다.** base64로 조이면 `\r`가 애초에 슬라이스에 들어올 수 없어 이 결정 전체가
 * 사라지지만, 그 결정은 E2E 스킴과 함께 재검토한다고 스펙이 적었다. 여기서는 갭을 **보고**하는
 * 데까지만 간다.
 *
 * ## 결정 2 — `id:` 줄에 실을 수 없는 커서도 fail-closed
 *
 * 커서를 만드는 것은 저장소(#15)이지 이 함수가 아니다. 그래도 이 함수는 자기가 만드는 와이어의
 * 정합성을 책임진다. `§4.3` L400-401이 *"`append` 프레임에는 SSE `id:` 줄에 그 이벤트의 커서를
 * 싣는다 (MUST) — 재접속 시 `Last-Event-ID`로 되돌아오는 값이 이것이다"* 로 적었으므로,
 * `id:` 줄이 깨지면 재접속 커서가 **조용히** 잘리고 클라이언트는 자기가 어디까지 받았는지
 * 틀리게 기억한다. 그래서 {@link isRepresentableCursor}를 통과하지 못하는 커서에는 프레임을
 * 만들지 않는다 — `request.ts`가 검증키가 하나도 없으면 전부 `401`로 무너지는 것과 같은 방향의
 * fail-closed다.
 *
 * ## 결정 3 — **`heartbeat`의 주기는 이 파일에 없다**
 *
 * `§4.3` L405가 *"`heartbeat`는 유휴 15초 이내마다 보낸다"* 를 MUST로 적었지만, 유휴를 아는
 * 것도 타이머를 거는 것도 **연결을 가진 조각**이다. {@link serializeHeartbeatFrame}은 프레임을
 * 만들 뿐 언제 보낼지 모르고, 알아서도 안 된다 — 여기에 주기 타이머를 넣으면 프레임 하나를
 * 만드는 순수 함수가 연결의 수명을 갖게 되고, 테스트가 시계에 묶인다.
 * **다음 사람에게: 15초는 여기가 아니라 서버 조각의 것이다.**
 */

import type { AppendEvent } from './event.js'

/**
 * `§4.3` L395의 `from` 3변이.
 *
 * **이 함수는 판정하지 않고 받는다.** 셋을 가르는 것은 커서가 해석되는지 여부이고 그것은
 * 저장소가 안다 (`request.ts`의 `CursorStart`가 `beginning`/`after` 둘뿐인 이유가 그것이다 —
 * 해석되지 않는 커서는 에러가 아니라 `from: "unknown"` 정상 응답이다, `§3.2`).
 */
export type OpenFrom = 'beginning' | 'known' | 'unknown'

/**
 * `append` 프레임의 입력. `event.ts`가 돌려준 이벤트에 저장소가 붙인 커서 하나를 더한 것이다.
 *
 * `payload`가 **원문 조각**이라는 계약이 그대로 이어진다 ({@link AppendEvent} 참조) —
 * 이 파일은 그 값을 파싱하지도 재직렬화하지도 않는다.
 */
export type AppendFrameEvent = AppendEvent & {
  /**
   * 이 이벤트의 커서 (`§1.4`). 이 함수에게는 **불투명 문자열**이다 — 만들지도 해석하지도
   * 않고, `id:` 줄에 실을 수 있는지만 본다 (결정 2).
   */
  readonly cursor: string
}

/**
 * `append` 프레임을 만들 수 없는 이유. **새 에러 `code`가 아니다** (`errors.ts`의 doc이 표에
 * 없는 code를 만드는 것을 금지한다) — 이것은 스트림 안의 사건이고, 스트림은 이미 `200`이라
 * 상태코드를 가질 수 없다 (`§4.2`).
 *
 * 두 값 모두 **고정 문자열**이고 payload 원문도 커서 값도 담지 않으므로 (`§1.5` L145-146
 * MUST NOT), 부르는 쪽이 {@link serializeResetFrame}에 **그대로 넘겨** `§4.5` L433의
 * *"`reset`을 보내고 스트림을 닫는다"* 를 수행할 수 있다.
 */
export type AppendFrameFailure = 'payload_not_representable' | 'cursor_not_representable'

/**
 * `append` 프레임 직렬화의 결과.
 *
 * 판별 유니온인 것은 `event.ts`의 `AppendRequestResult`와 같은 이유다 — 실패를 빈 문자열이나
 * `null`로 돌려주면 부르는 쪽이 그것을 와이어에 그대로 쓸 수 있다.
 */
export type AppendFrameResult =
  | { readonly ok: true; readonly frame: string }
  | { readonly ok: false; readonly reason: AppendFrameFailure }

/**
 * SSE 필드 값의 구분자로 **SPACE를 항상 하나 쓴다** — 이것이 선택이 아니라 요구인 이유.
 *
 * SSE의 필드 문법은 `name:` 뒤에 오는 SPACE **하나**를 값에서 지운다. 그러므로 `data:${value}`
 * 처럼 붙여 쓰면 공백으로 시작하는 값이 조용히 한 칸 깎인다 — 예쁘게 찍힌 JSON의 들여쓰기가
 * 정확히 그 모양이고(`  "a": 1`), 깎이는 순간 `§1.3` L96의 바이트 보존이 깨진다.
 * `data: ${value}`로 쓰면 클라이언트가 지우는 한 칸이 **우리가 넣은 그 칸**이라 값이 온전히
 * 살아 돌아온다.
 */
const FIELD_SEPARATOR = ': '

/** 프레임을 끝내는 빈 줄 (`§4.3`). 이 줄이 프레임의 경계다. */
const FRAME_TERMINATOR = '\n'

/**
 * 값을 `data:` 줄들로 **접는다**. 개행이 없으면 한 줄, 있으면 `\n`으로 나눈 만큼의 줄이다.
 *
 * 빈 조각도 `data: ` 한 줄이 된다 — 빈 줄이 아니다. 그래서 값 안의 `\n\n`이 프레임 경계로
 * 오인되지 않는다 (그것이 접기의 요점이다).
 *
 * 접힌 줄을 클라이언트가 되돌리는 규칙은 *"각 `data:` 줄의 값을 `\n`으로 잇는다"* 이고,
 * `\r`가 없는 값에 대해 이 왕복은 무손실이다 (결정 1).
 */
function foldData(value: string): string {
  return value
    .split('\n')
    .map((line) => `data${FIELD_SEPARATOR}${line}\n`)
    .join('')
}

/**
 * 프레임 하나를 조립한다: `event:` 줄 → (있으면) `id:` 줄 → `data:` 줄들 → 빈 줄.
 *
 * `event`와 `id`는 접지 않는다. 접어야 할 값이 오면 그것은 이미 거부됐어야 하는 값이고
 * (결정 2), 여기서 조용히 접으면 `event:`/`id:` 줄이 둘이 되어 **뒤엣것이 이긴다** —
 * 깨진 프레임이 정상으로 보인다.
 */
function frame(eventName: string, data: string, cursor: string | null): string {
  const idLine = cursor === null ? '' : `id${FIELD_SEPARATOR}${cursor}\n`
  return `event${FIELD_SEPARATOR}${eventName}\n${idLine}${foldData(data)}${FRAME_TERMINATOR}`
}

/**
 * payload 원문 조각을 `data:` 줄들에 손실 없이 실을 수 있는가 (결정 1).
 *
 * - `\r` — SSE의 줄 문법을 왕복하지 못한다 (파일 상단 결정 1). `\n`은 접기가 무손실로
 *   처리하므로 여기서 걸리지 않는다.
 * - 빈 조각(공백만 든 조각 포함) — 원문 조각이 비거나 공백만이면 `{"id":…,"payload":,"cursor":…}`가
 *   되어 **JSON으로 파싱되지 않는 프레임**이 나간다. 줄 구조는 멀쩡하므로 클라이언트는 프레임을
 *   받아 놓고 본문에서 깨진다. `event.ts`는 빈 범위를 `500`으로 막으므로(*"스캐너와 파서가
 *   갈라졌다"*) 게이트를 지나온 값에는 이 경우가 없지만, **이 함수의 안전성이 부르는 쪽의
 *   규율에 의존하지 않게** 여기서 함께 막는다 — 조건이 빈 문자열에서 통째로 꺼지는 것이 이
 *   판정의 실패 모드다. `pull.ts`의 같은 판정(`payload.trim() === ''`)과 같은 기준이다.
 */
function isRepresentablePayload(payload: string): boolean {
  return payload.trim() !== '' && !payload.includes('\r')
}

/**
 * 커서를 `id:` 줄에 손실 없이 실을 수 있는가 (결정 2).
 *
 * - `\n`·`\r` — 줄을 끊는다. `id:` 줄이 거기서 끝나고 나머지가 다른 필드로 읽힌다.
 * - `U+0000` — SSE는 NULL이 든 `id` 필드를 **통째로 무시한다.** 프레임은 멀쩡해 보이는데
 *   클라이언트의 `Last-Event-ID`는 이전 값에 머문다 — 가장 조용한 형태의 손상이다.
 * - 빈 문자열 — 되돌아오는 `Last-Event-ID`가 "커서 없음"과 구분되지 않는다. 커서를 실었다는
 *   `§4.3` L400의 MUST를 형식만 지키고 뜻은 지키지 못한다.
 *
 * 이 넷 말고는 통과시킨다. 저장소가 어떤 커서 문법을 고를지 이 파일은 모르고, 모르는 채로
 * 좁히면 아직 존재하지 않는 저장소의 선택지를 여기서 지우게 된다.
 */
function isRepresentableCursor(cursor: string): boolean {
  return cursor !== '' && !/[\r\n\u0000]/.test(cursor)
}

/**
 * `open` 프레임 (`§4.3` L395). 연결 직후 1회, 항상 첫 프레임이다 — **그 순서를 지키는 것은
 * 부르는 쪽**이고, 이 함수는 프레임 하나만 만든다.
 */
export function serializeOpenFrame(from: OpenFrom): string {
  return frame('open', JSON.stringify({ from }), null)
}

/**
 * `append` 프레임 (`§4.3` L396 + `id:` 줄에 커서, L400 MUST). **이벤트 하나당 프레임 하나다**
 * (L402 MUST — 이 함수가 이벤트 하나만 받는 것이 그 계약이다).
 *
 * `data:`에 실리는 것은 `{"id":…,"payload":<원문 조각>,"cursor":…}`다. `payload`만 **원문을
 * 그대로 이어 붙이고** `id`·`cursor`는 문자열이므로 정상적으로 직렬화한다.
 * `JSON.stringify(payload)`를 부르면 JSON 텍스트가 문자열 리터럴로 한 번 더 감싸진다 —
 * `AppendEvent.payload`의 doc이 금지한 그것이고, 왕복하면 `§1.3` L96의 MUST가 깨진다.
 *
 * `event.id`는 따로 검사하지 않는다. `event.ts`가 `§1.3` L86 정규식으로 이미 좁혔고, 그것과
 * 무관하게 여기서는 `JSON.stringify`를 지나 `data:` 값 안으로 들어가므로 제어문자가 와도
 * 이스케이프되어 줄을 끊지 못한다. 줄을 끊을 수 있는 것은 이스케이프를 지나지 않는 둘 —
 * 원문 조각인 `payload`와 `id:` 줄에 날것으로 실리는 `cursor` — 뿐이고, 그 둘만 본다.
 */
export function serializeAppendFrame(event: AppendFrameEvent): AppendFrameResult {
  if (!isRepresentablePayload(event.payload)) {
    return { ok: false, reason: 'payload_not_representable' }
  }
  if (!isRepresentableCursor(event.cursor)) {
    return { ok: false, reason: 'cursor_not_representable' }
  }
  const data = `{"id":${JSON.stringify(event.id)},"payload":${event.payload},"cursor":${JSON.stringify(event.cursor)}}`
  return { ok: true, frame: frame('append', data, event.cursor) }
}

/**
 * `heartbeat` 프레임 (`§4.3` L397). `data:`는 빈 객체다.
 *
 * **주기는 여기 없다** (결정 3). L405의 "유휴 15초 이내"는 연결을 가진 조각의 것이고, 이
 * 함수는 언제 불릴지 모른다.
 */
export function serializeHeartbeatFrame(): string {
  return frame('heartbeat', '{}', null)
}

/**
 * `reset` 프레임 (`§4.3` L398). *"스트림으로 이어갈 수 없다 → pull로 내려가라"*.
 *
 * `reason`은 사람이 읽는 설명이고 클라이언트의 대응은 이유와 무관하게 하나다 (`§4.5` L443).
 * 값은 `JSON.stringify`를 지나므로 개행·제어문자가 와도 이스케이프되어 줄을 끊지 못한다 —
 * 그래서 이 함수에는 실패 경로가 없다.
 *
 * {@link AppendFrameFailure}를 그대로 넘길 수 있다. 그것이 `§4.5` L433(*"재생할 수 없으면
 * 조용히 건너뛰지 말고 `reset`을 보내고 스트림을 닫는다"*, MUST)이 이 파일의 실패와 만나는
 * 자리다. **`reason`에 payload 원문이나 토큰을 담지 않는 것은 부르는 쪽의 몫이다**
 * (`§1.5` L145-146 MUST NOT).
 */
export function serializeResetFrame(reason: string): string {
  return frame('reset', JSON.stringify({ reason }), null)
}
