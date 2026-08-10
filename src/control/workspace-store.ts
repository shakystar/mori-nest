/**
 * 작업공간 생애 추적 — 기록과 파생 상태 (`0003 §4`, mori-nest #68 범위 5번의 절반 · #97
 * 조각 1/3), 그리고 상태를 움직이는 세 전이 (#98 조각 2/3).
 *
 * ## 이 조각이 서는 것, 아직 서지 않는 것
 *
 * 이 파일이 세우는 것은 **개시**(`openWorkspace`) · **단건 조회**(`getWorkspace`) · **하트비트**
 * (`heartbeat`, `§4.3`) · **종료 선언**(`closeWorkspace`, `§4.4`) · **폐기**(`revokeWorkspace`,
 * `§4.5`) · `state`·`after`·`limit`로 거르는 **목록 조회**(`listWorkspaces`, `§4.6`, 조각 3/3)다.
 * HTTP 라우트·상태코드·토큰 갱신은 어느 조각에도 아직 없다 — 이 스토어는 토큰을 모른다.
 *
 * ## 목록 조회의 `state` 필터는 `WHERE`에서 계산된다 — `resolveActiveState`와 같은 임계
 *
 * `abandoned`는 저장 컬럼이 아니라 파생값이므로(위 "abandoned는 파생값이다"), `state=abandoned`나
 * `state=active`로 거르려면 그 계산이 SQL 질의 층에서 일어나야 한다(`§4.6` MUST: 필터 → 정렬 →
 * `limit` 순서, 읽어 온 뒤 애플리케이션에서 거르면 `hasMore`가 거짓말이 된다). {@link
 * resolveActiveState}는 `now.getTime() >= lastHeartbeatAt.getTime() + gracePeriodMs`일 때
 * 유기로 판정한다 — 이 부등식을 그대로 옮기면 `lastHeartbeatAt <= now.getTime() - gracePeriodMs`이고,
 * 우변(`now - gracePeriod`)은 질의당 한 번만 계산되는 상수이므로 SQL이 각 행마다 재계산할 필요가
 * 없다. {@link SqliteWorkspaceStore.listWorkspaces}가 이 상수 하나(`abandonThresholdIso`)를
 * 계산해 넘기고, SQL의 `CASE`가 `resolveActiveState`와 **같은 부등식**(단지 좌우가 뒤집힌 대수적
 * 동치)을 적용한다 — 다른 임계를 새로 적지 않는다.
 *
 * ## `closeWorkspace`라는 이름 — 이슈가 적은 `close`가 아닌 이유
 *
 * #98 본문은 이 전이를 `close(subject, workspaceId, outcome, { now })`로 적었지만, 이
 * 인터페이스에는 이미 **연결을 닫는** `close()`가 있다(조각 1/3). 같은 이름에 두 뜻을 겹치면
 * `store.close()`가 "커넥션을 닫는다"인지 "작업공간을 닫는다"인지 호출 자리에서 갈리지
 * 않는다 — 오버로드로 둘 다 받으면 인자를 빠뜨린 오타가 커넥션을 닫아 버린다. `openWorkspace`·
 * `getWorkspace`·`revokeWorkspace`(이슈가 이 이름은 그렇게 적었다)와 같은 접미사를 써서
 * `closeWorkspace`로 둔다. 스펙 `§4.4`의 라우트 이름(`POST .../close`)과 요청 필드는 그대로다.
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
 * ## `abandoned`는 파생값이다 — 하트비트가 도착한 그 한 자리에서만 저장된다
 *
 * `getWorkspace`는 저장분이 `active`일 때 조회 시각으로 유기를 계산한다({@link
 * resolveActiveState}, `§4.1` MUST: "별도 스케줄러·배치가 돌아야만 상태가 바뀌는 구현을
 * 금지한다"). 그래서 `abandoned`는 원래 컬럼에 없는 값이다 — **단 하나의 예외가 늦게 도착한
 * 하트비트다.**
 *
 * 하트비트는 `last_heartbeat_at`을 앞으로 옮긴다. 유기 판정의 근거가 바로 그 값이므로, 이미
 * 유기인 기록에 그냥 하트비트를 쓰면 판정이 `active`로 **되돌아간다** — `§4.1`이 MUST NOT으로
 * 막은 부활이고, `0001 §2.4`가 드러내려던 "flush 없이 죽은 작업공간"이 조회에서 조용히
 * 사라지는 자리다. 그래서 `§4.1`은 *"하트비트가 도착하면 서버는 먼저 파생 상태를 계산하고,
 * 이미 유기면 `abandoned`를 기록으로 확정한 뒤 거부한다"* 로 못박았다. {@link
 * SqliteWorkspaceStore.heartbeat}이 그 확정을 쓰는 유일한 자리이고, 그래서 스키마의
 * `terminal_state` CHECK 목록에 `'abandoned'`가 들어 있다.
 *
 * **종료·폐기는 유기를 확정하지 않는다.** 확정이 필요한 이유가 "판정의 입력이 움직인다"인데
 * 그 둘은 `last_heartbeat_at`을 건드리지 않는다 — 실패로 끝나는 그 경로에서 파생 판정은
 * 몇 번을 다시 계산해도 같은 `abandoned`·같은 `endedAt`이다. 필요 없는 쓰기를 실패 경로에
 * 넣지 않는다.
 *
 * ## 원자성 — 읽기·판정·쓰기를 한 `BEGIN IMMEDIATE`에 넣고, 판정에 쓴 값을 `WHERE`에 다시 싣는다
 *
 * `mintWorkspaceId`는 `BEGIN IMMEDIATE` **이전**에 부른다 — `src/control/credential.ts`의
 * `rotate()`와 같은 이유다: 난수원이 짧은 버퍼를 돌려주면 {@link readEntropy}가 던지는데,
 * 트랜잭션 안에서 던지면 그 예외를 잡는 코드가 없어 예약 락이 커밋도 롤백도 되지 않은 채
 * 커넥션에 남는다. `supersedes` 소유권 검증은 삽입과 **같은** `BEGIN IMMEDIATE` 안에 있다 —
 * 검증이 통과한 뒤 삽입이 실패하면(예: id 충돌) 롤백이 검증 결과까지 함께 되돌린다.
 *
 * 세 전이(`§4.3`~`§4.5`)에도 같은 규율이 그대로 적용되고, `§4.1`이 그것을 MUST로 요구한다 —
 * *"같은 작업공간에 대한 `close`와 하트비트가 동시에 도착해도 결과는 둘 중 하나이지, 「닫힌 뒤
 * 하트비트가 `active`로 되돌리는」 것이 아니다."* 두 겹으로 지킨다:
 *
 * 1. **`BEGIN IMMEDIATE`가 1차 보장이다.** 「종단인가·유기인가」를 읽는 `SELECT`와 「종단으로
 *    만든다」를 쓰는 `UPDATE`가 한 트랜잭션 안에 있고, `IMMEDIATE`가 그 시작에서 쓰기 락을
 *    잡으므로 두 전이가 겹쳐 읽을 수 없다. 락 밖에서 읽은 상태를 근거로 락 안에서 쓰는 스팬이
 *    없다. 전이 메서드 본문에 `await`가 없는 것이 이 보장의 전제다 (아래 {@link
 *    SqliteWorkspaceStore} doc).
 * 2. **조건부 `UPDATE`가 2차 보장이다.** 판정에 쓴 두 값 — `terminal_state IS NULL`과 읽은
 *    `last_heartbeat_at` — 을 `WHERE`에 다시 싣는다. 1이 성립하는 한 0행 갱신은 나오지
 *    않지만, 나오면 그 전이는 **진 것**이므로 조용히 덮는 대신 `workspace_not_active`로
 *    실패한다. 나중에 누가 트랜잭션 경계를 옮기거나 `await`를 들이더라도 그 변경이 남의 전이를
 *    덮어쓰는 대신 실패로 드러난다.
 */

