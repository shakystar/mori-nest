# CONTRIBUTING.md

이 문서는 아직 아래 절 하나만 담는다. 다른 절(코딩 스타일, 커밋 메시지, 이슈 작성 규칙,
리뷰 절차 등)은 그것을 요구하는 이슈가 따로 설 때 채운다 — 빈 자리를 TODO로 미리 만들지
않는다.

## 파일:줄 인용 관례

산정 문서(`docs/*-adjudication.md`) 둘이 이미 쓰고 있는 관례를 정본으로 옮겨 적은
것이다 — 여기서 새 규칙을 만들지 않는다.

### 경로 형태

인용은 **리포 루트 상대 경로 + `:줄`**(또는 `:시작-끝`)로 적는다.
예: `docs/design/0002-transport-spec.md:84-89`.
(선례: `docs/replica-identity-and-join-adjudication.md` §부록.)

같은 문서 안에서 같은 파일을 반복 인용할 때는 전체 경로 대신, 이미 한 번 전체 경로로
밝힌 파일을 가리키는 짧은 이름으로 줄인다 — 번호가 붙은 스펙 문서는 `0002:110`처럼
번호로, 그 외 파일은 `src/store.ts:101` 다음에 이어지는 `:374-385`처럼 줄 번호만으로.
(선례: `docs/selective-removal-and-retention-adjudication.md:57-59` §0.3 "리포 루트
상대 경로 + `:줄`, 같은 문서 안에서 반복될 때는 `0002:110`으로 줄인다"; 실사용 예 —
`docs/replica-identity-and-join-adjudication.md:791` `` `src/store.ts:101`, `:374-385` ``.)

절 참조(`0002 §1.4`처럼 번호+§+절 번호)는 줄 참조와 함께, 또는 줄 참조 대신 쓴다 — 정확한
줄보다 절 전체를 가리키고 싶을 때, 그리고 줄이 밀려도 절로 되찾을 수 있는 앵커를 남기고
싶을 때다.
(선례: `docs/selective-removal-and-retention-adjudication.md:67` `` `0003:1444-1446` (§8-4) ``;
`docs/replica-identity-and-join-adjudication.md:105` `` `0002-transport-spec.md:110-111` (§1.4) ``.)

### 기준 커밋 명시

줄 번호는 커밋에 매인 값이다. `파일:줄` 인용을 담는 문서는 **§0(또는 그에 준하는 자리)에
자신의 인용이 어느 커밋을 기준으로 확인됐는지** 명시한다.
(선례: `docs/replica-identity-and-join-adjudication.md:14-17` §0.1 "**`0c97aa1`**(착수
시점 `main`…) … 이 문서의 모든 `파일:줄` 인용은 이 커밋에서 직접 열어 확인한 것이다.";
`docs/selective-removal-and-retention-adjudication.md:16-21` §0.1 "**`eaa114c`**… 이
문서의 모든 `파일:줄` 인용은 이 커밋에서 직접 열어 확인한 것이다.")

### 줄 밀림 처리

인용한 문서를 **같은 PR에서 함께 고쳐** 줄이 밀리면, 밀리는 구간과 폭을 표로 남긴다.
(선례: `docs/selective-removal-and-retention-adjudication.md:29-34` §0.1의 밀림 표 —
`0002` 3행(머리말)~§1.4 끝 `+3`, §1.5(`:129`) 이후 전부 `+21`; `0003` 3행(머리말)~§4.9
끝 `+3`, §4.10(`:1184`) 이후 전부 `+6`.)

### CI advisory와의 관계

이 리포(`shakystar/mori-nest`)의 `.github/workflows/`에는 `ci.yml`(`build-and-test`,
typecheck·build·test) 하나뿐이고, 줄 인용을 기계적으로 점검하는 워크플로는 **없다** —
형제 리포 mori의 `#303` 계열 같은 advisory가 이 리포에는 아직 없다.
그런 워크플로가 생기더라도 **required check가 아니라 참고**로만 둔다 — 이 관례의 준수는
CI가 강제하는 것이 아니라 리뷰가 강제한다.
(선례: `.github/workflows/ci.yml` — required check는 `build-and-test` 하나뿐이고 인용
검사 스텝이 없다.)
