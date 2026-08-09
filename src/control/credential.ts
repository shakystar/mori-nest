/**
 * 런처 자격증명 — 발급·해시 저장·조회 판정·즉시 폐기 (`0003 §1.1` 형태, [사람 결정 §8-2]
 * (https://github.com/shakystar/mori-nest/issues/68#issuecomment-5211096830),
 * mori-nest #68 조각 5/5 · #74).
 *
 * ## #68 결정이 고른 형태 — 작업공간 토큰과 반대다
 *
 * 작업공간 토큰(`src/transport/token.ts`)은 **자체 검증형**이다 — 서명을 풀면 조회 없이
 * 판정이 끝난다. 그 이유는 전송 평면이 요청마다 조회를 하면 append 경로에 내구성
 * 단일 장애점이 생기기 때문이다(`0003 §3.3`). **런처 자격증명에는 그 제약이 없다** — 제어
 * 평면 여덟 라우트는 전부 짧은 요청/응답이고 대부분 어차피 저장소를 친다. 그래서 이 파일은
 * 반대를 고른다: **불투명 랜덤 bearer + 서버 측 해시 저장 + 요청마다 조회로 판정.**
 * 서명 스킴을 재사용하지 않는 것 자체가 `§1.1`이 요구하는 "두 자격은 구분 가능해야 한다"를
 * 형태만으로 만족시킨다.
 *
 * ## 저장 형태
 *
 * **평문을 저장하지 않는다** (MUST NOT). 저장되는 것은 SHA-256 해시뿐이고, 평문이 남는
 * 유일한 자리는 발급 응답이다 — `§3.8`이 작업공간 토큰에 건 규율과 같다. `src/control/store.ts`의
 * `logs`/`log_subjects`와는 별도 테이블·별도 관심사다(그쪽은 다대다 grant, 이쪽은
 * 자격증명 하나가 정확히 한 주체를 가리키는 조회).
 *
 * ## 판정 함수는 HTTP를 모른다 — 그래도 조회는 한다
 *
 * {@link LauncherCredentialStore.verify}는 판정 결과(주체, 또는 `0002 §1.5` 봉투)를
 * **반환**할 뿐 HTTP 응답을 쓰지 않는다 — `src/transport/token.ts`·`src/transport/request.ts`의
 * 선례와 같은 규율이다. 그 둘과 다른 점 하나: 이 판정은 서명을 푸는 순수 계산이 아니라
 * **조회**다 (위 "반대를 고른다"가 그 이유다) — 그래서 스토어 인스턴스에 매인 메서드다.
 *
 * ## 폐기는 즉시다 — 그 성질은 삭제로 난다
 *
 * 판정이 조회이므로, 행을 지우면 다음 조회부터 곧바로 실패한다. 작업공간 토큰이 `§3.5`에서
 * 감수한 `≤ tokenTtl` 잔여 창이 여기에는 없다. 회전은 "새 자격증명 발급 + 옛 자격증명
 * 폐기"를 한 트랜잭션으로 묶은 것뿐이다 — {@link LauncherCredentialStore.rotate}.
 */

import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'

import { ErrorCodes, errorResponse, type ErrorResponse } from '../errors.js'
import { readEntropy, type RandomBytesFn } from './store.js'

/** `SQLITE_CONSTRAINT_CHECK`. `launcher_credentials.subject <> ''` 위반. */
const SQLITE_CONSTRAINT_CHECK = 275

/** 잠금 대기 상한. 근거는 `src/control/store.ts`의 같은 값과 같다. */
const BUSY_TIMEOUT_MS = 5000

/** `§1.1` MUST 하한 그대로 — `mintLogId`(`src/control/store.ts`)와 같은 128비트. */
const CREDENTIAL_ENTROPY_BYTES = 16

