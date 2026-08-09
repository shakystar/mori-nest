/**
 * `0003 §3.2` 발급자 — 와이어 형식 + Ed25519 서명 (mori-nest #94).
 *
 * 이 파일이 시험하는 명제는 «내가 만든 토큰을 내가 읽을 수 있다»가 아니라
 * **«내가 만든 토큰을 이미 있는 검증자가 읽는다»**이다 (`§3.2`: *"발급자와 전송 평면이
 * 같은 바이트를 같게 읽어야 하므로 형식이 계약이다"*). 그래서 아래 1~3번은 발급자의
 * 출력을 `src/transport/token.ts`의 `verifyWorkspaceToken`에 그대로 먹인다 — 검증자
 * 쪽 동작을 다시 확인하는 것이 아니라, **두 구현이 같은 바이트를 같게 읽는지**를
 * 검증자를 계측기로 삼아 보는 것이다.
 *
 * 검증자 자신의 동작(엄격 파싱·검사 2~5)은 `./token.test.ts`가 덮는다. 여기서 그것을
 * 반복하지 않는다.
 */

import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'

import {
  WorkspaceTokenIssueError,
  issueWorkspaceToken,
  type WorkspaceTokenClaims,
  type WorkspaceTokenIssueFailure,
} from '../src/control/token.js'
import { createVerificationKeySet, verifyWorkspaceToken } from '../src/transport/token.js'
import { KEY_ID, NOW, baseClaims, issuer, keys } from './workspace-token.js'

/** 발급이 **실패**했음을 단언하고 그 이유를 꺼낸다. 토큰이 나오면 그 자리에서 깨진다. */
function issueFailureOf(run: () => string): WorkspaceTokenIssueError {
  let issued: string
  try {
    issued = run()
  } catch (error) {
    if (error instanceof WorkspaceTokenIssueError) {
      return error
    }
    throw error
  }
  // 잘린 토큰이 나오는 것이 이 자리의 실패 모드다 (`§3.2` MUST NOT) — 그래서 «던지지
  // 않았다»를 통과로 두지 않고, 무엇이 나왔는지는 싣지 않은 채 깨뜨린다 (`§3.8`).
  throw new Error(`expected issuing to fail, but it returned a token of ${issued.length} chars`)
}

function expectFailure(run: () => string, reason: WorkspaceTokenIssueFailure): WorkspaceTokenIssueError {
  const error = issueFailureOf(run)
  expect(error.reason).toBe(reason)
  return error
}

/**
 * 거부가 **어느 검사**에서 났는지까지 꺼낸다.
 *
 * 「서명이 그 바이트를 덮는다」를 `ok === false`로만 단언하면 다른 검사가 대신
 * 떨어뜨려도 초록이 된다 — `audience` 바이트를 뒤집은 토큰은 서명이 그 바이트를 전혀
 * 덮지 않아도 `§3.3` 검사 2에서 떨어지므로, 그 초록은 아무것도 증명하지 않는다.
 */
function failedCheckOf(result: ReturnType<typeof verifyWorkspaceToken>): unknown {
  if (result.ok) {
    throw new Error('expected the token to be rejected, but it verified')
  }
  return result.error.error.details?.['failedCheck']
}

/** 클레임 세그먼트 안의 `needle` 첫 바이트를 뒤집는다. ASCII 안에서 움직이므로 길이는 그대로다. */
function flipByteInClaims(token: string, needle: string): string {
  const [version = '', keyId = '', claimsSegment = '', signature = ''] = token.split('.')
  const block = Buffer.from(claimsSegment, 'base64url')
  const at = block.indexOf(needle, 0, 'latin1')
  expect(at, `claim block should contain ${needle}`).toBeGreaterThanOrEqual(0)
  block[at] = (block[at] ?? 0) ^ 0x01
  return `${version}.${keyId}.${block.toString('base64url')}.${signature}`
}

const claims: WorkspaceTokenClaims = baseClaims()

function issue(overrides: Partial<WorkspaceTokenClaims> = {}, keyId: string = KEY_ID): string {
  return issueWorkspaceToken({
    signingKey: issuer.privateKey,
    keyId,
    claims: { ...claims, ...overrides },
  })
}

