/**
 * 제어 평면 **단일 DB + 트랜잭션 관리자** ([사람 결정 2026-08-10]
 * (https://github.com/shakystar/mori-nest/issues/68#issuecomment-5236925659),
 * mori-nest #130 — UoW 조각 1/4).
 *
 * ## 연결 소유권이 스토어에 있으면 원자성을 **표현할 수단이 없다**
 *
 * `0003 §1.4`는 *"키 기록과 자원 생성은 원자적이다"*를 MUST로 못박는데, 제어 평면의 네
 * 스토어가 각자 `new DatabaseSync(path)`로 자기 파일을 열고 있었다. 공통 트랜잭션 경계가
 * **존재하지 않으니** 어떤 컴포넌트도 «이 두 쓰기는 함께 커밋된다»를 적을 수 없었고,
 * 적을 수 없는 것은 강제할 수도 없다. `ATTACH`로 파일들을 묶는 우회도 막혀 있다 — 넷 다
 * `journal_mode = WAL`을 걸고, SQLite는 WAL에서 다중 DB 원자 커밋을 보장하지 않는다.
 *
 * 규율이 없어서 생긴 문제가 아니다. **같은 DB 안에서는 이미 제대로 하고 있다** —
 * `src/control/store.ts`의 `createLog`는 `logs`와 `log_subjects`를 `BEGIN IMMEDIATE` 하나로
 * 묶는다. 무너지는 자리는 **파일 경계뿐**이다. 그래서 이 모듈이 하는 일은 새 규율을 들이는
 * 것이 아니라 **경계를 없애는 것**이다: 제어 평면 DB는 하나이고, 그 연결을 만드는 자리는
 * {@link openControlDatabase} 하나다.
 *
 * `docs/replica-identity-and-join-adjudication.md:103`이 이미 *"DB는 전체 하나"*로 적었다
 * ([mori-nest #15 결정](https://github.com/shakystar/mori-nest/issues/15#issuecomment-5198600623)).
 * 지금의 파일 넷은 그 결정이 아니라 **분해 순서의 산물**이었다.
 *
 * ## 스토어는 리포지토리가 된다
 *
 * 팩토리(`openIdempotencyStore`·`openLauncherCredentialStore`)는 이제 경로 문자열이 아니라
 * {@link ControlDatabase}를 받는다. 리포지토리는 {@link ControlDatabase.connection} 위에
 * 자기 문장을 준비할 뿐 **연결을 소유하지 않는다** — 그래서 `close()`도 갖지 않는다
 * (닫는 것은 연결의 소유자, 즉 {@link ControlDatabase.close} 하나다). 리포지토리가
 * 같은 연결을 공유하므로, `withTransaction` 안에서 부른 서로 다른 리포지토리의 쓰기는
 * **별도 배선 없이 같은 트랜잭션에 든다.** 파일 경계를 넘던 원자성은 그렇게 성립한다
 * (`test/control-db.test.ts`의 크로스-리포지토리 롤백 시험이 이 성질 하나를 잰다).
 *
 * `src/control/store.ts` · `src/control/workspace-store.ts`는 **조각 2/4 · 3/4**에서 이관한다.
 * 그동안 그 둘은 지금처럼 자기 경로로 연다 — 의도된 과도기다.
 *
 * ## 중첩 트랜잭션: **금지한다** (사람 결정 3절 «설계 시 반드시 답할 것»)
 *
 * `withTransaction` 안에서 `withTransaction`을 다시 부르면 savepoint로 감싸주지 않고
 * `nested_transaction`으로 **즉시 던진다.** 이유 셋:
 *
 * 1. **연결이 하나다.** `src/transport/store.ts`가 이미 문서화한 «같은 연결에서 중첩
 *    트랜잭션을 열 수 없다»가 공유 연결에서 그대로 재현된다. 감출 수 있는 제약이 아니라
 *    드러내야 하는 제약이다.
 * 2. **savepoint는 이 모듈이 세우려는 성질을 조용히 되돌린다.** 안쪽 롤백이 바깥 커밋을
 *    깨지 않는다는 것은 *«이 두 쓰기는 함께 커밋된다»를 조각 단위로 opt-out할 수 있다*는
 *    뜻이고, 그것이 바로 #130이 닫으려는 결함의 모양이다. 부분 롤백이 정말 필요한 자리가
 *    나오면 그때 근거와 함께 도입할 일이지, 뼈대에 미리 뚫어둘 구멍이 아니다.
 * 3. **에러가 설계 질문을 호출 자리로 옮긴다.** 명시적 실패는 «이 호출을 바깥 트랜잭션에
 *    합류시킬 것인가, 따로 커밋할 것인가»를 고르게 만든다. 합류시키려면 조합 메서드
 *    (예: `LauncherCredentialStore.rotate`)를 부르지 말고 그것이 쓰는 기본 연산들
 *    (`issue`·`revoke`)을 자기 `withTransaction` 안에서 직접 조합하면 된다.
 *
 * ## 한 연결이라 트랜잭션은 **직렬**이다
 *
 * 같은 이유로 «동시에 두 트랜잭션»도 없다 — 다른 비동기 호출이 이미 열린 트랜잭션 도중에
 * `withTransaction`을 부르면 (중첩이 아니라 인터리빙이어도) 같은 `nested_transaction`을
 * 받는다. SQLite가 낼 모호한 `SQLITE_ERROR` 대신 이 모듈의 고정 사유로 받는 것이 요점이다.
 * 뒤집으면, **트랜잭션이 열려 있는 동안 이벤트 루프가 다른 호출에 넘어가면 그 쓰기는 이
 * 트랜잭션에 든다.** 그래서 `body`가 동기이면 이 구현은 `await`를 **한 번도 하지 않는다**
 * (아래 {@link isThenable}) — 리포지토리 메서드 본문에 `await`를 두지 않는 기존 규율
 * (`src/control/store.ts` 상단 doc)과 같은 자리, 같은 이유다. 요청 하나를 한 트랜잭션으로
 * 묶는 라우트 배선(**조각 4/4**)은 이 성질 위에서 설계해야 한다.
 */