/** 이 스토어의 스키마. 관계가 아니라 단일 조회이므로 열이 둘뿐이다. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS launcher_credentials (
  credential_hash TEXT PRIMARY KEY,
  subject TEXT NOT NULL CHECK (subject <> '')
) STRICT;
`

/** 자격증명 원문을 저장 표현으로 접는다. 이 함수의 출력만 DB에 닿는다 — 원문은 닿지 않는다. */
function hashCredential(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** 이 스토어가 낼 수 있는 실패의 이유. 고정 문자열이고 `subject`·자격증명 원문을 담지 않는다. */
export type LauncherCredentialFailure =
  /** `subject`가 빈 문자열이다 (`issue` 전용 — 조회 대상 credentialId가 없다) */
  | 'blank_subject'
  /** `revoke`·`rotate`가 가리킨 credentialId가 존재하지 않는다 */
  | 'credential_not_found'
  /** 주입된 난수원이 요청한 바이트 수보다 짧은 버퍼를 돌려줬다 ({@link readEntropy}) */
  | 'random_source_too_short'
  /** DB가 돌려준 행의 모양이 스키마와 다르다 */
  | 'unexpected_row_shape'

export class LauncherCredentialError extends Error {
  readonly reason: LauncherCredentialFailure

  constructor(reason: LauncherCredentialFailure) {
    super(reason)
    this.name = 'LauncherCredentialError'
    this.reason = reason
  }
}

/**
 * 자격증명 원문을 mint한다. 길이 계약 위반은 `src/control/store.ts`의 {@link readEntropy}가
 * 잡지만, 이 스토어의 에러 표면은 자기 것만 노출한다 — `ControlStoreError`를 그대로 새지
 * 않고 `LauncherCredentialError`로 다시 씌운다.
 */
function mintCredentialToken(randomBytes: RandomBytesFn): string {
  let bytes: Buffer
  try {
    bytes = readEntropy(randomBytes, CREDENTIAL_ENTROPY_BYTES)
  } catch {
    throw new LauncherCredentialError('random_source_too_short')
  }
  return bytes.toString('base64url')
}

/**
 * 발급 결과. **`token`이 평문이 남는 유일한 자리다** (`§1.1`·`§3.8`과 같은 규율). `credentialId`는
 * 저장된 해시 그 자체이고, `revoke`·`rotate`가 자격증명을 가리키는 데 쓴다 — 해시를 아는 것과
 * 그 해시를 낳은 원문으로 인증하는 것은 다른 일이다({@link LauncherCredentialStore.verify}는
 * 제시된 값을 다시 해시해 대조하므로, 해시를 그대로 제시해도 통과하지 않는다).
 */
export type IssuedCredential = {
  readonly credentialId: string
  readonly token: string
}

export type LauncherCredentialVerification =
  | { readonly ok: true; readonly subject: string }
  | { readonly ok: false; readonly error: ErrorResponse }

/**
 * 런처 자격증명 스토어. 발급 라우트·회전 라우트는 이 이슈의 비범위다(mori-nest #74) — 이
 * 표면은 그 라우트가 재사용할 스토어/함수 수준까지다.
 */
export type LauncherCredentialStore = {
  /**
   * 새 자격증명을 발급한다. 반환된 `token`이 평문이 남는 유일한 자리다.
   *
   * @throws {LauncherCredentialError} `subject`가 빈 문자열이면 (`blank_subject`).
   */
  issue(subject: string): Promise<IssuedCredential>

  /**
   * 제시된 값을 판정한다 — 조회해서 **주체**로 해석한다. 매치가 없으면 `401 unauthenticated`
   * 판정을 반환한다 (`§1.2`). 이 함수는 HTTP 응답을 쓰지 않는다 — 판정만 반환한다.
   */
  verify(token: string): Promise<LauncherCredentialVerification>

  /** 자격증명을 폐기한다. 존재하지 않는 `credentialId`에 대해서도 조용히 성공한다 (멱등). */
  revoke(credentialId: string): Promise<void>

  /**
   * 회전 — 같은 주체에게 새 자격증명을 발급하고 옛 것을 같은 트랜잭션에서 폐기한다. 한
   * 번의 호출이 §1.1의 "회전·폐기 경로를 처음부터 둔다"가 요구하는 회전이다.
   *
   * @throws {LauncherCredentialError} `credentialId`가 존재하지 않으면 (`credential_not_found`).
   */
  rotate(credentialId: string): Promise<IssuedCredential>

  /** 연결을 닫는다. 두 번 불러도 안전하다. */
  close(): Promise<void>
}

function isCheckViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { errcode?: unknown }).errcode === SQLITE_CONSTRAINT_CHECK
  )
}

function columnAsSubject(value: SQLOutputValue | undefined): string {
  if (typeof value !== 'string') {
    throw new LauncherCredentialError('unexpected_row_shape')
  }
  return value
}

/** `401` 판정. `details`에 실을 수 있는 값이 없다 — 제시된 자격증명은 원문이든 해시든
 * 어디에도 실리지 않는다 (`0003 §1.3` MUST NOT). */