import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'

import { DEFAULT_PAGE_LIMIT, readEntropy, type RandomBytesFn } from './store.js'

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

/** `resolveLimit`이 받아들이는 상한. 근거는 `src/control/store.ts`의 같은 값과 같다
 * (음수 `LIMIT`은 SQLite에서 "무제한"으로 읽힌다). */
const MAX_ACCEPTED_LIMIT = 0x7fffffff

/** `§4.1`의 다섯 이름 전부 — `listWorkspaces`의 `state` 필터가 이 안에 있는지만 검사한다. */
const WORKSPACE_STATE_NAMES: readonly string[] = [
  'active',
  'closed_flushed',
  'closed_discarded',
  'revoked',
  'abandoned',
]

/**
 * 이 스토어의 스키마. `terminal_state`·`ended_at`은 세 전이(조각 2/3)가 채운다.
 *
 * CHECK 목록에 `'abandoned'`가 있는 것은 조각 1/3에서 늘어난 자리다 — 늦게 도착한 하트비트가
 * 유기를 기록으로 확정하는 자리 하나가 그 값을 쓴다(파일 상단 doc "`abandoned`는 파생값이다").
 * 컬럼도 테이블도 늘지 않으므로 마이그레이션 체계가 필요 없다. 이 조각 이전에 만들어진 DB
 * 파일은 `CREATE TABLE IF NOT EXISTS`가 건드리지 않아 좁은 CHECK를 그대로 갖지만, 그 값을 쓸
 * 라우트가 아직 없고(`§4.2`·`§4.3` 미구현) 그런 DB도 아직 없다.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id      TEXT PRIMARY KEY,
  subject           TEXT NOT NULL CHECK (subject <> ''),
  opened_at         TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  logs              TEXT NOT NULL,
  supersedes        TEXT,
  replica_id        TEXT,
  terminal_state    TEXT CHECK (terminal_state IN ('closed_flushed', 'closed_discarded', 'revoked', 'abandoned')),
  ended_at          TEXT,
  CHECK ((terminal_state IS NULL) = (ended_at IS NULL))
) STRICT;

CREATE INDEX IF NOT EXISTS workspaces_supersedes ON workspaces (supersedes);

-- listWorkspaces(§4.6)의 정렬·커서 축과 같은 열 순서 — 필터 → 정렬 → limit(§4.6 MUST)이 이
-- 인덱스 하나로 서비스된다(subject로 좁히고, opened_at·workspace_id로 정렬·커서 비교).
CREATE INDEX IF NOT EXISTS workspaces_subject_opened_at ON workspaces (subject, opened_at, workspace_id);

-- findForkAdvisory(§4.10, mori-nest #117)가 하트비트마다 도는 경로다 — 없으면 주체 전량
-- 스캔이 되어 #111(listWorkspaces N+1)과 같은 자리를 다시 만든다.
CREATE INDEX IF NOT EXISTS workspaces_subject_replica_id ON workspaces (subject, replica_id);
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
  /** `supersedes`가 가리키는 작업공간이 없거나 다른 주체의 것이다 (`§4.2` MUST), 또는 전이
   * 대상 작업공간이 없거나 다른 주체의 것이다 (`§4.3`~`§4.5`) — 호출자가 `404
   * workspace_not_found`로 옮기는 자리다. 없는 것과 다른 주체의 것은 여기서도 구분되지
   * 않는다 (`§4.6`의 열거 오라클 방지와 같은 이유). */
  | 'workspace_not_found'
  /** 전이 대상이 이미 종단 상태다 (`§4.1`: `closed_*`·`revoked`·`abandoned`) — 호출자가 `409
   * workspace_not_active`로 옮기는 자리다. 멱등이 성립하는 재시도(같은 `outcome`의 재종료,
   * 재폐기)는 여기에 들지 않는다 — 그 둘은 성공이다 (`§4.4`·`§4.5` MUST). */
  | 'workspace_not_active'
  /** mint 재시도가 {@link MAX_MINT_ATTEMPTS}를 넘었다 */
  | 'mint_exhausted'
  /** `listWorkspaces`의 `state`가 `§4.1`의 다섯 이름 중 하나가 아니다 — 호출자가 `400
   * invalid_state_filter`로 옮기는 자리다. 빈 문자열·알 수 없는 값도 "필터 없음"으로
   * 떨어지지 않고 여기 든다 (`§4.6` MUST NOT). */
  | 'invalid_state_filter'
  /** `listWorkspaces`의 `after`가 이 스토어가 발급한 커서 모양이 아니다 — 호출자가 `400
   * invalid_cursor`로 옮기는 자리다. 처음부터 주지 않는다 (`§4.6` MUST). */
  | 'invalid_cursor'
  /** `listWorkspaces`의 `limit`이 양의 안전 정수가 아니다. */
  | 'invalid_page_limit'
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