import { DatabaseSync } from 'node:sqlite'

/** 잠금 대기 상한. 근거는 이 값을 각자 걸던 네 스토어의 것과 같다. */
const BUSY_TIMEOUT_MS = 5000

export type ControlDatabaseFailure =
  /**
   * 열린 DB의 `journal_mode`/`synchronous`가 요구값이 아니다. **사유 문자열이 이관 전과
   * 같다** — `src/control/server.ts`가 이 사유를 `503 not_durable`로 옮기는 배선을 그대로
   * 쓴다.
   */
  | 'durability_pragmas_not_applied'
  /** 이미 트랜잭션이 열려 있는데 `withTransaction`을 다시 불렀다 (파일 상단 doc «중첩 금지»). */
  | 'nested_transaction'
  /** 닫힌 데이터베이스를 쓰려고 했다. */
  | 'database_closed'

export class ControlDatabaseError extends Error {
  readonly reason: ControlDatabaseFailure

  constructor(reason: ControlDatabaseFailure) {
    super(reason)
    this.name = 'ControlDatabaseError'
    this.reason = reason
  }
}

/**
 * 제어 평면 DB 하나와 그 위의 트랜잭션 경계. **`DatabaseSync` 인스턴스가 만들어지는 자리는
 * {@link openControlDatabase} 하나뿐이다** (파일 상단 doc).
 */
export type ControlDatabase = {
  /**
   * 리포지토리가 자기 문장을 준비하는 연결. **트랜잭션은 여기로 열지 않는다** —
   * `BEGIN`/`COMMIT`/`ROLLBACK`을 직접 실행하면 {@link withTransaction}의 중첩 판정이
   * 보지 못하는 경계가 생긴다.
   */
  readonly connection: DatabaseSync

  /**
   * `body`를 `BEGIN IMMEDIATE` … `COMMIT` 사이에서 실행한다. `body`가 던지면 `ROLLBACK`
   * 후 그 예외를 그대로 다시 던진다 — 이 계층은 실패를 삼키지 않는다.
   *
   * 이 연결 위의 리포지토리가 `body` 안에서 한 쓰기는 전부 이 트랜잭션에 든다 (파일 상단
   * doc). `BEGIN IMMEDIATE`인 것은 쓰기 락을 처음부터 잡아 «읽고 나서 승격»에서 나는
   * `SQLITE_BUSY` 실패를 없애기 위해서다 (`src/control/store.ts`·`src/transport/store.ts`의
   * 같은 선택과 같은 이유).
   *
   * @throws {ControlDatabaseError} 이미 트랜잭션이 열려 있으면 (`nested_transaction`),
   *   닫힌 DB면 (`database_closed`).
   */
  withTransaction<T>(body: () => T | PromiseLike<T>): Promise<T>

  /**
   * 연결을 닫는다. 두 번 불러도 안전하다. **리포지토리는 이것을 갖지 않는다** — 닫는 것은
   * 연결의 소유자, 즉 여기 하나다.
   *
   * 트랜잭션이 열린 채 닫으면 그 트랜잭션은 커밋되지 않는다 (연결을 닫으면 SQLite가
   * 롤백한다). 즉 종료가 반쯤 쓴 상태를 남기지는 않지만, 진행 중인 작업을 기다려주지도
   * 않는다 — 종료 경로에서 부르는 것을 전제한다.
   */
  close(): Promise<void>
}

