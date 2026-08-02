# H060: consolidation과 read/write surface 위치

상태(Status): Decision
확정(Since): 2026-07-01
개정(Revised): 2026-07-01 - 연기 성격 변경: 트리거-gated 무기한 연기 → 빌드 확정,
  로드맵 마지막 순번(공개 제품 필수 판단). 컴포넌트 정체성·경계는 불변.
대체함(Supersedes): —
대체됨(Superseded-by): —

## 진술 (Statement)

이번 라운드에서 **서버측 consolidation·coarse-recall·LLM은 전부 연기**한다. Hub는
**relay(전송) + gateway(제어평면)만**이다. consolidated view(dedup·cluster·모순플래그
된 재생성 가능 view, memorize SoT-040)는 각 레포의 **memorize 클라이언트가 raw union
에서 로컬로 빌드**한다. **Hub는 어떤 LLM도 돌리지 않는다** - LLM 판단은 memorize
클라의 write-time consolidation(salience 점수·태깅)에만 있고, 읽기/주입 hot-path는
기계적이다(memorize SoT-060).

**서버측에서 워크스페이스 기억에 도메인 수준으로 접근하는 모든 것은 memorize replica를
거친다 - relay도 gateway도 아니다.** relay는 opaque(도메인 무지)이고 gateway는
control-plane-only라, 이벤트 하나를 삽입하는 사소한 편집조차 도메인 스키마를 아는 주체가
있어야 하기 때문이다([[H010]]). 이 replica는 read이자 write surface다:

- **write** - 사용자가 워크스페이스 UI에서 기억을 추가하거나 task를 cancel하는 등의
  편집을 replica가 도메인 이벤트로 author(provenance = 서버측 계정)해 `wsp_` 로그로
  push하고, 바인딩된 모든 레포가 pull해 수렴한다("쓰기는 edge에서"의 서버판, memorize #92).
- **read** - union을 projection해 대시보드·remote MCP·클라우드 쿼리로 노출한다(코퍼스가
  로컬에 안 담기거나 per-query 취소가능 ACL이 필요한 예외 모드).

접근의 **무게는 스펙트럼**(단발 이벤트 삽입 ~ 상시 쿼리 서비스)이지만 **컴포넌트 정체성은
불변**이다 - 언제나 relay를 소비하는 memorize replica이지 relay/gateway의 확장이 아니다.
배포 형태(요청 시 on-demand authoring vs 상시 read 서비스)는 무게에 따라 달라질 수
있고, 이 컴포넌트 전체는 **빌드가 확정**되어 있으나 **로드맵의 맨 마지막 순번**이다 -
나머지 제어평면·전송·클라이언트를 먼저 끝내고 마지막에 짓는다(방향 전환 2026-07-01,
아래 경계 참조).

## 근거 (Why)

받아들인 트레이드오프: memorize SoT-060의 기본 경로는 local-replicate + 클라 최종
랭킹이다. 서버 consolidation·coarse recall이 필요한 건 오직 예외 모드 - (a) 한
워크스페이스 코퍼스가 로컬에 다 담기엔 너무 크거나, (b) per-query 취소가능 ACL이
필요할 때 - 뿐이다. 두 해피패스(HP1·HP2)는 각 레포가 로컬에서 union을 빌드하므로 이
예외를 안 쓴다. 서버측 authoring(UI에서 기억 추가)도 마찬가지로 **완전한 memorize
도메인 엔진이 필요한 일**이라 relay·gateway가 아니라 replica의 몫이다 - task·rule·기억이
무엇인지 아는 주체만 도메인 이벤트를 만들 수 있고, 그 지식을 dumb transport나 제어평면에
넣으면 [[H010]] 경계가 깨진다. read든 write든 replica를 별도 컴포넌트로 두는 것이
relay·gateway를 projection/도메인으로 오염시키지 않는 유일한 방법이다.

## 함의 (Implications)

- gateway 리빌드는 consolidation·authoring을 아예 건드리지 않는다 - 스코프가 깨끗해진다.
- relay에도 gateway에도 projection·query·랭킹·임베딩·도메인 스키마를 넣지 않는다.
- 워크스페이스 UI/서버가 author한 이벤트는 **union의 또 다른 writer**일 뿐이다 -
  append-only union이 특별 처리 없이 흡수하고(memorize SoT-030/040), relay/gateway는
  그것을 여느 opaque 이벤트처럼 나른다([[H010]], [[H020]]).
- headless replica read/write surface는 **미래의 별개 컴포넌트**다. 착수하면 그것이
  relay를 읽고 쓰는 또 하나의 memorize replica이지, relay/gateway의 확장이 아니다.

## 경계 (Boundaries)

이 문서는 미래 read/write surface를 relay·gateway와 **분리하되 빌드는 확정**한다.
**방향 전환(2026-07-01):** 이 도메인 surface(대시보드·remote MCP·UI 편집)는 "**일반
공개할 만한 제품이 되려면 반드시 있어야 하는 것**"으로 판단되어, 더 이상 트리거-gated
무기한 연기가 아니라 **로드맵의 마지막 빌드로 확정 예약**된다 - 나머지(제어평면·전송·
클라이언트)를 먼저 끝내고 **맨 마지막에** 착수한다([[H900]]). 착수 트리거(첫 claude.ai
소비자 / 로컬에 안 담기는 코퍼스 / 브라우저 UI 수요)는 이제 "혹시"의 게이트가 아니라
빌드를 앞당길 수 있는 신호일 뿐이다. **컴포넌트 정체성은 불변** - relay를 소비하는 별도
memorize replica이지 relay/gateway의 확장이 아니다. 무엇을 허용/거부하는가의 인가는
[[H030]]; UI/서버 authoring도 같은 정책 계층을 통과한다.

## 관련 (Related)

[[H010-two-plane-boundary]], [[H020-workspace-transport]], [[H030-authorization-policy]], [[H900-open-decisions]]
