/**
 * `0002 §0`의 라우트 해석 + `§1.1`·`§1.2`·`§4.2`의 공통 게이트.
 *
 * 여기서 보는 것은 **게이트가 각 판정을 부르고 그 결과를 옳게 옮기는가**다.
 * `checkMethod`·`verifyWorkspaceToken`의 내부 동작은 그 모듈의 테스트가 이미 덮는다.
 *
 * 검사 **순서**를 고정하는 케이스는 2번(자격 없이 보낸 traversal)과 8번(스코프 안의
 * 유효한 토큰으로 보낸 `Accept` 위반)이다 — 앞의 것은 문법 검사가 자격보다 먼저임을,
 * 뒤의 것은 `Accept`가 자격·스코프보다 뒤임을 각각 관찰한다.
 */

import { describe, expect, it } from 'vitest'

import { verifyTransportRequest, type RawRequest, type TransportRequestResult } from '../src/request.js'
import { NOW, baseClaims, keys, mint } from './workspace-token.js'

const LOG_ID = 'log_in-scope'
const OTHER_LOG_ID = 'log_out-of-scope'

/** 스코프에 `LOG_ID` 하나만 담은 유효한 토큰. */
const TOKEN = mint(baseClaims({ scope: [LOG_ID] }))
const AUTHORIZED = { authorization: `Bearer ${TOKEN}` }

function request(overrides: Partial<RawRequest> = {}): RawRequest {
  return {
    method: 'GET',
    url: `/v1/logs/${LOG_ID}/events`,
    headers: AUTHORIZED,
    ...overrides,
  }
}

function verify(overrides: Partial<RawRequest> = {}): TransportRequestResult {
  return verifyTransportRequest(request(overrides), keys, { now: NOW })
}

/** 실패한 판정의 상태코드와 code. 통과했으면 그 자리에서 깨져야 한다. */
function rejectionOf(result: TransportRequestResult): { status: number; code: string } {
  if (result.ok) {
    throw new Error('expected the request to be rejected, but it passed the gate')
  }
  return { status: result.status, code: result.error.error.code }
}

function acceptedOrThrow(result: TransportRequestResult) {
  if (!result.ok) {
    throw new Error(`expected the request to pass, but it was rejected: ${result.error.error.code}`)
  }
  return result.request
}

