/**
 * 제어 평면 스토어 — `logId` mint와 (주체, 로그) 다대다 관계 (`0003 §2.1`·`§3.6`·`§8-3`,
 * mori-nest #68 조각 3/5 · #72).
 *
 * ## 이 파일이 세우는 것
 *
 * `0002 §1.1`이 모양만 정하고 비워 둔 `logId` 발급 절차와, `§8-3`이 (주체, 로그) 다대다로
 * 닫은 관계를 스토어 계층에 세운다. 라우트도 서버도 여기 없다 — `src/transport/store.ts`의
 * 선례와 같은 순서다: `0002`가 "로그를 읽는 쪽"을 먼저 세우고 서버가 나중에 배선했다.
 *
 * ## 저장 형태
 *
 * `node:sqlite` 위에 스키마 둘(`logs`·`log_subjects`)을 둔다. 런타임 의존성은 여전히
 * 0이다(`0002 §4.1-3`). 전송 평면의 이벤트 스토어와는 **별도 DB 파일**이다 — 제어 평면은
 * 전송 평면을 import하지 않는다(`src/control/index.ts` 상단 doc).
 *
 * ## 원자성 — `BEGIN IMMEDIATE` 하나가 mint와 관계 행을 함께 묶는다
 *
 * `§2.1` MUST: *"성공한 요청은 (요청 주체, mint된 로그) 관계 행을 만든다."* 로그만 있고
 * 쌍이 없는 상태는 어떤 주체도 grant받지 못하는 고아 로그이므로, {@link createLog}는 `logs`
 * INSERT와 `log_subjects` INSERT를 한 트랜잭션에 묶는다 — 관계 행 추가가 실패하면 방금 넣은
 * 로그 행도 롤백으로 함께 사라진다.
 *
 * ## mint 재시도와 dedup — 선판정 없이 제약이 판정한다
 *
 * `logs.log_id`가 `PRIMARY KEY`다. *"이미 존재하는 id가 나오면 그 로그를 돌려주지 않는다"*
 * (§2.1 MUST NOT)를 지키는 것은 이 제약이고, 코드는 그 위반({@link isPrimaryKeyViolation})을
 * **받아서** 재mint할 뿐이다 — `src/transport/store.ts`의 dedup과 같은 규율("읽고-판정하고-
 * 쓰는 창이 존재하지 않는다").
 */

import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'

/** `SQLITE_CONSTRAINT_PRIMARYKEY`. `logs.log_id` 충돌 — mint가 이미 있는 id를 뽑았다. */
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555

/** `SQLITE_CONSTRAINT_CHECK`. `log_subjects.subject <> ''` 위반 — 빈 주체로는 관계를 만들지 않는다. */
const SQLITE_CONSTRAINT_CHECK = 275

/** `SQLITE_CONSTRAINT_FOREIGNKEY`. 존재하지 않는 `log_id`에 관계를 걸려는 시도. */
const SQLITE_CONSTRAINT_FOREIGNKEY = 787

/** 잠금 대기 상한. 근거는 `src/transport/store.ts`의 같은 값과 같다. */
const BUSY_TIMEOUT_MS = 5000

/**
 * mint 재시도 상한. 128비트 난수의 충돌 확률은 무시할 수 있으므로, 이 상한에 실제로
 * 닿는 것은 난수원이 고장 났을 때(엔트로피 고갈, 고정 시드)뿐이다 — 그 경우 재시도를
 * 무한히 반복하는 대신 `mint_exhausted`로 닫는다 (§2.1이 요구한 "다시 mint하거나 실패다"의
 * "실패" 쪽).
 */
const MAX_MINT_ATTEMPTS = 5

/** `listLogsForSubject`가 `limit` 없이 받을 페이지 크기. 근거는 전송 스토어의 같은 상수와 같다. */
export const DEFAULT_PAGE_LIMIT = 500

const MAX_ACCEPTED_LIMIT = 0x7fffffff

/** `logId` 모양 — `0002 §1.1`. */
const LOG_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** 이 스토어의 스키마. `PRAGMA foreign_keys = ON`이 걸려 있어야 `REFERENCES`가 강제된다. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS logs (
  log_id TEXT PRIMARY KEY
) STRICT;

CREATE TABLE IF NOT EXISTS log_subjects (
  log_id  TEXT NOT NULL REFERENCES logs (log_id),
  subject TEXT NOT NULL CHECK (subject <> ''),
  PRIMARY KEY (log_id, subject)
) STRICT;

