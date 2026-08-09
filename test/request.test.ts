/**
 * `0002 §0`의 라우트 해석 + `§1.1`·`§1.2`·`§4.2`의 공통 게이트.
 *
 * 여기서 보는 것은 **게이트가 각 판정을 부르고 그 결과를 옳게 옮기는가**다.
 * `checkMethod`·`verifyWorkspaceToken`의 내부 동작은 그 모듈의 테스트가 이미 덮는다.
 *
 * 검사 **순서**를 고정하는 케이스는 2번(자격 없이 보낸 traversal), 8번(스코프 안의
 * 유효한 토큰으로 보낸 `Accept` 위반), 16번(자격 없이 보낸 `limit` 위반)이다 — 2·16번은
 * 문법 검사(`logId`·`limit`)가 자격보다 먼저임을, 8번은 `Accept`가 자격·스코프보다
 * 뒤임을 각각 관찰한다.
 */

import { describe, expect, it } from 'vitest'

import { verifyTransportRequest, type RawRequest, type TransportRequestResult } from '../src/transport/request.js'
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

function verify(
  overrides: Partial<RawRequest> = {},
  options: { maxLimit?: number } = {},
): TransportRequestResult {
  return verifyTransportRequest(request(overrides), keys, { now: NOW, ...options })
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

  // 12 — §3.1 L284-287·L304. 서버 상한(100)을 주입한 채 세 경우를 본다.
  it('resolves pull limit: as-given, clamped to the server cap, or absent', () => {
    const cases = [
      { label: 'within the cap', url: `/v1/logs/${LOG_ID}/events?limit=10`, limit: 10 },
      { label: 'above the cap — clamped', url: `/v1/logs/${LOG_ID}/events?limit=1000`, limit: 100 },
      { label: 'absent', url: `/v1/logs/${LOG_ID}/events`, limit: undefined },
    ] as const

    for (const { label, url, limit } of cases) {
      const resolved = acceptedOrThrow(verify({ url }, { maxLimit: 100 }))
      expect(resolved.route === 'pull' ? resolved.limit : null, label).toBe(limit)
    }
  })

  // 13 — 형식 위반 다섯 가지를 하나의 처리로 합류시킨다: 비숫자·음수·소수·`0`(§3.1 L303의
  //      MUST와 충돌하므로 형식 위반으로 다룬다)·반복 쿼리. 새 code를 만들지 않고
  //      `malformed_request`로 합류한다 (`§1.5`에 `invalid_limit`이 없다 — 스펙 갭).
  it('rejects every malformed limit the same way', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['non-numeric', `/v1/logs/${LOG_ID}/events?limit=abc`],
      ['negative', `/v1/logs/${LOG_ID}/events?limit=-1`],
      ['decimal', `/v1/logs/${LOG_ID}/events?limit=1.5`],
      ['zero', `/v1/logs/${LOG_ID}/events?limit=0`],
      ['repeated query', `/v1/logs/${LOG_ID}/events?limit=1&limit=2`],
    ]

    for (const [label, url] of cases) {
      expect(rejectionOf(verify({ url }, { maxLimit: 100 })), label).toEqual({
        status: 400,
        code: 'malformed_request',
      })
    }
  })

  // 14 — `§3.1`의 표는 pull의 것이다. subscribe는 `limit` 쿼리를 읽지 않으므로 결과에
  //      그 필드가 (값이 아니라) **키 자체가** 없다 — 무시가 아니라 부재.
  it('does not read limit on subscribe — the field is absent, not ignored', () => {
    const resolved = acceptedOrThrow(
      verify(
        {
          url: `/v1/logs/${LOG_ID}/subscribe?limit=5`,
          headers: { ...AUTHORIZED, accept: 'text/event-stream' },
        },
        { maxLimit: 100 },
      ),
    )

    expect(resolved.route).toBe('subscribe')
    expect('limit' in resolved).toBe(false)
  })

  // 15 — fail-closed: 서버 상한을 주지 않으면 명시적 `limit`은 거부되지만, `limit`을
  //      보내지 않은 요청은 상한 부재의 영향을 받지 않는다. 그리고 그 거부는 자격·스코프
  //      **뒤**에서만 일어난다 — 자격 없는 요청자가 받는 응답은 `maxLimit`이 설정됐는지와
  //      무관하게 같아야 한다 (배포 설정이 자격 없는 쪽으로 새면 안 된다).
  it('fails closed when no server cap is configured', () => {
    expect(rejectionOf(verify({ url: `/v1/logs/${LOG_ID}/events?limit=10` }))).toEqual({
      status: 400,
      code: 'malformed_request',
    })

    const resolved = acceptedOrThrow(verify({ url: `/v1/logs/${LOG_ID}/events` }))
    expect(resolved.route === 'pull' ? resolved.limit : null).toBe(undefined)

    // 자격 없는 요청자에게는 `maxLimit` 설정 여부가 보이지 않는다: 유효한 `limit`을 실어
    // 보내도, 아예 보내지 않아도, 응답은 상한 설정과 무관하게 같은 401이다.
    const unauthedWithLimit = verify({ url: `/v1/logs/${LOG_ID}/events?limit=10`, headers: {} })
    const unauthedWithoutLimit = verify({ url: `/v1/logs/${LOG_ID}/events`, headers: {} })
    expect(rejectionOf(unauthedWithLimit)).toEqual({ status: 401, code: 'unauthenticated' })
    expect(rejectionOf(unauthedWithoutLimit)).toEqual({ status: 401, code: 'unauthenticated' })

    const unauthedWithLimitCapped = verify(
      { url: `/v1/logs/${LOG_ID}/events?limit=10`, headers: {} },
      { maxLimit: 100 },
    )
    expect(rejectionOf(unauthedWithLimitCapped)).toEqual({ status: 401, code: 'unauthenticated' })
  })

  // 16 — 순서 고정: 위반 `limit`을 `Authorization` 없이 보낸다. `401`이 아니라 `400`이
  //      나오는 것이 `limit` 형식 검사(5)가 자격 검사(6)보다 먼저라는 증거다.
  it('rejects a malformed limit before checking credentials', () => {
    expect(
      rejectionOf(verify({ url: `/v1/logs/${LOG_ID}/events?limit=abc`, headers: {} }, { maxLimit: 100 })),
    ).toEqual({ status: 400, code: 'malformed_request' })
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