describe('issueWorkspaceToken', () => {
  // 1 — 이 이슈의 핵심 완료 조건. 「형식이 계약이다」의 직접 증명이고, 이것이 초록이면
  //     클레임 7개(블록의 6 + 세그먼트의 `keyId`)가 왕복에서 하나도 변형되지 않았다는 뜻이다.
  it('round-trips through verifyWorkspaceToken with all seven claims intact', () => {
    const result = verifyWorkspaceToken(issue(), keys, { now: NOW })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.token.keyId).toBe(KEY_ID)
    expect(result.token.claims).toEqual({
      tokenId: claims.tokenId,
      workspaceId: claims.workspaceId,
      audience: claims.audience,
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
      scope: claims.scope,
    })
  })

  // 2 — `§3.2` 성질 2: 서명 메시지가 `mnw1.<keyId>.<claims>`이므로 `keyId` 세그먼트가
  //     서명에 덮인다. 그 세그먼트를 한 글자 바꾼 토큰은 **같은 키로도** 검증되지 않는다.
  it('covers the keyId segment with the signature', () => {
    const [version = '', keyId = '', claimsSegment = '', signature = ''] = issue().split('.')
    expect(keyId).toBe(KEY_ID)

    const tamperedKeyId = `${keyId.slice(0, -1)}x`
    const tampered = `${version}.${tamperedKeyId}.${claimsSegment}.${signature}`

    // 변조된 `keyId`도 **같은 공개키로 주입해 둔다** — 그러지 않으면 "알려지지 않은
    // 키"에서 떨어지고, 서명이 그 세그먼트를 덮는다는 증거가 되지 못한다.
    const keysWithBoth = createVerificationKeySet([
      [KEY_ID, issuer.publicKey],
      [tamperedKeyId, issuer.publicKey],
    ])

    expect(failedCheckOf(verifyWorkspaceToken(tampered, keysWithBoth, { now: NOW }))).toBe(
      'signature',
    )
  })

  // 3 — 같은 성질의 나머지 절반: 클레임 블록도 전부 서명에 덮인다. 변조 경로가 되기
  //     쉬운 두 바이트열(`scope`·`audience`)을 각각 건드려 본다.
  it('covers the claim block with the signature', () => {
    const token = issue()

    for (const needle of ['agent/developer', 'transport']) {
      const tampered = flipByteInClaims(token, needle)
      // 검사 이름까지 본다 — `audience`는 검사 2로도 떨어지므로 `ok === false`만으로는
      // 서명이 그 바이트를 덮는다는 증거가 되지 않는다.
      expect(failedCheckOf(verifyWorkspaceToken(tampered, keys, { now: NOW })), needle).toBe(
        'signature',
      )
    }
  })

  // 4 — `§3.6`: 스코프가 빈 토큰을 만들 수 있는 경로가 없다. 검증자는 원소 수 0을 형식
  //     위반으로 떨어뜨리므로, 발급이 성공하면 «검증을 통과할 수 없는 토큰»이 나간다.
  it('refuses to issue a token with an empty scope', () => {
    const error = expectFailure(() => issue({ scope: [] }), 'empty_scope')

    expect(error.message).not.toContain(claims.tokenId)
  })

  // 5 — `§3.2` MUST NOT: 인코딩 한계를 넘는 값을 조용히 잘라 싣지 않는다. 잘라 실으면
  //     `§3.6`의 "발급된 토큰의 scope는 요청한 logs와 같다"가 인코딩 층에서 깨진다.
  it('fails instead of truncating values that the encoding cannot carry', () => {
    const tooLongForU8 = 'a'.repeat(256)

    expectFailure(() => issue({ workspaceId: tooLongForU8 }), 'claim_too_long')
    const scopeError = expectFailure(() => issue({ scope: [tooLongForU8] }), 'claim_too_long')
    expectFailure(
      () => issue({ scope: Array.from({ length: 65_536 }, (_unused, index) => `log-${index}`) }),
      'scope_too_many_elements',
    )

    // `§3.8`: 실패 메시지에 실리는 것은 클레임의 **이름**까지다.
    expect(scopeError.message).toContain('scope[0]')
    expect(scopeError.message).not.toContain(tooLongForU8)
  })

  // 6 — `§3.2` MUST NOT: 초 미만 정밀도와 `Z` 이외의 오프셋은 이 형식에 없다. 조용히
  //     반올림하거나 잘라 싣는 순간 같은 시각의 표현이 둘이 된다.
  it('refuses timestamps that are not the fixed 20-byte UTC form', () => {
    expectFailure(() => issue({ issuedAt: '2026-08-05T11:55:00.123Z' }), 'timestamp_not_canonical')
    expectFailure(() => issue({ expiresAt: '2026-08-05T21:05:00+09:00' }), 'timestamp_not_canonical')
  })
})
