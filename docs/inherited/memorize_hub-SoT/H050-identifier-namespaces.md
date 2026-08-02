# H050: 식별자 네임스페이스와 발급

상태(Status): Decision
확정(Since): 2026-07-01
대체함(Supersedes): —
대체됨(Superseded-by): H051 (proj_ 위상 서술 부분만; server-minted 발급·prefix 예약·relay prefix-blind 등 나머지는 유효)

## 진술 (Statement)

path-id 정규식 `^[A-Za-z0-9_-]{1,128}$`는 relay와 gateway가 공유하는 계약이다(id가
relay의 파일시스템 경로 컴포넌트가 되므로 traversal 차단도 겸한다).

**인증적(authoritative) 원격 store id는 항상 gateway가 발급한다**(memorize SoT-020):
개인 `psm_`, 프로젝트-scope 공유 store `wsp_`(1-멤버 degenerate=private ~ N-멤버=shared,
[[H040]]), invite `inv_`, account `acc_`. 협업·coordination을 담당하는 store id는 예외
없이 서버 발급이며, 이것이 **여러 클라이언트가 각자 만든 id의 충돌·모호를 원천 제거**한다.

memorize 클라이언트의 **`proj_`(memorize#30 true-replica)는 로컬 프로젝트 정체성 +
provenance(`sourceProjectId`)일 뿐**, 원격 coordination/store 키가 아니다. 워크스페이스
에서 사용자 A·B가 각자 db를 올릴 때 공유 store는 server-minted `wsp_`이고, 각자의
`proj_`는 이벤트 안 provenance 라벨로만 남는다 - 그래서 client-minted id가 서로
충돌하지 않는다. relay는 **prefix-blind**: 서버가 건넨 id를 위 정규식으로만 검증해 키한다.

## 근거 (Why)

memorize SoT-020: 똑똑한 서버(SaaS)를 택한 순간 서버가 id를 발급하는 게 정석이고,
콘텐츠/클라 파생 정체성은 안티패턴이다 - root commit 충돌, fork 모호, origin 변경으로
깨진다. 특히 join-and-merge(HP2)에서 A·B의 이미 채워진 db를 하나로 union할 때, 공유
store가 server-minted `wsp_`이므로 두 클라의 `proj_`를 재작성하거나 하나로 접을 필요가
전혀 없다(JOIN_AND_MERGE.md "Initial Boundary"). `proj_` true-replica는 유지하되 그
역할을 **로컬 정체성 + provenance로 한정**해 원격 정체성과 직교시킨다.

## 함의 (Implications)

- 공유·개인 store의 접근·병합은 **server-minted id로만** 라우팅한다. 이벤트 속
  `sourceProjectId`(=`proj_`)는 표시·필터·drill-down용 provenance지 라우팅 키가 아니다.
- gateway가 account↔store 매핑을 authoritative하게 쥔다([[H040]]의 stores/memberships).
  로컬 폴더↔store 바인딩은 클라측이다([[H040]]).
- prefix 판정 로직은 **gateway에만** 산다(`isPersonalStoreId` 류 검사를 `wsp_`/`inv_`
  까지 확장). relay 코드엔 prefix 분기가 없다. 새 스토어 종류 = 새 prefix + gateway
  예약. relay 무변경.
- 예약: gateway는 `psm_`·`wsp_`·`inv_` 형태 id를 프로젝트로 grant/clone하도록 거부한다.

## 경계 (Boundaries)

**모든 원격 store id는 server-minted로 통일한다**(2026-07-01 확정): private 프로젝트도
1-멤버 `wsp_`(server-minted)이며, `proj_`는 로컬 정체성+provenance로만 남는다 - SoT-020
문자 그대로이자 [[H040]] 'project=degenerate workspace' 통일과 완전 정합. 귀결: memorize
클라의 private-sync 원격 경로가 client `proj_`에서 server-minted store id로 바뀐다 -
개인 store의 `GET /v1/account/personal-store` discovery와 같은 결의 store-id 해석/발급
단계가 필요하며 `PROTOCOL.md` 정합 대상이다. id가 어떤 테이블에 저장되나는 [[H040]],
접근 판정은 [[H030]].

## 관련 (Related)

[[H010-two-plane-boundary]], [[H040-control-plane-data-model]], [[H030-authorization-policy]], [[H020-workspace-transport]], [[H900-open-decisions]]
