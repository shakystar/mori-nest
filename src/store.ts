/**
 * 이벤트 스토어 — 로그를 실제로 들고 있는 것 (`0002 §1.3`·`§1.4`·`§2.1`·`§2.2`·`§3.1`·`§3.2`).
 *
 * `token.ts`·`request.ts`·`event.ts`·`sse.ts`·`pull.ts`는 저장소를 모르는 순수 함수다 —
 * 게이트 판정과 직렬화를 끝내 놓았고, 지금까지 없던 것이 **로그 그 자체**였다. 이 파일이 그것이다.
 * 라우트 핸들러도 HTTP 서버도 여기 없다 (후속 세 조각의 몫이다) — 이 파일은 저장소만이다.
 *
 * 구현은 `node:sqlite`다 (mori-nest [#15의 사람 결정, 2안 확정](https://github.com/shakystar/mori-nest/issues/15#issuecomment-5198717953)).
 * 런타임 의존성은 **0을 유지한다** — `node:sqlite`는 빌트인이다.
 *
 * ## 이 파일의 요지 — 두 MUST를 **응용 코드가 아니라 스토어가** 강제한다
 *
 * `0002`가 저장소에 와이어에서 관찰 가능한 계약 둘을 걸었고, 둘 다 "코드가 조심하면 지켜지는"
 * 종류가 아니다.
 *
 * - **`§2.1` 원자적 dedup (MUST)** — 같은 `id`를 담은 요청 두 건이 동시에 도착해도 로그에 그
 *   이벤트는 정확히 한 번 나타난다. 스펙이 실패 모드까지 적어 뒀다: *"'있는지 보고 없으면
 *   쓴다'를 원자적이지 않게 구현하면 두 요청이 모두 빈 로그를 보고 둘 다 쓴다."*
 *   → 이 파일에 **그 선판정이 없다.** 판정하는 것은 `UNIQUE (log_id, event_id)` 제약이고,
 *   코드는 그 위반(`SQLITE_CONSTRAINT_UNIQUE` = `errcode 2067`)을 **받아서** `duplicate`로
 *   분류할 뿐이다. 읽고-판정하고-쓰는 창이 존재하지 않는다.
 * - **`§2.2` 내구성 (MUST)** — `200`의 마지막 바이트 이후 언제 죽여도 `accepted` ∪ `duplicate`의
 *   모든 id가 같은 상대 순서로 남는다.
 *   → `journal_mode=WAL` + `synchronous=FULL`이고, 그 둘이 **실제로 적용됐는지 열 때마다 되읽어
 *   확인한다** ({@link applyDurabilityPragmas}). 설정 회귀는 조용히 일어나고 조용히 틀린다.
 *
 * ## 인터페이스가 async인 이유 (구현은 동기다)
 *
 * `node:sqlite`는 전부 동기 API지만 {@link EventStore}의 메서드는 `Promise`를 돌려준다
 * (#15 결정 §추가 1). 훗날 단일 프로세스를 벗어나 Postgres로 갈 때 **인터페이스 교체만으로**
 * 이관이 끝나게 하기 위해서다 — 동기로 잘라 두면 그날 모든 호출부에 `await`가 번지는 수술이 된다.
 *
 * 뒤집어 말하면 이 구현의 메서드 본문에는 **`await`가 하나도 없다.** 그것이 사고가 아니라
 * 계약이다: `append`의 `BEGIN`~`COMMIT` 사이에 `await`가 하나라도 있으면 그 자리에서 이벤트
 * 루프가 다른 `append`에 제어를 넘기고, 한 프로세스 안에서 트랜잭션이 겹친다 (SQLite는 한
 * 연결에서 중첩 트랜잭션을 열 수 없으므로 두 번째 `BEGIN`이 그대로 실패한다). 이 파일을 고치는
 * 사람은 트랜잭션 구간에 `await`를 넣지 마라.
 *
 * ## 단일 프로세스 가정 — 전제·깨지는 조건·그때 깨지는 계약
 *
 * **전제: 이 DB 파일을 여는 서버 프로세스는 하나다** (#15 결정 §함께 정하는 것).
 * **깨지는 조건: 같은 DB 파일을 여는 프로세스가 둘 이상이 되는 순간**(워커를 늘리거나, 별도
 * 관리 프로세스가 같은 파일을 여는 순간)이다.
 *
 * 이 전제에 **의존하지 않는 것** — 프로세스가 둘이어도 성립한다:
 * dedup 원자성(`UNIQUE` 제약이 강제), all-or-nothing(트랜잭션이 강제), 내구성(WAL+FULL),
 * 전순서(단조 증가 `seq`). `test/store.test.ts`의 ①②가 실제로 **자식 프로세스**로 검증한다.
 *
 * 이 전제에 **의존하는 것** — 워커를 늘리는 순간 깨지는 것:
 *
 * 1. **쓰기 직렬화와 지연.** SQLite의 writer는 DB당 하나다. 프로세스를 늘리면
 *    `BEGIN IMMEDIATE`가 서로 기다리고, {@link BUSY_TIMEOUT_MS}를 넘기면 `SQLITE_BUSY`가
 *    `append` 밖으로 튀어나온다 — 그 순간 클라이언트는 `§1.5` 표에 없는 실패를 본다.
 *    처리량도 워커 수에 비례해 늘지 않는다.
 * 2. **subscribe의 새 이벤트 알림.** 후속 subscribe 조각이 *"새 이벤트가 생겼다"* 를
 *    이 프로세스 안(= `append` 호출)에서 알아채도록 만들면, **다른 프로세스가 쓴 이벤트는 그
 *    신호를 만들지 않는다.** 그 구독자는 `§4.4`가 금지한 조용한 누락을 겪는다 — 스트림은 계속
 *    열려 있는데 이벤트만 오지 않으므로 클라이언트가 알아챌 방법도 없다. 워커를 늘리는 날 이
 *    알림은 프로세스 밖(폴링·외부 큐)으로 옮겨야 한다.
 * 3. **WAL의 공유 메모리(`-shm`).** DB 파일을 네트워크 파일시스템에 두거나 컨테이너 경계를
 *    넘겨 공유하면 잠금 자체가 성립하지 않는다. 그때 깨지는 것은 위 둘이 아니라 `§2.1`·`§2.2`
 *    **전부**다.
 */

