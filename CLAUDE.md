# mori-nest

mori 하네스의 공유 기억 서버. **지금은 코드가 없고 프로토콜 설계 단계다.**

## 하드 룰

1. **스펙 없이 구현 코드를 쓰지 마라.** `docs/design/0001-protocol-requirements.md`는
   요구사항이지 스펙이 아니다. 엔드포인트·스키마를 정한 스펙 문서가 머지되기 전에
   서버 코드를 만들면, 전신이 했던 실수(계약을 정하기 전에 구현이 계약을 결정해버리는
   것)를 반복하는 것이다. 이 단계에서 열리는 이슈는 대부분 **문서 작업**이다.

2. **`docs/inherited/`를 규격으로 읽지 마라.** 전신 프로젝트의 기록이다. 맥락으로만
   쓴다. "inherited에 그렇게 적혀 있다"는 구현 근거가 되지 않는다. mori-nest가 지킬
   것은 `docs/design/`에 다시 적혀야 효력이 있다. 자세한 이유는
   `docs/inherited/_INHERITED.md`.

3. **`shakystar/memorize_hub`을 수정하지 마라.** 그 리포는 실서비스로 떠 있고
   (`memorize-hub-shakystar.fly.dev`), 이 플릿 자신의 기억이 거기 있다. 코드를 읽는
   것은 자유다 (`gh api repos/shakystar/memorize_hub/contents/<path>`). PR·이슈·커밋은
   금지.

4. **설계는 `shakystar/mori`와 엮여 있다.** 프로토콜이 바뀌면 클라이언트도 바뀐다.
   프로토콜에 영향을 주는 결정을 내렸으면 mori
   [#115](https://github.com/shakystar/mori/issues/115)와의 정합성을 확인하고, 어긋나면
   **구현하지 말고 `agent:decision`으로 사람에게 올려라.**

## 이 서버가 무엇을 위한 것인지

mori는 개발자 전용 도구가 아니라 **사람들이 협업에 쓰는 하네스**다. 그래서 hub는
백업이 아니라 **유일한 공유 지점**이고, "동료가 내 기억을 언제 보는가"가 곧 제품
품질이다. 설계 판단이 갈릴 때 이 기준으로 정하라.

또 하나: **git이 있는 환경을 가정하지 마라.** 정체성도 동기화도 git 산출물에 의존하면
비개발자 사용자에게 그대로 깨진다.

## 읽는 순서

| 문서 | 내용 |
|---|---|
| `docs/design/0001-protocol-requirements.md` | 새 프로토콜이 만족해야 하는 것 + 계승할 불변식 4개 + 반복하지 말 구현 갭 4개 |
| `docs/inherited/_INHERITED.md` | 전신 기록을 어떻게 읽어야 하는가 |
| `docs/inherited/memorize_hub-SoT/` | 전신 서버의 SoT (H\* 시리즈) |

## 빌드·테스트

Node 22 · TypeScript · pnpm · vitest. 런타임 의존성은 0개다 (`0002 §4.1-3`).

```bash
pnpm install
pnpm typecheck   # tsc --noEmit (src + test)
pnpm build       # tsc -> dist/
pnpm test        # vitest run
```

CI의 `build-and-test` job(`.github/workflows/ci.yml`)이 위 셋을 그대로 돌리기로 돼 있다.
**그 워크플로우 파일은 아직 리포에 없다** — 에이전트 토큰에 `workflow` 스코프가 없어
push가 거부됐다 ([#7](https://github.com/shakystar/mori-nest/issues/7)). 파일이 들어오면
이 문단의 뒷줄을 지운다.
