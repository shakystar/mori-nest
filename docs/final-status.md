# mori-nest 최종 구현·검증 상태

> **판정 기록 · 동결됨 (커밋 `03dd631` 시점).** 이 문서는 그 시점의 기록이며 오늘의 코드를
> 보증하지 않는다. **갱신하지 않는다** — 낡으면 새 문서가 대체(supersede)한다. 인용이 코드와
> 어긋나 보이면 이 문서가 아니라 코드를 따른다.

정리일: 2026-09-23. 구현 기준: `03dd63135f1c8579c262de0c72f75022e46d1d13`.
이번 정리에서는 런타임 코드와 테스트를 바꾸지 않았다.

## 구현과 검증 범위

| 기능            | 상태·핵심 구현                                               | 확인 근거                                                                                                                                         |
| --------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| append          | 구현. 배치 원자성·이벤트 ID dedup·출처 저장                  | `src/transport/store.ts`, `server.ts`; `test/store.test.ts`, `server.test.ts`, `server-origin.test.ts`                                            |
| pull            | 구현. 커서·페이지 처리                                       | `src/transport/pull.ts`; `test/pull.test.ts`, `server-pull.test.ts`                                                                               |
| subscribe       | 구현. SSE 연결·순서·종료                                     | `src/transport/sse.ts`; `test/sse.test.ts`, `server-subscribe.test.ts`                                                                            |
| 키 경계·토큰    | 구현. 제어 개인키·전송 공개키, Ed25519                       | `src/control/index.ts`, `token.ts`, `src/transport/index.ts`, `token.ts`; `test/entry-boundary.test.ts`, `control-token.test.ts`, `token.test.ts` |
| 로그 관리       | 생성·목록·단건·폐기 구현                                     | `src/control/request.ts`, `server.ts`, `store.ts`; `test/control-server.test.ts`, `control-store.test.ts`                                         |
| 작업공간        | 개시·하트비트·종료·폐기·조회 구현                            | `src/control/workspace-store.ts`, `server.ts`; `test/control-workspace-store.test.ts`, `control-server.test.ts`                                   |
| 자격증명        | 불투명 bearer 토큰 발급·조회·폐기 로직                       | `src/control/credential.ts`; `test/control-credential.test.ts`. 발급 HTTP API는 미구현                                                            |
| 멱등성과 원자성 | 공유 연결에서 자원 생성과 멱등 완료를 같은 트랜잭션으로 커밋 | `src/control/db.ts`, `idempotency.ts`, `server.ts`; `test/control-db.test.ts`, `idempotency.test.ts`, `control-server.test.ts`                    |
| 스키마 경쟁     | 버전 판정·스키마 변경·버전 쓰기의 트랜잭션 경계 구현         | `src/transport/store.ts`의 `applySchema`; `test/store.test.ts`의 높은 버전 동시 커밋 검사                                                         |

표의 같은 영역에서 생략한 소스 디렉터리는 직전 경로와 같고,
테스트는 모두 `test/` 아래에 있다.
기능별 단위·통합 검증과 실제 다중 사용자 서비스 운영은 구분한다.

## 구현 상태 정정

이전 README가 인용한 #71 단계 이후 제어 평면이 구현됐다.
현재 `ControlRoute`는 로그 4종·작업공간 6종의 HTTP 동작을 구분한다.
스펙의 기능 행 수와 실제 HTTP 라우트 수가 달라 혼동할 수 있으므로
[README](../README.md)의 메서드·경로 표를 기준으로 읽는다.

`src/control/index.ts`와 `db.ts`의 일부 설명에는 과거 ‘조각 4/4가 남았다’ 문장이 남아 있다.
실제 `src/control/server.ts`의 생성 라우트는 `withTransaction` 안에서
자원 삽입과 멱등 완료를 호출한다. 이번 종료 정리는 그 경로와 회귀 테스트를 근거로 한다.

## 재현 결과

Node 22.23.1 · pnpm 10.30.3 · Linux, frozen lockfile 설치 후 확인했다.

| 검사             | 결과                        |
| ---------------- | --------------------------- |
| `pnpm typecheck` | 통과                        |
| `pnpm build`     | 통과                        |
| `pnpm test`      | 25개 파일·214개 테스트 통과 |

첫 테스트 실행은 213 통과·1 실패였다.
호스트가 주입한 네트워크 프록시의 `UNDICI-EHPA` 경고가 자식 프로세스 stderr에 나타나
`test/store.test.ts`의 `crashSignal`이 이를 예외로 판단했다.
`NODE_OPTIONS`의 기존 설정을 유지한 채 `--disable-warning=UNDICI-EHPA`만 추가해 다시 실행하니
214개가 통과했다. 코드·검증 조건·프록시를 변경하거나 제거하지 않았다.
이 환경 조정은 호스트 특유의 경고를 구분하기 위한 것이며 제품 변경이 아니다.

실제 모델 호출은 없었다. 테스트의 HTTP 연결은 로컬 테스트 서버를 사용했다.
[기준 커밋의 CI](https://github.com/shakystar/mori-nest/actions/runs/33261298887)도
타입 검사·빌드·테스트 단계의 성공을 기록한다.

## 남은 범위

- 런처 자격증명 발급 HTTP API와 완성된 계정·멤버십 UI/API.
- 로그의 사람이 읽는 이름 등 #68의 남은 제품 메타데이터 결정.
- PostgreSQL 이관과 이관 후 트랜잭션·동시성 재검증.
- mori 클라이언트의 자동 join·push/pull 및 복구까지 포함한 종단 간 통합.
- 다중 사용자 배포, 장기 부하·운영 검증, 처리량·지연 SLA.
- 단일 서버 내구성 검사를 다중 노드 합의·무중단 운영의 증거로 확장하지 않는다.

두 평면의 키를 별도로 주입할 수 있다는 구현 사실과,
실제 배포 환경에서 개인키가 전송 서버에 전달되지 않았다는 검증은 별개다.

## 종료 판단

군 복무 중 개인 프로젝트로 개발했다. 모델 API 사용과 반복 평가에 드는 비용, 복무 중 확보할 수 있는 개발 시간, 관련 도구의 등장을 함께 고려해 추가 개발을 종료했다. 구현한 코드와 검증 기록을 보존하며, 신규 기능 개발과 정기 유지보수는 계획하지 않는다.

전신 memorize_hub는 이 종료 작업의 변경 대상이 아니다.
이슈 #68은 이미 구현된 결정을 담은 기록과 후속 과제를 함께 포함하므로,
열린 상태라는 이유로 제어 평면 전체를 미구현으로 분류하지 않는다.

## 라이선스 범위

원본 코드에 [MIT](../LICENSE)를 적용한다.
Node.js와 개발 도구·외부 자료는 각각의 라이선스를 따른다.
이 저장소에는 런타임 npm dependencies가 없지만, 이를 외부 구성 요소의 권리가 없다는 뜻으로 읽지 않는다.
