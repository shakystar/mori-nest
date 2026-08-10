/**
 * 제어 평면 멱등성 계층 (`0003 §1.4`) — `POST /v1/logs`·`POST /v1/workspaces`가 공유해서 탈
 * 자리다. 라우트도 서버도 여기 없다 — 이 파일이 아는 것은 (주체, 키, 요청 본문) 삼중과 그
 * 판정뿐이다.
 *
 * 두 조각으로 갈린다:
 * - {@link parseIdempotencyKey} — `Idempotency-Key` 헤더의 형식 판정. `src/transport/request.ts`와
 *   같은 규율이다: **판정을 반환할 뿐 HTTP 응답을 쓰지 않는다.**
 * - {@link IdempotencyStore} — 원자적 예약·재생·충돌 판정과 24시간 보관을 지는 저장소.
 *   구현은 `src/transport/store.ts`와 같은 `node:sqlite`다 (런타임 의존성 0 유지).
 *
 * ## 연결을 소유하지 않는다 (mori-nest #130 — UoW 조각 1/4)
 *
 * 이 파일에 `new DatabaseSync`가 없다. 연결은 `./db.ts`의 {@link ControlDatabase}가 소유하고
 * 이 스토어는 그 위에 문장을 준비하는 **리포지토리**다 — 그래서 `close()`도 없다(닫는 것은
 * 연결의 소유자다). 그 대가로 얻는 것: 자격증명 쓰기와 멱등 쓰기가 `withTransaction` 하나
 * 안에서 **함께 커밋된다.** 파일이 갈려 있던 동안에는 표현할 수조차 없던 성질이다
 * (`./db.ts` 상단 doc).
 *
 * ## 원자성을 세우는 자리
 *
 * `§1.4`의 MUST — *"키 기록과 자원 생성은 원자적이다"* — 를 이 파일이 통째로 못 지킨다: 자원을
 * **만드는** 코드(로그·작업공간 생성)는 다음 조각(라우트 배선)에 있고 이 파일에는 없다. 대신
 * 이 파일이 지는 것은 그보다 좁고 정확한 절반이다 — **`reserve`가 `'reserved'`를 돌려주는
 * 호출은 동시에 최대 하나다.** 그 보장은 `(subject, key)`에 건 `PRIMARY KEY` 제약이 한다
 * (`store.ts`의 `UNIQUE (log_id, event_id)`와 같은 자리 — 판정하는 것은 제약이고 코드는 그
 * 위반을 **받아서** 분류할 뿐이다). 자원 생성 코드가 `'reserved'`를 받은 호출에서만 실행되는
 * 한, 그 호출이 항상 하나이므로 자원도 항상 하나다. 라우트 배선 조각이 지켜야 하는 규율은
 * 이것 하나뿐이다: **`'reserved'`가 아닌 결과에서는 자원을 만들지 않는다.**
 *
 * ## 예약과 완료가 갈린 이유 — `'in_progress'`
 *
 * 예약(`reserve`)과 완료(`complete`)가 한 호출이 아니라 둘인 것은, 응답(상태코드·본문)이
 * **자원을 실제로 만든 뒤에야** 정해지기 때문이다 — 만들기 전에는 저장할 것이 없다. 그 창
 * 사이에 같은 키로 두 번째 요청이 오면(정확히 `§1.4`가 든 시나리오 — 타임아웃을 만난 런처의
 * 재시도) 저장소는 아직 응답이 없다. 그 상태를 `'conflict'`·`'replay'`와 같은 값으로 뭉개지
 * 않고 `'in_progress'`로 따로 낸다 — 처음 결과를 아직 모르면서 재생한 것처럼 굴거나(거짓
 * 재생) 다른 본문인 것처럼 굴면(거짓 충돌) 둘 다 틀리기 때문이다. 이 상태를 무엇으로 옮길지
 * (대기·재시도 유도·5xx)는 자원 생성 코드를 쥔 라우트 배선 조각의 몫이다.
 */