/** `§4.4`의 `CloseWorkspaceRequest.outcome`. 선택 필드가 아니고 기본값도 없다 — *"선언은
 * 명시적이어야 기록으로서 값이 있다"* (`§4.4`). */
export type CloseOutcome = 'flushed' | 'discarded'

/** 세 전이가 공유하는 인자. `gracePeriodMs`가 조회와 같은 이유로 여기 있다: 전이는 모두
 * **먼저 파생 상태를 판정**해야 한다 (`§4.1` — 유기는 저장분이 아니라 계산값이다). */
export type WorkspaceTransitionOptions = {
  /** 유기 판정의 grace 창, 밀리초. {@link GetWorkspaceOptions}의 같은 필드와 같은 값이어야
   * 조회와 전이의 판정이 갈리지 않는다 — 그 값을 정하는 것은 라우트다. */
  readonly gracePeriodMs: number
  /** 전이 시각. 부재면 현재 시각. */
  readonly now?: Date
}

/** {@link WorkspaceStore.closeWorkspace}·{@link WorkspaceStore.revokeWorkspace}가 확정한
 * 종단 상태. `§4.4`·`§4.5` 응답의 `state`·`endedAt`이 그대로 이 값이다 (`workspaceId`는
 * 호출자가 이미 안다). */
export type WorkspaceTerminalResult = {
  readonly state: 'closed_flushed' | 'closed_discarded' | 'revoked'
  readonly endedAt: string
}

/** {@link findForkOverlap}·{@link WorkspaceStore.findForkAdvisory}가 돌려주는 판정 결과
 * (`0003 §4.10`, mori-nest #117 조각 1/2). 이 값을 `HeartbeatResponse`에 싣는 배선은
 * `src/control/server.ts`의 `handleHeartbeatWorkspace`가 한다(조각 2/2, mori-nest #118) —
 * 이 파일 자신은 그 배선을 갖지 않는다(파일 상단 doc 비범위, 두 평면 경계). */
export type ForkOverlap = {
  readonly replicaId: string
  readonly overlappingWorkspaceId: string
}

/** {@link findForkOverlap}·{@link WorkspaceStore.findForkAdvisory}의 판정 인자. `now`가
 * 필수인 것은 {@link GetWorkspaceOptions}·{@link WorkspaceTransitionOptions}와 다르다 —
 * `findForkAdvisory`는 대상과 후보들을 각각 조회해 비교하므로, 그 사이에 시계가 움직이면
 * 겹침 판정 자체가 흔들린다. 호출자가 한 시각을 못박아 두 조회에 같이 넘긴다. */
export type FindForkAdvisoryOptions = {
  readonly gracePeriodMs: number
  readonly now: Date
}

/** {@link WorkspaceStore.listWorkspaces}의 요청 모양 (`§4.6`의 쿼리 셋, HTTP 유효성 검증
 * 이전의 스토어 표면 — 라우트가 `state`·`after`를 그대로 문자열로 넘기면 된다). */
export type ListWorkspacesOptions = {
  /** `§4.1`의 다섯 이름 중 하나가 아니면 실패한다 (`invalid_state_filter`) — 부재만
   * "필터 없음"이다. 타입을 `string`으로 둔 것은 검증을 이 스토어가 하기 때문이다
   * (`§4.6` MUST NOT: 타입 불일치를 "필터 없음"으로 떨어뜨리지 않는다). */
  readonly state?: string
  /** 이 스토어가 {@link WorkspaceStore.listWorkspaces}로 발급한 불투명 커서. 해석되지
   * 않으면 실패한다 (`invalid_cursor`) — 부재만 "처음부터"다. */
  readonly after?: string
  /** 페이지 크기. 부재면 `DEFAULT_PAGE_LIMIT`. 근거는 `listLogsForSubject`의 같은 필드와 같다. */
  readonly limit?: number
  /** 유기 판정의 grace 창, 밀리초. {@link GetWorkspaceOptions}의 같은 필드와 같은 값이어야
   * 단건 조회와 목록 조회의 판정이 갈리지 않는다. */
  readonly gracePeriodMs: number
  /** 조회 기준 시각. 부재면 현재 시각. */
  readonly now?: Date
}

