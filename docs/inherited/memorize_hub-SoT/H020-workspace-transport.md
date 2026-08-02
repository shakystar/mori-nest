# H020: workspace transport = hybrid (typed control-plane + opaque log)

상태(Status): Decision
확정(Since): 2026-07-01
대체함(Supersedes): —
대체됨(Superseded-by): —

## 진술 (Statement)

워크스페이스는 **하이브리드**로 와이어에 실린다. **① typed 제어평면**(gateway):
워크스페이스 생성·초대·join·멤버십·역할. **② opaque 이벤트 로그**(relay): `wsp_…`는
또 하나의 `:id` 로그이고, 데이터는 기존 `POST/GET /v1/projects/:id/events` 라우트로
byte-for-byte 흐른다. 멤버십 = publish이며(memorize SoT-040 - publish "권리"이지
sync 트리거가 아님, [[H040]]) whole-DB union이다 - 새 이벤트 envelope는 없다. provenance(`writer` + `sourceProjectId`)는 이미 모든
`DomainEvent`가 싣고 있다(memorize SoT-030). 이 결정이 memorize SoT-900 #1을 닫는다.

전송 토폴로지는 **공유 wsp_ 로그**다: 바인딩된 각 프로젝트가 자기 이벤트를 하나의
`wsp_` 로그로 push하고, 모두가 그 union을 pull한다. 로컬 `memorize.db`는 `event.id`
dedup으로 깔끔한 union이 된다.

## 근거 (Why)

받아들인 트레이드오프: id·멤버십·invite는 **서버 발급 정체성**(memorize SoT-020)이라
dumb relay가 못 한다 → gateway. 그러나 공유 기억의 수렴은 append-only opaque 로그로
충분하다 → relay 무변경. 기각한 대안: **순수 relay(A)**는 id를 mint하거나 멤버십·역할·
invite를 쥘 수 없다; **순수 typed 데이터 API(B)**는 projection·랭킹을 gateway로
끌어와 memorize SoT-060("서버는 ACL + coarse recall만")과 relay-dumb 불변([[H010]])을
깬다. 공유 wsp_ 로그를 택한 이유: 로컬 병합 결과는 fan-out과 동일하지만, relay 코드
변경 0, `psm_` 선례와 동일 패턴, pull이 단일 로그라 단순, cross-account ACL도 wsp_
하나에만 건다. workspace-only push면 Hub 저장 중복도 0이다.

## 함의 (Implications)

- 워크스페이스 데이터평면은 events 라우트 그 이상이 아니다. relay는 `wsp_` 로그를
  여느 프로젝트 로그처럼 저장한다([[H010]], [[H050]]).
- `psm_` 개인 store 선례를 그대로 복제한다: typed discovery 엔드포인트 +
  그 뒤 opaque events 라우트.
- 제거는 두 동작이다: 멤버십 DELETE(향후 push/pull 차단) + 필요시 owner 전역 retract
  이벤트(projection이 숨김, 클라측 - relay는 opaque). memorize SoT-050/040.

## 경계 (Boundaries)

서버측 consolidated view 생성 + coarse-recall **쿼리 엔드포인트**는 데이터평면 밖이며
연기됐다([[H060]]). 암호화 축(payload `__enc` envelope는 opt, 워크스페이스는 요구 안
함)은 [[H070]]. 제어평면 스키마(stores/memberships/invites)는 [[H040]].

## 관련 (Related)

[[H010-two-plane-boundary]], [[H040-control-plane-data-model]], [[H060-consolidation-and-read-surface]], [[H070-at-rest-encryption]]
