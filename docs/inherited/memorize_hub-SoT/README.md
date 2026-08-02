# memorize_hub Source of Truth (Hub SoT)

memorize_hub(전송 relay + 제어평면 gateway)의 하중을 지는 아키텍처 불변식과 확정된
결정들. `memorize/docs/SoT`(제품층)와 짝을 이루며, 그 SoT가 다루지 않는 **Hub의
구현/아키텍처층**을 담는다. 설계 질문을 다시 꺼내기 전에 여기를 먼저 본다 - 확정된
것은 이 문서들 중 하나에 있고, 미결인 것은 `H900-open-decisions.md`에 있다.

## memorize SoT와의 관계

- **memorize SoT = 제품층** (정체성·sync·공유·보안의 "무엇"). **Hub SoT = 그 "무엇"을
  Hub가 어떻게 실현하나** (전송 토폴로지·제어평면 스키마·인가 계층·배포).
- Hub SoT는 memorize SoT를 **인용**하되(예: "memorize SoT-040") 대체하지 않는다.
  memorize 결정을 뒤집는 건 이쪽이 아니라 memorize 레포의 supersede 라인으로 한다.
- 반대로, Hub 고유 아키텍처(2-plane 경계, wsp_ 전송 토폴로지, 제어평면 스키마)는
  memorize SoT에 없으며 여기가 authoritative다.

## 상태 범례 (Status legend)

- **Invariant (불변)** - 아키텍처(dumb relay, opaque append-only 로그, 2-plane 분리)가
  강제하는 것. 바꾸려면 모델 자체를 바꿔야 한다.
- **Decision (결정)** - 의도적으로 선택한 것. 명시적으로 대체되기 전까지 유효하다.
- **Open (미결)** - 아직 안 정함. `H900`에 두어 확정으로 오해되지 않게 한다.

## 규율 (append-and-supersede)

memorize SoT와 동일하다. 확정된 문서를 제자리에서 덮어쓰지 않는다. Invariant나
Decision을 바꾸려면 대체 문서를 추가하고 옛 문서는 `대체됨:`으로 남긴다.

## 인덱스 (Index)

| 문서 | 주제 | 주 상태 |
| --- | --- | --- |
| H010 | 2-plane 경계 (relay transport vs gateway control-plane) | Invariant |
| H020 | workspace transport = hybrid (typed control-plane + opaque log) | Decision |
| H030 | 인가와 정책 계층 | Decision |
| H040 | 제어평면 데이터 모델 (workspace-중심 통일) | Decision |
| H050 | 식별자 네임스페이스와 발급 | Decision (H051이 부분 대체) |
| H051 | proj_의 맥락별 역할 — 로컬 정체성 ↔ provenance | Decision |
| H060 | consolidation과 read/write surface 위치 (UI에서 기억 추가 포함) | Decision |
| H070 | at-rest 암호화 (디스크 위임, E2E 아님) | Decision |
| H080 | onboarding 개방(베타 게이트 제거) + entitlements seam(결제 연기) | Decision |
| H900 | 미결·연기 결정 | Open |

## 해피패스 (이 SoT가 서비스하는 것)

- **HP1 - 멀티-프로젝트 기억 공유**: 여러 레포의 로컬 `memorize.db`를 한 워크스페이스로
  union, 어느 레포 세션이든 서로의 기억을 provenance 라벨로 봄.
- **HP2 - 크로스-계정 join-and-merge**: 서로 다른 기기·폴더·사용자가 같은 워크스페이스로
  합류(생성 → 초대 → 폴더 지정 → sync), 로컬 정체성은 그대로 두고 whole-DB union.

둘 다 100% local-replicate + Hub-transit다. 서버측 consolidation·E2E·realtime는 어느
해피패스도 쓰지 않는다([[H060]], [[H070]], [[H900]]). 상세: [[H020]], [[H040]].

## 출처 (Source)

2026-07-01 memorize_hub 워크스페이스 설계 세션. memorize SoT 2026-07-01 세트를 기반
컨텍스트로 삼음. 진단 동반: `docs/WORKSPACE_CONTRACT_BRIEF.md`, `docs/JOIN_AND_MERGE.md`,
`PROTOCOL.md`.
