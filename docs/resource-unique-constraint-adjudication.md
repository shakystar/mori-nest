# 자원 유니크 제약 — 「읽고 판정하고 쓴다」 전수 조사와 판정

## 판정 — 요약

**제어 평면(`src/control/`)의 「읽고 판정하고 쓴다」 스팬은 16개이고, 그 중 `제약으로 옮긴다`는
하나다** — `credential.ts`의 `rotate()`. 나머지는 `현행 유지`(10) 또는 `해당 없음`(5)이며, 근거는
아래 표의 마지막 열과 §2의 해당 절에 있다.

**이 결과가 뜻하는 것은 「할 일이 없다」가 아니라 「이 리포가 이미 대부분 옮겨 뒀다」이다.**
조사 중 반복해 나온 모양이 둘이다:

- **선판정 없이 제약이 판정한다** — `logs.log_id` `PRIMARY KEY`가 mint 충돌을 판정하고
  (`store.ts:53-58`, `:447-460`), `idempotency_keys`의 복합 `PRIMARY KEY`가 예약 경쟁을 판정한다
  (`idempotency.ts:280-289`). 이슈 #144가 출발점 후보 1번으로 지목한 `server.ts`의 mint 재시도
  배선(`:478-495`, `:882-906`)은 **조사 결과 이미 이 모양이었다** — 재시도 루프에 선판정 `SELECT`가
  없다.
- **판정에 쓴 값을 쓰기 문장의 `WHERE`에 다시 싣는다** — `workspace-store.ts:118-122`가 이것을
  「2차 보장」으로 이름 붙여 놓았고(`UPDATE … WHERE terminal_state IS NULL AND last_heartbeat_at = ?`),
  `idempotency.ts:247-253`(`WHERE created_at = ?`)·`:254-259`(`WHERE status IS NULL`)·
  `store.ts:436-438`(`COALESCE` + `RETURNING`)이 같은 규율을 각자의 자리에서 쓴다. **이 형태는
  단일 라이터와 독립으로 성립한다** — 락이 사라져도 진 쪽이 0행을 받아 실패한다.

남은 하나(`rotate()`)가 정확히 그 두 모양 **어느 쪽도 아닌** 자리다: 트랜잭션 안에서 읽고,
읽은 값을 쓰기 조건에 싣지 않고, `BEGIN IMMEDIATE`의 쓰기 락에만 기댄다. 그래서 단일 라이터가
사라지면 여기 하나만 샌다.

### 스팬 전수 — 한 행에 하나

판정 셋의 정의는 §0.3에, 「오늘 무엇이 지키는가」의 네 갈래(제약 / 트랜잭션 경계 / 응용 코드의
순서 규율 / 단일 라이터라는 사실뿐)는 이슈 #144 작업 범위 2의 것을 그대로 쓴다.

