/**
 * pull 응답의 **본문 직렬화** (`0002 §3.1`) — 저장소가 고른 페이지 하나를 와이어 텍스트로
 * 만드는 순수 함수.
 *
 * 이 모듈에는 **서버도 저장소도 타이머도 없다** (mori-nest #23의 완료 조건이 grep으로 그것을
 * 고정한다 — `request.ts`·`sse.ts`가 같은 방식으로 고정된 것과 같다). 산출물은 **JSON 텍스트
 * 문자열 하나**이고, 그것을 어떤 상태코드·헤더로 언제 쓰는지는 라우트를 가진 조각의 몫이다.
 *
 * **페이지를 고르는 일도 여기 없다.** `§3.1` L307-311이 MUST로 적은 *"`limit`은 커서 해석과
 * 정렬이 끝난 뒤에 앞에서부터 취한다"*, `§3.2` L317-322의 미지 커서 판정, `hasMore` 판정,
 * `from` 판정 — 전부 **로그를 읽는 쪽**(저장소, #15)의 것이다. 이 함수는 그 결과를 **입력으로
 * 받아** 와이어 텍스트로 만들 뿐 로그의 내용을 보지 않는다. 커서는 `request.ts`의
 * `CursorStart`·`sse.ts`가 그런 것처럼 `§1.4` L119의 **불투명 문자열**로 받는다.
 *
 * ## 이 파일이 `JSON.stringify(응답객체)` 한 번이 아닌 이유
 *
 * `event.ts`가 정한 대로 `AppendEvent.payload`는 **요청 본문의 원문 조각**(JSON 텍스트)이고,
 * 그 doc이 *"응답에 실을 때 다시 파싱하거나 `JSON.stringify`하지 않는다 — 나가는 JSON 문서에
 * 그대로 이어 붙인다"* 로 못박았다. 원문 조각을 `JSON.stringify`에 넣으면 JSON 텍스트가
 * **문자열 리터럴로 한 번 더 감싸지고**, 파싱된 값을 넣으면 숫자 재표기(`1.0`→`1`)·키 재정렬·
 * 공백 제거가 일어난다 — 어느 쪽이든 `§1.3` L96-101의 MUST가 그 자리에서 깨진다.
 *
 * 그래서 이 응답도 **손조립**이다: `payload`만 원문을 그대로 이어 붙이고 나머지(`id`·`cursor`·
 * `hasMore`·`from`)는 정상 직렬화한다. `sse.ts`가 `data:` 문서에 대해 한 것과 같은 일이고,
 * 이번엔 줄 접기가 없다.
 *
 * ## `\r`는 여기서 문제가 아니다 — 그것이 이 조각의 요점이다
 *
 * `sse.ts`의 결정 1은 `\r`를 담은 payload에 **프레임을 만들지 않는다**(fail-closed). 그 결정이
 * 이벤트의 소실이 아니라 **경로의 강등**인 근거는 문장 하나에 통째로 얹혀 있다:
 * *"pull은 줄 문법이 아니므로 같은 이벤트를 바이트 그대로 실어 나를 수 있다."*
 *
 * **이 파일이 그 문장을 처음으로 참으로 만든다.** pull 응답은 줄 단위 문법이 아니라 JSON
 * 문서 하나이므로, `\r`가 든 원문 조각도 그대로 이어 붙이면 바이트 그대로 나가고 클라이언트의
 * `JSON.parse`가 그대로 되돌린다. 그러므로 **`sse.ts`의 `\r` 판정을 여기로 옮겨오지 마라** —
 * 옮겨오는 순간 강등할 경로가 없어지고 PR #22 결정 1의 근거가 통째로 무너진다.
 * (`test/pull.test.ts`의 3번 테스트가 이 비대칭을 고정한다.)
 *
 * ## 결정 1 — `hasMore: true`인데 `events`가 빈 페이지는 **직렬화하지 않는다** (fail-closed)
 *
 * `§3.1` L303이 *"`hasMore: true`면 `events`는 비어 있지 않다"* 를 **MUST**로 적었다. 그런
 * 페이지를 그대로 직렬화하면 **서버가 자기 MUST를 어긴 `200`을 내보낸다.** 게다가 그 응답은
 * 클라이언트를 막다른 곳에 세운다: `hasMore`를 보고 다음 페이지를 요청해야 하는데
 * `cursor`는 없고(L292 — `events`가 비면 없음), 그러면 `after` 없이 **로그의 처음부터** 다시
 * 요청하는 것 말고 할 수 있는 일이 없다. 순회가 그 자리에서 멈추거나 처음으로 되감긴다.
 *
 * 선택지는 `sse.ts`의 결정 1과 같은 종류였다 — *지킬 수 없는 응답을 `200`으로 내보내는 것과
 * 내보내지 않는 것 중 어느 쪽이 정직한가.* 후자를 골랐다. 이것은 클라이언트의 잘못이 아니라
 * **부르는 쪽(저장소)의 결함**이고, `event.ts`가 스캐너와 파서의 판정이 갈라졌을 때 `500`을
 * 고른 것과 같은 규율이다. 조용한 손상 대신 명시적 실패를 고른다.
 *
 * 반대 방향(빈 `events`를 보고 `hasMore`를 `false`로 **고쳐서** 내보내기)은 고르지 않았다.
 * 그것은 이 함수가 페이지의 내용을 판정하는 것이고 — 판정의 근거(로그에 더 있는가)를 이
 * 함수는 갖고 있지 않다 — 저장소가 "더 있다"고 말한 사실을 조용히 지우는 것이다.
 *
 * ## 결정 2 — 최상위 `cursor`는 **입력으로 받지 않고 `events`에서 파생한다**
 *
 * L292가 *"`events`의 마지막 이벤트 커서. `events`가 비면 없음"* 으로 적었으므로 값은 이미
 * 결정돼 있다. 입력으로 또 받으면 **마지막 이벤트와 어긋난 커서**가 나갈 자리가 생기고,
 * 클라이언트는 그 값으로 다음 페이지를 요청하므로 어긋남이 **조용한 누락**이 된다 (건너뛴
 * 구간을 클라이언트가 알 방법이 없다 — `§3.2`가 미지 커서에 대해 금지한 바로 그 실패 모드다).
 *
 * `event.ts`의 *"같은 사실의 표현이 둘이면 다음 사람이 둘 중 하나를 고른다"* 와 같은 기준이다.
 * 파생하면 어긋날 수 있는 상태 자체가 존재하지 않는다.
 *
 * ## 결정 3 — 빈 원문 조각은 **응답을 만들지 않는다** (fail-closed)
 *
 * 빈 조각을 그대로 이으면 `{"id":…,"payload":,"cursor":…}`, 즉 **JSON으로 파싱되지 않는
 * 본문**이 `200`으로 나간다. `event.ts`가 빈 범위를 `500`으로 막으므로(*"스캐너와 파서가
 * 갈라졌다"*) 게이트를 지나온 값에는 이 경우가 없지만, **이 함수의 안전성이 부르는 쪽의
 * 규율에 의존하지 않게** 여기서도 막는다 — `sse.ts`가 같은 구멍에 대해 내린 것과 같은 판정이고,
 * 조건이 빈 문자열에서 통째로 꺼지는 것이 이 판정의 실패 모드다.
 *
 * **공백만 든 조각(`" "`)도 같이 막는다.** `{"payload": ,"cursor":…}`는 빈 조각과 문자 하나
 * 차이일 뿐 똑같이 파싱되지 않는다 — `=== ''`만 보면 판정이 그 한 칸에서 꺼진다.
 * 여기까지가 이 함수가 보는 전부다: **조각이 JSON 값인지는 검사하지 않는다.** 그것은
 * `event.ts`의 게이트가 이미 판정했고(`parseBody`의 `JSON.parse`), 여기서 다시 파싱하면
 * 이 파일이 "payload를 읽지 않는다"는 계약(`§1.3` L91-93 MUST NOT)에 한 발을 걸치게 된다.
 * 막는 것은 **문서의 문법 자체가 성립하지 않는 경우** 하나다.
 *
 * **`\r` 거부와 이것을 한 덩어리로 읽지 마라.** 값 없는 조각은 *어떤* 직렬화로도 실을 수 없어
 * 막는 것이고, `\r`는 *SSE의 줄 문법으로만* 실을 수 없어 거기서만 막는 것이다.
 */