CREATE INDEX IF NOT EXISTS log_subjects_subject ON log_subjects (subject, log_id);
`

/** {@link mintLogId}가 받는 난수원의 모양. 테스트가 고정할 수 있도록 주입 지점을 둔다. */
export type RandomBytesFn = (size: number) => Buffer

/** `§2.1` MUST의 하한 그대로 — 여유를 더 두지 않는다. `toString('base64url')`이 그대로
 * `0002 §1.1` 알파벳(`A-Za-z0-9_-`)이라 인코딩 자체가 이미 항등이다. */
const MINT_ENTROPY_BYTES = 16

/**
 * `logId`를 mint한다 (`0003 §2.1`).
 *
 * - **`0002 §1.1` 정규식을 만족한다** (MUST) — base64url 알파벳(`A-Za-z0-9-_`)이 그 정규식이
 *   허용하는 문자 집합의 부분집합이라 별도 인코딩 변환이 필요 없다.
 * - **최소 128비트의 예측 불가능한 성분을 포함한다** (MUST) — {@link MINT_ENTROPY_BYTES}가
 *   정확히 그만큼이다.
 * - **접두사를 두지 않는다 — owner 판단** (`0003 §2.3`이 연 자리, `mori-nest #72` 이슈 본문의
 *   owner 판단을 그대로 옮긴다). `§2.3`은 접두사를 **MAY**로 열어 뒀지만, 접두사에 의미를 둘
 *   소비자가 오늘 하나도 없다. 지금 두면 뜻이 정해지지 않은 구조가 mint된 모든 id에 영구히
 *   박히고, 나중에 두더라도 그 시점부터 mint되는 id에만 붙이면 되므로 미루는 비용은 0이다.
 *   접두사를 여는 다음 사람은 `§2.3`의 두 MUST NOT(전송 평면이 접두사를 해석하게 만들지 않는다,
 *   인가를 접두사로 표현하지 않는다)을 먼저 읽어야 한다.
 */
export function mintLogId(randomBytes: RandomBytesFn = nodeRandomBytes): string {
  const logId = randomBytes(MINT_ENTROPY_BYTES).toString('base64url')
  // 방어적 확인 — 주입된 난수원이 계약(길이 `MINT_ENTROPY_BYTES`의 `Buffer`)을 어기면
  // 여기서 잡는다. 이 정규식을 벗어난 id는 발급 즉시 전송 평면에서 쓸 수 없는 로그가
  // 된다(§2.1 MUST) — 통과시키는 쪽으로 무너지지 않는다.
  if (!LOG_ID_PATTERN.test(logId)) {
    throw new ControlStoreError('minted_id_invalid')
  }
  return logId
}

/** 이 스토어가 낼 수 있는 실패의 이유. 고정 문자열이고 `subject`·`logId` 원문을 담지 않는다. */
export type ControlStoreFailure =
  /** {@link mintLogId}이 낸 값이 `0002 §1.1`을 만족하지 못한다 — 주입된 난수원의 결함 */
  | 'minted_id_invalid'
  /** `log_subjects.subject`가 빈 문자열이다 (`grant`·`createLog` 공통) */
  | 'blank_subject'
  /** `grant`가 가리킨 `logId`가 존재하지 않는다 */
  | 'log_not_found'
  /** mint 재시도가 {@link MAX_MINT_ATTEMPTS}를 넘었다 — 난수원이 고장났다고 본다 */
  | 'mint_exhausted'
  /** `limit`이 양의 안전 정수가 아니다 */
  | 'invalid_page_limit'
  /** DB가 돌려준 행의 모양이 스키마와 다르다 */
  | 'unexpected_row_shape'

export class ControlStoreError extends Error {
  readonly reason: ControlStoreFailure

  constructor(reason: ControlStoreFailure) {
    super(reason)
    this.name = 'ControlStoreError'
    this.reason = reason
  }
}

/** `§2.4`의 `LogRecord`와 같은 모양 — 이 스토어가 아는 필드는 `logId` 하나뿐이다. */
export type LogRecord = {
  readonly logId: string
}

export type ListLogsForSubjectOptions = {
  /** 이 `logId` **다음**부터 (사전순, exclusive). 부재면 처음부터. */
  readonly after?: string
  /** 페이지 크기. 부재면 {@link DEFAULT_PAGE_LIMIT}. */
  readonly limit?: number
}

export type ListLogsForSubjectPage = {
  readonly logs: readonly LogRecord[]
  readonly hasMore: boolean
}

/**
 * 제어 평면 스토어. 표면이 넷인 것은 §72 이슈 범위 그대로다 — 라우트가 아직 없으므로
 * HTTP 표현(에러 봉투·상태코드)은 이 표면에 없다.
 */
