/**
 * `0003 §3.2` 와이어 파서 + `§3.3` 검사 1~5.
 *
 * 유효 키쌍 생성과 서명은 **여기에만 있다.** `src/`는 검증만 하고 서명 능력을 갖지
 * 않는다 (`§3.2` — HMAC을 기각한 이유가 그것이다). 아래 헬퍼가 `src/`로 새어 나가면
 * 그 성질이 깨진다.
 */

import { generateKeyPairSync, sign } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'

import {
  checkLogScope,
  createVerificationKeySet,
  verifyWorkspaceToken,
  type VerifiedWorkspaceToken,
} from '../src/token.js'

// ── 테스트 헬퍼: 발급자 흉내 ─────────────────────────────────────────────────

type Claims = {
  tokenId: string
  workspaceId: string
  audience: string
  issuedAt: string
  expiresAt: string
  scope: string[]
}

const KEY_ID = 'k-2026-08'
const NOW = new Date('2026-08-05T12:00:00Z')

function baseClaims(overrides: Partial<Claims> = {}): Claims {
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
function encodeClaimBlock(claims: Claims): Buffer {
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

const issuer = generateKeyPairSync('ed25519')
const otherIssuer = generateKeyPairSync('ed25519')

type MintOptions = {
  keyId?: string
  privateKey?: typeof issuer.privateKey
  claimBlock?: Buffer
  version?: string
}

/** 서명된 `mnw1` 토큰 하나. 서명 메시지는 `mnw1.<keyId>.<claims>` (`§3.2`). */
function mint(claims: Claims, options: MintOptions = {}): string {
  const version = options.version ?? 'mnw1'
  const keyId = options.keyId ?? KEY_ID
  const claimBlock = options.claimBlock ?? encodeClaimBlock(claims)
  const claimsSegment = claimBlock.toString('base64url')
  const message = Buffer.from(`${version}.${keyId}.${claimsSegment}`, 'latin1')
  const signature = sign(null, message, options.privateKey ?? issuer.privateKey)
  return `${version}.${keyId}.${claimsSegment}.${signature.toString('base64url')}`
}

const keys = createVerificationKeySet([[KEY_ID, issuer.publicKey]])

/** 실패 응답에서 code를 꺼낸다 — 통과했으면 테스트가 그 자리에서 깨져야 한다. */
function rejectionOf(result: ReturnType<typeof verifyWorkspaceToken>): string {
  if (result.ok) {
    throw new Error('expected the token to be rejected, but it verified')
  }
  return result.error.error.code
}

function verifiedOrThrow(result: ReturnType<typeof verifyWorkspaceToken>): VerifiedWorkspaceToken {
  if (!result.ok) {
    throw new Error(`expected the token to verify, but it was rejected: ${result.error.error.code}`)
  }
  return result.token
}

// ── §3.3 검사 1~5 ────────────────────────────────────────────────────────────

describe('verifyWorkspaceToken', () => {
  // 1 — 대조군. 이게 없으면 "항상 거부"가 아래 전부를 통과시킨다.
  it('verifies a well-formed token signed by an injected key', () => {
    const token = verifiedOrThrow(verifyWorkspaceToken(mint(baseClaims()), keys, { now: NOW }))

    expect(token.keyId).toBe(KEY_ID)
    expect(token.claims.workspaceId).toBe('ws_01HZZ')
    expect(token.claims.scope).toEqual(['agent/developer', 'agent/owner'])
    expect(checkLogScope(token, 'agent/developer')).toEqual({ ok: true })
  })

  // 2 — 검사 1: 클레임이 변조되면 서명이 덮은 바이트가 달라진다.
  it('rejects a token whose claims segment was altered by one byte', () => {
    const [version = '', keyId = '', claimsSegment = '', signature = ''] = mint(baseClaims()).split('.')
    const block = Buffer.from(claimsSegment, 'base64url')
    block.writeUInt8(block.readUInt8(block.length - 1) ^ 0x01, block.length - 1)
    const tampered = `${version}.${keyId}.${block.toString('base64url')}.${signature}`

    expect(rejectionOf(verifyWorkspaceToken(tampered, keys, { now: NOW }))).toBe('unauthenticated')
  })

  // 3 — 검사 1: `keyId` 세그먼트도 서명 메시지에 포함된다 (§3.2 "keyId 딜레마").
  it('rejects a token whose keyId segment was altered', () => {
    const minted = mint(baseClaims())
    const [, , claimsSegment = '', signature = ''] = minted.split('.')
    const tampered = `mnw1.${KEY_ID}x.${claimsSegment}.${signature}`
    const keysWithBoth = createVerificationKeySet([
      [KEY_ID, issuer.publicKey],
      [`${KEY_ID}x`, issuer.publicKey],
    ])

    expect(rejectionOf(verifyWorkspaceToken(tampered, keysWithBoth, { now: NOW }))).toBe('unauthenticated')
  })

  // 4 — §3.2 MUST: 알려지지 않은 `keyId`는 그 자리에서 401. 다른 키로 재시도하지 않는다.
  it('rejects an unknown keyId without trying the other injected keys', () => {
    const token = mint(baseClaims(), { keyId: 'k-rotated-out' })
    const keysWithAnotherValidKey = createVerificationKeySet([
      [KEY_ID, issuer.publicKey],
      ['k-other', otherIssuer.publicKey],
    ])

    expect(rejectionOf(verifyWorkspaceToken(token, keysWithAnotherValidKey, { now: NOW }))).toBe(
      'unauthenticated',
    )
  })

  // 5 — §3.3 MUST: 키 집합이 비면 모든 요청이 401이다 ("검증할 키가 없으니 통과" 금지).
  it('rejects every token when the injected key set is empty', () => {
    const empty = createVerificationKeySet([])

    expect(empty.size).toBe(0)
    expect(rejectionOf(verifyWorkspaceToken(mint(baseClaims()), empty, { now: NOW }))).toBe(
      'unauthenticated',
    )
  })

  // 6 — 검사 2.
  it('rejects a token whose audience is not "transport"', () => {
    const token = mint(baseClaims({ audience: 'control' }))

    expect(rejectionOf(verifyWorkspaceToken(token, keys, { now: NOW }))).toBe('unauthenticated')
  })

  // 7 — 검사 3: 스큐 밖으로 지난 만료.
  it('rejects a token that expired beyond the clock skew allowance', () => {
    const token = mint(baseClaims({ expiresAt: '2026-08-05T11:58:59Z' })) // NOW - 61초

    expect(rejectionOf(verifyWorkspaceToken(token, keys, { now: NOW }))).toBe('unauthenticated')
  })

  // 8 — 검사 3의 짝: 스큐 안이면 통과한다 (7과 함께 60초가 상한임을 못박는다).
  it('accepts a token that expired within the clock skew allowance', () => {
    const token = mint(baseClaims({ expiresAt: '2026-08-05T11:59:01Z' })) // NOW - 59초

    expect(verifyWorkspaceToken(token, keys, { now: NOW }).ok).toBe(true)
  })

  // 9 — §3.2: 원소 수 0은 이 형식에 존재하지 않으므로 파싱에서 떨어진다.
  it('rejects a claim block whose scope element count is zero', () => {
    const token = mint(baseClaims(), { claimBlock: encodeClaimBlock(baseClaims({ scope: [] })) })

    expect(rejectionOf(verifyWorkspaceToken(token, keys, { now: NOW }))).toBe('unauthenticated')
  })

  // 11 — §3.2 "파싱은 엄격하다". 네 가지가 모두 401이다.
  it('rejects tokens that violate the strict wire format', () => {
    const minted = mint(baseClaims())
    const [, , claimsSegment = '', signature = ''] = minted.split('.')
    const paddedClaims = `${claimsSegment}=` // 패딩 문자는 이 형식에 없다 (§3.2)
    const trailing = mint(baseClaims(), {
      claimBlock: Buffer.concat([encodeClaimBlock(baseClaims()), Buffer.from([0x00])]),
    })

    const cases: ReadonlyArray<readonly [string, string]> = [
      ['five segments', `${minted}.extra`],
      ['unknown version', mint(baseClaims(), { version: 'mnw2' })],
      ['base64url padding', `mnw1.${KEY_ID}.${paddedClaims}.${signature}`],
      ['trailing bytes after the claim block', trailing],
    ]

    for (const [label, token] of cases) {
      expect(rejectionOf(verifyWorkspaceToken(token, keys, { now: NOW })), label).toBe(
        'unauthenticated',
      )
    }
  })
})

// 10 — 검사 5: 스코프 밖은 403이고, 4번(401)과 뒤집히지 않는다.
describe('checkLogScope', () => {
  it('rejects a logId outside the token scope with out_of_scope', () => {
    const token = verifiedOrThrow(verifyWorkspaceToken(mint(baseClaims()), keys, { now: NOW }))

    const result = checkLogScope(token, 'agent/secretary')

    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error.error.code).toBe('out_of_scope')
  })
})

// 12 — 0002 §1.2 · 0003 §3.8: 토큰 값이 응답 본문 어디에도 실리지 않는다.
describe('rejection envelopes', () => {
  it('never carries the token, its claims segment, or the tokenId', () => {
    const tokenId = 'tok_leak_canary'
    const claims = baseClaims({ tokenId })
    const minted = mint(claims)
    const [, , claimsSegment = ''] = minted.split('.')

    const bodies = [
      verifyWorkspaceToken(minted, createVerificationKeySet([]), { now: NOW }),
      verifyWorkspaceToken(mint(baseClaims({ tokenId, audience: 'control' })), keys, { now: NOW }),
      verifyWorkspaceToken(mint(baseClaims({ tokenId, expiresAt: '2026-08-05T11:58:59Z' })), keys, {
        now: NOW,
      }),
      verifyWorkspaceToken(`${minted}.extra`, keys, { now: NOW }),
    ].map((result) => JSON.stringify(result.ok ? result.token : result.error))

    expect(bodies).toHaveLength(4)
    for (const body of bodies) {
      expect(body).not.toContain(minted)
      expect(body).not.toContain(claimsSegment)
      expect(body).not.toContain(tokenId)
    }
  })
})
