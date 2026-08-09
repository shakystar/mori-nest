/**
 * 런처 자격증명 — 발급·해시 저장·조회 판정·즉시 폐기 (mori-nest #68 조각 5/5 · #74).
 *
 * 이슈 본문이 못박은 신규 6건 + 후속 코멘트가 더한 난수원 길이 계약 1건, 합쳐서 **일곱
 * 건**이고, 그 이상 만들지 않는다. HTTP 상태코드·발급 라우트·회전 라우트는 여기서 다루지
 * 않는다 — 라우트가 아직 없다(비범위).
 */

import { describe, expect, it } from 'vitest'

import { LauncherCredentialError, openLauncherCredentialStore } from '../src/control/credential.js'
import type { RandomBytesFn } from '../src/control/store.js'
import { verifyTransportRequest } from '../src/transport/request.js'
import { baseClaims, keys, mint } from './workspace-token.js'

describe('LauncherCredentialStore.issue + verify', () => {
  it('발급된 값으로 검증하면 그 주체가 나온다', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    const { token } = await store.issue('operator-a')

    const result = await store.verify(token)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.subject).toBe('operator-a')
  })

  it('저장 표현(해시)으로는 원문을 되찾을 수 없다 — 해시 자체를 제시해도 검증이 통과하지 않는다', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    const { credentialId, token } = await store.issue('operator-b')

    expect(credentialId).not.toBe(token)

    // 저장된 것(해시)을 그대로 Authorization 값으로 제시해도, verify는 그것을 다시 해시해
    // 대조하므로 원문 없이는 통과하지 않는다.
    const usingStoredRepresentation = await store.verify(credentialId)
    expect(usingStoredRepresentation.ok).toBe(false)
  })

  it('폐기 직후 검증이 실패한다 — 즉시성', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    const { credentialId, token } = await store.issue('operator-c')
    expect((await store.verify(token)).ok).toBe(true)

    await store.revoke(credentialId)

    expect((await store.verify(token)).ok).toBe(false)
  })
})

describe('0003 §1.1 — 두 자격은 서로의 평면에서 통과하지 못한다', () => {
  it('작업공간 토큰 문자열을 제어 평면 판정에 넣으면 통과하지 못한다', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    await store.issue('operator-d')

    const workspaceToken = mint(baseClaims())
    const result = await store.verify(workspaceToken)

    expect(result.ok).toBe(false)
  })

  it('런처 자격증명으로 전송 평면 판정(verifyTransportRequest)을 통과하지 못한다 — 401', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    const { token } = await store.issue('operator-e')

    const result = verifyTransportRequest(
      {
        method: 'GET',
        url: '/v1/logs/some-log-id/events',
        headers: { authorization: `Bearer ${token}` },
      },
      keys,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(401)
  })
})

describe('실패 응답 봉투', () => {
  it('자격증명 값·해시가 실리지 않는다', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    const { credentialId, token } = await store.issue('operator-f')
    await store.revoke(credentialId)

    const unknownToken = 'this-value-was-never-issued'
    const bodies = [await store.verify(unknownToken), await store.verify(token)].map((result) =>
      JSON.stringify(result.ok ? result.subject : result.error),
    )

    expect(bodies).toHaveLength(2)
    for (const body of bodies) {
      expect(body).not.toContain(unknownToken)
      expect(body).not.toContain(token)
      expect(body).not.toContain(credentialId)
    }
  })
})

describe('발급 — 난수원의 길이 계약', () => {
  it('주입된 난수원이 요청한 바이트 수보다 짧은 버퍼를 돌려주면 발급이 실패한다', async () => {
    const shortRandomBytes: RandomBytesFn = () => Buffer.from('too-short', 'utf8')
    const store = await openLauncherCredentialStore(':memory:', { randomBytes: shortRandomBytes })

    await expect(store.issue('operator-g')).rejects.toThrow(LauncherCredentialError)
  })
})
