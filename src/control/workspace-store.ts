/**
 * 작업공간 생애 추적 — 기록과 파생 상태 (`0003 §4`, mori-nest #68 범위 5번의 절반 · #97
 * 조각 1/3).
 *
 * ## 이 조각이 서는 것, 아직 서지 않는 것
 *
 * 이 파일이 세우는 것은 **개시**(`openWorkspace`)와 **단건 조회**(`getWorkspace`)뿐이다.
 * 하트비트·종료·폐기 전이는 조각 2/3, `state`·`after`·`limit`로 거르는 목록 조회는 조각
 * 3/3이다 — 그래서 이 조각이 만드는 기록은 `active`로 태어나 `active`로만 있다. 스키마는
 * 그 두 후속 조각이 쓸 자리(`terminal_state`·`ended_at`)까지 미리 열어 두지만, 이 파일의
 * 쓰기 경로는 그 두 컬럼에 `NULL` 이외의 값을 넣지 않는다.
 *
 * ## 별도 모듈, 별도 DB — 근거
 *
 * `src/control/store.ts`(로그·`(주체, 로그)` 관계)에 테이블을 얹지 않고 새 모듈·새 DB 파일로
 * 세운 이유 둘:
 *
 * 1. 이 조각이 열릴 때 `src/control/store.ts`를 고치는 PR #95가 열려 있었다 — 같은 파일을
 *    고치면 병합 충돌이 난다. 새 모듈은 그 위험이 없다.
 * 2. 이 스토어는 `isGranted`(grant 판정)를 부르지 않는다 — `logs`는 개시 시 스코프로
 *    **기록만** 한다(비범위: grant 판정·토큰 발급은 발급 라우트의 몫). 로그 스토어와 같은
 *    커넥션이어야 할 이유가 코드 어디에도 없으므로 갈라 둔다.
 *
 * ## `workspaceId`에 접두사(`ws_`)를 둔다
 *
 * `logId`(`src/control/store.ts`)는 접두사가 없다 — 그 결정은 mori-nest #72에서 owner가
 * "의미를 둘 소비자가 없다"는 이유로 내렸다. `workspaceId`는 사정이 다르다: 이 스토어
 * 자체가 같은 문자열 공간에서 `logId`와 `workspaceId`를 섞어 다루지 않지만(별도 컬럼,
 * 별도 PK), `0003 §2.3`이 "제어 평면은 mint하는 문자열에 접두사를 둘 수 있다"고 연 자리를
 * 여기서 처음 쓴다 — 로그와 작업공간을 사람이 읽을 때(디버깅 로그, DB 덤프) 구분하는
 * 것만이 목적이고, 인가나 라우팅을 접두사로 표현하지 않는다(`§2.3` MUST NOT 그대로).
 *
 * ## `logs`를 JSON 배열 하나로 저장한다 — 조인 테이블이 아니다
 *
 * `log_subjects`(다대다, `store.ts`)와 달리 이 `logs`는 **개시 시점에 얼어붙는 스냅샷**이다
 * (`0003 §4.6`: "조회에 싣는 것은 개시 시 스코프다. 갱신으로 좁아진 현재 스코프는 싣지
 * 않는다"). 이 조각의 조회 축은 `workspaceId` 하나뿐이고 — 목록 조회(조각 3/3)도 `§4.6`이
 * 정한 축은 `state`·`after`·`limit`이지 `logId` 멤버십이 아니다 — `logId`로 거꾸로 찾는
 * 질의가 스펙 어디에도 없다. 그 축이 없으면 조인 테이블은 삽입 비용만 늘리고 아무 질의도
 * 얻지 못한다.
 *
 * ## `active`를 제외한 네 상태로의 전이는 이 파일에 없다 — 그래도 자리는 스키마에 있다
 *
 * `terminal_state`·`ended_at` 컬럼은 지금 항상 `NULL`이다. 조각 2/3(하트비트·종료·폐기)이
 * 그 값을 채우는 유일한 쓰기 경로가 될 것이다. `abandoned`는 그 넷과 다르다 — **저장되는
 * 값이 아니다.** `getWorkspace`가 조회 시각에 계산한다: {@link resolveActiveState}가 그
 * 계산 자리이고, 조각 3/3의 목록 조회가 같은 함수를 재사용한다(이슈 본문의 요구 — "계산
 * 자리가 재사용 가능한 형태다").
 *
 * ## 원자성 — mint는 트랜잭션 밖, `supersedes` 검증과 삽입은 트랜잭션 안
 *
 * `mintWorkspaceId`는 `BEGIN IMMEDIATE` **이전**에 부른다 — `src/control/credential.ts`의
 * `rotate()`와 같은 이유다: 난수원이 짧은 버퍼를 돌려주면 {@link readEntropy}가 던지는데,
 * 트랜잭션 안에서 던지면 그 예외를 잡는 코드가 없어 예약 락이 커밋도 롤백도 되지 않은 채
 * 커넥션에 남는다. `supersedes` 소유권 검증은 삽입과 **같은** `BEGIN IMMEDIATE` 안에 있다 —
 * 검증이 통과한 뒤 삽입이 실패하면(예: id 충돌) 롤백이 검증 결과까지 함께 되돌린다.
 */

