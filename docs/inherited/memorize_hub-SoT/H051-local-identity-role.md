# H051: proj_의 맥락별 역할 — 로컬 정체성 ↔ provenance (H050 정정)

상태(Status): Decision
확정(Since): 2026-07-01
대체함(Supersedes): H050 (proj_ 위상 서술 부분만; server-minted 발급·prefix 예약·relay prefix-blind 등 나머지 H050 유효)
대체됨(Superseded-by): —

## 진술 (Statement)

H050은 memorize 클라의 `proj_`를 "로컬 프로젝트 정체성 + provenance**일 뿐**", "이벤트 안
provenance 라벨**로만** 남는다"고 서술했다. memorize SoT-021에 맞춰 이 위상 서술을 정정한다:
`proj_`와 server-minted `wsp_`는 **동등한 두 정체성 축**이며, `proj_`는 강등된 라벨이 아니라
**맥락에 따라 역할이 바뀐다** — 로컬 프로젝트를 열 땐 `proj_`가 로컬 정체성(1급), 통합
워크스페이스를 다룰 땐 `wsp_`가 정체성이고 `proj_`는 provenance(`sourceProjectId`) 라벨.
server-minted 원격 store id는 **원격 라우팅·coordination 권위**이지 로컬 정체성 권위가 아니다.

## 근거 (Why)

- 순수 로컬(Hub 미사용·오프라인) 사용자는 `wsp_`가 없다 — 로컬 genesis는 `proj_`
  (`project.created`)여야 하고 항상 존재한다(memorize SoT-021; H050이 인용한 memorize
  SoT-020/060 local-first와 정합).
- H050의 "provenance로만 / 일 뿐" 표현은 **워크스페이스(통합) 관점에서만** 참이며, 로컬
  관점의 `proj_` 정체성을 지워버려 memorize SoT-021과 어긋났다. "true-replica"라는 레거시
  프레이밍도 이 정정으로 대체된다.
- 뒤집는 게 아니라 **범위를 명확히** 하는 것이다: server-minted 원격 발급(H050)은 원격
  경로에 여전히 유효하다.

## 함의 (Implications)

- Hub 계약·구현에서 `proj_`를 "라벨"로 취급하는 것은 **워크스페이스 union 뷰에 한정**한다.
  로컬 store 정체성으로서의 `proj_`를 부정하지 않는다.
- README의 HP1/HP2("로컬 정체성은 그대로 두고 whole-DB union")가 이 정정과 정합한다 —
  각 멤버의 `proj_`는 로컬에선 정체성, 통합에선 provenance.
- server-minted `wsp_`/`psm_` 발급, prefix 예약, relay prefix-blind 검증은 H050 그대로
  유효하다.

## 경계 (Boundaries)

- `proj_` genesis 항상 보장, `reduceProjectState`의 self-vs-provenance 분리 등 **클라 구현
  규칙은 memorize SoT-021 소관**이다. H051은 Hub 서술을 021과 정합시킬 뿐이다.
- `wsp_` 발급 시점 / 오프라인 전환 메커니즘은 구현 계획 소관이다(H050 경계 유지).

## 관련 (Related)

[[H050-identifier-namespaces]], [[H040-control-plane-data-model]], [[H020-workspace-transport]]