import { Buffer } from 'node:buffer'
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'

import type { AppendEvent } from './event.js'
import type { PullEvent, PullPage } from './pull.js'
import type { CursorStart } from './request.js'

/**
 * `SQLITE_CONSTRAINT_UNIQUE`. `UNIQUE` 제약 위반의 확장 결과코드이고, #15 결정의 부수 실측이
 * 이 값으로 dedup을 분류할 수 있음을 확인했다.
 *
 * 이 테이블의 `UNIQUE`는 `(log_id, event_id)` **하나뿐이므로** 이 코드는 모호하지 않다
 * (기본키 충돌은 `1555`/`SQLITE_CONSTRAINT_PRIMARYKEY`로 따로 온다). 스키마에 `UNIQUE`를
 * 하나 더 추가하는 사람은, 그 순간 이 분류가 **조용히 넓어져** 다른 제약 위반까지
 * `duplicate`로 둔갑한다는 것을 알아야 한다.
 */
const SQLITE_CONSTRAINT_UNIQUE = 2067

/**
 * 잠금 대기 상한. 단일 프로세스 전제에서는 도달하지 않는다 — 한 연결의 트랜잭션은 서로
 * 겹치지 않기 때문이다(파일 상단 doc의 *"본문에 `await`가 없다"*).
 *
 * 그런데도 0이 아닌 값을 두는 이유는 둘이다: (1) 테스트 ①②가 자식 프로세스 둘로 실제 경쟁을
 * 만들고, 그때 대기 없이 곧장 `SQLITE_BUSY`가 나면 검증하려던 계약이 아니라 잠금 실패를 보게
 * 된다. (2) 운영에서 백업·점검 도구가 잠깐 파일을 잡는 경우를 이 시간 안에서 흡수한다.
 * **이 값이 커진다고 다중 프로세스가 지원되는 것은 아니다** — 위 doc의 2·3번은 대기로 해결되지
 * 않는다.
 */
const BUSY_TIMEOUT_MS = 5000

/**
 * 스키마 버전. 열 때 이보다 **높은** 버전이 적혀 있으면 열지 않는다 — 나중 스키마를 예전 코드가
 * 읽으면 컬럼 하나가 조용히 무시되는 형태로 틀리고, 그 틀림은 로그에 남는다(append-only라
 * 되돌릴 수 없다). `§3.2`가 *"저장소가 재구축돼 커서 표현이 바뀐 경우"* 를 미지 커서의 발생
 * 경로로 이미 적고 있으므로, 스키마가 언젠가 움직인다는 것은 전제된 사실이다.
 */
const SCHEMA_VERSION = 1

/**
 * `limit`이 주어지지 않은 pull의 페이지 크기.
 *
 * **부재는 "무제한"이 아니다.** 무제한으로 읽으면 로그 전체가 한 번에 메모리에 올라오고, 그것은
 * 큰 로그에서 서버가 죽는 경로다. `§3.1`은 *"`limit`은 페이지 크기일 뿐 필터가 아니다"* 로
 * 잘려나간 이벤트가 다음 페이지에 그대로 있음을 보장하고, `hasMore`+`cursor`가 그 이어받기를
 * 가능하게 하므로 — 기본 페이지 크기를 두는 것은 아무것도 감추지 않는다.
 *
 * 배포가 조절하는 손잡이는 이 값이 아니라 `request.ts`의 `maxLimit`이다 (`§3.1` L304).
 * 여기 오는 `limit`은 이미 그 상한을 통과한 값이므로 이 파일은 그 위에 **또 다른 상한을 얹지
 * 않는다** — 얹으면 배포가 설정한 값을 스토어가 조용히 뒤집는다.
 */
