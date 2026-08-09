/**
 * 제어 평면 요청 판정 (`verifyControlRequest`, mori-nest #83·#93·#102 — #68 라우트 조각 1/2).
 *
 * #83 이슈 본문이 못박은 아홉 건 + #93 이슈 본문이 못박은 두 건(`§2.6` revoke 판정) + #102
 * 이슈 본문이 못박은 네 건(`§4.2` openWorkspace 판정)이고, 그 이상 만들지 않는다. HTTP
 * 서버·라우트 실행(스토어를 실제로 부르는 배선)은 라우트 조각 2/2다 — 여기서는 다루지 않는다.
 */

import { describe, expect, it } from 'vitest'

import { openLauncherCredentialStore } from '../src/control/credential.js'
import { verifyControlRequest, type RawRequest } from '../src/control/request.js'
import { baseClaims, mint } from './workspace-token.js'

function post(token: string, headers: Readonly<Record<string, string>> = {}): RawRequest {
  return {
    method: 'POST',
    url: '/v1/logs',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'key-1', ...headers },
  }
}

describe('verifyControlRequest — POST /v1/logs', () => {
  it('① 유효 자격증명 + 빈 본문 + 유효 키 → 성공 판정, 주체가 발급 시 준 주체와 같다', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    const { token } = await store.issue('subject-a')

    const result = await verifyControlRequest(post(token), '{}', store)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.route).toBe('createLog')
    if (result.request.route !== 'createLog') return
    expect(result.request.subject).toBe('subject-a')
    expect(result.request.idempotencyKey).toBe('key-1')
    expect(result.request.requestBody).toBe('{}')
  })

  it('② 작업공간 토큰 문자열을 Bearer로 제시하면 판정 함수 경유로도 401이다 (§1.1)', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    await store.issue('subject-b')
    const workspaceToken = mint(baseClaims())

    const result = await verifyControlRequest(post(workspaceToken), '{}', store)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(401)
    expect(result.error.error.code).toBe('unauthenticated')
  })

  it('③ 폐기된 자격증명 → 401', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    const { credentialId, token } = await store.issue('subject-c')
    await store.revoke(credentialId)

    const result = await verifyControlRequest(post(token), '{}', store)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(401)
  })

  it('④ {"logId":"x","zzz":1} → 400 client_minted_id — malformed_request보다 우선한다 (§2.2)', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    const { token } = await store.issue('subject-d')

    const result = await verifyControlRequest(post(token), JSON.stringify({ logId: 'x', zzz: 1 }), store)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.error.error.code).toBe('client_minted_id')
  })

  it('⑤ 정의되지 않은 최상위 필드만 있으면 → 400 malformed_request', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    const { token } = await store.issue('subject-e')

    const result = await verifyControlRequest(post(token), JSON.stringify({ zzz: 1 }), store)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.error.error.code).toBe('malformed_request')
  })

  it('⑥ Idempotency-Key가 없으면 → 400 missing_idempotency_key', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    const { token } = await store.issue('subject-f')

    const result = await verifyControlRequest(
      { method: 'POST', url: '/v1/logs', headers: { authorization: `Bearer ${token}` } },
      '{}',
      store,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.error.error.code).toBe('missing_idempotency_key')
  })
})

describe('verifyControlRequest — GET /v1/logs', () => {
  it('⑦ after를 해석할 수 없으면 → 400 invalid_cursor (§2.4)', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    const { token } = await store.issue('subject-g')

    const result = await verifyControlRequest(
      { method: 'GET', url: '/v1/logs?after=not@valid', headers: { authorization: `Bearer ${token}` } },
      '',
      store,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.error.error.code).toBe('invalid_cursor')
  })

  it('⑧ DELETE /v1/logs → 405 method_not_allowed (§0)', async () => {
    const store = await openLauncherCredentialStore(':memory:')

    const result = await verifyControlRequest({ method: 'DELETE', url: '/v1/logs', headers: {} }, '', store)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(405)
    expect(result.error.error.code).toBe('method_not_allowed')
  })
})

