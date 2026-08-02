# H040: 제어평면 데이터 모델 (workspace-중심 통일)

상태(Status): Decision
확정(Since): 2026-07-01
대체함(Supersedes): —
대체됨(Superseded-by): H080 (access_requests 유지/베타 게이팅 부분만; 나머지는 유효)

## 진술 (Statement)

제어평면은 **workspace-중심으로 통일**한다. `project_acl`을 없애고 `stores` +
`memberships`로 대체하며, **private 프로젝트 = degenerate 워크스페이스**
(`invite_reachable=false`인 1-멤버 스토어)로 모델링한다(memorize SoT-010의 "혼자 있는
워크스페이스" 직역). 개인 store(`psm_`)는 통일에서 **제외하고 물리적으로 분리 유지**
한다 - memorize SoT-010이 cross-account 금지를 구조적으로 강제하는 장치이기 때문이다.

스키마:

```
accounts              (현 users)  id(acc_) · email · github_login · created_at
stores                project-scope 스토어 메타 (store_id는 server-minted; [[H050]])
  store_id PK(wsp_) · invite_reachable(bool) · name? · created_by · created_at
memberships           project_acl 대체 · proj_/wsp_ 공통
  store_id · account_id · role('owner'|'member') · created_at · PK(store_id, account_id)
invites
  invite_id PK(inv_) · store_id · token_hash · role · max_uses · used_count
  · expires_at? · revoked_at? · created_by · created_at
personal_stores       그대로 (owner-only, 구조적 cross-account 차단)
api_tokens/token_scopes  그대로 (key↔account · read_only · project scoping)
access_requests       그대로 (Hub 베타 게이팅)
```

역할은 **owner/member 2역할**이다(memorize SoT-040). read_only는 role이 아니라 키
속성이다([[H030]]). invite는 **철회가능 멀티유즈 링크 + 선택적 만료**다
(`max_uses=null`=무제한, `revoked_at`). **폴더 바인딩은 Hub에 저장하지 않는다** -
"어느 로컬 폴더가 어느 스토어에 sync"는 클라이언트에만 산다.

## 근거 (Why)

받아들인 트레이드오프: memorize SoT-010이 private 프로젝트와 공유 워크스페이스의 차이를
"내용"이 아니라 "도달가능성(reachability)"으로 규정했으므로, 하나의 membership 모델이
가장 정합적이고 클린 리빌드에 맞다 - 앞단 설계 비용은 더 들지만 두 병렬 ACL 모델의
이원화를 없앤다. 개인 store를 memberships에 섞지 않는 이유: 물리 분리가 "2번째 멤버가
붙는" 버그를 원천 차단한다(memorize SoT-010). 폴더 경로를 Hub가 안 갖는 이유:
`folderIdentity`는 로컬 힌트이자 계정-private이고, 사람을 잇는 데 절대 쓰지 않는다
(memorize SoT-020) - Hub는 `membership(account↔store)`만 안다.

## 함의 (Implications)

- **멤버십 = publish "권리"(coarse)이지 트리거가 아니다.** 멤버면 push할 수 있고
  (기억별 per-item ACL 없음, [[H030]]), 그때 나가는 건 whole-DB union이다. 그러나
  멤버십·초대 수락이 곧 sync를 *실행*하지는 않는다 - 실제 공유는 (a) 로컬 폴더↔워크
  스페이스 명시 바인딩 + (b) 명시적 sync가 있어야 일어난다(memorize SoT-020 명시 바인딩,
  SoT-010 sync는 명시적·백그라운드 아님). "통째"는 sync 시 whole-DB라는 뜻(무엇을 보내나)
  이지 "자동"(언제 보내나)이 아니다. 카테고리 단위 opt-out은 별개 정책이다([[H900]]).
- 마이그레이션 불필요(프로덕션 데이터 없음) - 새 스키마로 시작한다.
- 별도 `bindings` 테이블 없음. 워크스페이스 roster = memberships(계정 + role);
  "어느 프로젝트에서 왔나"는 이벤트의 `sourceProjectId` provenance로 클라가 읽는다.
- 제거 = memberships DELETE(coarse) + 필요시 owner 전역 retract 이벤트(스키마 밖,
  projection이 처리)([[H020]], [[H030]]).
- `access_requests`는 워크스페이스 invite와 별개다: 전자는 Hub 베타 접근 게이팅,
  후자는 워크스페이스 join.

## 경계 (Boundaries)

식별자 발급 권한·예약(누가 `proj_`/`wsp_`/`inv_`를 mint하나)은 [[H050]]. 인가 판정
로직은 [[H030]]. opt-out publish 정책을 어디에 저장하나(멤버 로컬 vs 워크스페이스
메타데이터)는 미결이다([[H900]]).

## 관련 (Related)

[[H030-authorization-policy]], [[H050-identifier-namespaces]], [[H020-workspace-transport]], [[H900-open-decisions]]
