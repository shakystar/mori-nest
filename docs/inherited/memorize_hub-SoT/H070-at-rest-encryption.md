# H070: at-rest 암호화 (디스크 위임, E2E 아님)

상태(Status): Decision
확정(Since): 2026-07-01
대체함(Supersedes): —
대체됨(Superseded-by): —

## 진술 (Statement)

v1의 at-rest 암호화는 **디스크/볼륨 암호화 위임**으로 충족한다(Fly 볼륨·호스트 디스크
암호화). 애플리케이션은 데이터를 **평문으로 취급**한다 - 서버는 shared 기억
consolidation과 discover-before-mint clone·복구를 위해 평문을 읽을 수 있어야 하기
때문이다. 이는 memorize SoT-070의 "서버사이드 at-rest 암호화 + 접근제어" 기준선을
**인프라 레벨에서** 만족한다(GitHub가 private repo를 at-rest 암호화하되 평문으로 읽는
바로 그 모델). **E2E는 연기**한다(memorize SoT-070/900).

## 근거 (Why)

받아들인 트레이드오프: memorize SoT-070이 "서버는 신뢰 경계이며 shared 데이터를 읽는다"
를 전제로 설계하라고 못박았다 - shared 기억 consolidation을 서버가 1회 돌려 모두가
혜택을 보려면 평문 접근이 필요하다. 그렇다면 at-rest를 만족하는 가장 싼 방법은
인프라 디스크 암호화이고, 앱 코드 변경이 ~0이다. E2E를 v1에 넣으면 두 가지가 깨진다:
새 기기의 discover-before-mint clone(서버가 평문을 못 주면 키관리 없이 복호화 불가)과
단일 기기 분실 시 영구 소실("맥락을 잃지 않는다"와 정면 모순). 둘 다 memorize SoT-070이
짚은 이유다.

## 함의 (Implications)

- v1에 앱레벨 암호화 로직을 넣지 않는다. `docs/DEPLOY.md`의 위협모델을 "평문 at-rest"
  에서 "디스크 암호화 at-rest"로 갱신한다.
- payload `__enc` envelope(memorize #182)는 개인/private sync엔 **opt로 남지만**,
  워크스페이스 shared 기억엔 **요구하지 않는다** - 서버가 consolidation 위해 평문이
  필요하므로([[H020]], memorize SoT-070). 두 축(at-rest vs E2E)을 분리해 유지한다.
- 계약을 E2E를 원천봉쇄하는 방식으로 설계하지 않는다.

## 경계 (Boundaries)

E2E의 의도된 형태(store별 DEK를 기기 public key로 래핑)와 그 착수 선결(복구 정책:
오프라인 복구키 / 서버 매개 / 다중기기 상호복구 중 택1)은 미결이며 memorize SoT-070/900
을 상속한다([[H900]]). 개인 store의 격리는 암호화가 아니라 "절대 떠나지 않음"으로
보장한다(memorize SoT-010, [[H040]]).

## 관련 (Related)

[[H020-workspace-transport]], [[H040-control-plane-data-model]], [[H900-open-decisions]]