describe('verifyControlRequest — POST /v1/logs/{logId}/revoke', () => {
  function revokeReq(token: string, logId: string): RawRequest {
    return { method: 'POST', url: `/v1/logs/${logId}/revoke`, headers: { authorization: `Bearer ${token}` } }
  }

  it('⑩ 유효 자격증명 + reason 문자열 → revokeLog 판정, reason이 실린다 (§2.6)', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    const { token } = await store.issue('subject-i')

    const result = await verifyControlRequest(revokeReq(token, 'log-1'), JSON.stringify({ reason: 'stale' }), store)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.route).toBe('revokeLog')
    if (result.request.route !== 'revokeLog') return
    expect(result.request.subject).toBe('subject-i')
    expect(result.request.logId).toBe('log-1')
    expect(result.request.reason).toBe('stale')
  })

  it('⑪ reason이 문자열이 아니면 → 400 malformed_request (§2.6)', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    const { token } = await store.issue('subject-j')

    const result = await verifyControlRequest(revokeReq(token, 'log-1'), JSON.stringify({ reason: 123 }), store)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.error.error.code).toBe('malformed_request')
  })
})

describe('verifyControlRequest — POST /v1/workspaces', () => {
  function openReq(token: string, headers: Readonly<Record<string, string>> = {}): RawRequest {
    return {
      method: 'POST',
      url: '/v1/workspaces',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'key-1', ...headers },
    }
  }

  it('⑫ 유효 자격증명 + { logs: ["log-a"] } + Idempotency-Key → openWorkspace 판정, logs·idempotencyKey가 실리고 replicaId를 안 보냈으면 그 필드가 없다 (§4.2)', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    const { token } = await store.issue('subject-k')

    const result = await verifyControlRequest(openReq(token), JSON.stringify({ logs: ['log-a'] }), store)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.route).toBe('openWorkspace')
    if (result.request.route !== 'openWorkspace') return
    expect(result.request.subject).toBe('subject-k')
    expect(result.request.logs).toEqual(['log-a'])
    expect(result.request.idempotencyKey).toBe('key-1')
    expect('replicaId' in result.request).toBe(false)
  })

  it('⑬ logs가 빈 배열이면 → 400 empty_scope, logs 원소가 LOG_ID_PATTERN 위반이면 → 400 invalid_log_id (§4.2)', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    const { token } = await store.issue('subject-l')

    const emptyResult = await verifyControlRequest(openReq(token), JSON.stringify({ logs: [] }), store)
    expect(emptyResult.ok).toBe(false)
    if (emptyResult.ok) return
    expect(emptyResult.status).toBe(400)
    expect(emptyResult.error.error.code).toBe('empty_scope')

    const invalidResult = await verifyControlRequest(openReq(token), JSON.stringify({ logs: ['not valid'] }), store)
    expect(invalidResult.ok).toBe(false)
    if (invalidResult.ok) return
    expect(invalidResult.status).toBe(400)
    expect(invalidResult.error.error.code).toBe('invalid_log_id')
  })

  it('⑭ Idempotency-Key가 없으면 → 400 missing_idempotency_key (§4.2)', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    const { token } = await store.issue('subject-m')

    const result = await verifyControlRequest(
      { method: 'POST', url: '/v1/workspaces', headers: { authorization: `Bearer ${token}` } },
      JSON.stringify({ logs: ['log-a'] }),
      store,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.error.error.code).toBe('missing_idempotency_key')
  })

  it('⑮ POST 아닌 메서드 → 405, Allow: POST (§4.2)', async () => {
    const store = await openLauncherCredentialStore(':memory:')

    const result = await verifyControlRequest({ method: 'GET', url: '/v1/workspaces', headers: {} }, '', store)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(405)
    expect(result.error.error.code).toBe('method_not_allowed')
    expect(result.headers['Allow']).toBe('POST')
  })
})

describe('실패 판정 봉투', () => {
  it('⑨ 자격증명 값·해시가 실리지 않는다', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    const { credentialId, token } = await store.issue('subject-h')
    await store.revoke(credentialId)

    const unknownToken = 'this-value-was-never-issued'
    const results = await Promise.all(
      [unknownToken, token].map((presented) =>
        verifyControlRequest(
          { method: 'GET', url: '/v1/logs', headers: { authorization: `Bearer ${presented}` } },
          '',
          store,
        ),
      ),
    )

    for (const result of results) {
      expect(result.ok).toBe(false)
      if (result.ok) continue
      const body = JSON.stringify(result.error)
      expect(body).not.toContain(unknownToken)
      expect(body).not.toContain(token)
      expect(body).not.toContain(credentialId)
    }
  })
})