describe('verifyTransportRequest', () => {
  // 1 — 대조군. 이게 없으면 "항상 거부"가 아래 전부를 통과시킨다.
  it('resolves each of the three routes in the §0 table', () => {
    const cases = [
      { method: 'POST', url: `/v1/logs/${LOG_ID}/events`, headers: AUTHORIZED, route: 'append' },
      { method: 'GET', url: `/v1/logs/${LOG_ID}/events`, headers: AUTHORIZED, route: 'pull' },
      {
        method: 'GET',
        url: `/v1/logs/${LOG_ID}/subscribe`,
        headers: { ...AUTHORIZED, accept: 'text/event-stream' },
        route: 'subscribe',
      },
    ] as const

    for (const { route, ...raw } of cases) {
      const resolved = acceptedOrThrow(verify(raw))
      expect(resolved.route, route).toBe(route)
      expect(resolved.logId, route).toBe(LOG_ID)
    }
  })

  // 2 — §1.1 L40·L45. 마지막 케이스는 **자격 헤더 없이** 보낸다: 문법 검사가 자격보다
  //     먼저라는 것과, 퍼센트 디코딩을 먼저 하지 않는다는 것을 함께 고정한다.
  it('rejects a logId that violates the §1.1 pattern, before looking at credentials', () => {
    const cases: ReadonlyArray<readonly [string, Partial<RawRequest>]> = [
      ['empty', { url: '/v1/logs//events' }],
      ['129 characters', { url: `/v1/logs/${'a'.repeat(129)}/events` }],
      ['dot', { url: '/v1/logs/log.id/events' }],
      ['percent-encoded traversal without credentials', { url: '/v1/logs/%2e%2e%2f/events', headers: {} }],
    ]

    for (const [label, overrides] of cases) {
      expect(rejectionOf(verify(overrides)), label).toEqual({ status: 400, code: 'invalid_log_id' })
    }
  })

  // 3 — §1.5 L156. `Allow`는 RFC 9110 §10.2.1이 405에 요구하는 헤더이고, 그 값은
  //     라우트 표를 가진 이 게이트가 만든다 (`method.ts`의 doc이 그렇게 지시한다).
  it('rejects a method outside the route table with the Allow value in the result', () => {
    const result = verify({ method: 'DELETE' })

    expect(rejectionOf(result)).toEqual({ status: 405, code: 'method_not_allowed' })
    expect(result.ok ? null : result.headers['Allow']).toBe('POST, GET')
  })

  // 4 — §1.2 L59.
  it('rejects a request without an Authorization header', () => {
    expect(rejectionOf(verify({ headers: {} }))).toEqual({ status: 401, code: 'unauthenticated' })
  })

  // 5 — §1.2 L53-59. 중복 헤더가 401인 것은 둘 중 하나를 고르면 프록시와 서버가 서로
  //     다른 자격을 보게 되기 때문이다.
  it('rejects malformed Authorization headers', () => {
    const cases: ReadonlyArray<readonly [string, RawRequest['headers']]> = [
      ['wrong scheme', { authorization: 'Basic dXNlcjpwYXNz' }],
      ['empty credentials', { authorization: 'Bearer ' }],
      ['duplicated header', { authorization: [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`] }],
    ]

    for (const [label, headers] of cases) {
      expect(rejectionOf(verify({ headers })), label).toEqual({
        status: 401,
        code: 'unauthenticated',
      })
    }
  })

  // 6 — §1.2 L60 MUST NOT: 쿼리스트링은 액세스 로그·프록시 로그에 그대로 남는다.
  //     같은 토큰이 헤더로 오면 통과하므로(1번), 이 401은 토큰이 아니라 **자리**를 본 것이다.
  it('does not accept a token carried in the query string', () => {
    const result = verify({ url: `/v1/logs/${LOG_ID}/events?token=${TOKEN}`, headers: {} })

    expect(rejectionOf(result)).toEqual({ status: 401, code: 'unauthenticated' })
  })

  // 7 — §1.2 L75 · 0003 §3.3 검사 5.
  it('rejects a path logId outside the token scope', () => {
    expect(rejectionOf(verify({ url: `/v1/logs/${OTHER_LOG_ID}/events` }))).toEqual({
      status: 403,
      code: 'out_of_scope',
    })
  })

  // 8 — §4.2 L370. 두 케이스 다 스코프 안의 유효한 토큰을 실었다 — 그래서 이 406은
  //     자격·스코프 판정 **뒤에** 온다는 순서까지 함께 고정한다.
  it('rejects subscribe without Accept: text/event-stream', () => {
    const cases: ReadonlyArray<readonly [string, RawRequest['headers']]> = [
      ['absent', AUTHORIZED],
      ['application/json', { ...AUTHORIZED, accept: 'application/json' }],
    ]

    for (const [label, headers] of cases) {
      expect(
        rejectionOf(verify({ url: `/v1/logs/${LOG_ID}/subscribe`, headers })),
        label,
      ).toEqual({ status: 406, code: 'not_acceptable' })
    }
  })

  // 9 — §4.2 L372-374. "지금부터"를 뜻하는 값은 이 스펙에 없다.
  it('reads the subscribe start position from after, then Last-Event-ID', () => {
    const sse = { ...AUTHORIZED, accept: 'text/event-stream' }
    const cases = [
      {
        label: 'after wins over Last-Event-ID',
        url: `/v1/logs/${LOG_ID}/subscribe?after=cursor-a`,
        headers: { ...sse, 'last-event-id': 'cursor-b' },
        start: { kind: 'after', cursor: 'cursor-a' },
      },
      {
        label: 'Last-Event-ID alone',
        url: `/v1/logs/${LOG_ID}/subscribe`,
        headers: { ...sse, 'last-event-id': 'cursor-b' },
        start: { kind: 'after', cursor: 'cursor-b' },
      },
      {
        label: 'neither — from the beginning of the log',
        url: `/v1/logs/${LOG_ID}/subscribe`,
        headers: sse,
        start: { kind: 'beginning' },
      },
    ] as const

    for (const { label, start, ...raw } of cases) {
      const resolved = acceptedOrThrow(verify(raw))
      expect(resolved.route === 'subscribe' ? resolved.start : null, label).toEqual(start)
    }
  })

  // 10 — §1.5 L153. 반복 쿼리가 `after`를 문자열이 아니게 만드는 실제 경로다.
  //      "형식은 맞는데 해석 안 됨"은 여기가 아니다 (§3.2 L322) — 그건 저장소의 일이다.
  it('rejects a repeated after query with invalid_cursor_format', () => {
    expect(rejectionOf(verify({ url: `/v1/logs/${LOG_ID}/events?after=a&after=b` }))).toEqual({
      status: 400,
      code: 'invalid_cursor_format',
    })
  })
})

// 11 — §1.2 L78 · §1.5 L145: 토큰 값은 응답 본문 어디에도 실리지 않는다 (MUST NOT).
//      `logId`도 싣지 않는다 — 스코프 밖 응답이 로그마다 달라지면 열거 오라클이 된다 (L75).
describe('rejection envelopes', () => {
  it('never carry the token or the requested logId', () => {
    const rejections = [
      verify({ headers: {} }),
      verify({ method: 'DELETE' }),
      verify({ url: `/v1/logs/${OTHER_LOG_ID}/events` }),
      verify({ url: '/v1/logs/log.id/events' }),
      verify({ url: `/v1/logs/${LOG_ID}/events?after=a&after=b` }),
      verify({ url: `/v1/logs/${LOG_ID}/subscribe`, headers: AUTHORIZED }),
      verify({ url: `/v1/logs/${LOG_ID}/nowhere` }),
    ].map((result) => JSON.stringify(result.ok ? result.request : result))

    expect(rejections).toHaveLength(7)
    for (const body of rejections) {
      expect(body).not.toContain(TOKEN)
      expect(body).not.toContain(LOG_ID)
      expect(body).not.toContain(OTHER_LOG_ID)
    }
  })
})