export const DEFAULT_PAGE_LIMIT = 500

/**
 * `limit`으로 받아들이는 상한. `LIMIT`에 실을 수 있는 정수의 안전 구간을 넘지 않게만 두는
 * 값이고, 페이지 정책이 아니다 (정책은 `maxLimit`이다 — {@link DEFAULT_PAGE_LIMIT}).
 */
const MAX_ACCEPTED_LIMIT = 0x7fffffff

/** 커서로 받아들이는 10진수의 최대 자릿수. 이 이상은 파싱하지 않고 **미지 커서**다. */
const MAX_CURSOR_DIGITS = 19

/**
 * 이 스토어가 낼 수 있는 실패의 이유. **새 에러 `code`가 아니다** — `errors.ts`의 doc이
 * `§1.5` 표에 없는 code를 만드는 것을 금지한다. 이것은 부르는 쪽이 분기하는 내부 사유이고,
 * 상태코드를 고르는 것은 라우트를 가진 조각의 몫이다.
 *
 * 전부 **고정 문자열**이고 `payload` 원문도 커서 값도 담지 않는다 (`§1.5` L145-146 MUST NOT) —
 * 그대로 로그에 찍히거나 에러 봉투로 나가도 새는 것이 없다.
 *
 * **이것이 이 스토어에서 나올 수 있는 예외의 전부는 아니다.** `node:sqlite` 자신의 예외(디스크
 * 부족·`SQLITE_BUSY` 등)는 그대로 올라간다 — 감싸서 삼키면 원인이 사라지기 때문이다. 그 예외의
 * `message`는 SQLite가 만든 문자열이고 바인딩된 값을 담지 않지만, **부르는 쪽이 그것을 에러
 * 봉투에 그대로 옮기지는 마라**: `§1.5` L145-146이 금지하는 것은 payload 원문이고, 그 규칙을
 * 지키는 가장 싼 방법은 스토어 밖으로 나가는 `message`를 고정 문자열로 갈아 끼우는 것이다.
 */
export type EventStoreFailure =
  /** 열린 DB의 `journal_mode`/`synchronous`가 요구값이 아니다 (`§2.2`를 보장할 수 없다) */
  | 'durability_pragmas_not_applied'
  /** DB에 적힌 스키마 버전이 이 코드보다 높다 */
  | 'schema_version_too_new'
  /** `events`가 비어 있다 (`§2.1` L204-206 — 빈 요청은 `400`이지 `200`이 아니다) */
  | 'empty_batch'
  /** `payload` 조각이 비었거나 공백뿐이다 — 기록하면 그 로그의 pull이 영구히 깨진다 */
  | 'blank_payload'
  /** `payload` 조각이 UTF-8 왕복에서 보존되지 않는다 (`§1.3` L96 MUST를 만족시킬 수 없다) */
  | 'payload_not_byte_preserving'
  /** `limit`이 양의 안전 정수가 아니다 */
  | 'invalid_page_limit'
  /** DB가 돌려준 행의 모양이 스키마와 다르다 */
  | 'unexpected_row_shape'
  /** `UNIQUE` 위반을 받았는데 먼저 저장돼 있던 사본을 찾을 수 없다 */
  | 'duplicate_without_stored_copy'

/**
 * 스토어의 실패. `message`는 {@link EventStoreFailure}와 같은 고정 문자열이고, 클라이언트가
 * 보낸 값(`payload`·`id`·커서)은 어느 필드에도 싣지 않는다.
 */
export class EventStoreError extends Error {
  readonly reason: EventStoreFailure

  constructor(reason: EventStoreFailure) {
    super(reason)
    this.name = 'EventStoreError'
    this.reason = reason
  }
}

/**
 * 로그에 자리를 얻은 이벤트 하나. `§2.1`의 `AppendResponse`가 `accepted`·`duplicate` 양쪽에
 * 싣는 모양 그대로다 (`{ id, cursor }`).
 */
export type StoredEventRef = {
  readonly id: string
  /** {@link EventStore.readPage}가 해석할 수 있는 커서 (알파벳은 {@link encodeCursor}). */
  readonly cursor: string
}