import { createHash } from 'node:crypto'
import { type DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'

import type { ControlDatabase } from './db.js'

/** `0003 §1.4`: `Idempotency-Key := ^[A-Za-z0-9_.:-]{1,128}$`. */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/

export type IdempotencyKeyResult = { readonly ok: true; readonly key: string } | { readonly ok: false }

/**
 * `Idempotency-Key` 헤더 값의 형식 판정.
 *
 * **부재와 형식 위반을 구분하지 않는다** — `0003 §1.3` 표에 `missing_idempotency_key` 하나만
 * 있고, `request.ts`의 `parseLimitFormat`이 반복 쿼리·비숫자를 하나의 `malformed_request`로
 * 합류시킨 것과 같은 이유다: 둘 다 "그 라우트가 쓸 수 있는 키가 없다"는 같은 뜻이라 새 code를
 * 만들지 않는다.
 *
 * @param headerValue 이미 단일 값으로 좁혀진 헤더 값 (중복 헤더 판정은 부르는 쪽의 몫이다 —
 *   `request.ts`의 `atMostOne`이 그 선례다).
 */
export function parseIdempotencyKey(headerValue: string | null | undefined): IdempotencyKeyResult {
  if (headerValue === null || headerValue === undefined || !IDEMPOTENCY_KEY_PATTERN.test(headerValue)) {
    return { ok: false }
  }
  return { ok: true, key: headerValue }
}

/** 멱등성 키 하나가 최소한으로 보관되는 시간 (`§1.4` MUST). */
const RETENTION_MS = 24 * 60 * 60 * 1000

const SQLITE_CONSTRAINT_PRIMARYKEY = 1555

/**
 * 저장된 응답. `body`는 이미 직렬화된 JSON 문자열이다 — 이 계층은 응답의 **모양**을 모른다
 * (로그 생성과 작업공간 개시가 서로 다른 스키마를 돌려주므로), 재생할 때 바이트를 그대로
 * 돌려주는 것까지가 이 계층의 일이다.
 */
export type IdempotencyRecord = {
  readonly status: number
  readonly body: string
}

/**
 * `reserve`의 판정. 넷 중 라우트가 자원을 만들어도 되는 것은 `'reserved'` **하나뿐이다**
 * (파일 상단 doc).
 */
export type IdempotencyReservation =
  | { readonly kind: 'reserved' }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'replay'; readonly record: IdempotencyRecord }

export type IdempotencyStoreFailure =
  /**
   * DB가 돌려준 행의 모양이 스키마와 다르다.
   *
   * 내구성 PRAGMA 실패(`durability_pragmas_not_applied`)는 더 이상 이 표면에 없다 — 연결을
   * 여는 자리가 `./db.ts`로 옮겨갔으므로 그 사유도 그쪽 `ControlDatabaseError`가 낸다
   * (문자열은 그대로다, mori-nest #130).
   */
  | 'unexpected_row_shape'
  /** `subject`가 빈 문자열이다 — 네임스페이스가 없는 예약을 만들지 않는다 (`§1.4` MUST). */
  | 'missing_subject'
  /** `complete`가 가리키는 `(subject, key)` 예약이 없다 — `reserve`로 예약하지 않고 부른 것. */
  | 'reservation_not_found'

export class IdempotencyStoreError extends Error {
  readonly reason: IdempotencyStoreFailure

  constructor(reason: IdempotencyStoreFailure) {
    super(reason)
    this.name = 'IdempotencyStoreError'
    this.reason = reason
  }
}

/**
 * 멱등성 키의 예약·완료를 지는 저장소. `Promise`를 돌려주는 인터페이스 뒤에 동기 구현이
 * 있는 것도 `store.ts`와 같다 (같은 이유 — 훗날 Postgres로 갈 때 인터페이스 교체만으로).
 */
export type IdempotencyStore = {
  /**
   * `(subject, key)`를 예약한다 (`§1.4`).
   *
   * @param subject 요청 주체. **네임스페이스가 이것이다** (`§1.4` MUST) — 다른 주체가 같은
   *   `key`를 써도 서로 부딪히지 않는다. 이 계층은 이 값을 해석하지 않는다 — 런처 자격증명
   *   인증(조각 5/5)이 이 값을 무엇으로 채울지 정한다.
   * @param key `parseIdempotencyKey`를 통과한 키.
   * @param requestBody 요청 본문 원문. 바이트를 저장하지 않고 다이제스트만 저장한다 — 이
   *   계층이 필요로 하는 것은 "같은 본문인가"뿐이고, 본문 자체를 다시 보여줄 일이 없다.
   * @param now 판정 기준 시각. 기본값은 현재 시각 — 보관 창(24시간)의 경계를 주입된 시각으로
   *   시험할 수 있게 한다 (`server.ts`가 이미 쓰는 관례).
   */
  reserve(subject: string, key: string, requestBody: string, now?: Date): Promise<IdempotencyReservation>

  /**
   * 예약을 응답으로 완결한다. `reserve`가 `'reserved'`를 돌려준 호출만 이것을 부른다.
   *
   * @throws {IdempotencyStoreError} 가리키는 예약이 없으면 (`reservation_not_found`) —
   *   `reserve` 없이 부른 것이라 부르는 쪽의 결함이다.
   */
  complete(subject: string, key: string, record: IdempotencyRecord): Promise<void>
}

