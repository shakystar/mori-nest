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

/**
 * 이 스토어의 스키마. `PRAGMA foreign_keys = ON`이 걸려 있어야 `REFERENCES`가 강제된다.
 *
 * ## `revoked_at`은 `logs`에 있다 — `log_subjects`가 아니다 (mori-nest #92)
 *
 * `§2.6`이 정한 폐기는 **로그 단위**이지 관계 단위가 아니다. `RevokeLogResponse`가
 * `{ logId, state, revokedAt }`으로 주체를 싣지 않는 것이 그 힌트다 — 폐기는 "이 주체가 이
 * 로그를 더 보지 않는다"가 아니라 "이 로그 자체가 죽었다"는 사실이고, `§2.6` 본문도 "효력은
 * §3.5의 대가를 그대로 상속한다: 이후 갱신이 전부 거부되고"라고 적어 **모든** 주체에게
 * 미치는 효과로 서술한다. `§8-3`이 관계를 다대다로 열어 두긴 했지만, 오늘 그 관계에 행을
 * 더하는 경로는 `createLog` 하나뿐이라 "누가 폐기를 요청했는지"와 "누구에게 효력이
 * 미치는지"가 갈리는 요청(예: 공유받은 주체 하나만 손을 떼는 것)은 이 스펙 절이 아예
 * 다루지 않는다. 그래서 `revoked_at`을 `log_subjects`(관계)가 아니라 `logs`(로그 그 자체)에
 * 둔다 — 관계 행이 여럿이어도 폐기는 하나의 사실이다.
 *
 * `revoked_at`이 `NULL`인 것이 "폐기되지 않았다"이고, 값이 있으면 그 값이 최초 폐기 시각이다
 * (RFC 3339 UTC). `NOT NULL`을 걸지 않는 이유는 아래 {@link addMissingRevocationColumn}에
 * 있다 — 기존 DB 파일이 이 컬럼 없이 만들어졌을 수 있고, `STRICT` 테이블에 기본값 없는
 * `NOT NULL` 컬럼은 `ALTER TABLE ADD COLUMN`으로 붙지 않는다(`src/transport/store.ts`의
 * v1→v2 이주 doc과 같은 SQLite 제약).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS logs (
  log_id     TEXT PRIMARY KEY,
  revoked_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS log_subjects (
  log_id  TEXT NOT NULL REFERENCES logs (log_id),
  subject TEXT NOT NULL CHECK (subject <> ''),
  PRIMARY KEY (log_id, subject)
) STRICT;

CREATE INDEX IF NOT EXISTS log_subjects_subject ON log_subjects (subject, log_id);
`

/** `revoked_at`을 모르는 채 만들어진 `logs` 테이블에 뒤늦게 붙일 컬럼. 이름·선언은
 * {@link SCHEMA}의 것과 같아야 한다. */
const REVOCATION_COLUMN = { name: 'revoked_at', declaration: 'revoked_at TEXT' } as const

/**
 * `revoked_at` 없이 만들어진 `logs`에 그 컬럼을 붙인다 (`src/transport/store.ts`의
 * `addMissingProvenanceColumns`와 같은 관례 — 이 리포에 이미 있는 마이그레이션 패턴을
 * 그대로 재사용한다). 새로 만든 DB에서는 {@link SCHEMA}의 `CREATE TABLE`이 이미 컬럼을
 * 세웠으므로 아무것도 하지 않는다.
 *
 * `BEGIN IMMEDIATE`로 감싸는 이유도 그 파일과 같다 — 같은 구 DB 파일을 두 프로세스가
 * 동시에 여는 창에서 `ALTER TABLE`이 중복 실행되는 것을 막는다. `PRAGMA user_version`류의
 * 스키마 버전 추적은 이 스토어에 아직 없어서 들이지 않는다 — `openControlStore`를 부를
 * 때마다 컬럼 존재 여부를 직접 확인하는 이 함수 하나로 충분하다(호출 빈도가 연결을 열 때
 * 뿐이라 비용도 무시할 수 있다).
 */
function addMissingRevocationColumn(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = new Set(
      db
        .prepare('PRAGMA table_info(logs)')
        .all()
        .map((row) => row['name']),
    )
    if (!existing.has(REVOCATION_COLUMN.name)) {
      // 상수 문자열이고 클라이언트 입력이 아니다 (`ALTER TABLE`은 식별자를 바인딩할 수 없다).
      db.exec(`ALTER TABLE logs ADD COLUMN ${REVOCATION_COLUMN.declaration}`)
    }
    db.exec('COMMIT')
  } catch (error) {
    // 예외 경로에서 트랜잭션을 반드시 놓는다 — 붙잡은 채로 올라가면 이 연결은 쓸 수 없다.
    try {
      db.exec('ROLLBACK')
    } catch {
      // 트랜잭션이 이미 열려 있지 않다.
    }
    throw error
  }
}