export type ListWorkspacesPage = {
  readonly workspaces: readonly WorkspaceRecord[]
  /** `workspaces`의 마지막 항목 커서. `workspaces`가 비면 없다 (`§4.6`). */
  readonly cursor?: string
  readonly hasMore: boolean
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

  /**
   * 하트비트 — `lastHeartbeatAt`을 `now`로 옮긴다 (`§4.3`). 돌려주는 것은 옮긴 뒤의 값이다.
   *
   * 옮기기 **전에** 파생 상태를 판정한다: 이미 유기면 `abandoned`를 기록으로 확정하고
   * (`endedAt`은 확정 시각이 아니라 `lastHeartbeatAt + gracePeriod`다) 실패로 알린다
   * (`§4.1` MUST, 파일 상단 doc "`abandoned`는 파생값이다").
   *
   * 이 전이만 **내구성 요구에서 빠진다** (`§4.1` MAY 지연 기록: 하트비트 유실은 유기 오탐
   * 쪽으로 기우는데 그 방향은 안전하다). 그래도 커넥션 설정은 그대로다 — `synchronous`는
   * 연결 단위 PRAGMA이고, 이 전이 하나를 위해 그것을 낮추면 같은 커넥션의 종료·폐기가
   * 함께 내구성을 잃는다. 즉 이 면제는 **지금 비용을 덜 내고 있다는 뜻이 아니라, 나중에
   * 하트비트만 따로 덜 낼 수 있다는 뜻**이다.
   *
   * @throws {WorkspaceStoreError} 없는/다른 주체의 작업공간이면 (`workspace_not_found`);
   *   종단 상태이거나 이 호출이 유기를 확정했으면 (`workspace_not_active`).
   */
  heartbeat(
    subject: string,
    workspaceId: string,
    options: WorkspaceTransitionOptions,
  ): Promise<{ readonly state: 'active'; readonly lastHeartbeatAt: string }>

  /**
   * 종료 선언 (`§4.4`). `outcome`에 따라 `closed_flushed`·`closed_discarded`로 닫고
   * `endedAt`을 기록한다. 이름이 `close`가 아닌 이유는 파일 상단 doc에 있다.
   *
   * **같은 `outcome`으로 다시 닫으면 성공이고 결과가 같다** (`§4.4` MUST — 멱등성 키 없이
   * 멱등이다. 첫 `endedAt`이 그대로 다시 나온다).
   *
   * @throws {WorkspaceStoreError} 없는/다른 주체의 작업공간이면 (`workspace_not_found`);
   *   **다른** `outcome`으로 이미 닫혔거나 `revoked`·`abandoned`(파생 포함)면
   *   (`workspace_not_active`).
   */
  closeWorkspace(
    subject: string,
    workspaceId: string,
    outcome: CloseOutcome,
    options: WorkspaceTransitionOptions,
  ): Promise<WorkspaceTerminalResult>

  /**
   * 폐기 (`§4.5`). `revoked`로 닫고 `endedAt`을 기록한다. 이미 `revoked`면 같은 결과다
   * (MUST, 멱등). `reason`은 받지도 저장하지도 않는다 — `§4.5`의 요청 필드이고 응답에
   * 실리지 않는다. 보관 여부는 라우트 조각이 닫는다(`§2.6`의 `reason`을 #92가 다룬 방식).
   *
   * @throws {WorkspaceStoreError} 없는/다른 주체의 작업공간이면 (`workspace_not_found`);
   *   `closed_*`·`abandoned`(파생 포함)면 (`workspace_not_active`) — *"이미 갱신되지 않는
   *   상태이므로 폐기가 더할 것이 없다"*.
   */
  revokeWorkspace(
    subject: string,
    workspaceId: string,
    options: WorkspaceTransitionOptions,
  ): Promise<WorkspaceTerminalResult>

  /**
   * 목록 조회 (`§4.6`). **요청 주체가 연 작업공간만** 실린다 — 다른 주체를 지정하거나
   * 스코프를 끄는 인자는 없다 (MUST NOT, 파일 상단 doc). **필터 → 정렬 → `limit`** 순서로
   * 적용된다 (MUST): `state`가 있으면 파생 상태 계산이 `WHERE`에서 일어나고(`resolveActiveState`와
   * 같은 임계, 파일 상단 doc), 정렬은 `openedAt` 오름차순 + `workspaceId` 사전순 안정화다.
   * `hasMore`는 필터 적용 **후** 건수를 말한다 (`listLogsForSubject`의 `LIMIT`+1 관례와 같다).
   *
   * @throws {WorkspaceStoreError} `state`가 `§4.1`의 다섯 이름 밖이면 (`invalid_state_filter`);
   *   `after`가 이 스토어가 발급한 커서 모양이 아니면 (`invalid_cursor`); `limit`이 양의 안전
   *   정수가 아니면 (`invalid_page_limit`).
   */
  listWorkspaces(subject: string, options: ListWorkspacesOptions): Promise<ListWorkspacesPage>

  /**
   * 포크 판정 — 같은 `replicaId`를 신고한 활성 구간이 겹치는 다른 작업공간을 찾는다
   * (`§4.10`, advisory 조각 1/2). **읽기 전용이다 — 어떤 레코드도 쓰지 않는다** (`§7.2` MUST
   * NOT: 잠금·CAS·조건부 쓰기가 아니다).
   *
   * 대상이 없거나 다른 주체의 것이면 `undefined`다 — 여기서 `workspace_not_found`를 던지지
   * 않는다. 없음/다른 주체의 구분은 부르는 쪽(하트비트)이 이미 한다.
   *
   * 비교는 **같은 `subject`·같은 `replica_id`의 다른 레코드로만** 좁힌다 (`§4.10` MUST) — 다른
   * 주체의 작업공간과 겹쳤다는 사실을 노출하면 그 자체가 열거 경로다. 판정 자체는
   * {@link findForkOverlap}이다.
   */
  findForkAdvisory(subject: string, workspaceId: string, options: FindForkAdvisoryOptions): Promise<ForkOverlap | undefined>

  /** 연결을 닫는다. 두 번 불러도 안전하다. 작업공간을 닫는 것은 {@link
   * WorkspaceStore.closeWorkspace}다 (파일 상단 doc). */
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
 * 같은 기록을 다른 시각에 조회해도 같은 값이 나온다. 늦은 하트비트가 유기를 **기록으로
 * 확정할** 때 저장하는 값도 같은 값이다 ({@link SqliteWorkspaceStore.heartbeat}).
 *
 * 돌려주는 두 갈래는 판별 유니온이다 — `abandoned`면 `endedAt`이 반드시 있다는 것을 확정
 * 경로가 타입으로 알아야 한다 (그 자리가 `endedAt`을 저장하므로).
 */
export function resolveActiveState(
  lastHeartbeatAt: string,
  options: { readonly gracePeriodMs: number; readonly now: Date },
): { readonly state: 'active'; readonly endedAt?: undefined } | { readonly state: 'abandoned'; readonly endedAt: string } {
  const deadline = new Date(lastHeartbeatAt).getTime() + options.gracePeriodMs
  if (options.now.getTime() >= deadline) {
    return { state: 'abandoned', endedAt: new Date(deadline).toISOString() }
  }
  return { state: 'active' }
}

/**
 * 한 레코드의 활성 구간이 끝나는 시각 — {@link findForkOverlap}의 겹침 판정이 쓰는 유일한
 * 계산 자리 (`§4.10`).
 *
 * - 종단 상태(`closed_flushed`·`closed_discarded`·`revoked`)는 저장된 `endedAt`을 그대로 쓴다.
 * - `abandoned`(파생 포함)는 {@link resolveActiveState}가 내는 값을 쓴다 — 같은 계산식을
 *   여기 다시 적지 않는다(이 함수가 부르는 두 자리가 갈라지면 유기 경계가 판정마다 달라진다).
 * - `active`는 판정 시점(`options.now`)까지로 본다 — `§4.1`이 유기 판정에서 쓴 것과 같은 모양이다.
 */
function forkOverlapEndMs(
  record: WorkspaceRecord,
  options: { readonly gracePeriodMs: number; readonly now: Date },
): number {
  if (record.state === 'active') {
    return options.now.getTime()
  }
  if (record.state === 'abandoned') {
    const derived = resolveActiveState(record.lastHeartbeatAt, options)
    if (derived.state !== 'abandoned') {
      // `record.state`가 'abandoned'인데 같은 (gracePeriodMs, now)로 다시 재보면 아니라는
      // 뜻이다 — 호출자가 self·others를 서로 다른 grace period·now로 조회해 넘긴 것이다.
      throw new WorkspaceStoreError('unexpected_row_shape')
    }
    return new Date(derived.endedAt).getTime()
  }
  if (record.endedAt === undefined) {
    throw new WorkspaceStoreError('unexpected_row_shape')
  }
  return new Date(record.endedAt).getTime()
}

/**
 * 포크 판정 (`§4.10`) — 순수 함수. `self`와 같은 `replicaId`를 신고한 `others` 중, 활성
 * 구간이 `self`와 겹치는 것을 찾는다.
 *
 * 활성 구간은 반열린 구간 `[openedAt, effectiveEnd)`다 — 겹침도 반열린 교차
 * (`aOpenedAt < bEnd && bOpenedAt < aEnd`)라 경계가 맞닿는 것(앞의 `endedAt` == 뒤의
 * `openedAt`)은 겹침이 아니다.
 *
 * 제외 규칙(`§4.10` MUST NOT 전부):
 * - `self.replicaId`가 없으면 즉시 `undefined` — 미신고를 전량 일치로 떨어뜨리지 않는다.
 * - `others` 중 `replicaId`가 없거나 `self.replicaId`와 다른 레코드는 비교하지 않는다.
 * - `workspaceId`가 `self`와 같은 레코드는 제외한다.
 *
 * 겹치는 상대가 여럿이면 `openedAt` 오름차순, 동률이면 `workspaceId` 사전순으로 첫 번째를
 * 고른다 — `forkAdvisory`가 단수 필드라 선택 규칙이 필요하다(owner가 정한 관례, 스펙 조항은
 * 아니다).
 */
export function findForkOverlap(
  self: WorkspaceRecord,
  others: readonly WorkspaceRecord[],
  options: { readonly gracePeriodMs: number; readonly now: Date },
): ForkOverlap | undefined {
  if (self.replicaId === undefined) {
    return undefined
  }
  const replicaId = self.replicaId

  const candidates = others
    .filter((other) => other.workspaceId !== self.workspaceId && other.replicaId === replicaId)
    .toSorted((a, b) => (a.openedAt !== b.openedAt ? (a.openedAt < b.openedAt ? -1 : 1) : a.workspaceId < b.workspaceId ? -1 : 1))

  const selfStart = new Date(self.openedAt).getTime()
  const selfEnd = forkOverlapEndMs(self, options)

  for (const other of candidates) {
    const otherStart = new Date(other.openedAt).getTime()
    const otherEnd = forkOverlapEndMs(other, options)
    if (selfStart < otherEnd && otherStart < selfEnd) {
      return { replicaId, overlappingWorkspaceId: other.workspaceId }
    }
  }
  return undefined
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
  // 않는다(`§4.1` MUST NOT: abandoned에서도 종단 상태에서도 부활이 없다). 이 분기를 채우는
  // 쓰기 경로는 `heartbeat`의 유기 확정 · `closeWorkspace` · `revokeWorkspace`다(`§4.3`~`§4.5`).
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

/** `limit` 부재/유효성 판정. 근거는 `src/control/store.ts`의 `resolveLimit`과 같다(음수
 * `LIMIT`은 SQLite에서 "무제한"으로 읽힌다). */
function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_PAGE_LIMIT
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ACCEPTED_LIMIT) {
    throw new WorkspaceStoreError('invalid_page_limit')
  }
  return limit
}