| # | `파일:심볼` | 오늘 무엇이 지키는가 | 단일 라이터가 없을 때 열리는 인터리브 | 판정 | 근거 |
|---|---|---|---|---|---|
| S1 | `credential.ts:rotate` (`:242-249`) | **단일 라이터라는 사실뿐** — `SELECT`는 락을 잡지 않고, 뒤따르는 `INSERT`·`DELETE`가 읽은 값을 `WHERE`에 싣지 않는다 | A·B가 같은 `credentialId`를 동시에 회전: 둘 다 `:243`에서 같은 행을 읽고, 둘 다 `:247`에서 서로 다른 새 자격증명을 삽입하고, `:248`의 `DELETE`는 하나만 1행·다른 하나는 **0행(결과를 보지 않는다)**. 커밋 후 **자격증명이 1개에서 2개로 늘어난다** | **제약으로 옮긴다** | mori#189의 모양 그대로다 — 옛 자격증명의 소멸이 회전의 **결과**여야 하는데 오늘은 별개의 무조건 `DELETE`다. §3의 C1 |
| S2 | `store.ts:addMissingRevocationColumn` (`:138-154`) | **트랜잭션 경계** — `PRAGMA table_info` 읽기와 `ALTER TABLE`이 한 `withTransaction`(`:142`) 안이고 `BEGIN IMMEDIATE`가 쓰기 락을 먼저 잡는다 | 두 프로세스가 같은 구 DB를 동시에 부팅: 둘 다 「컬럼 없음」을 관측하고 둘 다 `ALTER TABLE` → 진 쪽이 중복 컬럼 오류로 **부팅 실패** | 현행 유지 | 제약으로 표현할 수 있는 불변식이 아니다(DDL이다). 실패가 부팅 시점의 예외라 **조용히 새지 않고** 데이터도 손상시키지 않는다. 이관 시 `ADD COLUMN IF NOT EXISTS`가 읽기 자체를 없앤다 — §4의 M1 |
| S3 | 네 스토어의 `exec(SCHEMA)` (`store.ts:531`·`workspace-store.ts:1106`·`idempotency.ts:350`·`credential.ts:269`) | **엔진** — `CREATE TABLE IF NOT EXISTS`의 존재 판정이 SQLite 안에서 원자적이다 | 동시 부팅 시 PostgreSQL의 `CREATE TABLE IF NOT EXISTS`가 카탈로그 유니크 위반을 낼 수 있다 → 진 쪽 **부팅 실패** | 현행 유지 | S2와 같은 이유·같은 성격(부팅 경로, 시끄러운 실패). 스키마 관리 방식 자체가 이관의 항목이지 이 조각이 걸 제약이 아니다 — §4의 M2 |
| S4 | `workspace-store.ts:insertMintedWorkspace`의 `supersedes` 소유권 검증 (`:814-820` → `:823`) | **트랜잭션 경계 + 읽는 값의 불변성** — 검증과 삽입이 같은 콜백 안이다(`:106-107`, `server.ts:890-897`) | **열리지 않는다.** 판정이 읽는 것은 `workspaces.subject` 하나인데, 이 열을 갱신하는 문장이 없고(전수 A1: `UPDATE workspaces …`는 `last_heartbeat_at`·`terminal_state`·`ended_at`만 건드린다) `workspaces`에 `DELETE` 경로가 0건이다 → 읽은 사실이 커밋 시점까지 유효하다 | 현행 유지 | 근거가 **전수 조사의 부산물**이다(§1.2의 A1 목록). `workspaces`에 삭제·주체 변경 경로가 생기는 날 이 근거는 무효가 된다 — §5의 R1 |
| S5 | `workspace-store.ts:heartbeat` (`:867-904`) | **제약이 아닌 조건부 쓰기(CAS)** — `#loadOwned`가 읽은 `last_heartbeat_at`과 `terminal_state IS NULL`을 `UPDATE`의 `WHERE`에 다시 싣고(`:766-773`), 0행이면 실패한다(`#applyTransition`, `:1084-1088`) | **열리지 않는다.** A·B가 같은 `last_heartbeat_at = T`를 읽어도 `WHERE … last_heartbeat_at = T`를 통과하는 것은 하나뿐이고, 진 쪽은 0행 → `workspace_not_active`. `last_heartbeat_at`이 T로 되돌아가는 경로가 없어 ABA도 없다 | 현행 유지 | 이 파일이 이미 「2차 보장」으로 진술한 규율이다(`:118-122`: *"나중에 누가 트랜잭션 경계를 옮기거나 `await`를 들이더라도 그 변경이 남의 전이를 덮어쓰는 대신 실패로 드러난다"*). 다음 조각의 본보기 |
| S6 | `workspace-store.ts:#transitionToTerminal` (`:1011-1042`, `closeWorkspace`·`revokeWorkspace`의 공통 몸통) | S5와 같은 CAS (`:1039`) | **열리지 않는다** — S5와 같은 이유. `§4.1` MUST(*"닫힌 뒤 하트비트가 `active`로 되돌리는 것이 아니다"*)가 요구하는 성질이 락이 아니라 `WHERE`에 있다 | 현행 유지 | S5와 같음 |
| S7 | `workspace-store.ts:#selectSupersededBy`/`#selectSupersededByBatch`의 `supersedes` 유일성 (`:748-750`, `:758-763`) | **아무것도 지키지 않는다** — 같은 작업공간을 잇는 행이 여럿일 수 있고, 파생 조회는 `MIN(workspace_id)` 하나만 노출한다 | 둘 이상이 같은 `supersedes`를 실어 동시에 개시하면 둘 다 성공한다. **단, 이것은 오늘 SQLite에서도 그대로 성립한다** — 단일 라이터가 막고 있는 것이 아니다 | 현행 유지 | 스펙이 유일성을 요구하지 않는다 — `0003 §4.8`(`:1236`)이 `supersedes`를 *"선언이지 증명이 아니다"*로 못박고 `§4.2`(`:949`)는 *"서버는 검증하지 않는다"*로 적는다(소유권만 예외, S4). `§4.7`이 세운 것은 *"아무도 이어받지 않은 유기"*와의 구분(`:1226`)이지 이어받는 쪽의 유일성이 아니다. 여기 `UNIQUE`를 거는 것은 이식성 조치가 아니라 **스펙 변경**이다 — §5의 R2 |
| S8 | `store.ts:revoke` (`:501-510`) | **응용 코드의 순서 규율 + 읽는 값의 단조성** — `#selectMembership`(`:502`)로 판정하고 `#revokeLog`(`:508`)로 쓴다. 둘 다 트랜잭션 **밖**이다 | **판정을 뒤집는 인터리브는 열리지 않는다.** 판정 근거인 `log_subjects` 행은 늘기만 한다 — 전수 A1에 `DELETE FROM log_subjects`가 **없다**. 「있다」를 읽은 뒤 그것이 사라질 수 없으므로 통과한 판정은 커밋까지 유효하고, 반대 방향(`grant`가 끼어들어 「없다」가 「있다」로)은 클라이언트가 재시도하면 그만인 양성 오류다 | 현행 유지 | 쓰기 자체의 멱등은 이미 제약이 아니라 **문장**이 진다 — `UPDATE … SET revoked_at = COALESCE(revoked_at, ?) … RETURNING`(`:436-438`)이 "첫 값이 이긴다"를 한 문장의 원자성으로 보장한다(그 자리의 주석이 이미 그렇게 적는다) — §5의 R1 |
| S9 | `idempotency.ts:reserve`의 만료 재예약 (`:291-301`) | **조건부 쓰기(CAS)** — 읽은 `created_at`을 `#claimExpired`의 `WHERE created_at = ?`에 다시 싣는다(`:247-253`) | **열리지 않는다.** 그 자리의 주석이 이미 이 인터리브를 적어 뒀다: *"두 프로세스가 동시에 「만료됐다」고 판단해도 `WHERE created_at = ?`를 통과하는 것은 하나뿐"* — 진 쪽은 `changes === 0`을 보고 다시 읽어 일반 경로로 판정한다(`:300`) | 현행 유지 | 이슈 #144가 지목한 *「보관 창 경과 후 `claimExpired`가 새 예약을 잡아 두 번째 자원이 생기던」* 시나리오는 **동시성이 아니라 보관 창의 의미**다 — `§1.4`가 *「최소 24시간」*으로 허락한 동작이고, 창 안의 동시 재예약은 이 CAS가 이미 하나로 좁힌다 |
| S10 | `server.ts:handleOpenWorkspace`의 `isGranted` 게이트 → `insertMintedWorkspace` (`:865` → `:891`) | **아무것도 지키지 않는다** — 읽기는 트랜잭션 밖(`Promise.all`), 쓰기는 트랜잭션 안이다 | A가 `isGranted = true`를 본 뒤 다른 요청의 `revokeLog`가 커밋되고, 그 다음 A의 삽입이 커밋 → **폐기된 로그를 스코프로 가진 작업공간**이 생긴다. **이 창은 오늘 이미 열려 있다** — 읽기가 어느 트랜잭션에도 속하지 않으므로 단일 라이터가 닫고 있지 않다. 즉 **이관이 넓히지 않는다** | 현행 유지 | 둘째, `§3.4`가 *「매 갱신이 개시 시 스코프를 다시 판정한다」*로 수렴을 설계해 뒀다(`server.ts:958-963`) — 다음 하트비트가 그 로그를 스코프에서 뺀다. 셋째, 제약으로는 표현할 수 없다: `workspaces.logs`가 JSON 열이라 `FK`를 걸려면 관계로 펴야 하고, 펴도 **「폐기되지 않았다」는 시간 의존 술어를 `FK`가 표현하지 못한다**(폐기는 삭제가 아니라 `revoked_at` 갱신이다) — §5의 R3 |
| S11 | `server.ts:handleHeartbeatWorkspace`의 `getWorkspace` 상태 판정 → `heartbeat` 전이 (`:987` → `:1027`) | **스토어 안의 원자적 재판정** — 라우트의 읽기는 게이트가 아니라 재판정 대상(`logs`)을 얻기 위한 읽기다 | 열려도 **안전하다.** 그 사이 종단으로 갔으면 `heartbeat`의 CAS(S5)가 `workspace_not_active`를 던지고 라우트가 그것을 `409`로 옮긴다(`:1033-1038`) | 현행 유지 | 이 파일이 이미 진술했다(`:971-974`: *"원본은 `heartbeat`다 … 아래 `getWorkspace`의 판정은 재판정 대상을 얻기 위한 읽기이지 게이트가 아니다"*). 권위 판정이 스토어 안에 있는 것이 정확히 이 조각이 요구하는 모양이다 |
| S12 | `server.ts`의 mint 재시도 배선 (`handleCreateLog:478-495`·`handleOpenWorkspace:882-906`) | **제약** — `logs.log_id`/`workspaces.workspace_id`의 `PRIMARY KEY`가 판정하고, 코드는 그 위반을 **받아서** 재mint한다 | **읽고 판정하는 자리가 없다** — 재시도 루프에 선판정 `SELECT`가 없고, 충돌한 시도는 아무것도 커밋하지 않는다(`:488-490`, `:898-903`) | 해당 없음 | 이슈 #144의 출발점 후보 1번이지만 **이미 제약으로 옮겨진 자리**다. `store.ts:53-58`이 그 규율을 명시한다: *"읽고-판정하고-쓰는 창이 존재하지 않는다"* |
| S13 | `store.ts:insertMintedLog` (`:447-460`) · `store.ts:grant` (`:462-478`) | **제약** — `logs`의 PK, `log_subjects`의 복합 PK·`CHECK`·`FK`(`:104-117`) | 선행 읽기 없음 | 해당 없음 | `grant`의 멱등도 선판정이 아니라 PK 위반 수신으로 표현된다(`:466-469`) |
| S14 | `idempotency.ts:reserve`의 최초 삽입 (`:280-289`) · `completeSync` (`:325-330`) | **제약 + 조건부 쓰기** — `PRIMARY KEY (subject, key)`가 예약 경쟁을 판정하고(`:171-181`), 완료는 `WHERE status IS NULL`로 첫 결과를 지킨다(`:254-259`) | 선행 읽기 없음 — `:287-288`이 명시한다: *"선판정이 아니다 — `INSERT`가 이미 「있다」를 판정했다"* | 해당 없음 | `completeSync`의 `changes !== 1` 판정(`:327`)이 방어선을 라우트가 아니라 스토어에 둔 자리다(`:254-256`) |
| S15 | `credential.ts:issue` (`:205-217`) · `credential.ts:revoke` (`:227-229`) | **제약** (`credential_hash` PK, `subject <> ''` CHECK) · 무조건 `DELETE`(멱등) | 선행 읽기 없음 | 해당 없음 | `issue`는 PK 충돌을 재시도로 다루지 않는다(`mintLogId`과 다르다) — 128비트 엔트로피 하한(`:60-61`)에서 무시 가능한 확률이고, 이 성질은 엔진과 무관하다 |
| S16 | 읽기 전용 경로 — `store.ts:isGranted`·`listLogsForSubject`, `workspace-store.ts:getWorkspace`·`listWorkspaces`·`findForkAdvisory`, `server.ts:replayOpenWorkspace` | 해당 사항 없음 (쓰기가 없다) | 다중 질의 경로(`getWorkspace`는 행 조회 + `supersededBy` 조회 2회, `listWorkspaces`는 페이지 + 배치 2회)는 스냅샷이 원자적이지 않지만, **쓰지 않으므로 이 조각의 대상이 아니다** | 해당 없음 | 판정 대상은 「읽고 판정하고 **쓴다**」이다. 읽기 일관성은 별개 축이고 이 조각이 열지 않는다 — §5의 R4 |