/**
 * `§2.1`의 append 응답 본문 그대로다.
 *
 * `accepted`는 **요청 배열 순서**를 보존한다 (L193 MUST). `duplicate`의 `cursor`는 **먼저
 * 저장돼 있던 사본**의 커서다 (L194 — 이번 요청이 위치를 바꾸지 않는다). 부분 실패를 표현하는
 * 모양이 없는 것은 `event.ts`의 `AppendRequestResult`와 같은 이유다: `§2.1` L207-208이
 * all-or-nothing을 MUST로 적었고, 실패는 값이 아니라 예외({@link EventStoreError})다.
 */
export type AppendResult = {
  readonly accepted: readonly StoredEventRef[]
  readonly duplicate: readonly StoredEventRef[]
}

/**
 * 로그를 들고 있는 것. **`Promise`를 돌려주는 것이 계약**이고 동기 구현은 그 뒤에 있다
 * (파일 상단 doc *"인터페이스가 async인 이유"*).
 *
 * 표면이 셋뿐인 것은 의도적이다 — 라우트가 필요로 하는 판정(`hasMore`, 미지 커서, `from`)을
 * 라우트가 **다시 계산하지 않도록** 이 조각이 답한다. 그래서 {@link readPage}는 `pull.ts`의
 * `PullPage`를 그대로 돌려준다: pull 라우트가 할 일은 그 값을 `serializePullResponse`에
 * 넘기는 것뿐이고, 정렬도 자르기도 `from` 판정도 라우트에 없다.
 */
export type EventStore = {
  /**
   * 이벤트들을 로그 끝에 붙인다 (`§2.1`). **한 요청 = 한 트랜잭션**이고, 커밋이 돌아오면
   * 내구화가 끝나 있다 (`§2.2`).
   *
   * @param logId `§1.1` 정규식을 통과한 로그 식별자. 이 값은 항상 **동등 조건**으로만 쓰인다 —
   *   비어 있거나 미지의 값이면 아무 로그에도 걸리지 않을 뿐, 조건이 통째로 꺼져 다른 로그의
   *   이벤트에 닿는 경로는 이 파일에 없다.
   * @param events `event.ts`의 게이트를 통과한 이벤트들, **요청 배열 순서 그대로**.
   * @throws {EventStoreError} 배열이 비었거나(`empty_batch`) 기록할 수 없는 `payload`가
   *   섞여 있으면 — 그때 이 요청의 이벤트는 **하나도** 남지 않는다.
   */
  append(logId: string, events: readonly AppendEvent[]): Promise<AppendResult>

  /**
   * 커서 이후 한 페이지를 읽는다 (`§3.1`·`§3.2`).
   *
   * @param limit 페이지 크기. 부재면 {@link DEFAULT_PAGE_LIMIT}이고, **무제한이 아니다.**
   * @throws {EventStoreError} `limit`이 양의 안전 정수가 아니면 (`invalid_page_limit`).
   */
  readPage(logId: string, start: CursorStart, limit?: number): Promise<PullPage>

  /** 연결을 닫는다. 두 번 불러도 안전하다. */
  close(): Promise<void>
}

/**
 * 스키마.
 *
 * - **`seq INTEGER PRIMARY KEY AUTOINCREMENT`** — `§1.4`의 전순서를 떠받치는 단조 증가 정수
 *   하나다. `AUTOINCREMENT` 없이도 rowid는 증가하지만, 그 경우 **행이 지워지면 값이 재사용될
 *   수 있다.** 보존(retention)은 `§8` 미결 6이라 지금은 지우는 코드가 없지만, 그것이 언젠가
 *   생기는 날 재사용된 `seq`는 **클라이언트가 들고 있던 옛 커서가 조용히 다른 이벤트를 가리키게**
 *   만든다 — 미지 커서로도 잡히지 않는 형태의 오류다. `AUTOINCREMENT`가 그 경로를 없앤다.
 * - **`UNIQUE (log_id, event_id)`** — `§2.1`의 원자적 dedup을 강제하는 것이 이 한 줄이다.
 *   dedup 판정은 코드가 아니라 이 제약이 한다.
 * - **`payload BLOB`** — `§1.3`의 바이트 보존. 원문 슬라이스를 UTF-8 바이트로 넣고 그대로 꺼낸다.
 * - **`STRICT`** — 선언한 타입을 SQLite가 강제한다. 이게 없으면 `payload` 자리에 TEXT가
 *   들어가도 통과하고, TEXT는 인코딩 정규화가 개입할 수 있는 자리다.
 * - **`events_log_seq` 인덱스** — 페이지 읽기(`WHERE log_id = ? AND seq > ? ORDER BY seq`)가
 *   `UNIQUE (log_id, event_id)` 인덱스로는 정렬을 못 받기 때문에 따로 둔다.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  log_id   TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload  BLOB NOT NULL,
  UNIQUE (log_id, event_id)
) STRICT;

CREATE INDEX IF NOT EXISTS events_log_seq ON events (log_id, seq);
`

/**
 * 커서 인코딩 — **`seq`의 10진수 표기**다. 쓰는 알파벳은 `0-9` **뿐이다.**
 *
 * `after=<cursor>`는 `application/x-www-form-urlencoded` 쿼리로 다니고 `request.ts`의
 * `queryValue`가 표준 디코딩을 하므로, 커서에 `+`가 있으면 **공백이 되어 돌아온다**
 * ([#15의 14:31 커서 알파벳 제약](https://github.com/shakystar/mori-nest/issues/15#issuecomment-5193789043)).
 * `0-9`에는 `+`·공백·`&`·`=`·`%`·`#`가 하나도 없으므로 인코딩이 항등이고, 왕복이 자명하게
 * 안전하다. (표준 base64는 `+`·`/`·`=`를 쓰므로 이 자리에 쓸 수 없다.)
 *
 * 클라이언트에게 이 값은 여전히 **불투명**하다 — `§1.4`가 만들지도 파싱하지도 대소 비교하지도
 * 말라고 MUST NOT으로 적었고, 서버가 위치를 커서에 싣는 것은 같은 절이 명시적으로 허용한다.
 * 다만 관측 가능한 성질 하나를 여기 적어 둔다: `seq`는 **DB 전체에서 단조 증가**하므로(#15
 * 결정 §함께 정하는 것 — DB는 전체 하나, 로그 구분은 `log_id` 컬럼), 한 로그의 커서 두 개
 * 사이의 간격은 그 사이에 **다른 로그들이 쓴 이벤트 수**를 드러낸다. 이것은 결정이 고른
 * 구조(전체 하나의 DB + 단조 증가 정수 하나)에서 따라오는 성질이고 자격증명이나 payload가
 * 아니지만, 로그 사이를 완전히 가리려면 커서를 로그별 시퀀스로 바꿔야 한다 — 그 변경은
 * `§3.2`의 미지 커서 경로가 이미 흡수한다(재구축된 커서 표현은 미지 커서다).
 */