import type { AppendEvent } from './event.js'
import type { OpenFrom } from './sse.js'

/**
 * pull 응답에 실리는 이벤트 하나 (`§3.1` L291). `event.ts`가 돌려준 이벤트에 저장소가 붙인
 * 커서 하나를 더한 것이다.
 *
 * `payload`가 **원문 조각**이라는 계약이 그대로 이어진다 ({@link AppendEvent} 참조) —
 * 이 파일은 그 값을 파싱하지도 재직렬화하지도 않는다.
 *
 * `sse.ts`의 `AppendFrameEvent`와 모양이 같다. 이름을 재사용하지 않은 것은 그 이름이 SSE
 * **프레임**에 묶여 있기 때문이고, 값 집합이 아니라 구조를 가진 타입이라 둘이 갈라질 자리가
 * 없다 — 구조 타입이므로 부르는 쪽은 어느 쪽 이름으로 만든 값이든 그대로 넘길 수 있다.
 * (`from`의 `OpenFrom`은 반대다 — 값 집합이 같으므로 타입을 새로 만들지 않고 import한다.)
 */
export type PullEvent = AppendEvent & {
  /**
   * 이 이벤트의 커서 (`§1.4` L119). 이 함수에게는 **불투명 문자열**이다 — 만들지도
   * 해석하지도 않고, `JSON.stringify`를 지나므로 어떤 값이 와도 문서를 깨뜨리지 못한다
   * (`sse.ts`가 `id:` 줄 때문에 커서를 검사해야 했던 것과 다른 자리다).
   */
  readonly cursor: string
}

