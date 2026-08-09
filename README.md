# mori-nest

mori 하네스의 공유 기억 서버. [`memorize_hub`](https://github.com/shakystar/memorize_hub)의
후신이며, 코드를 잇지 않고 **프로토콜부터 다시 정의한다.**

## 왜 새 리포인가

`memorize_hub`은 지금 `https://memorize-hub-shakystar.fly.dev`에 **실서비스로 떠 있다.**
플릿(owner·developer)이 자기 기억을 거기 맡기고 있으므로, 에이전트가 그 리포에 잘못된
변경을 머지하면 플릿 자신의 기억 경로가 끊긴다. 그래서 구 리포는 운영 상태 그대로 두고
건드리지 않으며, 새 설계는 여기서 한다.

## 지금 상태

**기준 커밋 `1317429`**(이 절을 고친 PR의 베이스 `main`) **+ 그 위의 mori-nest #71.**
이 절의 `파일:줄` 인용은 **#71이 파일을 옮긴 뒤의 자리**에서 직접 열어 확인한 것이다 —
베이스 커밋에는 옛 경로(`src/server.ts` 등)로 있다. 이동 표는 이 절 끝에 있다. 커밋이
움직이면 재확인이 필요하다.

`src/`는 셋으로 갈려 있다 — **경계는 배포 단위에 긋고, 코드에서 그것을 표현하는 최소
단위는 엔트리포인트다**(#68 사람 결정 ① 정정, #71):

| 자리 | 무엇 | 자기 설정 스키마 |
|---|---|---|
| `src/transport/` | 전송 평면 엔트리 | `parseTransportConfig` — `keyId → 공개키` 집합 |
| `src/control/` | 제어 평면 엔트리 | `parseControlConfig` — private key |
| `src/` | 양쪽이 import하는 것 | 없음 |

전송 평면 3 라우트(append `0002 §2` · pull `§3` · subscribe `§4`)는 **구현·배선돼 있다.**
`src/transport/server.ts:5-6`이 `POST /v1/logs/{logId}/events` · `GET /v1/logs/{logId}/events` ·
`GET /v1/logs/{logId}/subscribe` 셋을 배선한다고 적고, `src/transport/server.ts:347`의
`handleAppend`가 그중 append 핸들러다. `src/transport/store.ts`(이벤트 스토어, #27) ·
`src/transport/pull.ts` · `src/transport/sse.ts` · `src/transport/token.ts`(작업공간 토큰 검증,
#11) · `src/transport/event.ts` · `src/transport/request.ts`도 전부 전송 평면 구현이다.
두 평면이 공유하는 것은 에러 봉투와 `code` 상수(`src/errors.ts`, `0002 §1.5` · `0003 §1.3`) ·
최상위 필드 검증(`src/body.ts`) · `405` 판정(`src/method.ts`)뿐이고, `src/index.ts`가 그
셋만 낸다.

제어 평면 6 라우트는 **0건**이다 — `0003 §8-2`(런처 자격증명의 형태)와 `0003 §8-3`(grant
판정 규칙)이 이 커밋 시점에도 열려 있어 착수할 수 없다. `src/control/index.ts`는 그래서
**설정 스키마와 모듈 경계까지**다.

**전송 엔트리는 서명자에 닿지 않는다.** 이 성질을 만드는 것은 코드 배치가 아니라
**키 배포**다 — Ed25519는 서명과 검증이 `node:crypto`라는 같은 빌트인에 있으므로
디렉터리로는 능력을 뺏을 수 없고, 전송 평면에 오는 것은 공개키뿐이다(`0003 §3.3` MUST).
private key가 나타나는 설정 스키마는 리포 전체에서 `src/control/index.ts` 하나이고,
전송 설정 파서는 정의되지 않은 최상위 필드와 private `KeyObject`가 섞인 키 목록을 둘 다
거부한다(`test/entry-boundary.test.ts`). 같은 파일의 **트립와이어**는 전송 엔트리의 import
그래프에 서명 심볼이 없음을 보지만, 그것은 불변식의 증명이 아니라 사고 결합을 잡는
장치다. 유효 키쌍 생성과 서명은 발급자 흉내(`test/workspace-token.ts:1-30`) 안에만 있다.

#71의 파일 이동 표 (`src/` 안, 내용 변경은 import 경로 갱신뿐 — 줄 번호는 밀리지 않았다):

| 옛 경로 | 새 경로 |
|---|---|
| `src/token.ts` · `src/request.ts` · `src/event.ts` | `src/transport/` 아래 같은 이름 |
| `src/sse.ts` · `src/pull.ts` · `src/store.ts` · `src/server.ts` | `src/transport/` 아래 같은 이름 |
| `src/errors.ts` · `src/body.ts` · `src/method.ts` | 그대로 (`src/`) |

mori는 개발자만이 아니라 **사람들이 협업에 쓰는 하네스**다. 그 전제가 서버 요구사항을
바꾼다 — hub가 백업이 아니라 **유일한 공유 지점**이 되므로, 동료의 기억이 몇 분 뒤에
보이면 협업이 성립하지 않는다. 구 relay의 폴링 전용 계약으로는 이 요구를 못 덮는다.

읽는 순서:

| 문서 | 내용 |
|---|---|
| `docs/design/0001-protocol-requirements.md` | 새 프로토콜이 만족해야 하는 것. **먼저 읽을 것** |
| `docs/design/0002-transport-spec.md` | 전송 평면(dumb) 와이어 스펙 — append / pull / subscribe |
| `docs/design/0003-control-plane-spec.md` | 제어 평면(smart) 스펙 — 식별자 발급 / 작업공간 토큰 / 생애 추적 |
| `docs/inherited/` | 전신(`memorize`·`memorize_hub`)의 기록. **규격이 아니라 맥락** |

## 빌드·테스트

Node 22 · TypeScript · pnpm · vitest. **런타임 의존성(`dependencies`)은 0개다** —
전송 평면을 `node:http` 수준으로 유지한다는 `0002 §4.1-3`의 방향이다.

```bash
pnpm install
pnpm typecheck   # tsc --noEmit (src + test)
pnpm build       # tsc -> dist/
pnpm test        # vitest run
```

CI는 `.github/workflows/ci.yml`의 `build-and-test` job이 위 셋을 그대로 돌린다.

## 관련 리포

| 리포 | 역할 |
|---|---|
| [`mori`](https://github.com/shakystar/mori) | 클라이언트 하네스 |
| [`memorize_hub`](https://github.com/shakystar/memorize_hub) | 전신 서버. 운영 중, 읽기 참조만 |
| [`memorize`](https://github.com/shakystar/memorize) | 전신 클라이언트 |
| [`autopilot-agents`](https://github.com/shakystar/autopilot-agents) | 이 리포를 다루는 에이전트들 |
