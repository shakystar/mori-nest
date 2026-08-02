# H030: 인가와 정책 계층

상태(Status): Decision
확정(Since): 2026-07-01
대체함(Supersedes): —
대체됨(Superseded-by): —

## 진술 (Statement)

인가는 단일 정책 계층 `authorize(principal, resource, action)`으로 통일한다.
**principal**은 API 키(머신) 또는 세션 쿠키(브라우저)에서 해석된 하나의 개념이다
(`accountId` + `via('key'|'session')` + `readOnly?` + `scopes?`). **resource**는
스토어(`proj_`/`wsp_`/`psm_`) 또는 control-plane 객체(workspace/invite/membership).
**action**은 read(pull) / write(push) / admin(멤버십 관리·invite 발급·전역 retract).

opaque 이벤트 라우트에서 gateway는 **coarse ACL만** 판단한다: 멤버십 role ∩ 키 scope
∩ 키 read_only ∩ 스토어-kind 규칙. **페이로드는 절대 파싱하지 않는다.** fine 규칙
(예: owner-only 전역 retract가 남의 assertion을 지우는지)은 gateway가 아니라
**클라이언트 projection**이 retract 이벤트의 `writer` role로 판정한다.

## 근거 (Why)

받아들인 트레이드오프: 현재 ACL은 `proxy.ts`에 인라인 하드코딩이고 auth 축이 둘로
갈려 있다(API 키 vs 쿠키). 워크스페이스 제어평면은 CLI(키)와 브라우저(쿠키) 둘 다
걸치므로 "누가 행위하는가"의 단일 개념이 필요하다. 그리고 memorize SoT-060이 "서버는
ACL + coarse recall만, 최종 랭킹은 클라이언트"라고 못박으므로, gateway 인가는 구조적
으로 coarse에 그쳐야 한다 - relay가 opaque라 fine 규칙을 write-time에 강제할 방법도
없다([[H010]]).

## 함의 (Implications)

- `policy.ts` 모듈(`resolvePrincipal(req)` + `authorize(...)`)이 `proxy.ts`의 인라인
  `min(role, scope, readOnly)`을 대체한다.
- personal owner-only / `wsp_` membership-coarse / `proj_` membership은 같은 함수의
  **resource-kind 분기**다 - 각기 다른 핸들러에 흩지 않는다.
- gateway는 retract·supersede의 의미를 절대 강제하지 않는다(payload 불파싱). 그 정합성은
  클라 projection의 책임이다([[H020]], memorize SoT-050).
- read_only는 role이 아니라 키 속성이다: read_only 키는 role과 무관하게 push 불가(403).

## 경계 (Boundaries)

이 문서는 "허용/거부"만 정한다. 무엇을 얼마나 돌려줄지의 랭킹·recall·budget 분배는
클라이언트(그리고 미래의 read surface)의 몫이다([[H060]]). role 집합(owner/member)과
스토어 종류의 실제 스키마는 [[H040]]. prefix 예약 규칙은 [[H050]].

## 관련 (Related)

[[H010-two-plane-boundary]], [[H040-control-plane-data-model]], [[H020-workspace-transport]], [[H060-consolidation-and-read-surface]]