function encodeCursor(seq: number): string {
  return String(seq)
}

/**
 * 커서를 `seq`로 되돌린다. 해석할 수 없으면 `null` — **에러가 아니다** (`§3.2`가 미지 커서를
 * 에러로 만드는 것을 MUST NOT으로 금지했다).
 *
 * 엄격하게 본다: 앞자리 `0`·부호·공백·소수점·지수 표기를 전부 거른다. 느슨하게 파싱하면
 * `" 12"`·`"+12"`·`"12.0"`이 전부 같은 자리를 가리키게 되어, 불투명해야 할 커서에 클라이언트가
 * 만들어 낼 수 있는 표현이 여럿 생긴다.
 */
function decodeCursor(cursor: string): number | null {
  if (!/^[1-9][0-9]*$/.test(cursor) || cursor.length > MAX_CURSOR_DIGITS) {
    return null
  }
  const seq = Number(cursor)
  return Number.isSafeInteger(seq) ? seq : null
}

/**
 * `INSERT`가 돌려준 rowid를 `seq`로 좁힌다. `node:sqlite`는 이 값을 `number | bigint`로
 * 돌려주므로 좁히는 자리가 필요하다 — 안전 정수를 벗어나면 커서가 두 `seq`를 같은 문자열로
 * 표기하게 되고, 그때 커서는 조용히 잘못된 자리를 가리킨다.
 */
function toSeq(rowid: number | bigint): number {
  const seq = typeof rowid === 'bigint' ? Number(rowid) : rowid
  if (!Number.isSafeInteger(seq) || seq <= 0) {
    throw new EventStoreError('unexpected_row_shape')
  }
  return seq
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { errcode?: unknown }).errcode === SQLITE_CONSTRAINT_UNIQUE
  )
}

/** 행에서 정수 컬럼 하나를 꺼낸다. 모양이 다르면 fail-closed. */
function columnAsSeq(value: SQLOutputValue | undefined): number {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return toSeq(value)
  }
  throw new EventStoreError('unexpected_row_shape')
}

/**
 * 저장된 행 하나를 `pull.ts`가 쓰는 이벤트로 되돌린다.
 *
 * `payload`는 BLOB(= 넣을 때의 UTF-8 바이트)이고, 여기서 UTF-8로 디코드한 것이 **넣은 원문
 * 조각과 같은 문자열**이다 — {@link SqliteEventStore.append}가 넣기 전에 그 왕복을 검사해
 * 통과한 것만 기록하기 때문이다 (`§1.3` L96 MUST).
 */
function toPullEvent(row: Record<string, SQLOutputValue>): PullEvent {
  const eventId = row['event_id']
  const payload = row['payload']
  if (typeof eventId !== 'string' || !(payload instanceof Uint8Array)) {
    throw new EventStoreError('unexpected_row_shape')
  }
  return {
    id: eventId,
    payload: Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8'),
    cursor: encodeCursor(columnAsSeq(row['seq'])),
  }
}