/** {@link mintLogId}가 받는 난수원의 모양. 테스트가 고정할 수 있도록 주입 지점을 둔다. */
export type RandomBytesFn = (size: number) => Buffer

/** `§2.1` MUST의 하한 그대로 — 여유를 더 두지 않는다. `toString('base64url')`이 그대로
 * `0002 §1.1` 알파벳(`A-Za-z0-9_-`)이라 인코딩 자체가 이미 항등이다. */
const MINT_ENTROPY_BYTES = 16

/**
 * 주입된 난수원이 요청한 바이트 수를 실제로 돌려줬는지 확인한다 (mori-nest #74 이슈 코멘트,
 * #72 교차 지적을 이관).
 *
 * {@link mintLogId}는 결과가 `LOG_ID_PATTERN`(1자 이상)을 만족하는지만 봤는데, 그 정규식은
 * **모양**만 보고 **양**은 보지 않는다 — 고장난 난수원이 요청보다 짧은 버퍼를 돌려줘도
 * `base64url` 인코딩 결과가 그 정규식을 통과하면 "최소 128비트" MUST가 조용히 깨진 채
 * 지나간다. 이 함수가 그 자리에 선다: 길이가 어긋나면 인코딩하기 전에 던진다.
 *
 * `src/control/credential.ts`의 런처 자격증명 발급도 같은 `RandomBytesFn` 주입 지점을
 * 쓰므로 이 함수를 그대로 재사용한다 — 검증을 두 곳에 각각 만들지 않는다.
 */
export function readEntropy(randomBytes: RandomBytesFn, size: number): Buffer {
  const bytes = randomBytes(size)
  if (bytes.length !== size) {
    throw new ControlStoreError('random_source_too_short')
  }
  return bytes
}

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
  const logId = readEntropy(randomBytes, MINT_ENTROPY_BYTES).toString('base64url')
  // 방어적 확인 — 길이는 위 {@link readEntropy}가 이미 확인했다. 여기서 보는 것은 인코딩
  // 결과의 문자 집합·길이(모양)뿐이다.
  if (!LOG_ID_PATTERN.test(logId)) {
    throw new ControlStoreError('minted_id_invalid')
  }
  return logId
}

