# H010: 2-plane 경계 (relay transport vs gateway control-plane)

상태(Status): Invariant
확정(Since): 2026-07-01
대체함(Supersedes): —
대체됨(Superseded-by): —

## 진술 (Statement)

Hub는 두 평면으로 갈린다. **relay = 전송평면**: dumb store-and-forward, zero 런타임
의존, `node:http`, ndjson-on-disk, `event.id`로만 라우팅, 페이로드는 opaque,
append-only. **gateway = 제어평면**: 정체성·API키·ACL·멤버십·invite·reverse-proxy.
둘은 **별개 프로세스**이며 오직 HTTP로만 통신한다 - gateway는 relay의 `EventStore`를
절대 import하지 않고, relay는 계정·멤버십·prefix를 절대 알지 못한다. 제어평면 DB는
users/tokens/ACL/membership만 담고 **이벤트 데이터를 절대 담지 않는다.**

## 근거 (Why)

relay를 dumb·vendor-neutral로 유지하는 것이 memorize 클라이언트의 기억 스키마가
relay를 건드리지 않고 진화하게 만드는 유일한 방법이다 - relay가 payload 구조나 기억
taxonomy를 조금이라도 알면, 클라 스키마 변경마다 relay를 함께 바꿔야 한다. 반대로
식별·인가·멤버십은 판단(누가 무엇에 접근하는가)이 필요하고, 그 판단을 dumb transport에
넣는 순간 relay가 더 이상 opaque하지 않다. 그래서 둘은 같은 프로세스에 있을 수 없다.
이 분리는 memorize SoT가 전제하지만 명시하지 않은, Hub의 하중 불변식이다.

## 함의 (Implications)

- 새 기능은 먼저 "전송이냐 제어냐"로 가른다. 워크스페이스 = 제어평면(gateway) 신규 +
  전송평면(relay) 무변경([[H020]]).
- relay에 prefix 인지·projection·query·identity를 절대 넣지 않는다. `wsp_`/`psm_`는
  gateway 개념이고 relay에겐 그냥 `:id` 문자열이다([[H050]]).
- gateway 인가가 아무리 커져도 이벤트 payload를 파싱하지 않는다 - 인가는 coarse(메타
  수준)에 그친다([[H030]]).
- 두 평면은 각자 배포 경계를 가진다: relay는 내부 전용·토큰 게이트, gateway는 공개
  엣지·TLS(`docs/DEPLOY.md`).

## 경계 (Boundaries)

이 문서는 relay와 gateway만 다룬다. #92 read surface(consolidation·다중사용자 쿼리·
remote MCP)는 relay도 gateway도 아닌 **별도의 headless memorize replica**가 맡으며,
그 컴포넌트 경계는 [[H060]]에 있다. 그 replica를 relay나 gateway로 키우지 않는다.

## 관련 (Related)

[[H020-workspace-transport]], [[H030-authorization-policy]], [[H050-identifier-namespaces]], [[H060-consolidation-and-read-surface]]