/**
 * `journal_mode=WAL`·`synchronous=FULL`을 **연결을 열 때마다** 걸고, **걸렸는지 되읽어
 * 확인한다** (#15 결정 실측 ②가 이 조합으로 `§2.2`를 통과시켰다).
 *
 * `journal_mode`는 DB 파일에 남지만 `synchronous`는 **연결마다** 다시 걸어야 하는 값이라,
 * 이 함수를 열 때마다 부르지 않으면 두 번째 연결부터 기본값(`NORMAL`)으로 조용히 되돌아간다.
 * 그 회귀는 kill -9로는 드러나지 않고 전원 차단에서만 드러난다 — 즉 **테스트가 초록인 채로**
 * `§2.2`가 깨진다. 그래서 거는 것으로 끝내지 않고 되읽어 대조하고, 다르면 연결을 **열지
 * 않는다**: 내구성을 보장할 수 없는 스토어는 `§2.2` 기준으로 없느니만 못하다.
 *
 * 되읽기가 `:memory:` DB를 배제한다는 것은 의도한 결과다 — WAL을 지원하지 않는 저장 방식으로
 * 이 스토어를 열면 `§2.2`가 성립하지 않는다.
 */
function applyDurabilityPragmas(db: DatabaseSync): void {
  // `busy_timeout`이 **맨 먼저**다. `journal_mode` 전환은 짧게나마 잠금을 요구하므로, 대기
  // 시간을 그 뒤에 걸면 다른 프로세스가 파일을 잡고 있는 순간에 `SQLITE_BUSY`로 곧장 튄다 —
  // 대기하라고 둔 값이 정작 대기가 필요한 첫 구문에는 적용되지 않는 형태다.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')

  const journalMode = db.prepare('PRAGMA journal_mode').get()?.['journal_mode']
  const synchronous = db.prepare('PRAGMA synchronous').get()?.['synchronous']
  // `synchronous`는 이름이 아니라 숫자로 돌아온다. `FULL` = 2.
  if (journalMode !== 'wal' || synchronous !== 2) {
    throw new EventStoreError('durability_pragmas_not_applied')
  }
}

function applySchema(db: DatabaseSync): void {
  const version = db.prepare('PRAGMA user_version').get()?.['user_version']
  if (typeof version !== 'number' && typeof version !== 'bigint') {
    throw new EventStoreError('unexpected_row_shape')
  }
  if (Number(version) > SCHEMA_VERSION) {
    throw new EventStoreError('schema_version_too_new')
  }
  db.exec(SCHEMA)
  // 값 바인딩이 불가능한 자리(PRAGMA)라 문자열을 잇는다. 상수이고 클라이언트 입력이 아니다.
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}

/** `limit` 부재/유효성 판정. */
function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_PAGE_LIMIT
  }
  // SQLite는 **음수 `LIMIT`을 "제한 없음"으로 해석한다.** 즉 여기서 거르지 않으면 잘못된
  // `limit` 하나가 페이지 크기를 통째로 꺼 버리고, 로그 전체가 한 응답에 실린다.
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ACCEPTED_LIMIT) {
    throw new EventStoreError('invalid_page_limit')
  }
  return limit
}

/** `node:sqlite` 위의 {@link EventStore} 구현. 메서드 본문에 `await`가 없다 (파일 상단 doc). */
class SqliteEventStore implements EventStore {
  readonly #db: DatabaseSync
  readonly #insert: StatementSync
  readonly #selectSeqById: StatementSync
  readonly #selectSeqExists: StatementSync
  readonly #selectPage: StatementSync
  #closed = false