/**
 * 내구성 PRAGMA를 걸고 **되읽어 확인한다.** 걸었다는 것과 걸렸다는 것은 다르다 — SQLite는
 * `journal_mode` 전환을 조용히 거절할 수 있다(`:memory:`가 그렇다). 네 스토어가 각자 하던
 * 것을 여기로 모았고, 실패 사유는 이관 전과 같은 `durability_pragmas_not_applied`다.
 */
function applyDurabilityPragmas(db: DatabaseSync): void {
  // `busy_timeout`이 맨 먼저다 — `journal_mode` 전환 자체가 짧게 잠금을 요구한다.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  // 연결 단위 설정이고 기본값이 꺼짐이다. 켜지 않으면 `REFERENCES`가 강제되지 않는다 —
  // `src/control/store.ts`가 자기 연결에 걸던 것으로, 그 스키마가 이 연결로 오는
  // **조각 2/4** 전에 자리를 잡아 둔다 (그때 빠뜨리면 관계 무결성이 조용히 사라진다).
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')

  const journalMode = db.prepare('PRAGMA journal_mode').get()?.['journal_mode']
  const synchronous = db.prepare('PRAGMA synchronous').get()?.['synchronous']
  if (journalMode !== 'wal' || synchronous !== 2) {
    throw new ControlDatabaseError('durability_pragmas_not_applied')
  }
}

/** `body`의 반환값이 기다려야 하는 것인지 판정한다 (파일 상단 doc «트랜잭션은 직렬이다»). */
function isThenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    typeof value === 'object' && value !== null && typeof (value as PromiseLike<T>).then === 'function'
  )
}

class SqliteControlDatabase implements ControlDatabase {
  readonly #db: DatabaseSync
  #inTransaction = false
  #closed = false

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  get connection(): DatabaseSync {
    if (this.#closed) {
      throw new ControlDatabaseError('database_closed')
    }
    return this.#db
  }

  async withTransaction<T>(body: () => T | PromiseLike<T>): Promise<T> {
    if (this.#closed) {
      throw new ControlDatabaseError('database_closed')
    }
    if (this.#inTransaction) {
      throw new ControlDatabaseError('nested_transaction')
    }
    // `BEGIN`보다 먼저 세운다 — `BEGIN` 자체가 던져도 `finally`가 되돌리므로 상태가 새지
    // 않고, 그 사이에 끼어든 호출은 «열려 있다»로 판정된다.
    this.#inTransaction = true
    try {
      this.#db.exec('BEGIN IMMEDIATE')
      const raw = body()
      const value = isThenable(raw) ? await raw : raw
      this.#db.exec('COMMIT')
      return value
    } catch (error) {
      this.#rollbackQuietly()
      throw error
    } finally {
      this.#inTransaction = false
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return
    }
    this.#closed = true
    this.#db.close()
  }

  #rollbackQuietly(): void {
    try {
      this.#db.exec('ROLLBACK')
    } catch {
      // 트랜잭션이 이미 열려 있지 않다 (`BEGIN`이 실패했거나, 제약 위반이 트랜잭션을
      // 자동으로 접은 경우). 원래의 실패를 이 실패로 덮지 않는다.
    }
  }
}

/**
 * 제어 평면 DB를 연다. 파일이 없으면 만든다.
 *
 * @param path DB 파일 경로. **`:memory:`는 쓸 수 없다** — WAL을 걸 수 없어
 *   {@link applyDurabilityPragmas}가 `durability_pragmas_not_applied`로 거부한다.
 *   (이관 전 `credential.ts`·`store.ts`는 `:memory:`를 받았다. 멱등 키 보관 창 24시간
 *   (`0003 §1.4` MUST)을 지는 DB에 내구성 없는 모드를 허용할 자리가 없으므로 여기서
 *   좁힌다 — 테스트는 임시 디렉터리의 파일을 쓴다.)
 * @throws {ControlDatabaseError} PRAGMA가 요구값으로 걸리지 않으면
 *   (`durability_pragmas_not_applied`).
 */
export async function openControlDatabase(path: string): Promise<ControlDatabase> {
  const db = new DatabaseSync(path)
  try {
    applyDurabilityPragmas(db)
  } catch (error) {
    db.close()
    throw error
  }
  return new SqliteControlDatabase(db)
}