---

## 0. 기준점

### 0.1 기준 커밋

**`13427f9`** (착수 시점 `main`. UoW 사슬 넷 — #130(PR #135)·#131(PR #137)·#132(PR #138)·
#133(PR #139) — 과 그 후속 #140(PR #143)이 전부 머지된 상태. 열린 PR 0건).

**이 문서의 모든 `파일:줄` 인용은 이 커밋에서 직접 열어 확인한 것이다.** 이슈 본문이 옮겨 적은
줄 번호를 그대로 복사하지 않았다. 이 조각은 `src/`를 한 줄도 고치지 않으므로(§0.4) 줄 밀림 표는
없다.

### 0.2 인용 관례

`CONTRIBUTING.md:7-51`의 「파일:줄 인용 관례」를 따른다 — 리포 루트 상대 경로 + `:줄`, 같은
문서 안에서 반복 인용하는 파일은 파일명이 이미 나온 뒤로 `:줄`만으로 줄인다. 전체 경로는
§부록 표가 해소한다. 스펙 문서는 `0003 §4.1`처럼 번호+절로 가리킨다 — 줄이 밀려도 절로
되찾을 수 있게.

**이것은 스펙이 아니다.** `docs/design/0000`–`0003`이 스펙이고, 이 문서는 *오늘 무엇이 어떤
불변식을 지고 있는가*를 재는 산정이다. 그래서 `docs/design/` 밖에 있고 번호도 붙이지 않는다 —
`pglite-test-backend-adjudication.md`·`replica-identity-and-join-adjudication.md`·
`selective-removal-and-retention-adjudication.md`와 같은 자리, 같은 접미사, 같은 형식이다.
**MUST / MUST NOT을 쓰지 않는다** — 인용 안에 있는 것은 인용된 문서의 계약이다.

근거 이슈: mori-nest [#144](https://github.com/shakystar/mori-nest/issues/144)
(= [#68](https://github.com/shakystar/mori-nest/issues/68) **항목 8**, [2026-08-08 사람
결정](https://github.com/shakystar/mori-nest/issues/68)이 *「UoW가 선 뒤」*를 조건으로 남겨 둔
후속 조각).

### 0.3 판정 셋의 정의

| 판정 | 뜻 |
|---|---|
| `제약으로 옮긴다` | 오늘 **응용 코드의 규율 또는 단일 라이터**가 지고 있는 불변식을, 스토어가 지도록 옮긴다 |
| `현행 유지` | 오늘 그 불변식을 지는 것이 이미 스토어(제약 또는 조건부 쓰기)이거나, 인터리브가 열리지 않거나, 열려도 스펙이 이미 그 결과를 허용·수렴시킨다 |
| `해당 없음` | 「읽고 판정하고 쓴다」 스팬이 아니다 — 선행 읽기가 없거나, 쓰기가 없다 |

**「스토어가 진다」의 형태는 둘이다.** 결정문 §5 이식성 하드 룰 4가 요구하는 것은 «`UNIQUE`라는
문법»이 아니라 *「불변식은 응용 코드의 규율이 아니라 스토어의 제약으로 강제한다」*이므로, 이
판정은 다음 둘을 같은 판정으로 묶는다. 다만 §3의 목록은 항목마다 어느 형태인지 반드시 적는다.

- **(a) 선언적 제약** — `PRIMARY KEY`·`UNIQUE`(부분 유니크 인덱스 포함)·`CHECK`·`FK`.
  예: `logs.log_id` PK가 mint 충돌을 판정한다(S12).
- **(b) 조건부 쓰기** — 판정에 쓴 값을 쓰기 문장의 `WHERE`에 다시 싣고 영향 행 수로 승패를
  가른다(CAS), 또는 `RETURNING`/`COALESCE`로 판정과 쓰기를 한 문장에 묶는다. 이 리포가 이미
  「2차 보장」이라 부르는 것이다(`workspace-store.ts:118-122`). 예: S5·S6·S9.

**(b)를 포함시키는 이유**는 (a)로 표현할 수 없는 불변식이 실재하기 때문이다 — 「이 행이 아직
종단이 아니다」·「이 예약이 아직 완료되지 않았다」는 **행의 현재 상태에 대한 술어**라
`UNIQUE`가 표현하지 못한다. (b)를 제외하면 이 조사의 절반이 「제약으로는 안 되니 현행 유지」로
끝나고, 그러면 하드 룰 4가 실제로 요구하는 성질(락이 사라져도 진 쪽이 **실패로 드러난다**)이
아무 데도 기록되지 않는다.

### 0.4 이 조각의 산출물

**문서 하나뿐이다.** `src/`·`test/`·스키마 변경 0줄 — `git diff --stat`으로 확인할 수 있다.
제약을 실제로 거는 것은 **다음 조각**이고, 그 작업 범위가 §3이다. 조사 중 「이건 한 줄이면
되는데」 싶은 자리(S1의 `DELETE … RETURNING`이 그렇다)에도 손대지 않았다 — 목록의 크기를 모르는
채 일부만 적용하면 다음 조각의 범위가 흐려진다(이슈 #144 비범위).

---

## 1. 전수성의 근거 — 어떻게 찾았는가

이 절이 있는 이유는 다음 세션이 **같은 방법으로 재현하고 확장**할 수 있어야 하기 때문이다.
아래 명령은 전부 기준 커밋 `13427f9`의 리포 루트에서 실행했고, 괄호 안이 실제 결과 건수다.

### 1.1 대상 파일 아홉

```
src/control/credential.ts       (271줄)
src/control/db.ts               (264줄)
src/control/idempotency.ts      (352줄)
src/control/index.ts            (329줄)
src/control/request.ts          (932줄)
src/control/server.ts          (1353줄)
src/control/store.ts            (534줄)
src/control/token.ts            (275줄)
src/control/workspace-store.ts (1108줄)
```

`wc -l src/control/*.ts` — 합계 5418줄. 이슈 #144가 지정한 아홉과 같고, 이 디렉터리에 다른
`.ts` 파일은 없다.

### 1.2 방법 — 쓰기에서 거꾸로 올라간다

「읽고 판정하고 쓴다」 스팬을 **읽기**에서 찾으면 읽기 전용 경로까지 전부 후보가 되어 목록이
발산한다. 그래서 **쓰기를 먼저 전수로 세우고, 각 쓰기마다 「이 쓰기의 가부를 정한 읽기가
있는가」를 거꾸로 물었다.** 쓰기 없는 읽기는 정의상 이 조각의 대상이 아니므로(S16), 이 방향이
전수성을 보장한다.

**A1 — 쓰기 문장(DML + `ALTER`) 전수: 12건**

```
rg -n --no-heading -e "INSERT INTO" -e "UPDATE [a-z_]+ SET" -e "DELETE FROM" \
   -e "ALTER TABLE logs ADD" src/control/*.ts | grep -v "^\S*:[0-9]*: \*"
```

| 문장 | 자리 | 선행 판정 읽기 | 스팬 |
|---|---|---|---|
| `INSERT INTO workspaces` | `workspace-store.ts:741` | `:815` (`supersedes` 소유권) | S4 |
| `UPDATE workspaces SET last_heartbeat_at` | `:767` | `:880` `#loadOwned` | S5 |
| `UPDATE workspaces SET terminal_state, ended_at` | `:771` | `:880`·`:1021` `#loadOwned` | S5·S6 |
| `ALTER TABLE logs ADD COLUMN` | `store.ts:151` | `:145` `PRAGMA table_info` | S2 |
| `INSERT INTO logs` | `:416` | 없음 | S12·S13 |
| `INSERT INTO log_subjects` | `:417` | 없음 | S13 |
| `UPDATE logs SET revoked_at` | `:437` | `:502` `#selectMembership` | S8 |
| `INSERT INTO idempotency_keys` | `idempotency.ts:242` | 없음 | S14 |
| `UPDATE idempotency_keys …(claim)` | `:251` | `:291` `#selectRow` | S9 |
| `UPDATE idempotency_keys …(complete)` | `:258` | 없음 | S14 |
| `INSERT INTO launcher_credentials` | `credential.ts:200` | `issue`: 없음 / `rotate`: `:243` | S15 / S1 |
| `DELETE FROM launcher_credentials` | `:202` | `revoke`: 없음 / `rotate`: `:243` | S15 / S1 |

**전수 A1이 직접 낳은 판정 근거 둘** — 「없다」가 근거가 되는 자리다:

- `DELETE FROM log_subjects`가 **없다** → S8의 판정 근거(관계 행의 단조성).
- `UPDATE workspaces`가 `subject`를 **건드리지 않는다**, `DELETE FROM workspaces`가 **없다**
  → S4의 판정 근거(읽는 값의 불변성).

**A2 — DDL 실행 전수: 5건**

```
rg -n --no-heading "\.exec\(SCHEMA\)|\.exec\(\`ALTER" src/control/*.ts
```

`store.ts:531`·`:151`, `workspace-store.ts:1106`, `idempotency.ts:350`, `credential.ts:269`
→ S2·S3.

**B — 읽기 전수: 21건**

```
rg -n --no-heading "\.get\(|\.all\(" src/control/*.ts
```

A1·A2의 각 쓰기에 대해 이 21건 중 「그 쓰기의 가부를 정한 것」을 짝지었다. 짝이 없는 읽기는
전부 읽기 전용 경로(S16)다.

**C — 트랜잭션 경계 전수: 6건**

```
rg -n --no-heading "withTransaction\(" src/control/*.ts | grep -v "^\S*:[0-9]*: \*"
```

`workspace-store.ts:879`·`:1020`, `store.ts:142`, `credential.ts:242`,
`server.ts:483`·`:890`. **`db.ts` 밖에서 `BEGIN`/`COMMIT`을 직접 실행하는 자리는 없다** —
`db.ts:126-129`가 그것을 금지하고, #140(PR #143)이 스토어의 자체 트랜잭션 경로를 마지막으로
걷어냈다. 그래서 이 6건이 제어 평면 쓰기 경계의 전부이고, 「어느 스팬이 락 안에 있는가」를
이 목록만으로 판정할 수 있다.

**D — 제약 위반 수신 / 영향 행 수 판정 전수: 12건**

```
rg -n --no-heading "isPrimaryKeyViolation\(error\)|isCheckViolation\(error\)|isForeignKeyViolation\(error\)|\.changes" src/control/*.ts
```

이것이 §0.3의 (a)·(b)가 실제로 걸려 있는 자리의 목록이다 — 「오늘 무엇이 지키는가」 열에서
`제약`·`조건부 쓰기`라고 답한 행은 전부 여기 근거가 있다.

### 1.3 이 방법이 놓칠 수 있는 것

정직하게 적는다 — 다음 세션이 같은 착각을 하지 않도록.

- **동적으로 조립되는 SQL**은 A1이 놓친다. 오늘 제어 평면에는 없다(모든 문장이 생성자에서
  준비되는 리터럴이고, 유일한 문자열 보간은 `store.ts:151`의 상수 컬럼 선언이다). 문장을
  런타임에 조립하는 코드가 생기면 A1을 다시 설계해야 한다.
- **`src/transport/`는 보지 않았다** — 이슈 #144 비범위(전송 평면은 UoW가 아직 같은 형태로 서지
  않았다). 결정문이 이관을 두 평면 함께 다루기로 했으므로 **같은 조사가 전송 평면에도 필요하다**.
- **읽기 일관성**(다중 질의 스냅샷)은 이 조사의 축이 아니다 — S16, §5의 R4.

---

## 2. 스팬별 판정 — 상세

요약 표의 각 행을 여기서 되풀이하지 않는다. **표만으로 근거가 부족한 셋**만 편다.

### 2.1 S1 — `credential.ts:rotate` (유일한 `제약으로 옮긴다`)

```ts
// credential.ts:242-249
await this.#database.withTransaction(() => {
  const row = this.#selectSubject.get(credentialId)
  if (row === undefined) {
    throw new LauncherCredentialError('credential_not_found')
  }
  this.#insert.run(newCredentialId, columnAsSubject(row['subject']))
  this.#delete.run(credentialId)
})
```

**오늘 무엇이 지키는가.** 트랜잭션 경계는 있지만, 이 경계가 지키는 것은 *원자성*(둘 다 되거나
둘 다 안 되거나)이지 *배타성*이 아니다. 배타성을 지는 것은 `BEGIN IMMEDIATE`가 잡는 **쓰기
락**뿐이고, 그 락은 SQLite가 DB당 라이터를 하나로 강제하기 때문에 존재한다. 파일 상단 doc이
이 메서드의 트랜잭션을 *"커밋이 돌아온 시점에 새 자격증명이 있고 옛 것은 없다"*로 진술하는데
(`:238-241`), **그 진술의 전제가 바로 단일 라이터다.**

**인터리브.** PostgreSQL의 기본 격리 수준(READ COMMITTED)에서 `SELECT`는 행 락을 잡지 않는다.

| 시각 | 트랜잭션 A | 트랜잭션 B |
|---|---|---|
| t1 | `SELECT subject WHERE hash = X` → `s` | |
| t2 | | `SELECT subject WHERE hash = X` → `s` |
| t3 | `INSERT (X_a, s)` | |
| t4 | | `INSERT (X_b, s)` |
| t5 | `DELETE WHERE hash = X` → 1행 | |
| t6 | | `DELETE WHERE hash = X` → **0행 (결과를 보지 않는다)** |
| t7 | `COMMIT` — `X_a` 유효 | `COMMIT` — `X_b`도 유효 |

**하나를 회전했는데 자격증명이 둘이 된다.** `:227-229`의 `revoke`가 결과를 보지 않는 것은 그
메서드의 계약이 멱등이라 옳지만(`:145`), `rotate` 안에서 같은 문장을 쓰면 그 관대함이 「내가
지웠다」와 「남이 이미 지웠다」를 구분하지 못하게 만든다. mori#189의 문장 그대로다 — *「응용
코드의 «읽고 판정하고 쓴다»는 조여도 계속 샌다」*.

**왜 다른 스팬처럼 이미 닫혀 있지 않은가.** `workspace-store.ts`는 판정값(`last_heartbeat_at`)을
`WHERE`에 다시 실었고(S5), `idempotency.ts`는 `created_at`을 다시 실었다(S9). `rotate`만
읽은 값을 **쓰기 조건으로 되싣지 않는다** — 읽은 `subject`는 새 행의 *값*으로만 쓰이고,
`DELETE`의 조건은 읽기와 무관한 `credentialId`다.

**같은 파일의 `issue`·`revoke`를 조합하는 우회는 이 결함을 고치지 않는다.** `:152-155`가
안내하는 「바깥 트랜잭션에서 `issue`+`revoke`를 직접 조합」 경로도 같은 무조건 `DELETE`를 쓰므로
같은 인터리브를 그대로 받는다. 고칠 자리는 조합 방식이 아니라 **삭제 문장**이다.

### 2.2 S10 — 「오늘 이미 열려 있다」와 「이관이 연다」는 다르다

S10은 이 조사에서 **판정이 가장 미끄러운 자리**여서 따로 적는다. `isGranted` → `insertMintedWorkspace`
사이에 폐기가 끼면 폐기된 로그를 스코프로 가진 작업공간이 생기는데, 이것은 **결함이지만 이
조각의 결함이 아니다.** 근거 셋:

1. **단일 라이터가 이 창을 닫고 있지 않다.** 읽기가 어느 트랜잭션에도 속하지 않으므로
   (`server.ts:806-814`가 그 선택과 이유를 적는다 — `isGranted`는 비동기라 동기 콜백 전제를
   깨지 않고는 트랜잭션에 넣을 수 없다), 락이 사라져도 이 창의 크기는 그대로다. **이관 재감사의
   대상이 아니다** — 이관 전후로 같다.
2. **스펙이 수렴을 설계했다.** `§3.4`의 매 갱신 재판정이 다음 하트비트에서 그 로그를 스코프에서
   뺀다(`server.ts:946-963`).
3. **제약으로 표현할 수 없다.** `workspaces.logs`가 JSON 열이라 `FK`를 걸려면 관계 테이블로
   펴야 하는데, 펴도 필요한 술어는 「그 로그가 존재한다」가 아니라 「그 로그가 **아직 폐기되지
   않았다**」이다. 폐기는 삭제가 아니라 `logs.revoked_at` 갱신(`store.ts:437`)이므로 `FK`가
   그것을 보지 못한다.

그래서 `현행 유지`다. 다만 **이 창을 좁히고 싶어지는 날**을 위해 재검토 트리거로 남긴다(§5의 R3).

### 2.3 S2·S3 — `현행 유지`가 「이관 시에도 손대지 않는다」는 뜻은 아니다

스키마 부트스트랩 둘(`exec(SCHEMA)`·`addMissingRevocationColumn`)은 인터리브가 **실제로 열린다.**
그런데도 `현행 유지`인 것은 판정 축이 「제약으로 옮길 수 있는가」이고 DDL은 제약으로 표현할
대상이 아니기 때문이다. 이 둘이 목록에서 사라지지 않도록 §4에 따로 모았다 — **§3(제약)과 §4(그
밖의 이관 작업)는 다른 목록이고, 다음 조각의 작업 범위는 §3이다.**

---

## 3. `제약으로 옮긴다` 목록 — 착수 순서

**한 건이다.** 착수 순서를 정할 것이 없다는 뜻이지만, 형식은 그대로 지킨다.

### C1 — `credential.ts:rotate`의 회전을 원자적 청구로 만든다 (S1)

| 항목 | 내용 |
|---|---|
| **제약의 형태 (권고)** | **(b) 조건부 쓰기.** `DELETE FROM launcher_credentials WHERE credential_hash = ? RETURNING subject` 하나로 선판정 `SELECT`를 대체한다 — **삭제가 곧 판정이다.** 0행이면 `credential_not_found`(오늘 `:244-246`이 던지는 것과 같은 사유), 1행이면 그 `subject`로 새 자격증명을 삽입한다. 지는 쪽은 0행을 받아 실패하므로 자격증명이 늘어날 수 없다 |
| **기존 DB 보정** | **불필요.** 스키마가 바뀌지 않는다 (`launcher_credentials`의 열도 제약도 그대로) |
| **대체하는 응용 코드** | `credential.ts:243-246`의 선판정 `SELECT`와 `:248`의 결과를 보지 않는 `DELETE`. `#selectSubject`(`:201`)는 `verify`(`:220`)가 계속 쓰므로 남는다. `#delete`(`:202`)는 `revoke`(`:228`)가 계속 쓰므로 남고, `rotate` 전용 문장이 하나 는다 |
| **제약의 형태 (대안)** | **(a) 선언적 제약.** `launcher_credentials`에 `rotated_from TEXT`를 더하고 `CREATE UNIQUE INDEX IF NOT EXISTS launcher_credentials_rotated_from ON launcher_credentials (rotated_from) WHERE rotated_from IS NOT NULL` — 「한 자격증명에서 나온 회전 결과는 최대 하나」를 선언으로 못박는다 |
| **대안의 기존 DB 보정** | **필요.** `ALTER TABLE launcher_credentials ADD COLUMN rotated_from TEXT` — `NULL` 허용이라 `STRICT` 테이블에도 붙는다. **`store.ts:138-154`의 `addMissingRevocationColumn` 선례를 그대로 따를 수 있다**(같은 이유로 `NOT NULL`을 걸지 않는 것까지 같다, `:98-102`) |
| **권고** | **(b)를 먼저 한다.** 스키마 변경 0·DB 보정 0으로 같은 결함을 닫고, 이 리포가 이미 세 자리에서 쓰는 규율(S5·S9·S8)과 같은 모양이라 새 관례를 늘리지 않는다. (a)는 (b)로 닫히지 않는 요구 — 회전 계보의 **감사** — 가 생길 때 얹는다. 다만 (a)는 자격증명 해시의 계보를 영구 보관하게 되므로, 착수 전에 `0003 §1.3`·`§3.8`의 「자격증명 관련 값을 남기지 않는다」 규율과의 정합을 먼저 판정해야 한다 (`rotated_from`은 원문이 아니라 해시이지만 **관계**가 새로 남는다) |

**시험이 재야 할 것** (다음 조각의 몫): 같은 `credentialId`에 대한 두 `rotate`가 겹칠 때
성공하는 것이 하나뿐이고, 진 쪽이 `credential_not_found`를 받으며, 커밋 후 `launcher_credentials`에
그 주체의 새 자격증명이 **하나만** 있다는 것. 오늘의 시험은 단일 라이터 위에서 도므로 이 성질을
재지 못한다.

---

## 4. 제약이 아닌 이관 작업 — 목록 밖이지만 잃으면 안 되는 것

§3이 아니다. 다음 조각의 작업 범위도 아니다. **PostgreSQL 이관 자체의 항목**이고, 여기 적는
이유는 §2.3의 판정이 이 둘을 조용히 삼키지 않게 하기 위해서다.

| # | 자리 | 이관 시 필요한 것 |
|---|---|---|
| M1 | `store.ts:138-154` `addMissingRevocationColumn` (S2) | `ALTER TABLE … ADD COLUMN IF NOT EXISTS`로 바꾼다 — 읽고 판정하는 자리 자체가 사라진다. PostgreSQL 9.6+가 지원한다 |
| M2 | 네 스토어의 `exec(SCHEMA)` (S3) | `CREATE TABLE IF NOT EXISTS`의 동시 실행이 카탈로그 유니크 위반을 낼 수 있다. 스키마 부트스트랩을 요청 경로 밖의 **한 번 도는 마이그레이션 단계**로 분리하거나, 부팅 실패를 재시도로 흡수한다. 어느 쪽이든 스키마 관리 방식의 결정이지 제약이 아니다 |

---

## 5. 재검토 트리거

이 판정들은 **오늘의 코드 모양에 매여 있다.** 아래가 생기면 해당 행의 근거가 무효가 되므로
그 스팬만 다시 판정한다 — 전수 조사를 처음부터 다시 돌 필요는 없다(§1.2의 방법이 그대로
재현된다).

| # | 조건 | 무효가 되는 판정 |
|---|---|---|
| R1 | `log_subjects`에 삭제 경로가 생긴다 (`0003 §8-3`이 연 다대다 관계에서 「주체 하나만 손을 뗀다」를 구현하는 날 — `store.ts:86-96`이 그 미구현을 명시한다) | **S8**. 판정 근거인 「관계 행은 늘기만 한다」가 깨지고, 「있다」를 읽은 뒤 사라질 수 있게 된다 |
| R2 | `supersedes`의 유일성이 스펙 요구가 된다 | **S7**. 그때는 부분 유니크 인덱스(`WHERE supersedes IS NOT NULL`)가 형태이고, 기존 DB에 중복 행이 있으면 보정이 필요하다 |
| R3 | `workspaces.logs`가 JSON 열에서 관계 테이블로 펴진다 | **S10**. 관계로 펴는 순간 `FK`가 「그 로그가 존재한다」까지는 지게 되므로, 남는 술어(「폐기되지 않았다」)만 다시 판정하면 된다 |
| R4 | 읽기 일관성(다중 질의 스냅샷)이 축으로 열린다 | **S16**. `getWorkspace`(행 + `supersededBy`)·`listWorkspaces`(페이지 + 배치)의 2질의 경로가 대상이 된다. 이 조각은 「쓰지 않으므로 대상이 아니다」로만 판정했다 |
| R5 | `workspaces`에 삭제 경로나 `subject` 갱신 경로가 생긴다 | **S4**. 판정 근거인 「읽는 값이 불변」이 깨진다 |
| R6 | 트랜잭션 콜백에 `await`가 들어간다 (`db.ts:83-90`이 「코드 결함의 신호」로 못박은 것) | **S5·S6·S9**의 1차 보장. 2차 보장(CAS)은 그대로 성립하므로 결과는 조용한 덮어쓰기가 아니라 **실패**다 — 그것이 (b)를 쓰는 이유다 |

---

## 부록 — 이 산정이 인용한 것

| 축약형 | 전체 경로 |
|---|---|
| `credential.ts` | `src/control/credential.ts` |
| `db.ts` | `src/control/db.ts` |
| `idempotency.ts` | `src/control/idempotency.ts` |
| `server.ts` | `src/control/server.ts` |
| `store.ts` | `src/control/store.ts` |
| `workspace-store.ts` | `src/control/workspace-store.ts` |
| `0003 §…` | `docs/design/0003-control-plane-spec.md` |
| `CONTRIBUTING.md:7-51` | `CONTRIBUTING.md` 「파일:줄 인용 관례」 |
| 결정문 §5 하드 룰 4 | `CLAUDE.md` 「이식성 하드 룰 (제어 평면 스토어)」 4번 + [2026-08-10 사람 결정](https://github.com/shakystar/mori-nest/issues/68#issuecomment-5236925659) |
| mori#189 | 결정문이 인용한 전신 리포의 교훈 — *「응용 코드의 «읽고 판정하고 쓴다»는 조여도 계속 새고, 스토어가 유니크를 강제하면 새지 않는다」* |
| 선례 산정 셋 | `docs/pglite-test-backend-adjudication.md` · `docs/replica-identity-and-join-adjudication.md` · `docs/selective-removal-and-retention-adjudication.md` |