function unauthenticated(): LauncherCredentialVerification {
  return {
    ok: false,
    error: errorResponse(ErrorCodes.unauthenticated, 'launcher credential is not valid'),
  }
}

function applyPragmas(db: DatabaseSync): void {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
}

/** `node:sqlite` 위의 {@link LauncherCredentialStore} 구현. 메서드 본문에 `await`가 없다 —
 * `src/control/store.ts` 파일 상단 doc과 같은 규율(트랜잭션 구간에 `await`를 넣으면
 * 이벤트 루프가 다른 호출에 제어를 넘겨 트랜잭션이 겹칠 수 있다). */
class SqliteLauncherCredentialStore implements LauncherCredentialStore {
  readonly #db: DatabaseSync
  readonly #randomBytes: RandomBytesFn
  readonly #insert: StatementSync
  readonly #selectSubject: StatementSync
  readonly #delete: StatementSync
  #closed = false

  constructor(db: DatabaseSync, randomBytes: RandomBytesFn) {
    this.#db = db
    this.#randomBytes = randomBytes
    this.#insert = db.prepare('INSERT INTO launcher_credentials (credential_hash, subject) VALUES (?, ?)')
    this.#selectSubject = db.prepare('SELECT subject FROM launcher_credentials WHERE credential_hash = ?')
    this.#delete = db.prepare('DELETE FROM launcher_credentials WHERE credential_hash = ?')
  }

  async issue(subject: string): Promise<IssuedCredential> {
    const token = mintCredentialToken(this.#randomBytes)
    const credentialId = hashCredential(token)
    try {
      this.#insert.run(credentialId, subject)
    } catch (error) {
      if (isCheckViolation(error)) {
        throw new LauncherCredentialError('blank_subject')
      }
      throw error
    }
    return { credentialId, token }
  }

  async verify(token: string): Promise<LauncherCredentialVerification> {
    const row = this.#selectSubject.get(hashCredential(token))
    if (row === undefined) {
      return unauthenticated()
    }
    return { ok: true, subject: columnAsSubject(row['subject']) }
  }

  async revoke(credentialId: string): Promise<void> {
    this.#delete.run(credentialId)
  }

  async rotate(credentialId: string): Promise<IssuedCredential> {
    // mint를 BEGIN IMMEDIATE 이전에 한다 — issue()·store.ts의 createLog와 같은 이유:
    // mintCredentialToken은 던질 수 있고(readEntropy가 짧은 난수원을 거부), 트랜잭션
    // 안에서 던지면 그 예외를 잡는 catch가 없어 예약 락이 커밋도 롤백도 되지 않은 채
    // 커넥션에 남는다.
    const token = mintCredentialToken(this.#randomBytes)
    const newCredentialId = hashCredential(token)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.#selectSubject.get(credentialId)
      if (row === undefined) {
        throw new LauncherCredentialError('credential_not_found')
      }
      this.#insert.run(newCredentialId, columnAsSubject(row['subject']))
      this.#delete.run(credentialId)
      // 커밋이 돌아온 시점에 새 자격증명이 있고 옛 것은 없다 — 회전이 한 번의 호출로
      // 표현된다(§1.1). 삽입이 실패하면 옛 자격증명은 롤백으로 그대로 남는다: 회전
      // 시도 실패가 기존 접근을 조용히 잃게 만들지 않는다.
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#rollbackQuietly()
      throw error
    }
    return { credentialId: newCredentialId, token }
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

export type LauncherCredentialStoreOptions = {
  /** 테스트가 발급 결과를 고정하기 위한 주입 지점. 기본은 `node:crypto`의 `randomBytes`. */
  readonly randomBytes?: RandomBytesFn
}

/**
 * 스토어를 연다. `path`의 DB가 없으면 만들고, 있으면 그대로 연다.
 *
 * @param path DB 파일 경로. `:memory:`도 받는다 — `src/control/store.ts`의 로그 스토어와
 *   같은 이유로(라우트가 아직 없다) WAL 강제 확인까지는 하지 않는다.
 */
export async function openLauncherCredentialStore(
  path: string,
  options: LauncherCredentialStoreOptions = {},
): Promise<LauncherCredentialStore> {
  const db = new DatabaseSync(path)
  try {
    applyPragmas(db)
    db.exec(SCHEMA)
  } catch (error) {
    db.close()
    throw error
  }
  return new SqliteLauncherCredentialStore(db, options.randomBytes ?? nodeRandomBytes)
}