/**
 * 저장소가 고른 페이지. 이 함수의 **입력**이고, 여기 있는 판정은 하나도 이 파일의 것이 아니다.
 *
 * `cursor`가 없는 것이 결정 2다 — `events`에서 파생한다.
 */
export type PullPage = {
  /**
   * `§1.4`의 전순서대로 저장소가 담은 이벤트들 (`§3.1` L301 MUST). **이 함수는 정렬하지
   * 않는다** — 받은 순서를 그대로 싣는 것이 그 MUST를 지키는 방법이다.
   */
  readonly events: readonly PullEvent[]
  /** `§3.1` L293. 판정은 저장소의 일이고 여기서는 **받는다**. */
  readonly hasMore: boolean
  /**
   * `§3.1` L294·L312 — 서버가 어디서부터 읽었는가. 판정은 저장소의 일이다 (`§3.2`).
   *
   * `§4.3`이 *"`from`의 의미는 pull의 `from`과 같다(`§3.1`)"* 로 명시했고 값 집합이 동일하므로
   * `sse.ts`의 {@link OpenFrom}을 그대로 쓴다 — 같은 값 집합의 타입이 공개 표면에 둘이면
   * 한쪽이 바뀌는 날 다른 쪽이 조용히 뒤처진다. **이름이 pull 자리와 맞지 않는 것은 사실이다.**
   * 공용 모듈로 옮기는 것은 서버 조각이 양쪽을 다 부를 때 판단한다 (`sse.ts` 수정은 #23의
   * 범위 밖이다).
   */
  readonly from: OpenFrom
}

/**
 * 응답 본문을 만들 수 없는 이유. **새 에러 `code`가 아니다** (`errors.ts`의 doc이 `§1.5` 표에
 * 없는 code를 만드는 것을 금지한다) — 둘 다 클라이언트의 잘못이 아니라 **부르는 쪽이 넘긴
 * 페이지의 결함**이고, 상태코드를 고르는 것은 라우트를 가진 조각의 몫이다.
 *
 * 두 값 모두 **고정 문자열**이고 payload 원문도 커서 값도 담지 않는다 (`§1.5` L145-146
 * MUST NOT) — 그대로 로그에 찍히거나 에러 봉투로 나가도 새는 것이 없다.
 */
export type PullResponseFailure = 'has_more_without_events' | 'empty_payload'

