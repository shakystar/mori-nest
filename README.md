# mori-nest

mori 하네스의 공유 기억 서버. [`memorize_hub`](https://github.com/shakystar/memorize_hub)의
후신이며, 코드를 잇지 않고 **프로토콜부터 다시 정의한다.**

## 왜 새 리포인가

`memorize_hub`은 지금 `https://memorize-hub-shakystar.fly.dev`에 **실서비스로 떠 있다.**
플릿(owner·developer)이 자기 기억을 거기 맡기고 있으므로, 에이전트가 그 리포에 잘못된
변경을 머지하면 플릿 자신의 기억 경로가 끊긴다. 그래서 구 리포는 운영 상태 그대로 두고
건드리지 않으며, 새 설계는 여기서 한다.

## 지금 상태

**전송·제어 두 평면의 스펙이 머지됐고, 코드는 스캐폴드 단계다.** 9개 라우트
(전송 3 + 제어 6) 중 구현된 것은 아직 하나도 없다. `src/`에 있는 것은 **어느 평면에도
속하지 않는 공통 계약**뿐이다 — 에러 봉투와 `code` 상수(`0002 §1.5` · `0003 §1.3`),
최상위 필드 검증, `405` 판정.

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