/**
 * 스키마. `PRIMARY KEY (subject, key)`가 원자성을 지는 제약이다 (파일 상단 doc) — 위반의
 * 확장 결과코드는 `SQLITE_CONSTRAINT_PRIMARYKEY`(1555)이고, `store.ts`의 `UNIQUE` 위반
 * (2067)과 다른 코드다 (복합 기본키라 `store.ts`처럼 `UNIQUE`를 별도로 걸지 않는다).
 *
 * `status`·`response_body`가 `NULL` 허용인 것은 예약 직후·완료 전 상태를 표현하기 위해서다
 * (`'in_progress'`, 파일 상단 doc). `created_at`은 보관 창 판정과 만료 후 재예약(claim)의
 * CAS 기준값 둘 다로 쓴다 ({@link SqliteIdempotencyStore.reserve}).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS idempotency_keys (
  subject       TEXT NOT NULL,
  key           TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  status        INTEGER,
  response_body TEXT,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (subject, key)
) STRICT;
`

/** 요청 본문의 다이제스트. 저장소는 본문 원문을 보관하지 않는다 (타입 doc). */
function hashRequestBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

function isPrimaryKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { errcode?: unknown }).errcode === SQLITE_CONSTRAINT_PRIMARYKEY
  )
}

type StoredRow = {
  readonly requestHash: string
  readonly status: number | null
  readonly responseBody: string | null
  readonly createdAt: number
}

/** 정수 컬럼(`status`·`created_at`)을 좁힌다. `bigint`로 올 수 있어 `store.ts`의 `toSeq`와 같다. */
function toInteger(value: SQLOutputValue | undefined): number {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return Number(value)
  }
  throw new IdempotencyStoreError('unexpected_row_shape')
}

function toStoredRow(row: Record<string, SQLOutputValue>): StoredRow {
  const requestHash = row['request_hash']
  const status = row['status']
  const responseBody = row['response_body']
  if (typeof requestHash !== 'string') {
    throw new IdempotencyStoreError('unexpected_row_shape')
  }
  if (status !== null && typeof status !== 'number' && typeof status !== 'bigint') {
    throw new IdempotencyStoreError('unexpected_row_shape')
  }
  if (responseBody !== null && typeof responseBody !== 'string') {
    throw new IdempotencyStoreError('unexpected_row_shape')
  }
  return {
    requestHash,
    status: status === null ? null : Number(status),
    responseBody,
    createdAt: toInteger(row['created_at']),
  }
}

/** `node:sqlite` 위의 {@link IdempotencyStore} 구현 — 연결을 소유하지 않는 리포지토리다
 * (파일 상단 doc). */
class SqliteIdempotencyStore implements IdempotencyStore {
  readonly #insert: StatementSync
  readonly #select: StatementSync
  readonly #claimExpired: StatementSync
  readonly #complete: StatementSync