export type ControlStore = {
  /**
   * 새 로그를 mint하고, (요청 주체, 그 로그) 관계 행을 같은 트랜잭션에 만든다 (`§2.1` MUST).
   *
   * @throws {ControlStoreError} `subject`가 빈 문자열이면 (`blank_subject`, 그 시도의 로그도
   *   함께 롤백된다) mint가 {@link MAX_MINT_ATTEMPTS}번 전부 기존 id와 충돌하면
   *   (`mint_exhausted`).
   */
  createLog(subject: string): Promise<{ readonly logId: string }>

  /**
   * (주체, 로그) 관계 행을 추가한다. **오늘 이 함수를 부르는 유일한 경로는
   * {@link createLog} 내부다** — 라우트로 노출된 자리가 없다. 관계가 다대다이므로
   * (`§8-3`), 초대·공유·join(`§2.5`) 같은 이 관계에 행을 더하는 다른 경로가 열리면
   * 그 라우트들이 이 함수를 그대로 재사용할 수 있게 표면으로 둔다.
   *
   * 이미 같은 (주체, 로그) 행이 있으면 조용히 성공한다 (멱등) — 같은 grant를 두 번
   * 요청하는 것은 사고가 아니다.
   *
   * @throws {ControlStoreError} `subject`가 빈 문자열이면 (`blank_subject`), `logId`가
   *   존재하지 않으면 (`log_not_found`).
   */
  grant(subject: string, logId: string): Promise<void>

  /**
   * grant 판정 (`§3.6`) — (주체, 로그) → 통과/불통과. **행이 없으면 불통과다**
   * (fail-closed, MUST). 이 판정을 끄는 인자·설정이 없다.
   */
  isGranted(subject: string, logId: string): Promise<boolean>

  /**
   * 한 주체와 쌍을 이룬 로그 목록 (`§2.4`). **grant 판정 → 정렬 → `limit`** 순서로 적용된다
   * (MUST) — SQL의 `WHERE`(판정) → `ORDER BY`(정렬) → `LIMIT`이 그 순서 그대로다. 정렬은
   * `logId` 사전순으로 안정적이다.
   *
   * @throws {ControlStoreError} `limit`이 양의 안전 정수가 아니면 (`invalid_page_limit`).
   */
  listLogsForSubject(subject: string, options?: ListLogsForSubjectOptions): Promise<ListLogsForSubjectPage>

  /** 연결을 닫는다. 두 번 불러도 안전하다. */
  close(): Promise<void>
}

function isPrimaryKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { errcode?: unknown }).errcode === SQLITE_CONSTRAINT_PRIMARYKEY
  )
}

function isCheckViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { errcode?: unknown }).errcode === SQLITE_CONSTRAINT_CHECK
  )
}

function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { errcode?: unknown }).errcode === SQLITE_CONSTRAINT_FOREIGNKEY
  )
}

function columnAsLogId(value: SQLOutputValue | undefined): string {
  if (typeof value !== 'string') {
    throw new ControlStoreError('unexpected_row_shape')
  }
  return value
}

/** `limit` 부재/유효성 판정. 근거는 전송 스토어의 `resolveLimit`과 같다(음수 `LIMIT`은
 * SQLite에서 "무제한"으로 읽힌다). */
function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_PAGE_LIMIT
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ACCEPTED_LIMIT) {
    throw new ControlStoreError('invalid_page_limit')
  }
  return limit
}

function applyPragmas(db: DatabaseSync): void {
  // `busy_timeout`이 맨 먼저다 — `journal_mode` 전환 자체가 짧게 잠금을 요구한다
  // (`src/transport/store.ts`의 같은 순서와 같은 이유).
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  // `REFERENCES`(외래키)는 이 PRAGMA 없이는 강제되지 않는다 — 켜지 않으면 `grant`가
  // 존재하지 않는 로그에도 조용히 관계 행을 만든다.
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
}

/** `node:sqlite` 위의 {@link ControlStore} 구현. 메서드 본문에 `await`가 없다 — 트랜잭션
 * 구간에 `await`를 넣으면 이벤트 루프가 다른 호출에 제어를 넘겨 트랜잭션이 겹칠 수 있다
 * (`src/transport/store.ts` 파일 상단 doc과 같은 규율). */
class SqliteControlStore implements ControlStore {
  readonly #db: DatabaseSync
  readonly #randomBytes: RandomBytesFn
  readonly #insertLog: StatementSync
  readonly #insertSubject: StatementSync
  readonly #selectGrant: StatementSync
  readonly #selectPage: StatementSync
  #closed = false