  constructor(db: DatabaseSync) {
    this.#db = db
    this.#insert = db.prepare('INSERT INTO events (log_id, event_id, payload) VALUES (?, ?, ?)')
    // 이 SELECT는 **선판정이 아니다.** `UNIQUE` 제약이 이미 "이미 있다"를 판정한 뒤, `§2.1`
    // L194가 요구하는 *"먼저 저장돼 있던 사본의 커서"* 를 가져오려고 부른다. 부르는 자리는
    // {@link append}의 `catch` 안 하나뿐이고, 같은 트랜잭션 안이라 그 사이에 값이 바뀌지 않는다.
    this.#selectSeqById = db.prepare('SELECT seq FROM events WHERE log_id = ? AND event_id = ?')
    // 커서 해석(`§3.2`). 다른 로그의 `seq`를 보내면 `log_id`가 걸러 **미지**가 된다 (`§1.4` —
    // *"다른 로그의 커서를 보내면 미지 커서로 취급된다"*).
    this.#selectSeqExists = db.prepare('SELECT 1 AS ok FROM events WHERE log_id = ? AND seq = ?')
    // `§3.1` L307-311: 커서 해석·정렬이 **끝난 뒤** 앞에서부터 취한다. `LIMIT ?`에 한 건을 더
    // 얹어 읽는 것이 `hasMore` 판정이다 — 별도의 `COUNT(*)`를 돌리면 그 사이에 append가 끼어
    // 개수와 페이지가 서로 다른 순간을 가리킬 수 있다.
    this.#selectPage = db.prepare(
      'SELECT seq, event_id, payload FROM events WHERE log_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
    )
  }

  async append(logId: string, events: readonly AppendEvent[]): Promise<AppendResult> {
    // `§2.1` L204-206: 빈 요청은 `400`이고 `200`이 아니다. `event.ts`가 이미 거르지만, 여기서
    // 통과시키면 "아무것도 검사하지 않은 것"이 `{accepted: [], duplicate: []}`라는 **성공**으로
    // 보이는 형태가 계약에 남는다.
    if (events.length === 0) {
      throw new EventStoreError('empty_batch')
    }

    const accepted: StoredEventRef[] = []
    const duplicate: StoredEventRef[] = []

    // `BEGIN IMMEDIATE`인 것은 이 트랜잭션이 반드시 쓰기 때문이다. 지연 트랜잭션(`BEGIN`)은
    // 첫 쓰기 시점에 잠금을 올리다 실패할 수 있고, 그 실패는 이미 몇 건을 처리한 뒤에 온다.
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      // 요청 배열 순서 그대로다 (`§1.4` MUST). `seq`가 삽입 순서로 늘어나므로 이 루프의
      // 순서가 곧 로그의 전순서 위 자리다 — 정렬하거나 묶어서 넣지 않는다.
      for (const event of events) {
        this.#insertOne(logId, event, accepted, duplicate)
      }
      // 커밋이 돌아온 시점이 `§2.2`의 *"내구화 완료"* 다 — `synchronous=FULL`이라 커밋은 WAL
      // 프레임이 디스크에 닿은 뒤에 돌아온다. 부르는 쪽은 이 `Promise`가 resolve된 **뒤에**
      // `200`을 쓴다.
      this.#db.exec('COMMIT')
    } catch (error) {
      // `§2.1` L207-208의 all-or-nothing. 예외가 어디서 났든 — `payload` 검사, `INSERT`,
      // `COMMIT` 자체 — 이 요청의 이벤트는 하나도 남지 않는다.
      this.#rollbackQuietly()
      throw error
    }

    return { accepted, duplicate }
  }

  async readPage(logId: string, start: CursorStart, limit?: number): Promise<PullPage> {
    const take = resolveLimit(limit)
    const { from, afterSeq } = this.#resolveStart(logId, start)

    // 커서 해석과 페이지 읽기는 **트랜잭션으로 묶지 않는다.** 두 구문 사이에 append가 끼면
    // 그 이벤트가 이 페이지에 실릴 수 있는데, 로그가 append-only라 그 방향의 어긋남은
    // **과잉 전달**뿐이다 — 조용한 누락은 구조적으로 불가능하다(자리는 확정되면 바뀌지 않고
    // 지워지지도 않는다, `§1.4`). `§3.2`가 *"덜 주는 것보다 더 주는 것이 안전하다"* 로 그
    // 방향을 명시했으므로 여기에 스냅샷 트랜잭션을 얹지 않는다. 얹으려는 사람은 그것이
    // 무엇을 고치는지 먼저 적어야 한다.

    // 한 건을 더 읽어 `hasMore`를 정한다 (`§3.1` L293). `hasMore`가 참이면 `events`는 비어
    // 있지 않다 (L303 MUST) — `take ≥ 1`이므로 그 성질이 구조로 성립한다.
    const rows = this.#selectPage.all(logId, afterSeq, take + 1)
    const hasMore = rows.length > take
    const page = hasMore ? rows.slice(0, take) : rows

    return { events: page.map(toPullEvent), hasMore, from }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return
    }
    this.#closed = true
    this.#db.close()
  }

  /** 이벤트 하나를 기록하거나 `duplicate`로 분류한다. **선판정 없이** 제약이 판정한다. */
  #insertOne(
    logId: string,
    event: AppendEvent,
    accepted: StoredEventRef[],
    duplicate: StoredEventRef[],
  ): void {
    const payload = encodePayload(event.payload)
    try {
      const changes = this.#insert.run(logId, event.id, payload)
      accepted.push({ id: event.id, cursor: encodeCursor(toSeq(changes.lastInsertRowid)) })
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error
      }
      // first-write-wins (`§2.1` L194): 이번 요청은 위치를 바꾸지 않고, 먼저 저장돼 있던
      // 사본의 커서를 그대로 돌려준다. payload 바이트는 **비교하지 않는다** (L192-193 —
      // 같은 id로 다른 바이트를 밀면 먼저 것이 남는다).
      const row = this.#selectSeqById.get(logId, event.id)
      if (row === undefined) {
        // `UNIQUE`가 충돌했는데 그 행이 없다 — 도달하면 안 되는 상태다. 통과시키지 않는다.
        throw new EventStoreError('duplicate_without_stored_copy')
      }
      duplicate.push({ id: event.id, cursor: encodeCursor(columnAsSeq(row['seq'])) })
    }
  }

  /**
   * `§3.2`의 시작점 판정. 미지 커서는 **에러가 아니라** `from: "unknown"` + 로그의 처음이다
   * (MUST) — 현재 head부터 주는 것은 MUST NOT이므로 `afterSeq`가 `0`인 것이 그 조항이다.
   */
  #resolveStart(logId: string, start: CursorStart): { from: PullPage['from']; afterSeq: number } {
    if (start.kind === 'beginning') {
      return { from: 'beginning', afterSeq: 0 }
    }
    const seq = decodeCursor(start.cursor)
    if (seq === null) {
      return { from: 'unknown', afterSeq: 0 }
    }
    // 존재 확인은 **이 로그 안에서만** 한다. 다른 로그의 커서는 `seq`가 실재해도 여기서
    // 걸러져 미지가 된다 (`§1.4`).
    if (this.#selectSeqExists.get(logId, seq) === undefined) {
      return { from: 'unknown', afterSeq: 0 }
    }
    return { from: 'known', afterSeq: seq }
  }

  /**
   * 롤백은 실패해도 삼킨다 — 이미 롤백된 트랜잭션(제약 위반이 트랜잭션을 자동으로 접은 경우)에
   * `ROLLBACK`을 부르면 그 자체가 예외이고, 그 예외가 원래 실패를 **가려 버린다.**
   */
  #rollbackQuietly(): void {
    try {
      this.#db.exec('ROLLBACK')
    } catch {
      // 트랜잭션이 이미 열려 있지 않다. 원래 예외를 그대로 올린다.
    }
  }
}