/**
 * pull 응답 직렬화의 결과.
 *
 * 판별 유니온인 것은 `event.ts`의 `AppendRequestResult`·`sse.ts`의 `AppendFrameResult`와 같은
 * 이유다 — 실패를 빈 문자열이나 `null`로 돌려주면 부르는 쪽이 그것을 와이어에 그대로 쓸 수 있다.
 */
export type PullResponseResult =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly reason: PullResponseFailure }

/**
 * 이벤트 하나를 `§3.1` L291의 선언 순서(`id` → `payload` → `cursor`)로 손조립한다.
 *
 * `payload`만 **원문을 그대로 이어 붙이고**, `id`·`cursor`는 문자열이므로 `JSON.stringify`로
 * 정상 직렬화한다 — 그 둘은 이스케이프를 지나므로 어떤 문자가 와도 문서를 깨뜨리지 못한다.
 * `sse.ts`의 `data:` 문서와 같은 모양이고, 같은 이유로 `payload`에는 `JSON.stringify`를
 * 부르지 않는다.
 */
function serializeEvent(event: PullEvent): string {
  return `{"id":${JSON.stringify(event.id)},"payload":${event.payload},"cursor":${JSON.stringify(event.cursor)}}`
}

/**
 * pull 응답 본문을 만든다 (`§3.1` L290-294).
 *
 * 키 순서는 **스펙의 선언 순서로 고정한다**: `events` → `cursor` → `hasMore` → `from`.
 * JSON 객체의 키 순서에 뜻은 없지만 손조립이라 순서가 코드에 박히고 테스트가 문자열로
 * 비교하므로, 근거 있는 순서 하나를 골라 둔다 — 스펙을 읽으면서 코드를 따라갈 수 있는 순서다.
 *
 * `cursor` 키는 `events`가 비면 **아예 없다** (L292 — 값이 `null`이나 `""`인 것과 다르다.
 * `undefined`를 실을 방법이 JSON에 없고, 빈 문자열을 실으면 클라이언트가 그것을 커서로 믿고
 * 되돌려보낸다). `events`가 있으면 **마지막 이벤트의 커서**다 (결정 2).
 *
 * 실패는 둘뿐이고 둘 다 **입력 페이지의 결함**이다 (결정 1·3). `\r`는 실패가 아니다 —
 * 파일 상단 doc의 *"`\r`는 여기서 문제가 아니다"*.
 */
export function serializePullResponse(page: PullPage): PullResponseResult {
  // 결정 1: `§3.1` L303 MUST를 어기는 페이지. 내용을 보기 전에 판정한다 — 이 페이지는
  // payload가 무엇이든 내보낼 수 없다.
  if (page.hasMore && page.events.length === 0) {
    return { ok: false, reason: 'has_more_without_events' }
  }

  // 결정 3: 값이 없는 원문 조각 하나가 문서 전체를 JSON이 아니게 만든다. 그 이벤트만 빼는
  // 선택지는 없다 — 빼면 `§3.1` L301의 전순서에 조용한 구멍이 뚫리고 클라이언트는 그것을 알
  // 수 없다. `trim`인 것은 공백만 든 조각(`" "`)이 빈 조각과 **같은** 실패 모드이기 때문이다:
  // `{"payload": ,` 역시 파싱되지 않는다. `=== ''`만 보면 판정이 그 자리에서 꺼진다.
  for (const event of page.events) {
    if (event.payload.trim() === '') {
      return { ok: false, reason: 'empty_payload' }
    }
  }

  const events = page.events.map(serializeEvent).join(',')
  const last = page.events[page.events.length - 1]
  const cursor = last === undefined ? '' : `,"cursor":${JSON.stringify(last.cursor)}`
  // `hasMore`는 `JSON.stringify`가 아니라 두 리터럴 중 하나다 — 타입을 벗어난 값이 런타임에
  // 들어와도 와이어에는 JSON 불리언만 나간다 (`"yes"`나 `1`이 실릴 자리를 두지 않는다).
  const hasMore = page.hasMore ? 'true' : 'false'
  return {
    ok: true,
    body: `{"events":[${events}]${cursor},"hasMore":${hasMore},"from":${JSON.stringify(page.from)}}`,
  }
}
