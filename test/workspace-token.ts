/**
 * 테스트 헬퍼: 발급자를 부르는 자리 (mori-nest #94 이전에는 «발급자 흉내»였다).
 *
 * ## 이 파일은 더 이상 서명하지 않는다 (mori-nest #94)
 *
 * 이전에는 `0003 §3.2`의 클레임 인코딩과 Ed25519 서명이 **이 파일 안에** 있었다.
 * 같은 형식이 두 곳에서 각자 구현되어 있으면 어느 쪽이 정본인지 없어지고, 테스트가
 * 초록인 것은 «헬퍼가 만든 것을 검증자가 읽는다»만 말할 뿐 **프로덕션 발급자가 만든
 * 것을 검증자가 읽는다**는 것을 말하지 않는다. 지금은 아래 {@link mint}가
 * `src/control/token.ts`의 {@link issueWorkspaceToken}을 그대로 부르므로, 전송 평면
 * 테스트 전부가 프로덕션 발급자의 바이트를 먹는다.
 *
 * 형식을 **어긴** 토큰(빈 스코프·잉여 바이트·다른 `version`)이 필요한 곳은 검증자의
 * 엄격 파싱을 시험하는 `test/token.test.ts` 하나이고, 그런 토큰은 발급자가 만들기를
 * 거부하는 바이트열이므로 정의상 발급자로 만들 수 없다 — 그 위조기는 그것을 쓰는
 * 그 파일 안에 산다.
 *
 * ## 이 파일이 지키는 성질 (정정 — mori-nest #71)
 *
 * 이전 머리말은 *"`src/`는 검증만 하고 서명 능력을 갖지 않는다"*고 적었다. 그 문장은
 * 두 번 틀렸다:
 *
 * 1. **코드 배치로는 그 성질을 만들 수 없다.** Ed25519는 `node:crypto`에 있고 서명과
 *    검증이 **같은 빌트인**이다. 이 파일을 `test/`에 가둬도 `src/` 어디서든
 *    `import { sign } from "node:crypto"`가 된다. 성질을 지키는 것은 **키 배포**다 —
 *    전송 평면에 오는 것은 공개키뿐이고 (`0003 §3.3` MUST: *"검증 키는 전송 평면에
 *    설정으로 주입된다"*), private key를 받은 적이 없으므로 서명할 대상이 없다.
 * 2. **제어 평면도 `src/`다.** 제어 평면이 토큰을 발급하기 시작하면 서명 코드는
 *    `src/control/` 안에 들어온다 — 그때 위 문장은 문자 그대로 거짓이 된다.
 *    **#94에서 실제로 그렇게 됐다** (`src/control/token.ts`).
 *
 * 실제 명제는 **«전송 엔트리가 서명자에 닿지 않는다»**이다 — 모듈 명제처럼 보이지만
 * **엔트리 명제**다. private key가 나타나는 설정 스키마는 `src/control/index.ts` 하나이고
 * (`parseControlConfig`), 전송 설정 스키마(`src/transport/index.ts`의
 * `parseTransportConfig`)에는 그 자리가 아예 없으며 private `KeyObject`가 섞인 키 목록을
 * 거부한다. `test/entry-boundary.test.ts`가 그 둘을 검사하고, 같은 파일의 **트립와이어**가
 * 전송 엔트리의 import 그래프에 서명 심볼이 없음을 함께 본다 — 트립와이어는 불변식의
 * 증명이 아니라 사고 결합을 잡는 장치다.
 *
 * 그 명제는 이 파일이 프로덕션 발급자를 부르게 된 뒤에도 그대로다 — 발급자를 부르는
 * 것은 `test/`이고, 전송 엔트리(`src/transport/index.ts`)는 여전히 그것에 닿지 않는다.
 * `test/entry-boundary.test.ts`의 트립와이어가 이 파일을 «비어 있지 않은 검사»의
 * 대조군으로 쓰는 것도 그대로 성립한다: 여기서 시작한 훑기는 이제 `src/control/token.ts`를
 * 거쳐 `sign`에 닿는다 (`§3.2`가 HMAC을 기각한 것도 같은 이유 — HMAC은 검증하는 쪽에
 * 서명 능력을 함께 넘긴다).
 *
 * 파일 이름에 `.test.`가 없으므로 vitest가 테스트 파일로 수집하지 않는다.
 */

import { generateKeyPairSync } from 'node:crypto'

import { issueWorkspaceToken } from '../src/control/token.js'
import { createVerificationKeySet } from '../src/transport/token.js'

export type Claims = {
  tokenId: string
  workspaceId: string
  audience: string
  issuedAt: string
  expiresAt: string
  scope: string[]
}

export const KEY_ID = 'k-2026-08'
export const NOW = new Date('2026-08-05T12:00:00Z')

export function baseClaims(overrides: Partial<Claims> = {}): Claims {
  return {
    tokenId: 'tok_01HZZ',
    workspaceId: 'ws_01HZZ',
    audience: 'transport',
    issuedAt: '2026-08-05T11:55:00Z',
    expiresAt: '2026-08-05T12:05:00Z',
    scope: ['agent/developer', 'agent/owner'],
    ...overrides,
  }
}

export const issuer = generateKeyPairSync('ed25519')
export const otherIssuer = generateKeyPairSync('ed25519')

export type MintOptions = {
  keyId?: string
  privateKey?: typeof issuer.privateKey
}

/**
 * 서명된 `mnw1` 토큰 하나 — **프로덕션 발급자가 짓는다** (`src/control/token.ts`).
 *
 * 클레임을 그대로 넘기는 얇은 어댑터이고, 형식에 대한 지식은 여기 없다. `keyId`와
 * private key만 바꿔 끼울 수 있는 것은 검증자 테스트가 «다른 키로 서명된 토큰»·
 * «회전으로 빠진 `keyId`»를 만들어야 하기 때문이다 — 둘 다 발급자가 정상적으로
 * 만들 수 있는 토큰이다.
 */
export function mint(claims: Claims, options: MintOptions = {}): string {
  return issueWorkspaceToken({
    signingKey: options.privateKey ?? issuer.privateKey,
    keyId: options.keyId ?? KEY_ID,
    claims,
  })
}

/** `issuer`의 공개키 하나만 주입된 집합. */
export const keys = createVerificationKeySet([[KEY_ID, issuer.publicKey]])