/** `listWorkspaces`의 `state` 필터 판정 (`§4.6` MUST NOT: 빈 문자열·알 수 없는 값·타입
 * 불일치를 "필터 없음"으로 떨어뜨리지 않는다). 부재만 "필터 없음"이다. */
function resolveStateFilter(state: string | undefined): WorkspaceState | undefined {
  if (state === undefined) {
    return undefined
  }
  if (!WORKSPACE_STATE_NAMES.includes(state)) {
    throw new WorkspaceStoreError('invalid_state_filter')
  }
  return state as WorkspaceState
}

/**
 * `listWorkspaces`가 발급·해석하는 불투명 커서 — 정렬 키(`openedAt`, `workspaceId`) 두 값을
 * JSON 배열로 담아 base64url로 감싼다. 불투명하기만 하면 되므로(`§4.6`) 인코딩은 이 파일의
 * 판단이다 — JSON을 고른 이유는 이 스토어가 이미 `logs` 컬럼에 같은 방식(JSON 문자열)을 쓰고
 * 있어 새 직렬화 관례를 늘리지 않기 때문이다.
 */
function encodeCursor(openedAt: string, workspaceId: string): string {
  return Buffer.from(JSON.stringify([openedAt, workspaceId]), 'utf8').toString('base64url')
}

