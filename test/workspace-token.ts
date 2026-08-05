/**
 * 테스트 헬퍼: `0003 §3.2`의 발급자 흉내.
 *
 * 유효 키쌍 생성과 서명은 **`test/` 안에만 있다.** `src/`는 검증만 하고 서명 능력을 갖지
 * 않는다 (`§3.2` — HMAC을 기각한 이유가 그것이다). 이 파일이 `src/`로 새어 나가면 그
 * 성질이 깨진다 (mori-nest #11의 완료 조건).
 *
 * 파일 이름에 `.test.`가 없으므로 vitest가 테스트 파일로 수집하지 않는다.
 */

import { generateKeyPairSync, sign } from 'node:crypto'
import { Buffer } from 'node:buffer'

import { createVerificationKeySet } from '../src/token.js'

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