/**
 * `payload` 원문 조각을 저장할 바이트로 만든다.
 *
 * 두 가지를 여기서 **거부**한다. 둘 다 `event.ts`의 게이트를 통과한 값에는 나타날 수 없으므로
 * (`event.ts`의 스캐너는 빈 범위를 돌려주지 않고, 원문 조각은 유효한 UTF-8 본문에서 잘라낸
 * 것이다) 도달하면 부르는 쪽의 결함이다. `event.ts`가 스캐너와 파서의 판정이 갈렸을 때
 * `500`으로 닫은 것과 같은 규율이다 — **통과시키는 쪽으로 무너지지 않는다.**
 *
 * 1. **비었거나 공백뿐인 조각.** 기록하면 `pull.ts`가 그 페이지를 영구히 직렬화하지 못한다
 *    (`empty_payload`) — 로그는 append-only라 그 이벤트를 지울 수도 없으므로, 그 로그의 pull은
 *    **영원히** 깨진다. 판정을 `pull.ts`와 같은 술어(`trim() === ''`)로 맞춘다.
 * 2. **UTF-8 왕복에서 보존되지 않는 조각.** `§1.3` L96은 받은 바이트 그대로 돌려주라는 MUST고,
 *    보존되지 않는 조각을 기록하면 그 MUST를 **만족시킬 방법이 없는** 이벤트가 로그에 남는다.
 *    디코드 한 번이 그 사실을 기록 **전에** 알려 준다.
 */
function encodePayload(payload: string): Buffer {
  if (payload.trim() === '') {
    throw new EventStoreError('blank_payload')
  }
  const bytes = Buffer.from(payload, 'utf8')
  if (bytes.toString('utf8') !== payload) {
    throw new EventStoreError('payload_not_byte_preserving')
  }
  return bytes
}

/**
 * 스토어를 연다. `path`의 DB가 없으면 만들고, 있으면 스키마를 맞춘다.
 *
 * @param path DB 파일 경로. **`:memory:`는 쓸 수 없다** — WAL을 걸 수 없어
 *   {@link applyDurabilityPragmas}가 거부한다 (그것이 의도다).
 * @throws {EventStoreError} 내구성 PRAGMA가 적용되지 않았거나
 *   (`durability_pragmas_not_applied`) 스키마 버전이 이 코드보다 높으면
 *   (`schema_version_too_new`).
 */
export async function openEventStore(path: string): Promise<EventStore> {
  const db = new DatabaseSync(path)
  try {
    applyDurabilityPragmas(db)
    applySchema(db)
  } catch (error) {
    // 반쯤 열린 연결을 남기지 않는다 — 남기면 파일 잠금이 잡힌 채로 다음 시도가 온다.
    db.close()
    throw error
  }
  return new SqliteEventStore(db)
}
