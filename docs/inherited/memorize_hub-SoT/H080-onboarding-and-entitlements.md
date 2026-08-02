# H080: onboarding 개방과 entitlements seam

상태(Status): Decision
확정(Since): 2026-07-01
대체함(Supersedes): H040의 "access_requests 그대로 (Hub 베타 게이팅)" 부분
대체됨(Superseded-by): —

## 진술 (Statement)

v1은 **베타 게이트가 없다**. OAuth로 인증된 계정(세션) 또는 그 계정이 `/account`에서
스스로 민팅한 API 키면 **누구나** 워크스페이스를 만들고 sync할 수 있다. legacy의
per-project **access-request + 수동 승인** 흐름과 `project_acl` grant는 **은퇴**하고,
접근권은 전적으로 **workspace membership**([[H040]])이 규정한다. 즉 "누가 접근하나"는
승인 큐가 아니라 membership + invite/join으로만 정해진다.

**결제 모델(free / team / pro)은 계획되어 있으나 의도적으로 연기**한다 - 코어
제어평면을 먼저 완결하고 그 위에 얹는 **시퀀싱**이지 scope-cut이 아니다. 결제는
구조적으로 **권한 분리 + quota** = *entitlements*이므로, 흩뿌리지 않고
**동일한 `authorize(principal, resource, action)` 게이트**([[H030]])에 삽입한다:

- principal은 이미 `accountId`를 싣는다 → `plan = planOf(accountId)` 조회는 순수 additive.
- tier 한도(계정당 워크스페이스 수, 워크스페이스당 멤버 수, read-only 좌석, retention
  창)는 `authorize` 안의 **quota 판정**이 되어 기계가독 사유와 함께 `403`/`409`를 낸다.
- 엔드포인트 모양은 안 바뀐다 - entitlements는 기존 action을 좁히기만 하며, 이는
  `read_only`/scope가 이미 하는 방식과 동일하다([[H030]] read_only×scope).

연기 동안 `plan`은 모든 계정에 대해 암묵적 무제한이다.

## 근거 (Why)

받아들인 트레이드오프: 베타 게이트는 client-minted `proj_`를 전제한 legacy 산물이라
server-minted store([[H050]]) 세계에서 `access_requests.requested_project_id`가 더 이상
라우팅되지 않는다 - 게이트를 고치기보다 **은퇴**가 정합적이다(프로덕션 데이터 없음,
마이그레이션 불필요). 결제를 지금 authorize 밖 핸들러마다 심으면, tier 규칙이 흩어져
클린 리빌드의 단일-정책-계층([[H030]]) 이점을 깬다. 반대로 seam만 남기고 연기하면
엔드포인트 계약을 하나도 안 바꾸고 나중에 additive 계층으로 얹을 수 있다 - "일단 개발
완결하고 위에 얹는다"는 방침과 정확히 맞다.

## 함의 (Implications)

- 새 제어평면 스키마에서 `project_acl`·`access_requests` 테이블은 만들지 않는다
  ([[H040]] memberships가 완전대체). 운영자 수동 승인 UI(legacy `/beta` + admin approve)는
  신규 흐름에서 obsolete.
- 계정 획득 = OAuth 로그인(또는 발급된 키). 그 이상 게이팅 없음.
- `accounts` 행에 미래 `plan` 컬럼을 둘 **자리**만 인지하되 지금은 만들지 않는다
  (deferred). 도입 시 `authorize`와 quota 헬퍼에만 손대고 라우팅/핸들러는 불변.
- entitlements 한도 위반의 상태코드 규약: 허용 자체가 막히면 `403`, 불변식/한도 충돌은
  `409`(예: 멤버 상한 초과 join) - PROTOCOL 규약과 정합.

## 경계 (Boundaries)

이 문서는 "누가 제어평면을 쓸 수 있나(게이팅)"와 "결제가 어디에 얹히나(seam)"만 정한다.
실제 tier 정의·가격·quota 수치는 **미결**이며 결제 도입 시점의 결정이다([[H900]]).
인가 판정 로직 자체는 [[H030]], 스키마는 [[H040]], 식별자는 [[H050]].

## 관련 (Related)

[[H030-authorization-policy]], [[H040-control-plane-data-model]], [[H050-identifier-namespaces]], [[H900-open-decisions]]
