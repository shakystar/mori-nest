/**
 * 테스트 헬퍼: `0003 §3.2`의 발급자 흉내.
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
 *
 * 실제 명제는 **«전송 엔트리가 서명자에 닿지 않는다»**이다 — 모듈 명제처럼 보이지만
 * **엔트리 명제**다. private key가 나타나는 설정 스키마는 `src/control/index.ts` 하나이고
 * (`parseControlConfig`), 전송 설정 스키마(`src/transport/index.ts`의
 * `parseTransportConfig`)에는 그 자리가 아예 없으며 private `KeyObject`가 섞인 키 목록을
 * 거부한다. `test/entry-boundary.test.ts`가 그 둘을 검사하고, 같은 파일의 **트립와이어**가
 * 전송 엔트리의 import 그래프에 서명 심볼이 없음을 함께 본다 — 트립와이어는 불변식의
 * 증명이 아니라 사고 결합을 잡는 장치다.
 *
 * 그러므로 이 파일이 `test/` 안에 있는 이유는 방어선이어서가 아니라, **발급자는 이
 * 리포의 전송 평면 코드가 아니기 때문**이다 (`§3.2`가 HMAC을 기각한 것도 같은 이유 —
 * HMAC은 검증하는 쪽에 서명 능력을 함께 넘긴다).
 *
 * 파일 이름에 `.test.`가 없으므로 vitest가 테스트 파일로 수집하지 않는다.
 */

import { generateKeyPairSync, sign } from 'node:crypto'
import { Buffer } from 'node:buffer'

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

/** `0003 §3.2`의 클레임 블록 — 표의 순서 그대로, 이름 없이, 정수는 빅엔디언. */
export function encodeClaimBlock(claims: Claims): Buffer {
  const lengthPrefixed = (value: string): Buffer => {
    const bytes = Buffer.from(value, 'latin1')
    return Buffer.concat([Buffer.from([bytes.length]), bytes])
  }
  const scopeCount = Buffer.alloc(2)
  scopeCount.writeUInt16BE(claims.scope.length, 0)
  return Buffer.concat([
    lengthPrefixed(claims.tokenId),
    lengthPrefixed(claims.workspaceId),
    lengthPrefixed(claims.audience),
    Buffer.from(claims.issuedAt, 'latin1'),
    Buffer.from(claims.expiresAt, 'latin1'),
    scopeCount,
    ...claims.scope.map(lengthPrefixed),
  ])
}

export const issuer = generateKeyPairSync('ed25519')
export const otherIssuer = generateKeyPairSync('ed25519')

export type MintOptions = {
  keyId?: string
  privateKey?: typeof issuer.privateKey
  claimBlock?: Buffer
  version?: string
}

/** 서명된 `mnw1` 토큰 하나. 서명 메시지는 `mnw1.<keyId>.<claims>` (`§3.2`). */
export function mint(claims: Claims, options: MintOptions = {}): string {
  const version = options.version ?? 'mnw1'
  const keyId = options.keyId ?? KEY_ID
  const claimBlock = options.claimBlock ?? encodeClaimBlock(claims)
  const claimsSegment = claimBlock.toString('base64url')
  const message = Buffer.from(`${version}.${keyId}.${claimsSegment}`, 'latin1')
  const signature = sign(null, message, options.privateKey ?? issuer.privateKey)
  return `${version}.${keyId}.${claimsSegment}.${signature.toString('base64url')}`
}

/** `issuer`의 공개키 하나만 주입된 집합. */
export const keys = createVerificationKeySet([[KEY_ID, issuer.publicKey]])
