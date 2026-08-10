/**
 * 제어 평면 요청 판정 (`verifyControlRequest`, mori-nest #83·#93·#102·#112 — #68 라우트 조각 1/2).
 *
 * #83 이슈 본문이 못박은 아홉 건 + #93 이슈 본문이 못박은 두 건(`§2.6` revoke 판정) + #102
 * 이슈 본문이 못박은 네 건(`§4.2` openWorkspace 판정) + #112 이슈 본문이 못박은 세 건
 * (`§4.3`~`§4.5` 작업공간 전이 판정)이고, 그 이상 만들지 않는다. HTTP
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

  it('⑲ 정의되지 않은 파라미터·형식 오류 limit·반복 limit → 400 malformed_request, after 반복은 여전히 400 invalid_cursor (§1.3, §2.4, GET /v1/workspaces와 통일, mori-nest #123)', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    const { token } = await store.issue('subject-g')
    const get = async (url: string) =>
      verifyControlRequest({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } }, '', store)

    const unrecognized = await get('/v1/logs?foo=bar')
    expect(unrecognized.ok).toBe(false)
    if (!unrecognized.ok) expect(unrecognized.error.error.code).toBe('malformed_request')

    const malformedLimit = await get('/v1/logs?limit=abc')
    expect(malformedLimit.ok).toBe(false)
    if (!malformedLimit.ok) expect(malformedLimit.error.error.code).toBe('malformed_request')

    const repeatedLimit = await get('/v1/logs?limit=1&limit=2')
    expect(repeatedLimit.ok).toBe(false)
    if (!repeatedLimit.ok) expect(repeatedLimit.error.error.code).toBe('malformed_request')

    const repeatedAfter = await get('/v1/logs?after=a&after=b')
    expect(repeatedAfter.ok).toBe(false)
    if (!repeatedAfter.ok) expect(repeatedAfter.error.error.code).toBe('invalid_cursor')
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

  it('⑮ POST·GET 밖의 메서드 → 405, Allow: POST, GET (§4.2·§4.6 — 컬렉션 경로는 개시와 목록 조회를 겸한다)', async () => {
    const store = await openLauncherCredentialStore(':memory:')

    const result = await verifyControlRequest({ method: 'DELETE', url: '/v1/workspaces', headers: {} }, '', store)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(405)
    expect(result.error.error.code).toBe('method_not_allowed')
    expect(result.headers['Allow']).toBe('POST, GET')
  })
})

describe('verifyControlRequest — POST /v1/workspaces/{workspaceId}/heartbeat|close|revoke (§4.3~§4.5)', () => {
  function subReq(token: string, workspaceId: string, action: string): RawRequest {
    return { method: 'POST', url: `/v1/workspaces/${workspaceId}/${action}`, headers: { authorization: `Bearer ${token}` } }
  }

  it('⑯ 세 경로가 각각 자기 route로 판별되고 workspaceId가 뽑힌다 (§4.3~§4.5)', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    const { token } = await store.issue('subject-n')

    const heartbeat = await verifyControlRequest(subReq(token, 'ws-1', 'heartbeat'), '{}', store)
    expect(heartbeat.ok).toBe(true)
    if (!heartbeat.ok) return
    expect(heartbeat.request.route).toBe('heartbeatWorkspace')
    if (heartbeat.request.route !== 'heartbeatWorkspace') return
    expect(heartbeat.request.subject).toBe('subject-n')
    expect(heartbeat.request.workspaceId).toBe('ws-1')

    const close = await verifyControlRequest(subReq(token, 'ws-2', 'close'), JSON.stringify({ outcome: 'flushed' }), store)
    expect(close.ok).toBe(true)
    if (!close.ok) return
    expect(close.request.route).toBe('closeWorkspace')
    if (close.request.route !== 'closeWorkspace') return
    expect(close.request.subject).toBe('subject-n')
    expect(close.request.workspaceId).toBe('ws-2')
    expect(close.request.outcome).toBe('flushed')

    const revoke = await verifyControlRequest(subReq(token, 'ws-3', 'revoke'), '{}', store)
    expect(revoke.ok).toBe(true)
    if (!revoke.ok) return
    expect(revoke.request.route).toBe('revokeWorkspace')
    if (revoke.request.route !== 'revokeWorkspace') return
    expect(revoke.request.subject).toBe('subject-n')
    expect(revoke.request.workspaceId).toBe('ws-3')
  })

  it('⑰ close의 outcome 부재·두 값 밖·타입 불일치가 각각 400 malformed_request다 (§4.4)', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    const { token } = await store.issue('subject-o')

    for (const body of [JSON.stringify({}), JSON.stringify({ outcome: 'other' }), JSON.stringify({ outcome: 1 })]) {
      const result = await verifyControlRequest(subReq(token, 'ws-1', 'close'), body, store)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.status).toBe(400)
      expect(result.error.error.code).toBe('malformed_request')
    }
  })

  it('⑱ heartbeat 본문에 정의되지 않은 필드가 있으면 400, revoke의 reason은 문자열이면 통과하되 산출물에 실리지 않는다 (§4.3·§4.5)', async () => {
    const store = await openLauncherCredentialStore(':memory:')
    const { token } = await store.issue('subject-p')

    const heartbeat = await verifyControlRequest(subReq(token, 'ws-1', 'heartbeat'), JSON.stringify({ zzz: 1 }), store)
    expect(heartbeat.ok).toBe(false)
    if (heartbeat.ok) return
    expect(heartbeat.status).toBe(400)
    expect(heartbeat.error.error.code).toBe('malformed_request')

    const revoke = await verifyControlRequest(subReq(token, 'ws-1', 'revoke'), JSON.stringify({ reason: 'stale' }), store)
    expect(revoke.ok).toBe(true)
    if (!revoke.ok) return
    expect(revoke.request.route).toBe('revokeWorkspace')
    if (revoke.request.route !== 'revokeWorkspace') return
    expect('reason' in revoke.request).toBe(false)
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
