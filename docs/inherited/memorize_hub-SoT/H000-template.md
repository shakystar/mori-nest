# H0NN: <제목>

상태(Status): Invariant | Decision | Open
확정(Since): YYYY-MM-DD
대체함(Supersedes): H0NN | —
대체됨(Superseded-by): H0NN | —

## 진술 (Statement)

한 문단으로, 얼버무리지 말고 규칙으로 단언한다. Hub에서 무엇이 참인가.

## 근거 (Why)

이 규칙을 강제하는 이유. **Invariant**라면 아키텍처(dumb relay, opaque append-only
로그, 2-plane 분리)의 무엇이 이걸 불가피하게 만드는지 적는다. **Decision**이라면
받아들인 트레이드오프와 기각한 대안을 적는다. memorize SoT를 인용할 땐 "memorize
SoT-0NN"으로 텍스트 참조하고, 그 결정을 뒤집지 않는다(뒤집으려면 memorize 레포의
supersede 라인으로).

## 함의 (Implications)

이게 하류에서 무엇을 제약하는가. 이것 때문에 구현자가 하면 안 되는 것은 무엇인가.

## 경계 (Boundaries)

이 문서가 주장하지 않는 것. 예외 사례. 어디서부터는 다른 Hub SoT 문서가 맡는가.

## 관련 (Related)

[[H010-two-plane-boundary]], … (Hub 내부) · memorize SoT-0NN (텍스트 참조)