  constructor(db: DatabaseSync, randomBytes: RandomBytesFn) {
    this.#db = db
    this.#randomBytes = randomBytes
    this.#insertLog = db.prepare('INSERT INTO logs (log_id) VALUES (?)')
    this.#insertSubject = db.prepare('INSERT INTO log_subjects (log_id, subject) VALUES (?, ?)')
    this.#selectGrant = db.prepare('SELECT 1 AS ok FROM log_subjects WHERE subject = ? AND log_id = ?')
    this.#selectPage = db.prepare(
      'SELECT log_id FROM log_subjects WHERE subject = ? AND log_id > ? ORDER BY log_id ASC LIMIT ?',
    )
  }

  async createLog(subject: string): Promise<{ readonly logId: string }> {
    for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
      const logId = mintLogId(this.#randomBytes)

      // `BEGIN IMMEDIATE`인 것은 이 트랜잭션이 반드시 쓰기 때문이다(`src/transport/store.ts`의
      // 같은 선택과 같은 이유).
      this.#db.exec('BEGIN IMMEDIATE')
      try {
        this.#insertLog.run(logId)
      } catch (error) {
        this.#rollbackQuietly()
        if (isPrimaryKeyViolation(error)) {
          // §2.1 MUST NOT: 이미 존재하는 id가 나오면 그 로그를 돌려주지 않는다 — 다시
          // mint한다. 이 트랜잭션은 아직 아무것도 커밋하지 않았으므로 다음 시도는 깨끗한
          // 상태에서 시작한다.
          continue
        }
        throw error
      }

      try {
        this.#insertSubject.run(logId, subject)
        // 커밋이 돌아온 시점에 로그와 관계 행이 함께 있다 — §2.1 MUST가 요구하는 그대로다.
        this.#db.exec('COMMIT')
        return { logId }
      } catch (error) {
        // 관계 행 추가가 실패하면 방금 넣은 로그 행도 롤백으로 함께 사라진다 — 로그만 있고
        // 쌍이 없는 고아 로그를 만들지 않는다 (파일 상단 doc "원자성").
        this.#rollbackQuietly()
        if (isCheckViolation(error)) {
          throw new ControlStoreError('blank_subject')
        }
        throw error
      }
    }
    throw new ControlStoreError('mint_exhausted')
  }

  async grant(subject: string, logId: string): Promise<void> {
    try {
      this.#insertSubject.run(logId, subject)
    } catch (error) {
      if (isPrimaryKeyViolation(error)) {
        // 이미 같은 (주체, 로그) 행이 있다 — 멱등하게 성공으로 본다.
        return
      }
      if (isCheckViolation(error)) {
        throw new ControlStoreError('blank_subject')
      }
      if (isForeignKeyViolation(error)) {
        throw new ControlStoreError('log_not_found')
      }
      throw error
    }
  }

  async isGranted(subject: string, logId: string): Promise<boolean> {
    return this.#selectGrant.get(subject, logId) !== undefined
  }

  async listLogsForSubject(subject: string, options: ListLogsForSubjectOptions = {}): Promise<ListLogsForSubjectPage> {
    const limit = resolveLimit(options.limit)
    const after = options.after ?? ''

    // `LIMIT`에 한 건을 더 얹어 읽는 것이 `hasMore` 판정이다 — 별도 `COUNT(*)`를 돌리면
    // 그 사이에 `grant`가 끼어 개수와 페이지가 서로 다른 순간을 가리킬 수 있다
    // (`src/transport/store.ts`의 `readPage`와 같은 이유).
    const rows = this.#selectPage.all(subject, after, limit + 1)
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    return {
      logs: page.map((row) => ({ logId: columnAsLogId(row['log_id']) })),
      hasMore,
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
      // 트랜잭션이 이미 열려 있지 않다 (제약 위반이 트랜잭션을 자동으로 접은 경우).
    }
  }
}

export type ControlStoreOptions = {
  /** 테스트가 mint 결과를 고정하기 위한 주입 지점. 기본은 `node:crypto`의 `randomBytes`. */
  readonly randomBytes?: RandomBytesFn
}

/**
 * 스토어를 연다. `path`의 DB가 없으면 만들고, 있으면 그대로 연다.
 *
 * @param path DB 파일 경로. `:memory:`도 받는다 — 전송 스토어의 이벤트 로그와 달리 이
 *   스토어에는 `0002 §2.2`급 내구성 MUST가 걸려 있지 않으므로(제어 평면 라우트가 아직
 *   없다), WAL 강제 확인까지는 하지 않는다.
 */
export async function openControlStore(path: string, options: ControlStoreOptions = {}): Promise<ControlStore> {
  const db = new DatabaseSync(path)
  try {
    applyPragmas(db)
    db.exec(SCHEMA)
  } catch (error) {
    db.close()
    throw error
  }
  return new SqliteControlStore(db, options.randomBytes ?? nodeRandomBytes)
}