/** 이 스토어가 낼 수 있는 실패의 이유. 고정 문자열이고 `subject`·`logId` 원문을 담지 않는다. */
export type ControlStoreFailure =
  /** {@link mintLogId}이 낸 값이 `0002 §1.1`을 만족하지 못한다 — 주입된 난수원의 결함 */
  | 'minted_id_invalid'
  /** 주입된 난수원이 요청한 바이트 수보다 짧은 버퍼를 돌려줬다 (mori-nest #74 이슈 코멘트) */
  | 'random_source_too_short'
  /** `log_subjects.subject`가 빈 문자열이다 (`grant`·`createLog` 공통) */
  | 'blank_subject'
  /** `grant`가 가리킨 `logId`가 존재하지 않는다. `revoke`도 이 이유를 낸다 — 없는 로그와
   *  이 주체가 애초에 grant받지 못한 로그를 구분하지 않는 것은 `§2.6`도 `grant`와 같다
   *  (존재 자체를 새는 것도 유출이다). */
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
 * 제어 평면 스토어. 원래 넷(#72)에 `revoke`가 더해져 다섯이다(#92, `§2.6`) — 라우트가
 * 아직 없으므로 HTTP 표현(에러 봉투·상태코드)은 이 표면에 없다.
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

  /**
   * 로그를 폐기한다 (`§2.6`). **폐기는 로그 단위다** — `subject`는 이 호출을 할 자격이
   * 있는지(폐기 이전의 grant 관계)를 판정하는 데만 쓰이고, 성공하면 그 로그는 **모든
   * 주체**에게 폐기된 것으로 본다 (`SCHEMA` doc "`revoked_at`은 `logs`에 있다" 참고).
   *
   * **이 판정 자체는 폐기를 입력으로 삼지 않는다** (`§2.6` MUST) — 이미 폐기된 로그에
   * 대한 재호출도 `subject`가 폐기 이전에 grant받은 관계만 있으면 실패하지 않는다. 그래야
   * 아래 멱등이 성립한다: 같은 (`subject`, `logId`)에 대한 반복 호출은 **첫 폐기 시각**을
   * 그대로 돌려준다 (갱신하지 않는다).
   *
   * 전이는 이 호출이 반환하기 전에 내구화된다 — `openControlStore`가 여는 연결에
   * `synchronous = FULL`이 걸려 있다({@link applyPragmas}). 갱신 자체는 `UPDATE ...
   * RETURNING` 한 문장이라(`COALESCE(revoked_at, ?)` — 이미 값이 있으면 덮지 않는다),
   * 같은 (`subject`, `logId`)를 겨눈 동시 호출 여럿이 있어도(같은 프로세스든 다른
   * 프로세스든) 그 문장 자체의 원자성이 "첫 값이 이긴다"를 보장한다 — 별도 트랜잭션으로
   * 감쌀 필요가 없다. 내구성을 보장할 수 없을 때(디스크 I/O 실패 등) `node:sqlite`가
   * 던지는 예외는 그대로 위로 올라간다 — 이 스토어를 감싸는 라우트 계층이 그 예외의
   * SQLite 결과코드로 `503 not_durable`을 판단한다(`src/control/server.ts`의
   * `storeFailure`와 같은 자리, `grant`·`createLog`가 이미 쓰는 것과 같은 경로).
   *
   * @throws {ControlStoreError} `subject`가 이 `logId`에 대해 (폐기 이전에도) grant받은
   *   적이 없으면 (`log_not_found`) — 존재하지 않는 로그와 구분하지 않는다.
   */
  revoke(subject: string, logId: string): Promise<{ readonly revokedAt: string }>

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

/** `#revokeLog`가 돌려준 `revoked_at`을 좁힌다. `COALESCE`가 항상 값을 채우므로(호출 전에
 * 이미 있었거나, 이 호출이 막 채웠거나) `NULL`이 나오면 스키마와 어긋난 것이다. */
function columnAsRevokedAt(value: SQLOutputValue | undefined): string {
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
  readonly #selectMembership: StatementSync
  readonly #selectGrant: StatementSync
  readonly #selectPage: StatementSync
  readonly #revokeLog: StatementSync
  #closed = false

  constructor(db: DatabaseSync, randomBytes: RandomBytesFn) {
    this.#db = db
    this.#randomBytes = randomBytes
    this.#insertLog = db.prepare('INSERT INTO logs (log_id) VALUES (?)')
    this.#insertSubject = db.prepare('INSERT INTO log_subjects (log_id, subject) VALUES (?, ?)')
    // 관계 행의 존재만 본다 — 폐기 여부는 이 질의의 입력이 아니다. `revoke`의 「폐기 이전의
    // 자격만 본다」(§2.6 MUST)가 이 질의를 쓴다.
    this.#selectMembership = db.prepare('SELECT 1 AS ok FROM log_subjects WHERE subject = ? AND log_id = ?')
    // 공개 grant 판정(§3.6) — 관계 행이 있어도 로그가 폐기됐으면 통과하지 못한다 (§2.4·§3.6
    // MUST: 폐기는 이 판정의 입력이다). `isGranted`가 이 질의를 쓴다.
    this.#selectGrant = db.prepare(
      'SELECT 1 AS ok FROM log_subjects ls JOIN logs l ON l.log_id = ls.log_id ' +
        'WHERE ls.subject = ? AND ls.log_id = ? AND l.revoked_at IS NULL',
    )
    // WHERE에서 폐기된 로그를 먼저 거른다 — ORDER BY·LIMIT보다 앞이어야 hasMore가 폐기분을
    // 제외한 값이 된다 (§2.4 MUST: 판정 → 정렬 → limit).
    this.#selectPage = db.prepare(
      'SELECT ls.log_id AS log_id FROM log_subjects ls JOIN logs l ON l.log_id = ls.log_id ' +
        'WHERE ls.subject = ? AND ls.log_id > ? AND l.revoked_at IS NULL ORDER BY ls.log_id ASC LIMIT ?',
    )
    // 이미 값이 있으면 덮지 않는다 — 재폐기가 최초 폐기 시각을 그대로 돌려주는 멱등이
    // 여기서 성립한다(§2.6 MUST). `RETURNING`으로 갱신과 읽기를 한 문장에 묶어, 동시
    // 호출이 있어도 그 문장의 원자성이 "첫 값이 이긴다"를 보장한다(별도 트랜잭션 불필요).
    this.#revokeLog = db.prepare(
      'UPDATE logs SET revoked_at = COALESCE(revoked_at, ?) WHERE log_id = ? RETURNING revoked_at',
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

  async revoke(subject: string, logId: string): Promise<{ readonly revokedAt: string }> {
    if (this.#selectMembership.get(subject, logId) === undefined) {
      // 존재하지 않는 로그와, 존재하지만 이 주체가 애초에 grant받지 못한 로그를 구분하지
      // 않는다 (§2.6 — §2.4의 같은 규율). 폐기 상태는 이 판정에 들어가지 않는다: 이미
      // 폐기된 로그라도 폐기 이전에 관계 행이 있었다면 여기를 통과한다.
      throw new ControlStoreError('log_not_found')
    }
    const row = this.#revokeLog.get(new Date().toISOString(), logId)
    return { revokedAt: columnAsRevokedAt(row?.['revoked_at']) }
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
    addMissingRevocationColumn(db)
  } catch (error) {
    db.close()
    throw error
  }
  return new SqliteControlStore(db, options.randomBytes ?? nodeRandomBytes)
}
