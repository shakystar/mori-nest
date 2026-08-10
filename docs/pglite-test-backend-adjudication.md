# PGlite(`@electric-sql/pglite`) 테스트 백엔드 검토 — 산정

**이것은 스펙이 아니다.** `docs/design/0000`–`0003`이 스펙이고, 이 문서는 *PGlite를 시험
백엔드로 갈아 끼우면 무엇이 부딪히는가*를 재는 산정이다. 그래서 `docs/design/` 밖에 있고
번호도 붙이지 않는다 — `replica-identity-and-join-adjudication.md`·
`selective-removal-and-retention-adjudication.md`와 같은 자리, 같은 형식이다. 이 조각은
**스펙 문면도 코드도 옮기지 않는다** — `src/`·`docs/design/` 변경 0줄. 판정은 owner에게
올리는 **권고**다(비범위 참고).

근거 이슈: mori-nest [#141](https://github.com/shakystar/mori-nest/issues/141)
(= [#68](https://github.com/shakystar/mori-nest/issues/68) 항목 6, UoW 넷(#130~#133) 착지
후속).

---

## 0. 기준점

### 0.1 기준 커밋

**`b89c716`** (착수 시점 `main`. UoW 넷 — #130(PR #135)·#131(PR #137)·#132(PR #138)·
#133(PR #139) — 전부 머지된 상태. 열린 PR 0건).

이 문서의 모든 `파일:줄` 인용은 이 커밋에서 직접 열어 확인한 것이다. 이 조각은 `src/`를
한 줄도 고치지 않으므로(비범위) 줄 밀림 표는 없다.

### 0.2 인용 관례

`CONTRIBUTING.md` 「파일:줄 인용 관례」를 따른다 — 리포 루트 상대 경로 + `:줄`, 같은
문서 안에서 반복 인용하는 파일은 파일명이 이미 나온 뒤로 `:줄`만으로 줄인다. 이 조각이
인용하는 것은 스펙 문서(`0002`·`0003`)가 아니라 **구현 파일**이므로 절 번호가 아니라
줄 번호가 유일한 앵커다. 전체 경로는 §부록에 모은다.

### 0.3 「부딪히는 자리」를 고르는 기준

이슈 #141이 최소 넷을 지정했다 — `src/control/db.ts`의 `DatabaseSync`·`exec`·`prepare`,
`BEGIN IMMEDIATE` 잠금 의미, 스토어들의 `run()` 반환값 `changes` 판정, 오류 식별
(`SQLITE_*` 코드). 이 산정은 그 넷을 §Q1~§Q4로, PGlite의 동기/비동기 모양(이슈가 "핵심"
이라 지목한 것)을 §Q5로 잰다.

---

## Q1 — `db.ts`의 `DatabaseSync`·`exec`·`prepare`

### Q1.1 오늘 코드

`src/control/db.ts:93`가 `node:sqlite`의 `DatabaseSync`를 유일한 가져오기 자리로 못박는다
(파일 상단 doc, `db.ts:121-122`: *"`DatabaseSync` 인스턴스가 만들어지는 자리는
`openControlDatabase` 하나뿐이다"*). 연결은 동기 메서드 셋 위에 서 있다:

- `db.exec(sql)` — PRAGMA·`BEGIN`/`COMMIT`/`ROLLBACK` 실행 (`db.ts:164-170`, `213`, `216`,
  `236`).
- `db.prepare(sql).get()` — 되읽기 확인 (`db.ts:172-173`).
- 리포지토리는 `connection.prepare(sql)`로 준비문을 만들고 `.run()`/`.get()`/`.all()`을
  동기로 부른다(`store.ts`·`workspace-store.ts`·`credential.ts`·`idempotency.ts` 전체).

**결정적인 성질 하나** — 이 셋(`exec`·`prepare().get/all/run`)은 전부 **값을 즉시
반환한다.** `Promise`가 어디에도 없다. `ControlDatabase.withTransaction`의 본문이
"동기이면 이 구현은 `await`를 한 번도 하지 않는다"(`db.ts:61-63`)는 성질은 이 동기
드라이버 위에서만 공짜다.

### Q1.2 PGlite에서 어떻게 되는가

PGlite(`@electric-sql/pglite` `0.5.4`)는 `.query()`·`.exec()` 두 메서드를 준다. 공식
문서 [PGlite API](https://pglite.dev/docs/api)(확인: 2026-08-10 12:30 UTC)의 시그니처:

```
.query<T>(query: string, params?: any[], options?: QueryOptions): Promise<Results<T>>
.exec(query: string, options?: QueryOptions): Promise<Array<Results>>
```

**둘 다 `Promise`를 돌려준다.** `db.prepare(sql).get()`처럼 문장을 준비해 두고 동기로
반복 실행하는 API가 없다 — PGlite에는 `prepare()`에 대응하는 것이 아예 없고, 매 호출이
`query`/`exec`이며 매 호출이 비동기다. `DatabaseSync`·`StatementSync` 자리에 넣을 동형
교체물이 없다는 뜻이다. 자세한 결과는 §Q5(핵심 판정)로 넘긴다 — 여기서는 API 모양만
확인한다.

**판정: 부딪힌다.** 자리 자체(연결을 여는 지점, `db.ts:93` import)는 옮겨 쓸 수 있지만,
그 위에 얹힌 전 구현(§Q1.1의 동기 메서드 체인)이 PGlite 위에서 성립하지 않는다.

---

## Q2 — `BEGIN IMMEDIATE` 잠금 의미

### Q2.1 오늘 코드가 기대는 성질

`db.ts:213`가 트랜잭션을 `BEGIN IMMEDIATE`로 연다. 그 이유가 `db.ts:136-139`에 있다:

> `BEGIN IMMEDIATE`인 것은 쓰기 락을 처음부터 잡아 «읽고 나서 승격»에서 나는
> `SQLITE_BUSY` 실패를 없애기 위해서다.

이것은 **SQLite의 파일 잠금 모델**(하나의 라이터, `IMMEDIATE`가 트랜잭션 시작 시점에
그 잠금을 선점)에 기댄 표현이다. `BUSY_TIMEOUT_MS`(`db.ts:96`)와 `SQLITE_BUSY`/
`SQLITE_LOCKED`를 `503 unavailable`로 옮기는 `server.ts:240-244`도 같은 모델 위에
서 있다.

### Q2.2 PGlite에서 어떻게 되는가

PostgreSQL(따라서 그 WASM 빌드인 PGlite도)에는 `BEGIN IMMEDIATE`라는 구문이 **없다.**
PostgreSQL의 잠금은 MVCC 기반이고, 즉시 쓰기 잠금을 원하면 `SELECT ... FOR UPDATE`나
`LOCK TABLE` 같은 다른 구문을 쓴다 — `BEGIN`의 옵션이 아니라 별개의 문장이다. 게다가
검색 결과([PGlite Multi-tab Worker 문서](https://pglite.dev/docs/multi-tab-worker),
[GitHub electric-sql/pglite#324](https://github.com/electric-sql/pglite/issues/324) —
확인: 2026-08-10 12:30 UTC)가 확인하듯 **PGlite 자체가 단일 연결 전용**이다(Postgres
"single-user mode"로 뜬다) — SQLite의 "단일 라이터, 다중 리더"와도 다르고, 목표 엔진인
실제 다중연결 PostgreSQL과도 다르다. 즉 PGlite는 SQLite식 파일 잠금도, 목표인 PostgreSQL의
행 단위 MVCC 동시성도 아닌 **세 번째 모델**(단일 연결이라 잠금 경합 자체가 발생하지
않는다)이다.

**판정: 부딪힌다 — 그리고 이관 목적에 도움이 안 되는 방향으로.** `BEGIN IMMEDIATE` 문장은
PostgreSQL 방언이 아니므로 쿼리 자체가 문법 오류로 거부된다(치환이 필요하다는 뜻).
더 중요한 것은, 설령 구문을 `BEGIN` + 필요시 `FOR UPDATE`로 고쳐 써도 PGlite는 단일
연결이라 **`SQLITE_BUSY` 같은 잠금 경합이 애초에 재현되지 않는다** — 이 시험 백엔드는
"방언이 다르다"를 넘어 "그 자리가 검사하려는 동시성 실패 모드 자체를 낼 수 없다."
`CLAUDE.md` 「이식성 하드 룰」이 이관 시 비쌀 항목으로 미리 적어 둔 "동시성 재감사"가
PGlite로는 **연습조차 되지 않는다** — 실제 다중연결 PostgreSQL에 붙어야 재현되는 성질이기
때문이다.

---

## Q3 — 스토어들의 `run()` 반환값 `changes` 판정

### Q3.1 오늘 코드

조건부 `UPDATE`/`INSERT`가 실제로 몇 행을 건드렸는지로 성공을 판정하는 자리 셋:

- `src/control/workspace-store.ts:1125-1129`의 `#applyTransition` — `result.changes`가
  1이 아니면 `workspace_not_active`.
- `src/control/idempotency.ts:296-297` — 만료 후 재예약 `UPDATE`의 `claimed.changes`가
  1이어야 성공.
- `src/control/idempotency.ts:326-327` — `complete`의 `changes.changes`가 1이 아니면
  `reservation_not_found`.

셋 다 `node:sqlite`의 `StatementSync.run()`이 돌려주는 `{ changes, lastInsertRowid }`
모양(`changes: number | bigint`, `workspace-store.ts:1125` 타입 주석)에 기대고 있다.

### Q3.2 PGlite에서 어떻게 되는가

PGlite `Results<T>`는 `{ rows, affectedRows?, fields, blob? }` 모양이다(
[PGlite API](https://pglite.dev/docs/api), 확인: 2026-08-10 12:30 UTC). `changes` 대신
**`affectedRows`**(옵셔널)가 같은 값을 준다 — 이름과 옵셔널 여부만 다르고 **뜻은
같다.** `node:sqlite`도 `bigint`를 낼 수 있어 기존 코드가 이미 `Number(...)`로
캐스팅하고 있으므로(`workspace-store.ts:1126`, `idempotency.ts:297,327`) 그 관용구는
그대로 재사용 가능하다.

**판정: 부딪히지 않는다 (사소한 이름 치환).** 넷 중 유일하게 **필드명 하나만 바꾸면
끝나는** 자리다 — 「부딪히는 자리」로 셀 만큼의 구조적 차이가 없다. `affectedRows`가
`undefined`일 수 있다는 점(SQLite의 `changes`는 항상 값이 있다)만 방어 코드 한 줄
(`?? 0` 또는 명시적 `undefined` 처리)이 늘어난다.

---

## Q4 — 오류 식별(`SQLITE_*` 코드)

### Q4.1 오늘 코드

네 파일이 SQLite 확장 결과코드를 숫자 상수로 박아 두고 판정한다:

| 파일 | 상수 | 값 | 판정 함수 |
|---|---|---|---|
| `src/control/store.ts:68` | `SQLITE_CONSTRAINT_PRIMARYKEY` | `1555` | `isPrimaryKeyViolation` (`store.ts:375-381`) |
| `src/control/store.ts:71` | `SQLITE_CONSTRAINT_CHECK` | `275` | `isCheckViolation` (`store.ts:383-387`) |
| `src/control/store.ts:74` | `SQLITE_CONSTRAINT_FOREIGNKEY` | `787` | `isForeignKeyViolation` (`store.ts:389-395`) |
| `src/control/workspace-store.ts:132` | `SQLITE_CONSTRAINT_PRIMARYKEY` | `1555` | `isPrimaryKeyViolation` (`workspace-store.ts:507-513`) |
| `src/control/workspace-store.ts:135` | `SQLITE_CONSTRAINT_CHECK` | `275` | `isCheckViolation` (`workspace-store.ts:515-519`) |
| `src/control/credential.ts:58` | `SQLITE_CONSTRAINT_CHECK` | `275` | `isCheckViolation` (`credential.ts:162-166`) |
| `src/control/idempotency.ts:76` | `SQLITE_CONSTRAINT_PRIMARYKEY` | `1555` | `isPrimaryKeyViolation` (`idempotency.ts:188-194`) |

셋은 예외 객체의 `errcode` 필드를 직접 비교한다. 그 위에 `src/control/server.ts:219-223`
이 한 겹 더 있다 — *"SQLite 확장 결과코드의 하위 8비트가 기본 코드다"*라며 `errcode & 0xff`
(`server.ts:223`, `sqlitePrimaryCode`, `server.ts:304-310`)로 `NOT_DURABLE_CODES`
(`server.ts:229-233`: `8`·`10`·`13`)와 `UNAVAILABLE_CODES`(`server.ts:240-244`: `5`·`6`·
`14`)를 가른다.

### Q4.2 PGlite에서 어떻게 되는가

PostgreSQL 계열은 **SQLSTATE**다 — 5자리 영숫자 문자열(`23505` = unique_violation,
`23514` = check_violation, `23503` = foreign_key_violation. 근거:
[PostgreSQL 18 Appendix A. Error Codes](https://www.postgresql.org/docs/current/errcodes-appendix.html)
+ 재확인 사례([bytebase 23505 레퍼런스](https://www.bytebase.com/reference/postgres/error/23505-duplicate-key-value/)),
확인: 2026-08-10 12:30 UTC). 숫자도 아니고 확장/기본 코드로 쪼개는 8비트 마스크 관례
(`server.ts:220-223`)도 PostgreSQL에는 없다 — SQLSTATE는 그 자체로 완전한 값이라 마스킹할
"기본 코드"라는 하위 계층이 존재하지 않는다.

PGlite는 `@electric-sql/pg-protocol`(node-postgres의 `pg-protocol`을 포팅한 내부 패키지)
을 통해 `DatabaseError`를 던진다. 이 클래스가 라이브러리에서 직접 export되지 않아
`instanceof` 판정이 불안정하다는 것이 이미 알려진 결함이다
([electric-sql/pglite#333](https://github.com/electric-sql/pglite/issues/333), 열림 상태,
확인: 2026-08-10 12:30 UTC) — 이슈 리포터는 "certain fields on the error object"를 보고
판정한다고 적었을 뿐 `.code` 필드의 존재 자체를 부정하지 않았고, node-postgres 계열
`DatabaseError`의 관례(`.code`에 SQLSTATE 문자열)를 그대로 물려받는다고 보는 것이
타당하다 — 다만 **export되지 않은 클래스**라는 점은 오늘 코드의
`(error as { errcode?: unknown }).errcode` 같은 구조적 타입 캐스팅 관용구를 그대로
재사용할 수 있다는 뜻이기도 하다(타입 좁히기가 필드 존재 여부만 보므로).

**판정: 부딪힌다 — 값·타입·판정 마스크 셋 다 바뀐다.** 상수 일곱 개(정수)가 문자열
리터럴로, `errcode & 0xff` 마스킹 로직이 통째로 삭제 대상으로, 판정 함수 넷의 비교
연산자가 `===` 대상만 바뀌는 게 아니라 **`server.ts`의 두 코드 집합
(`NOT_DURABLE_CODES`·`UNAVAILABLE_CODES`)이 무엇을 열거하는지부터 다시 조사해야 한다**
(PostgreSQL의 디스크 I/O·읽기전용·잠금 실패에 대응하는 SQLSTATE 클래스가 SQLite와
분류축 자체가 다르다 — 예: PostgreSQL은 `53*`(insufficient resources) 클래스로 디스크
문제를 낸다). 이슈 본문이 예고한 대로 "같은 자리가 통째로 갈린다."

---

## Q5 — 동기/비동기 판정 (핵심)

### Q5.1 확인한 사실

[PGlite API](https://pglite.dev/docs/api) — 확인: **2026-08-10 12:30 UTC**.

- `.query<T>(...)`: `Promise<Results<T>>`.
- `.exec(...)`: `Promise<Array<Results>>`.
- `.transaction<T>(callback: (tx: Transaction) => Promise<T>)`: 트랜잭션 콜백 자체의
  타입이 **`Promise<T>`를 요구한다.** 공식 문서 원문: *"The transaction will be committed
  when the promise returned from your callback resolves, and automatically rolled back
  if the promise is rejected."*
- 동기 API 모드나 동기 빌드는 문서 어디에도 없다 — `.query`/`.exec`/`.transaction`
  **셋 다 예외 없이 비동기다.**

npm 레지스트리(`https://registry.npmjs.org/@electric-sql/pglite/latest`, 확인: 2026-08-10
12:30 UTC) 기준 현재 버전은 `0.5.4`, 라이선스 `Apache-2.0`, `dependencies` 필드 없음
(런타임 의존성 0 — devDependency로 들여도 mori-nest 자신의 런타임 의존성 0 규율
(`CLAUDE.md` 「빌드·테스트」, 근거 `0002 §4.1-3`)을 해치지 않는다. 「비용」절에서 다시 판정).

**즉 PGlite는 완전히 비동기 전용이다 — 동기 폴백이 없다.**

### Q5.2 #133 불변식과의 양립 판정

`db.ts` 상단 doc 「조각 4/4가 고른 답」(`db.ts:67-81`)이 세운 것은 다음이다:

> 고른 답은 세 선택지((a) body를 동기로 강제, (b) DB 단위 직렬화 큐, (c) thenable body
> 자체를 거부) 중 **(a)** — `ControlStore.insertMintedLog`·`WorkspaceStore.insertMintedWorkspace`·
> `IdempotencyStore.completeSync`처럼 `Promise`를 돌려주지 **않는** 동기 전용 메서드를
> 리포지토리 경계마다 새로 낸다.

이 선택 (a)가 성립하려면 **리포지토리 메서드가 내부에서 쓰는 쿼리 프리미티브 자체가
동기여야 한다** — `insertMintedLog`가 "Promise를 안 돌려준다"고 선언해도, 그 몸통이
`await db.query(...)`를 감춰서 흉내 낼 수는 없다(그 순간 함수는 `async`가 되거나,
`async` 없이 두면 함수가 `Promise` 자체를 값처럼 반환해 타입이 거짓말을 하게 된다).
`node:sqlite`의 `StatementSync.run()`/`.get()`이 이것을 공짜로 준다 — 값을 즉시
반환하기 때문이다. **PGlite에는 이런 동기 프리미티브가 없다** (§Q5.1). `.query()`가
반환하는 것은 언제나 `Promise`이고, 그 값을 동기 함수 안에서 "풀어서" 즉시 쓸 방법이
없다(Node.js에는 top-level 이벤트 루프 안에서 Promise를 동기로 기다리는 수단이 없다 —
`Atomics.wait` 기반의 편법조차 PGlite가 워커 스레드로 쿼리를 실행하는 구조와 맞지
않는다).

**답: 아니오 — 양립하지 않는다.**

PGlite로 리포지토리를 다시 쓰면 `insertMintedLog`·`insertMintedWorkspace`·
`completeSync` 셋 다 `async`가 될 수밖에 없고, 그러면 그 셋을 `withTransaction` 콜백
안에서 조합하는 라우트(조각 4/4, mori-nest #133/PR #139)의 콜백도 다시 `async`가
된다. `db.ts:202`의 `withTransaction`은 `body: () => T | PromiseLike<T>`를 받고
`isThenable`이면 `await`하도록 이미 설계돼 있어(`db.ts:179-184`, `202-224`) **기계적으로는
돌아간다** — 그러나 그 순간 `db.ts:83-91`이 의존하는 성질,

> 모든 트랜잭션 콜백이 동기인 한, 한 콜백의 `BEGIN`~`COMMIT`은 한 자바스크립트 실행틱
> 안에서 끝나므로... 서로 다른 요청의 `withTransaction` 호출이 실제로 겹칠 수 없다

가 깨진다. `await`가 콜백 본문에 들어가는 순간 이벤트 루프가 다른 요청으로 넘어갈 수
있고, 그 요청이 `withTransaction`을 부르면 `nested_transaction`을 받는다 —
`server.ts:339-346`이 이미 적어 둔 대로 이것은 **"동시 요청은 원래 낼 수 없는 오류"에서
"흔한 500"으로 성격이 바뀐다.** 즉 PGlite로 시험 백엔드를 갈아 끼우는 순간, 그 시험이
검사하는 성질(콜백은 동기다 → 겹침이 구조적으로 불가능하다)이 **생산 코드(`node:sqlite`)의
성질과 달라진다** — 이슈 #141 본문이 미리 지목한 바로 그 실패 모드다. 시험이 초록이어도
그 초록이 검사하는 것은 "PGlite 위에서 재구현한 다른 동시성 전략"이지 오늘의
`node:sqlite` 구현이 아니다.

---

## 무엇을 얻는가

Q1~Q4가 확인한 부딪히는 자리 넷 중 셋(Q1·Q2·Q4)은 **PostgreSQL 방언으로 다시 쓰는
법**을 미리 보여준다는 값어치가 있다 — 특히 Q2(잠금 모델이 통째로 다르다)와 Q4(에러
코드 축이 통째로 다르다)는 오늘의 시험이 SQLite 방언으로만 짜여 있어서 지금은 전혀
못 잡는 결함이다: PostgreSQL로 실제 이관하는 날, `errcode === 1555` 같은 비교는 그냥
**항상 거짓**이 되어 `isPrimaryKeyViolation`이 죽은 코드처럼 통과하고, 원인 불명의
`500 internal`이 나가는 경로로 조용히 샐 수 있다. 오늘 시험은 이 실패를 낼 수
없다 — SQLite로만 도니까.

**그러나 Q5가 그 값어치를 대부분 무효화한다.** PGlite로 시험 백엔드를 바꾸려면
리포지토리 구현 자체(동기 전용 메서드 셋)를 PostgreSQL 이관 시점에 할 재작성과 사실상
같은 크기로 다시 써야 한다 — "시험만 갈아 끼운다"가 아니라 "프로덕션 코드를 먼저
PGlite용으로 재설계하고, 그 재설계가 실제 PostgreSQL과도 다시 맞는지 별도로 검증해야
하는" 2단 작업이 된다. 그 재작성이 끝난 시점에는 이미 진짜 `pg` 드라이버로 붙는 것과
비용이 다르지 않다 — PGlite가 그 사이의 지름길이 되지 못한다.

**남는 값어치**: Q2·Q4가 사람에게 "무엇이 갈리는지"를 미리 알려주는 **문서로서의
값어치**는 있다 — 이 산정 자체가 그 몫을 이미 했다. 코드로 자동 검증하는 값어치는
Q5의 재작성 비용 앞에서 작다.

---

## 비용

- **의존성.** `@electric-sql/pglite`는 `devDependency` 하나가 는다. 자기 자신은
  `dependencies` 필드가 없다(§Q5.1) — 그래서 mori-nest의 런타임 의존성 0 규율
  (`CLAUDE.md` 「빌드·테스트」, `0002 §4.1-3`)은 **해치지 않는다**(devDependency는 그
  규율의 대상이 아니다 — `#15`가 이미 "런타임 의존성 0"으로 좁혀 뒀다). 다만 오늘의
  `devDependencies`(`package.json` — `@types/node`·`typescript`·`vitest` 셋뿐, 도구류
  뿐이다)에 **처음으로 "실행되는" 의존성**이 들어간다는 점은 성격이 다르다.
- **패키지 크기.** `dist.unpackedSize` **25,403,132 바이트(≈24.2 MiB)**
  (`https://registry.npmjs.org/@electric-sql/pglite/latest`, 확인: 2026-08-10 12:30 UTC) —
  WASM Postgres 바이너리를 통째로 담기 때문이다. `node:sqlite`는 Node 런타임 내장이라
  설치 비용이 0이다.
- **시험 실행 시간.** 오늘 기준(SQLite, `b89c716`) `pnpm test`는 **25개 파일, 213개
  테스트, 30.98초**(`Duration` 줄 그대로 — `transform 705ms, collect 1.65s, tests
  23.92s`)로 끝난다. `node:sqlite`는 네이티브 애드온이라 인스턴스화가 사실상 0비용이고,
  `test/control-db.ts`(§부록)가 시험마다 임시 파일로 새 DB를 연다. PGlite는 매 인스턴스가
  WASM 모듈을 초기화하므로(공식 문서가 "very fast to start and tear down"이라고만
  주장할 뿐 구체적인 ms를 명시한 공개 벤치마크를 찾지 못했다 — 이 항목은 실측 없이
  숫자를 단정하지 않는다) **정성적으로는 네이티브 애드온보다 인스턴스당 비용이 더
  든다.** 정확한 배율은 §Q5의 재작성이 실제로 이뤄지기 전에는 잴 방법이 없다.
- **이중 백엔드 유지 비용.** Q5의 판정대로 "시험만 갈아 끼운다"가 성립하지 않으므로,
  PGlite를 들이는 순간 mori-nest는 **PGlite용 리포지토리 구현**과 **`node:sqlite`용
  리포지토리 구현**을 나란히 유지해야 한다(둘 중 하나로 완전히 대체하는 것이 아니라,
  §Q5가 확인했듯 프로덕션은 오늘 `node:sqlite` 동기 전제 위에 서 있고 그것을 바꾸는 것은
  이 조각의 비범위다). 코드 두 벌 + 두 벌이 다시 어긋나지 않는지 계속 확인하는 비용은,
  Q4가 준 "오늘 못 잡는 결함을 잡는다"는 값어치보다 크다고 판단한다(「무엇을 얻는가」 참고).

---

## 판정

**기각 권고.**

결정적 근거는 §Q5 하나다 — PGlite의 쿼리 API(`.query`·`.exec`·`.transaction`)가
**예외 없이 비동기**이고 동기 폴백이 없으므로, mori-nest #133이 세운 "트랜잭션 콜백은
동기다" 불변식(`db.ts:67-81`, 조각 4/4가 고른 답 (a))을 PGlite 위에서 그대로 구현할
수 없다. 리포지토리를 PGlite에 맞춰 다시 쓰면 그 불변식 자체가 성립하지 않는 다른
동시성 전략이 되고, 그 결과 "시험이 검사하는 성질이 생산 코드(`node:sqlite`)의 성질과
달라진다" — 이슈 #141이 미리 지목한, 채택을 막는 바로 그 실패 모드다.

Q1(연결 API 모양)·Q2(잠금 의미)·Q4(오류 코드 축)도 각각 구조적으로 부딪히고(Q3만
사소하다), 이 넷을 흡수하는 재작성 비용이 §Q5의 근본적 불일치 위에 얹히므로 "무엇을
얻는가"(오늘 못 잡는 이관 결함을 미리 잡는다)가 그 비용을 정당화하지 못한다고 판단한다.

**영구 기각이 아니다.** PGlite가 동기 모드나 동기 프리미티브를 내면(§Q5.1이 확인한
오늘 시점의 사실이 바뀌면), 또는 `CLAUDE.md` 「이식성 하드 룰」대로 mori-nest가 실제
PostgreSQL로 이관해 프로덕션 리포지토리 자체가 이미 비동기 전용으로 다시 쓰인 뒤라면
(그 시점엔 "시험 백엔드"가 아니라 "프로덕션과 같은 엔진의 인메모리 변종"이 되어 이
산정의 전제 자체가 바뀐다), 이 판정은 다시 열릴 조건을 만족한다.

### 더 나은 후보

조사 중 별도로 비교할 만한 동기 API의 WASM PostgreSQL 후보를 찾지 못했다 — 이 산정은
PGlite 하나에 대해서만 판정했다(비범위, 이슈 #141 「비범위」절).

---

## 부록 — 이 산정이 인용한 것

착수 시점 `main`(`b89c716`)에서 직접 열어 확인했다.

| 인용 | 무엇 |
|---|---|
| `src/control/db.ts:61-63` | "body가 동기이면 이 구현은 await를 한 번도 하지 않는다" |
| `src/control/db.ts:67-81` | 조각 4/4가 고른 답 — 동기 전용 메서드 (a) |
| `src/control/db.ts:83-91` | 동기 전제가 깨지면 `nested_transaction`이 코드 결함 신호에서 벗어난다는 논증 |
| `src/control/db.ts:93` | `import { DatabaseSync } from 'node:sqlite'` — 유일한 가져오기 자리 |
| `src/control/db.ts:96` | `BUSY_TIMEOUT_MS` |
| `src/control/db.ts:121-122` | `DatabaseSync` 인스턴스는 `openControlDatabase` 하나에서만 |
| `src/control/db.ts:136-139` | `BEGIN IMMEDIATE`를 고른 이유 — 승격 실패(`SQLITE_BUSY`) 제거 |
| `src/control/db.ts:164-170` | PRAGMA 적용 (`exec` 동기 호출) |
| `src/control/db.ts:172-173` | `prepare().get()` 되읽기 확인 |
| `src/control/db.ts:179-184` | `isThenable` — body가 thenable이면 await |
| `src/control/db.ts:202-224` | `withTransaction` 구현 — `BEGIN IMMEDIATE`(`:213`)·`COMMIT`(`:216`)·`ROLLBACK`(`:236`) |
| `src/control/store.ts:42-49` | "행 id를 밖으로 돌려주지 않는다" — `lastInsertRowid` 미사용 |
| `src/control/store.ts:67-74` | `SQLITE_CONSTRAINT_*` 상수 셋 |
| `src/control/store.ts:375-395` | `isPrimaryKeyViolation`·`isCheckViolation`·`isForeignKeyViolation` |
| `src/control/store.ts:502,509,517` | `.run()` 호출 (반환값의 `changes`는 쓰지 않는다) |
| `src/control/workspace-store.ts:131-135` | `SQLITE_CONSTRAINT_PRIMARYKEY`·`SQLITE_CONSTRAINT_CHECK` |
| `src/control/workspace-store.ts:507-519` | `isPrimaryKeyViolation`·`isCheckViolation` |
| `src/control/workspace-store.ts:1120-1129` | `#applyTransition` — `result.changes !== 1` 판정 |
| `src/control/credential.ts:57-58` | `SQLITE_CONSTRAINT_CHECK` |
| `src/control/credential.ts:162-166` | `isCheckViolation` |
| `src/control/idempotency.ts:76` | `SQLITE_CONSTRAINT_PRIMARYKEY` |
| `src/control/idempotency.ts:188-194` | `isPrimaryKeyViolation` |
| `src/control/idempotency.ts:296-297` | `claimed.changes === 1` 판정 |
| `src/control/idempotency.ts:326-327` | `changes.changes !== 1` 판정 |
| `src/control/server.ts:219-223` | "확장 결과코드의 하위 8비트가 기본 코드다" · `SQLITE_PRIMARY_CODE_MASK = 0xff` |
| `src/control/server.ts:229-233` | `NOT_DURABLE_CODES` (`8`·`10`·`13`) |
| `src/control/server.ts:240-244` | `UNAVAILABLE_CODES` (`5`·`6`·`14`) |
| `src/control/server.ts:304-310` | `sqlitePrimaryCode` |
| `src/control/server.ts:339-346` | `nested_transaction`이 500으로 남는 이유 — 동기 전제가 성립하는 한 동시 요청이 만들 수 없는 사유라는 논증 |
| `test/control-db.ts:22-31` | 시험 헬퍼 — 임시 파일로 매번 새 `ControlDatabase` |
| `CLAUDE.md` 「이식성 하드 룰」 1 | 스토어·리포지토리 인터페이스는 비동기를 유지한다 |
| `CLAUDE.md` 「이식성 하드 룰」 이관 시 비쌀 항목 | 동시성 재감사 — SQLite 단일 라이터가 봉쇄한 레이스가 이관과 함께 열린다 |
| `CLAUDE.md` 「빌드·테스트」 | 런타임 의존성 0, `0002 §4.1-3` 근거 |
| [PGlite API](https://pglite.dev/docs/api) | `.query`·`.exec`·`.transaction` 시그니처, `Results` 모양 (확인: 2026-08-10 12:30 UTC) |
| [PGlite Multi-tab Worker](https://pglite.dev/docs/multi-tab-worker) | 단일 연결 전용이라는 서술 (확인: 2026-08-10 12:30 UTC) |
| [electric-sql/pglite#324](https://github.com/electric-sql/pglite/issues/324) | 단일 연결 제약에 대한 커뮤니티 논의 (확인: 2026-08-10 12:30 UTC) |
| [electric-sql/pglite#333](https://github.com/electric-sql/pglite/issues/333) | `DatabaseError` export 안 됨, 필드 기반 판정이 현재 관행 (확인: 2026-08-10 12:30 UTC) |
| [npm 레지스트리 `@electric-sql/pglite@latest`](https://registry.npmjs.org/@electric-sql/pglite/latest) | 버전 `0.5.4`, 라이선스 `Apache-2.0`, `dist.unpackedSize` `25403132`, `dependencies` 필드 없음 (확인: 2026-08-10 12:30 UTC) |
| [PostgreSQL 18 Error Codes Appendix](https://www.postgresql.org/docs/current/errcodes-appendix.html) | SQLSTATE 클래스 정의 (확인: 2026-08-10 12:30 UTC) |