import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'

import { readEntropy, type RandomBytesFn } from './store.js'

/** `SQLITE_CONSTRAINT_PRIMARYKEY`. `workspaces.workspace_id` 충돌 — mint가 이미 있는 id를 뽑았다. */
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555

/** `SQLITE_CONSTRAINT_CHECK`. `workspaces.subject <> ''` 위반. */
const SQLITE_CONSTRAINT_CHECK = 275

/** 잠금 대기 상한. 근거는 `src/control/store.ts`의 같은 값과 같다. */
const BUSY_TIMEOUT_MS = 5000

/** mint 재시도 상한. 근거는 `src/control/store.ts`의 `MAX_MINT_ATTEMPTS`와 같다. */
const MAX_MINT_ATTEMPTS = 5

/** `mintLogId`(`src/control/store.ts`)와 같은 128비트 하한 — `§2.1`의 예측 불가능성
 * 요구를 그대로 옮긴다(`§4.2`가 `workspaceId`에 "§2.1·§2.2의 규칙이 그대로 적용된다"고
 * 못박았다). */
const WORKSPACE_ID_ENTROPY_BYTES = 16

/** 파일 상단 doc "`workspaceId`에 접두사를 둔다" 참고. */
const WORKSPACE_ID_PREFIX = 'ws_'

/** 접두사 + base64url(16바이트) 모양. */
const WORKSPACE_ID_PATTERN = /^ws_[A-Za-z0-9_-]{1,128}$/

/** 이 스토어의 스키마. `terminal_state`·`ended_at`은 조각 2/3이 채운다(파일 상단 doc). */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id      TEXT PRIMARY KEY,
  subject           TEXT NOT NULL CHECK (subject <> ''),
  opened_at         TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  logs              TEXT NOT NULL,
  supersedes        TEXT,
  replica_id        TEXT,
  terminal_state    TEXT CHECK (terminal_state IN ('closed_flushed', 'closed_discarded', 'revoked')),
  ended_at          TEXT,
  CHECK ((terminal_state IS NULL) = (ended_at IS NULL))
) STRICT;

