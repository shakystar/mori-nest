# mori-nest

mori 하네스의 공유 기억 서버. [`memorize_hub`](https://github.com/shakystar/memorize_hub)의
후신이며, 코드를 잇지 않고 **프로토콜부터 다시 정의한다.**

## 왜 새 리포인가

`memorize_hub`은 지금 `https://memorize-hub-shakystar.fly.dev`에 **실서비스로 떠 있다.**
플릿(owner·developer)이 자기 기억을 거기 맡기고 있으므로, 에이전트가 그 리포에 잘못된
변경을 머지하면 플릿 자신의 기억 경로가 끊긴다. 그래서 구 리포는 운영 상태 그대로 두고
건드리지 않으며, 새 설계는 여기서 한다.

## 지금 상태

**코드 없음. 프로토콜 문서 단계.**

mori는 개발자만이 아니라 **사람들이 협업에 쓰는 하네스**다. 그 전제가 서버 요구사항을
바꾼다 — hub가 백업이 아니라 **유일한 공유 지점**이 되므로, 동료의 기억이 몇 분 뒤에
보이면 협업이 성립하지 않는다. 구 relay의 폴링 전용 계약으로는 이 요구를 못 덮는다.

읽는 순서:

| 문서 | 내용 |
|---|---|
| `docs/design/0001-protocol-requirements.md` | 새 프로토콜이 만족해야 하는 것. **먼저 읽을 것** |
| `docs/inherited/` | 전신(`memorize`·`memorize_hub`)의 기록. **규격이 아니라 맥락** |

## 관련 리포

| 리포 | 역할 |
|---|---|
| [`mori`](https://github.com/shakystar/mori) | 클라이언트 하네스 |
| [`memorize_hub`](https://github.com/shakystar/memorize_hub) | 전신 서버. 운영 중, 읽기 참조만 |
| [`memorize`](https://github.com/shakystar/memorize) | 전신 클라이언트 |
| [`autopilot-agents`](https://github.com/shakystar/autopilot-agents) | 이 리포를 다루는 에이전트들 |
