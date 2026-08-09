/**
 * `0003 §3.2` 와이어 파서 + `§3.3` 검사 1~5.
 *
 * 발급자 흉내는 `./workspace-token.js`로 뺐다 (mori-nest #14가 같은 헬퍼를 쓴다).
 * 그 파일이 `test/`에 있는 이유는 방어선이어서가 아니라 **발급자가 전송 평면이 아니기
 * 때문**이다 — 성질을 지키는 것은 코드 배치가 아니라 키 배포이고, 실제 명제는
 * «전송 엔트리가 서명자에 닿지 않는다»이다 (mori-nest #71 —
 * `./workspace-token.ts` 머리말과 `./entry-boundary.test.ts`가 그 자리다).
 */

import { Buffer } from 'node:buffer'
import { sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  checkLogScope,
  createVerificationKeySet,
  verifyWorkspaceToken,
  type VerifiedWorkspaceToken,
} from '../src/transport/token.js'
import { KEY_ID, NOW, baseClaims, issuer, keys, mint, otherIssuer } from './workspace-token.js'

// ── 위조기 ───────────────────────────────────────────────────────────────────
//
// 아래 두 함수는 **발급자가 만들기를 거부하는 토큰**을 만든다 (빈 스코프·잉여 바이트·
// 다른 `version`). 검증자의 엄격 파싱(`§3.2`)을 시험하려면 그런 바이트열이 필요한데,
// 정의상 프로덕션 발급자(`src/control/token.ts`)로는 만들 수 없다 — 그것을 거부하는
// 것이 발급자의 계약이기 때문이다 (mori-nest #94).
//
// 그래도 **형식을 여기서 다시 구현하지는 않는다.** 위조는 발급자가 지은 정상 토큰에서
// 클레임 블록을 꺼내 필요한 만큼만 손대는 방식이고, 그래서 형식의 정본은 여전히 한
// 곳(`§3.2` 표 → `src/control/token.ts`)뿐이다.

/** 정상 발급된 토큰에서 클레임 블록 바이트를 꺼낸다. */
function claimBlockOf(token: string): Buffer {
  const [, , claimsSegment = ''] = token.split('.')
  return Buffer.from(claimsSegment, 'base64url')
}

/** 임의의 바이트열을 클레임 블록 자리에 넣고 `§3.2`의 서명 메시지로 서명한다. */
function forge(claimBlock: Buffer, options: { version?: string } = {}): string {
  const version = options.version ?? 'mnw1'
  const claimsSegment = claimBlock.toString('base64url')
  const message = Buffer.from(`${version}.${KEY_ID}.${claimsSegment}`, 'latin1')
  return `${version}.${KEY_ID}.${claimsSegment}.${sign(null, message, issuer.privateKey).toString('base64url')}`
}

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
    // 원소가 하나뿐인 블록의 꼬리는 `u16 원소 수(2) + u8 길이(1) + 그 1바이트`다.
    // 꼬리를 잘라내고 원소 수 0을 다시 붙이면 발급자가 만들 수 없는 블록이 된다.
    const single = claimBlockOf(mint(baseClaims({ scope: ['x'] })))
    const emptyScope = Buffer.concat([single.subarray(0, single.length - 4), Buffer.alloc(2)])

    expect(rejectionOf(verifyWorkspaceToken(forge(emptyScope), keys, { now: NOW }))).toBe(
      'unauthenticated',
    )
  })

  // 11 — §3.2 "파싱은 엄격하다". 네 가지가 모두 401이다.
  it('rejects tokens that violate the strict wire format', () => {
    const minted = mint(baseClaims())
    const [, , claimsSegment = '', signature = ''] = minted.split('.')
    const paddedClaims = `${claimsSegment}=` // 패딩 문자는 이 형식에 없다 (§3.2)
    const trailing = forge(Buffer.concat([claimBlockOf(minted), Buffer.from([0x00])]))

    const cases: ReadonlyArray<readonly [string, string]> = [
      ['five segments', `${minted}.extra`],
      ['unknown version', forge(claimBlockOf(minted), { version: 'mnw2' })],
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

// 13 — §3.3 MUST: 회전은 집합 전체 교체다. 그러려면 만들어진 집합이 원본과 끊겨 있어야
// 한다 — `createVerificationKeySet`의 doc이 진술만 하고 테스트가 없던 자리다 (#71).
describe('createVerificationKeySet', () => {
  it('snapshots its entries — mutating the source collection afterwards changes nothing', () => {
    const entries: [string, typeof issuer.publicKey][] = [[KEY_ID, issuer.publicKey]]
    const set = createVerificationKeySet(entries)

    entries.push(['k-late', otherIssuer.publicKey])
    entries.length = 0

    expect(set.size).toBe(1)
    expect(set.get(KEY_ID)).toBe(issuer.publicKey)
    expect(set.get('k-late')).toBeUndefined()

    // 스냅샷이므로 뒤늦게 넣은 키로 서명한 토큰도 이 집합에서는 통과하지 못한다.
    const late = mint(baseClaims(), { keyId: 'k-late', privateKey: otherIssuer.privateKey })
    expect(rejectionOf(verifyWorkspaceToken(late, set, { now: NOW }))).toBe('unauthenticated')
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