CREATE INDEX IF NOT EXISTS workspaces_supersedes ON workspaces (supersedes);
`

/**
 * `workspaceId`를 mint한다 (`0003 §4.2` — "`§2.1`·`§2.2`의 규칙이 그대로 적용된다").
 * `mintLogId`(`src/control/store.ts`)와 같은 엔트로피 하한·같은 방어적 확인 구조이고,
 * 다른 것은 접두사(파일 상단 doc)뿐이다.
 */
export function mintWorkspaceId(randomBytes: RandomBytesFn = nodeRandomBytes): string {
  let bytes: Buffer
  try {
    bytes = readEntropy(randomBytes, WORKSPACE_ID_ENTROPY_BYTES)
  } catch {
    throw new WorkspaceStoreError('random_source_too_short')
  }
  const workspaceId = `${WORKSPACE_ID_PREFIX}${bytes.toString('base64url')}`
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new WorkspaceStoreError('minted_id_invalid')
  }
  return workspaceId
}

/** 이 스토어가 낼 수 있는 실패의 이유. 고정 문자열이고 `subject`·`workspaceId` 원문을 담지 않는다. */
export type WorkspaceStoreFailure =
  /** {@link mintWorkspaceId}가 낸 값이 {@link WORKSPACE_ID_PATTERN}을 만족하지 못한다 */
  | 'minted_id_invalid'
  /** 주입된 난수원이 요청한 바이트 수보다 짧은 버퍼를 돌려줬다 */
  | 'random_source_too_short'
  /** `subject`가 빈 문자열이다 */
  | 'blank_subject'
  /** `supersedes`가 가리키는 작업공간이 없거나 다른 주체의 것이다 (`§4.2` MUST — 호출자가
   * `404 workspace_not_found`로 옮길 수 있는 자리) */
  | 'workspace_not_found'
  /** mint 재시도가 {@link MAX_MINT_ATTEMPTS}를 넘었다 */
  | 'mint_exhausted'
  /** DB가 돌려준 행의 모양이 스키마와 다르다 */
  | 'unexpected_row_shape'

export class WorkspaceStoreError extends Error {
  readonly reason: WorkspaceStoreFailure

  constructor(reason: WorkspaceStoreFailure) {
    super(reason)
    this.name = 'WorkspaceStoreError'
    this.reason = reason
  }
}

/** `0003 §4.1`의 상태 이름 다섯 전부. 이 파일이 만드는 기록은 `active`이거나(저장값)
 * `abandoned`다(파생값) — 나머지 셋은 조각 2/3이 쓴다(파일 상단 doc). */
export type WorkspaceState = 'active' | 'closed_flushed' | 'closed_discarded' | 'revoked' | 'abandoned'

/** `§4.6`의 `WorkspaceRecord`(HTTP 표현 제외). 부재 필드는 값이 없는 것이지 `null`이
 * 아니다(`exactOptionalPropertyTypes` — `replicaId` 미신고를 `undefined`로도 메우지 않는다,
 * `§4.6` MUST NOT). */
export type WorkspaceRecord = {
  readonly workspaceId: string
  readonly state: WorkspaceState
  readonly logs: readonly string[]
  readonly openedAt: string
  readonly lastHeartbeatAt: string
  readonly endedAt?: string
  readonly supersedes?: string
  readonly supersededBy?: string
  readonly replicaId?: string
}

/** {@link WorkspaceStore.openWorkspace}의 요청 모양 (`§4.2`의 `OpenWorkspaceRequest`에서
 * HTTP 유효성 검증이 걸러야 할 것 — 정규식·빈 배열 — 은 이 스토어의 몫이 아니다, 파일
 * 상단 doc 비범위 참고). */
export type OpenWorkspaceRequest = {
  readonly logs: readonly string[]
  readonly supersedes?: string
  readonly replicaId?: string
}

/** {@link WorkspaceStore.getWorkspace}가 파생 상태를 계산하는 데 쓰는 인자. 둘 다
 * `parseControlConfig`에 없다 — 이슈 본문 "쓰는 코드가 없는 필드를 스키마에 미리 만들지
 * 않는다"(`src/control/index.ts`)와 같은 이유로, `gracePeriod > tokenTtl` 강제(`§3.4`)는
 * 그 값을 정하는 라우트의 몫이다. */
export type GetWorkspaceOptions = {
  /** 유기 판정의 grace 창, 밀리초. 배포 파라미터이고 이 스토어는 값을 검증하지 않는다. */
  readonly gracePeriodMs: number
  /** 조회 기준 시각. 부재면 현재 시각 — `verifyWorkspaceToken(..., { now })`의 선례(§3.3
   * 구현)와 같은 주입 지점이다. */
  readonly now?: Date
}

export type WorkspaceStore = {
  /**
   * 작업공간을 개시한다 (`§4.2`). `lastHeartbeatAt`은 `openedAt`으로 초기화된다 (MUST).
   *
   * @throws {WorkspaceStoreError} `subject`가 빈 문자열이면 (`blank_subject`); `supersedes`가
   *   있는데 없는 id이거나 다른 주체의 것이면 (`workspace_not_found`, **작업공간은 만들어지지
   *   않는다**); mint가 {@link MAX_MINT_ATTEMPTS}번 전부 기존 id와 충돌하면 (`mint_exhausted`).
   */
  openWorkspace(subject: string, request: OpenWorkspaceRequest): Promise<{ readonly workspaceId: string }>

  /**
   * 단건 조회 — 저장분이 `active`면 조회 시각으로 재판정한다 (`§4.6`). 없는 작업공간과
   * 다른 주체의 작업공간을 구분하지 않는다 — 둘 다 `undefined`다 (`§4.6` MUST, 열거 오라클
   * 방지).
   */
  getWorkspace(subject: string, workspaceId: string, options: GetWorkspaceOptions): Promise<WorkspaceRecord | undefined>

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

function columnAsString(value: SQLOutputValue | undefined): string {
  if (typeof value !== 'string') {
    throw new WorkspaceStoreError('unexpected_row_shape')
  }
  return value
}

function columnAsNullableString(value: SQLOutputValue | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new WorkspaceStoreError('unexpected_row_shape')
  }
  return value
}

function columnAsLogs(value: SQLOutputValue | undefined): readonly string[] {
  if (typeof value !== 'string') {
    throw new WorkspaceStoreError('unexpected_row_shape')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new WorkspaceStoreError('unexpected_row_shape')
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new WorkspaceStoreError('unexpected_row_shape')
  }
  return parsed
}

/**
 * 저장분이 `active`(즉 `terminal_state IS NULL`)일 때의 파생 상태 계산 — 이 파일의
 * `getWorkspace`와 조각 3/3의 목록 조회가 공유하는 **유일한 계산 자리** (파일 상단 doc).
 *
 * `endedAt`은 조회 시각이 아니라 `lastHeartbeatAt + gracePeriodMs`다 (`§4.6` MUST) — 그래야
 * 같은 기록을 다른 시각에 조회해도 같은 값이 나온다.
 */
export function resolveActiveState(
  lastHeartbeatAt: string,
  options: { readonly gracePeriodMs: number; readonly now: Date },
): { readonly state: 'active' | 'abandoned'; readonly endedAt?: string } {
  const deadline = new Date(lastHeartbeatAt).getTime() + options.gracePeriodMs
  if (options.now.getTime() >= deadline) {
    return { state: 'abandoned', endedAt: new Date(deadline).toISOString() }
  }
  return { state: 'active' }
}

function rowToRecord(
  workspaceId: string,
  row: Record<string, SQLOutputValue>,
  options: { readonly gracePeriodMs: number; readonly now: Date; readonly supersededBy: string | undefined },
): WorkspaceRecord {
  const lastHeartbeatAt = columnAsString(row['last_heartbeat_at'])
  const storedTerminalState = columnAsNullableString(row['terminal_state'])
  const storedEndedAt = columnAsNullableString(row['ended_at'])

  // `terminal_state`가 있으면 조각 2/3이 확정한 종단 상태를 그대로 낸다 — 재판정하지
  // 않는다(`§4.1` MUST NOT: abandoned에서도 종단 상태에서도 부활이 없다). 오늘은 이 분기가
  // 죽은 코드다 — 이 파일의 쓰기 경로가 그 컬럼을 채우지 않는다(파일 상단 doc).
  const { state, endedAt } =
    storedTerminalState === undefined
      ? resolveActiveState(lastHeartbeatAt, options)
      : { state: storedTerminalState as WorkspaceState, endedAt: storedEndedAt }

  const supersedes = columnAsNullableString(row['supersedes'])
  const replicaId = columnAsNullableString(row['replica_id'])

  return {
    workspaceId,
    state,
    logs: columnAsLogs(row['logs']),
    openedAt: columnAsString(row['opened_at']),
    lastHeartbeatAt,
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(supersedes !== undefined ? { supersedes } : {}),
    ...(options.supersededBy !== undefined ? { supersededBy: options.supersededBy } : {}),
    ...(replicaId !== undefined ? { replicaId } : {}),
  }
}

function applyPragmas(db: DatabaseSync): void {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  db.exec('PRAGMA journal_mode = WAL')
  // `§4.1`: "active·closed_*·revoked로의 전이는 응답 전에 내구화된다" (MUST) — 이미
  // `openControlStore`가 거는 것과 같은 층위, 새 PRAGMA를 만들지 않는다(이슈 본문).
  db.exec('PRAGMA synchronous = FULL')
}

/** `node:sqlite` 위의 {@link WorkspaceStore} 구현. 메서드 본문에 `await`가 없다 —
 * `src/control/store.ts` 파일 상단 doc과 같은 규율(트랜잭션 구간에 `await`를 넣으면
 * 이벤트 루프가 다른 호출에 제어를 넘겨 트랜잭션이 겹칠 수 있다). */
class SqliteWorkspaceStore implements WorkspaceStore {
  readonly #db: DatabaseSync
  readonly #randomBytes: RandomBytesFn
  readonly #insert: StatementSync
  readonly #selectByWorkspaceId: StatementSync
  readonly #selectSupersededBy: StatementSync
  #closed = false

  constructor(db: DatabaseSync, randomBytes: RandomBytesFn) {
    this.#db = db
    this.#randomBytes = randomBytes
    this.#insert = db.prepare(
      `INSERT INTO workspaces (workspace_id, subject, opened_at, last_heartbeat_at, logs, supersedes, replica_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    this.#selectByWorkspaceId = db.prepare(
      `SELECT subject, opened_at, last_heartbeat_at, logs, supersedes, replica_id, terminal_state, ended_at
       FROM workspaces WHERE workspace_id = ?`,
    )
    this.#selectSupersededBy = db.prepare(
      'SELECT workspace_id FROM workspaces WHERE supersedes = ? ORDER BY workspace_id ASC LIMIT 1',
    )
  }

  async openWorkspace(subject: string, request: OpenWorkspaceRequest): Promise<{ readonly workspaceId: string }> {
    const logsJson = JSON.stringify(request.logs)

    for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt += 1) {
      // mint는 `BEGIN IMMEDIATE` 이전이다 — 파일 상단 doc "원자성".
      const workspaceId = mintWorkspaceId(this.#randomBytes)
      const openedAt = new Date().toISOString()

      this.#db.exec('BEGIN IMMEDIATE')
      try {
        if (request.supersedes !== undefined) {
          const supersedesRow = this.#selectByWorkspaceId.get(request.supersedes)
          if (supersedesRow === undefined || columnAsString(supersedesRow['subject']) !== subject) {
            // `§4.2` MUST: "쓰는 사람이 그 기록의 주인인가"는 검증할 수 있고, 해야 한다.
            throw new WorkspaceStoreError('workspace_not_found')
          }
        }

        this.#insert.run(
          workspaceId,
          subject,
          openedAt,
          openedAt,
          logsJson,
          request.supersedes ?? null,
          request.replicaId ?? null,
        )
        this.#db.exec('COMMIT')
        return { workspaceId }
      } catch (error) {
        this.#rollbackQuietly()
        if (error instanceof WorkspaceStoreError) {
          // `workspace_not_found`다 — id 충돌이 아니므로 재시도해도 소용없다.
          throw error
        }
        if (isPrimaryKeyViolation(error)) {
          // 이미 존재하는 workspaceId가 나왔다 — 다시 mint한다 (`mintLogId`와 같은 규율).
          continue
        }
        if (isCheckViolation(error)) {
          throw new WorkspaceStoreError('blank_subject')
        }
        throw error
      }
    }
    throw new WorkspaceStoreError('mint_exhausted')
  }

  async getWorkspace(
    subject: string,
    workspaceId: string,
    options: GetWorkspaceOptions,
  ): Promise<WorkspaceRecord | undefined> {
    const row = this.#selectByWorkspaceId.get(workspaceId)
    if (row === undefined) {
      return undefined
    }
    if (columnAsString(row['subject']) !== subject) {
      // `§4.6` MUST: 없는 작업공간과 다른 주체의 작업공간을 구분하지 않는다 (열거 오라클 방지).
      return undefined
    }

    const supersededByRow = this.#selectSupersededBy.get(workspaceId)
    const supersededBy = supersededByRow === undefined ? undefined : columnAsString(supersededByRow['workspace_id'])

    return rowToRecord(workspaceId, row, {
      gracePeriodMs: options.gracePeriodMs,
      now: options.now ?? new Date(),
      supersededBy,
    })
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

export type WorkspaceStoreOptions = {
  /** 테스트가 mint 결과를 고정하기 위한 주입 지점. 기본은 `node:crypto`의 `randomBytes`. */
  readonly randomBytes?: RandomBytesFn
}

/**
 * 스토어를 연다. `path`의 DB가 없으면 만들고, 있으면 그대로 연다.
 *
 * @param path DB 파일 경로. `:memory:`도 받는다 — `src/control/store.ts`의 로그 스토어와
 *   같은 이유로(라우트가 아직 없다) WAL 강제 확인까지는 하지 않는다.
 */
export async function openWorkspaceStore(path: string, options: WorkspaceStoreOptions = {}): Promise<WorkspaceStore> {
  const db = new DatabaseSync(path)
  try {
    applyPragmas(db)
    db.exec(SCHEMA)
  } catch (error) {
    db.close()
    throw error
  }
  return new SqliteWorkspaceStore(db, options.randomBytes ?? nodeRandomBytes)
}