/** {@link encodeCursor}의 역. 모양이 어긋나면 `invalid_cursor`다 — 해석 불가 커서를 처음부터
 * 주는 것은 `§4.6` MUST가 막는다. */
function decodeCursor(raw: string): { readonly openedAt: string; readonly workspaceId: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new WorkspaceStoreError('invalid_cursor')
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    Number.isNaN(new Date(parsed[0]).getTime()) ||
    !WORKSPACE_ID_PATTERN.test(parsed[1])
  ) {
    throw new WorkspaceStoreError('invalid_cursor')
  }
  return { openedAt: parsed[0], workspaceId: parsed[1] }
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
  readonly #selectSupersededByBatch: StatementSync
  readonly #moveHeartbeat: StatementSync
  readonly #writeTerminal: StatementSync
  readonly #selectPage: StatementSync
  readonly #selectByReplicaId: StatementSync
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
    // `listWorkspaces`가 페이지 전체의 `workspaceId` 목록을
    // 한 번에 넘겨 쓴다. `IN (...)`을 페이지 크기별로 동적 생성하지 않고 `json_each(?)`를
    // 쓴 이유: 이 생성자가 문장을 준비해 재사용하는 관례상 자리표 개수가 호출마다 달라지는
    // 문장을 만들 수 없고, 이 파일이 이미 `logs` 컬럼에 JSON 직렬화를 쓰고 있어(`#insert`)
    // 새 인코딩 관례를 늘리지 않는다. `MIN(workspace_id)`가 `#selectSupersededBy`의
    // `ORDER BY workspace_id ASC LIMIT 1`과 같은 규칙의 집합 표현이다 — 둘 다 컬럼에 별도
    // COLLATE가 없어 기본 BINARY 비교를 쓰므로 동치.
    this.#selectSupersededByBatch = db.prepare(
      `SELECT supersedes, MIN(workspace_id) AS superseded_by
       FROM workspaces
       WHERE supersedes IN (SELECT value FROM json_each(?))
       GROUP BY supersedes`,
    )
    // 두 `UPDATE`의 `WHERE`에 실린 `terminal_state IS NULL`·`last_heartbeat_at = ?`가 파일
    // 상단 doc "원자성"의 2차 보장이다 — 판정에 쓴 값을 쓰기 조건으로 다시 싣는다.
    this.#moveHeartbeat = db.prepare(
      `UPDATE workspaces SET last_heartbeat_at = ?
       WHERE workspace_id = ? AND terminal_state IS NULL AND last_heartbeat_at = ?`,
    )
    this.#writeTerminal = db.prepare(
      `UPDATE workspaces SET terminal_state = ?, ended_at = ?
       WHERE workspace_id = ? AND terminal_state IS NULL AND last_heartbeat_at = ?`,
    )
    // `scored`가 파생 상태를 한 번만 계산한다(파일 상단 doc "목록 조회의 state 필터는
    // WHERE에서 계산된다") — `derived_state = ?`가 `§4.6`의 판정 → 정렬 → limit 중 판정
    // 자리다. 커서 부재는 호출부가 `('', '')`를 넘겨 표현한다 — `opened_at`은 항상 비어
    // 있지 않은 ISO 문자열이라 `(opened_at, workspace_id) > ('', '')`가 항상 참이다. `state`
    // 필터 부재도 호출부가 두 자리 모두 `null`을 넘겨 `? IS NULL`이 참이 되게 한다.
    this.#selectPage = db.prepare(
      `WITH scored AS (
         SELECT workspace_id, opened_at, last_heartbeat_at, logs, supersedes, replica_id, terminal_state, ended_at,
           CASE
             WHEN terminal_state IS NOT NULL THEN terminal_state
             WHEN last_heartbeat_at <= ? THEN 'abandoned'
             ELSE 'active'
           END AS derived_state
         FROM workspaces
         WHERE subject = ?
       )
       SELECT workspace_id, opened_at, last_heartbeat_at, logs, supersedes, replica_id, terminal_state, ended_at
       FROM scored
       WHERE (opened_at, workspace_id) > (?, ?) AND (? IS NULL OR derived_state = ?)
       ORDER BY opened_at ASC, workspace_id ASC
       LIMIT ?`,
    )
    // findForkAdvisory(§4.10)의 비교 대상 조회 — 다른 주체의 작업공간과 겹쳤다는 사실을
    // 노출하면 그 자체가 열거 경로이므로(§4.10 MUST) 같은 subject로 SQL에서 미리 좁힌다.
    // replica_id 일치·자기 자신 제외는 findForkOverlap도 다시 거른다(순수 함수 단독 호출도
    // 같은 제외 규칙을 지켜야 하므로) — 여기서 미리 좁히는 것은 방어의 이중화일 뿐이다.
    this.#selectByReplicaId = db.prepare(
      `SELECT workspace_id, opened_at, last_heartbeat_at, logs, supersedes, replica_id, terminal_state, ended_at
       FROM workspaces WHERE subject = ? AND replica_id = ? AND workspace_id <> ?`,
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

  async heartbeat(
    subject: string,
    workspaceId: string,
    options: WorkspaceTransitionOptions,
  ): Promise<{ readonly state: 'active'; readonly lastHeartbeatAt: string }> {
    const now = options.now ?? new Date()
    const movedTo = now.toISOString()

    // 「이미 유기인가」를 읽고 「abandoned로 만든다」를 쓰는 스팬 전체가 한 락 안이다
    // (파일 상단 doc "원자성"). 확정은 **커밋되어야** 하므로 — 롤백되면 `§4.1`이 요구한
    // 확정이 사라지고 다음 하트비트가 다시 부활을 시도한다 — 실패 통보는 트랜잭션이 닫힌
    // 뒤에 던진다.
    const confirmedAbandonment = this.#inTransaction(() => {
      const current = this.#loadOwned(subject, workspaceId)
      if (current.terminal !== undefined) {
        throw new WorkspaceStoreError('workspace_not_active')
      }

      const derived = resolveActiveState(current.lastHeartbeatAt, {
        gracePeriodMs: options.gracePeriodMs,
        now,
      })
      if (derived.state === 'abandoned') {
        this.#applyTransition(
          this.#writeTerminal.run('abandoned', derived.endedAt, workspaceId, current.lastHeartbeatAt),
        )
        return true
      }

      this.#applyTransition(this.#moveHeartbeat.run(movedTo, workspaceId, current.lastHeartbeatAt))
      return false
    })

    if (confirmedAbandonment) {
      throw new WorkspaceStoreError('workspace_not_active')
    }
    return { state: 'active', lastHeartbeatAt: movedTo }
  }

  async closeWorkspace(
    subject: string,
    workspaceId: string,
    outcome: CloseOutcome,
    options: WorkspaceTransitionOptions,
  ): Promise<WorkspaceTerminalResult> {
    return this.#transitionToTerminal(
      subject,
      workspaceId,
      outcome === 'flushed' ? 'closed_flushed' : 'closed_discarded',
      options,
    )
  }

  async revokeWorkspace(
    subject: string,
    workspaceId: string,
    options: WorkspaceTransitionOptions,
  ): Promise<WorkspaceTerminalResult> {
    return this.#transitionToTerminal(subject, workspaceId, 'revoked', options)
  }

  async listWorkspaces(subject: string, options: ListWorkspacesOptions): Promise<ListWorkspacesPage> {
    const limit = resolveLimit(options.limit)
    const stateFilter = resolveStateFilter(options.state)
    const cursor = options.after === undefined ? undefined : decodeCursor(options.after)
    const now = options.now ?? new Date()

    // `resolveActiveState`와 같은 부등식의 대수적 동치 — 파일 상단 doc "목록 조회의 state
    // 필터는 WHERE에서 계산된다". 질의당 한 번만 계산되는 상수라 `#selectPage`에 그대로 싣는다.
    const abandonThresholdIso = new Date(now.getTime() - options.gracePeriodMs).toISOString()

    const rows = this.#selectPage.all(
      abandonThresholdIso,
      subject,
      cursor?.openedAt ?? '',
      cursor?.workspaceId ?? '',
      stateFilter ?? null,
      stateFilter ?? null,
      limit + 1,
    )
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    // 페이지당 최대 1회의 질의로 `supersededBy`를 해소한다 (mori-nest #109) —
    // `getWorkspace`의 행당 1회 조회(`#selectSupersededBy`)와 달리, 여기는 페이지 전체의
    // workspaceId를 한 번에 묶어 `#selectSupersededByBatch`에 넘긴다. 페이지가 비면 그 질의도
    // 돌지 않는다.
    const supersededByMap = new Map<string, string>()
    if (page.length > 0) {
      const workspaceIds = page.map((row) => columnAsString(row['workspace_id']))
      for (const supersededByRow of this.#selectSupersededByBatch.all(JSON.stringify(workspaceIds))) {
        supersededByMap.set(
          columnAsString(supersededByRow['supersedes']),
          columnAsString(supersededByRow['superseded_by']),
        )
      }
    }

    const workspaces = page.map((row) => {
      const workspaceId = columnAsString(row['workspace_id'])
      const supersededBy = supersededByMap.get(workspaceId)
      return rowToRecord(workspaceId, row, { gracePeriodMs: options.gracePeriodMs, now, supersededBy })
    })

    const last = workspaces.at(-1)
    return {
      workspaces,
      ...(last === undefined ? {} : { cursor: encodeCursor(last.openedAt, last.workspaceId) }),
      hasMore,
    }
  }

  async findForkAdvisory(
    subject: string,
    workspaceId: string,
    options: FindForkAdvisoryOptions,
  ): Promise<ForkOverlap | undefined> {
    const row = this.#selectByWorkspaceId.get(workspaceId)
    if (row === undefined || columnAsString(row['subject']) !== subject) {
      // `getWorkspace`·`#loadOwned`와 같은 이유(열거 오라클 방지) — 여기서
      // `workspace_not_found`를 던지지 않는다(파일 상단 doc, `WorkspaceStore.findForkAdvisory`).
      return undefined
    }
    const self = rowToRecord(workspaceId, row, { ...options, supersededBy: undefined })
    if (self.replicaId === undefined) {
      // SQL을 돌 것도 없다 — findForkOverlap도 같은 이유로 즉시 undefined다.
      return undefined
    }

    const otherRows = this.#selectByReplicaId.all(subject, self.replicaId, workspaceId)
    const others = otherRows.map((otherRow) =>
      rowToRecord(columnAsString(otherRow['workspace_id']), otherRow, { ...options, supersededBy: undefined }),
    )

    return findForkOverlap(self, others, options)
  }

  /**
   * `§4.4`와 `§4.5`의 공통 몸통 — 둘의 차이는 목표 상태 하나뿐이고, 멱등 규칙("이미 그
   * 상태면 같은 결과")과 거부 규칙("다른 종단 상태면 실패")은 글자 그대로 같다.
   *
   * 하트비트와 달리 유기를 확정하지 않는다 (파일 상단 doc) — 이 두 전이는 실패로 끝나든
   * 성공하든 `last_heartbeat_at`을 옮기지 않으므로 파생 판정이 움직이지 않는다.
   */
  #transitionToTerminal(
    subject: string,
    workspaceId: string,
    terminalState: WorkspaceTerminalResult['state'],
    options: WorkspaceTransitionOptions,
  ): WorkspaceTerminalResult {
    const now = options.now ?? new Date()
    const endedAt = now.toISOString()

    return this.#inTransaction(() => {
      const current = this.#loadOwned(subject, workspaceId)

      if (current.terminal !== undefined) {
        if (current.terminal.state === terminalState) {
          // 멱등: 같은 결과를 돌려준다 (`§4.4`·`§4.5` MUST). 두 번째 호출의 `now`로
          // `endedAt`을 다시 쓰지 않는다 — 그러면 "결과가 같다"가 깨진다.
          return { state: terminalState, endedAt: current.terminal.endedAt }
        }
        // 다른 `outcome`으로 이미 닫혔거나, `revoked`·`abandoned`다.
        throw new WorkspaceStoreError('workspace_not_active')
      }

      const derived = resolveActiveState(current.lastHeartbeatAt, { gracePeriodMs: options.gracePeriodMs, now })
      if (derived.state === 'abandoned') {
        // 저장분은 `active`지만 파생 판정이 유기다 — `§4.1`의 종단이므로 여기서도 실패다.
        throw new WorkspaceStoreError('workspace_not_active')
      }

      this.#applyTransition(this.#writeTerminal.run(terminalState, endedAt, workspaceId, current.lastHeartbeatAt))
      return { state: terminalState, endedAt }
    })
  }

  /**
   * 전이가 판정 근거로 읽는 한 행. 없는 작업공간과 다른 주체의 것을 구분하지 않는다 —
   * `getWorkspace`와 같은 이유(열거 오라클 방지)이고, 그 둘을 종단 상태와는 **구분한다**
   * (라우트가 `404`와 `409`로 갈라야 한다).
   *
   * 트랜잭션 안에서만 부른다.
   */
  #loadOwned(
    subject: string,
    workspaceId: string,
  ): {
    readonly lastHeartbeatAt: string
    /** 저장된 종단 상태. 있으면 `endedAt`도 반드시 있다 — 스키마의 `CHECK ((terminal_state
     * IS NULL) = (ended_at IS NULL))`를 타입으로 옮긴 모양이다. */
    readonly terminal?: { readonly state: string; readonly endedAt: string }
  } {
    const row = this.#selectByWorkspaceId.get(workspaceId)
    if (row === undefined || columnAsString(row['subject']) !== subject) {
      throw new WorkspaceStoreError('workspace_not_found')
    }
    const lastHeartbeatAt = columnAsString(row['last_heartbeat_at'])
    const state = columnAsNullableString(row['terminal_state'])
    const endedAt = columnAsNullableString(row['ended_at'])
    if (state === undefined) {
      if (endedAt !== undefined) {
        throw new WorkspaceStoreError('unexpected_row_shape')
      }
      return { lastHeartbeatAt }
    }
    if (endedAt === undefined) {
      throw new WorkspaceStoreError('unexpected_row_shape')
    }
    return { lastHeartbeatAt, terminal: { state, endedAt } }
  }

  /**
   * 조건부 `UPDATE`의 결과를 판정한다 — 파일 상단 doc "원자성"의 2차 보장. `BEGIN
   * IMMEDIATE` 안에서 판정 직후에 쓰므로 0행은 나오지 않지만, 나온다면 그 사이에 다른 전이가
   * 확정된 것이므로 조용히 덮는 대신 진 쪽이 실패한다.
   */
  #applyTransition(result: { readonly changes: number | bigint }): void {
    if (Number(result.changes) !== 1) {
      throw new WorkspaceStoreError('workspace_not_active')
    }
  }

  /** `BEGIN IMMEDIATE` … `COMMIT`으로 감싼다. `body`에 `await`를 넣지 않는다 — 아래 클래스
   * doc의 규율이 이 경계 안에서 깨지면 트랜잭션이 겹친다. */
  #inTransaction<T>(body: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      this.#rollbackQuietly()
      throw error
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