  constructor(db: DatabaseSync) {
    this.#insert = db.prepare(
      'INSERT INTO idempotency_keys (subject, key, request_hash, status, response_body, created_at) VALUES (?, ?, ?, NULL, NULL, ?)',
    )
    this.#select = db.prepare(
      'SELECT request_hash, status, response_body, created_at FROM idempotency_keys WHERE subject = ? AND key = ?',
    )
    // CAS: `created_at`이 읽은 값 그대로일 때만 만료된 행을 새 예약으로 덮는다. 두 프로세스가
    // 동시에 "만료됐다"고 판단해도 `WHERE created_at = ?`를 통과하는 것은 하나뿐이다 — 진 쪽은
    // `changes === 0`을 보고 다시 읽어 (이제 fresh해진) 행을 일반 경로로 판정한다.
    this.#claimExpired = db.prepare(
      'UPDATE idempotency_keys SET request_hash = ?, status = NULL, response_body = NULL, created_at = ? ' +
        'WHERE subject = ? AND key = ? AND created_at = ?',
    )
    // `status IS NULL`을 걸어 이미 완료된 예약을 다시 덮지 않는다 — 이 계층이 세운 «재시도는
    // 첫 결과 그대로»(§1.4 MUST)를 지키는 마지막 방어선이 라우트 배선(다음 조각)이 아니라
    // 여기 있어야, 자원 생성 코드의 실수로 `complete`가 두 번 불려도 첫 응답이 살아남는다.
    this.#complete = db.prepare(
      'UPDATE idempotency_keys SET status = ?, response_body = ? WHERE subject = ? AND key = ? AND status IS NULL',
    )
  }

  /**
   * `store.ts`와 같은 규율이다: 이 메서드 본문에는 **`await`가 하나도 없다.** `INSERT` 실패
   * 뒤의 재조회·`UPDATE`는 판정 하나를 완성하는 조각들이라, 그 사이에 `await`가 끼면 같은
   * 프로세스 안의 다른 `reserve` 호출이 이벤트 루프 자리를 얻어 같은 행을 동시에 손댈 수
   * 있다 — 그 순간 여기서 세운 원자성(파일 상단 doc)이 문서로만 남는다.
   */
  async reserve(
    subject: string,
    key: string,
    requestBody: string,
    now: Date = new Date(),
  ): Promise<IdempotencyReservation> {
    if (subject === '') {
      throw new IdempotencyStoreError('missing_subject')
    }
    const nowMs = now.getTime()
    const requestHash = hashRequestBody(requestBody)

    try {
      this.#insert.run(subject, key, requestHash, nowMs)
      return { kind: 'reserved' }
    } catch (error) {
      if (!isPrimaryKeyViolation(error)) {
        throw error
      }
      // 선판정이 아니다 — `INSERT`가 이미 "있다"를 판정했다. 여기서부터는 있는 행을 어떻게
      // 분류할지만 정한다 (`store.ts`의 `#insertOne` catch와 같은 자리).
    }

    let row = this.#selectRow(subject, key)
    // 보관 창(`§1.4` MUST, 최소 24시간)을 넘긴 행은 "새 자원" — 예약을 되찾는다. 경계는
    // **정확히 24시간 지난 시점부터** 만료로 본다: "최소 24시간"은 그 이전 전체를 보장하는
    // 것이지 24시간째 순간까지 보장하는 것이 아니다.
    if (nowMs - row.createdAt >= RETENTION_MS) {
      const claimed = this.#claimExpired.run(requestHash, nowMs, subject, key, row.createdAt)
      if (Number(claimed.changes) === 1) {
        return { kind: 'reserved' }
      }
      row = this.#selectRow(subject, key)
    }

    if (row.requestHash !== requestHash) {
      // `§1.4` MUST: 같은 키·다른 본문 → 조용히 첫 결과를 주지 않는다. 본문 불일치는 완료
      // 여부보다 먼저 판정한다 — 만료 후 재예약(claim) 경쟁에서 진 쪽이 이긴 쪽과 다른
      // 본문이면, 이긴 쪽의 `complete` 호출 전(아직 `status`가 없는 시점)이라도 최초 삽입
      // 경쟁 때와 같은 규율로 `conflict`를 받는다 — `in_progress`로 완화하지 않는다.
      return { kind: 'conflict' }
    }
    if (row.status === null) {
      return { kind: 'in_progress' }
    }
    if (row.responseBody === null) {
      // `complete`가 둘을 항상 함께 쓰므로 (`status`가 있는데 본문이 없는) 도달하면 안 되는
      // 모양이다 — 통과시키는 쪽으로 무너지지 않는다.
      throw new IdempotencyStoreError('unexpected_row_shape')
    }
    return { kind: 'replay', record: { status: row.status, body: row.responseBody } }
  }

  async complete(subject: string, key: string, record: IdempotencyRecord): Promise<void> {
    const changes = this.#complete.run(record.status, record.body, subject, key)
    if (Number(changes.changes) !== 1) {
      throw new IdempotencyStoreError('reservation_not_found')
    }
  }

  #selectRow(subject: string, key: string): StoredRow {
    const row = this.#select.get(subject, key)
    if (row === undefined) {
      // `PRIMARY KEY` 위반을 받았는데 그 행이 없다 — 도달하면 안 되는 상태다.
      throw new IdempotencyStoreError('unexpected_row_shape')
    }
    return toStoredRow(row)
  }
}

/**
 * 리포지토리를 연다 — 제어 평면 DB에 이 계층의 테이블이 없으면 만든다.
 *
 * @param database 연결의 소유자 (`./db.ts`). **경로를 받지 않는다** — DB를 여는 자리는
 *   `openControlDatabase` 하나다 (mori-nest #130).
 */
export async function openIdempotencyStore(database: ControlDatabase): Promise<IdempotencyStore> {
  const connection = database.connection
  connection.exec(SCHEMA)
  return new SqliteIdempotencyStore(connection)
}
