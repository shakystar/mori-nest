/**
 * 결함을 고정 문자열로 덮는 자리의 진단 규율 (`server.ts` 파일 상단 doc의 「삼킨 예외의 진단」) —
 * mori-nest #38, #51.
 *
 * 이 파일이 보는 것은 **두 가지가 동시에 성립하는가** 하나뿐이다:
 *
 * 1. 덮인 결함의 원문이 클라이언트에 닿는 경로가 없다 (`0002 §1.5` L145-146 MUST NOT). 그래서
 *    스토어 예외는 **식별 가능한 마커 문자열**을 메시지로 두고, `pull.serialize`(예외가 아닌
 *    결과 판정)는 응답 봉투가 이 이슈 **전과 한 글자도 같은지**를 본다 — 응답 본문·`reset`
 *    프레임 어디에도 그 문자열이 없음을 본다 — 봉투를 필드별로 다시 검사하는 대신 원문
 *    전체를 훑는 것은, 「어느 필드로도 새지 않는다」가 필드 목록보다 강한 진술이기 때문이다.
 * 2. 그 결함이 주입한 훅에는 **원문 그대로** 닿는다.
 *
 * 라우트 자신의 동작(정상 경로의 상태코드·봉투·프레임)은 `test/server.test.ts`·
 * `test/server-pull.test.ts`·`test/server-subscribe.test.ts`가 이미 덮는다 — 여기서 다시 쓰지
 * 않는다. 이 이슈는 라우트 동작을 바꾸는 이슈가 아니다.
 */

import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { createTransportServer, type TransportDiagnostic, type TransportServerOptions } from '../src/server.js'
import type { EventStore } from '../src/store.js'
import { NOW, baseClaims, keys, mint } from './workspace-token.js'

const LOG_ID = 'log_diagnostics'
const TOKEN = mint(baseClaims({ scope: [LOG_ID] }))

/**
 * 응답 어디에도 나타나면 안 되는 문자열. 스토어 예외의 `message`가 이것이므로, 이 문자열이
 * 응답에 있다는 것은 곧 `§1.5` MUST NOT을 어겼다는 뜻이다.
 */
const MARKER = 'store-internals-2f9c41-must-not-reach-the-client'

/** 무엇을 불러도 {@link MARKER}를 메시지로 던지는 스토어. 실제 DB를 열지 않는다. */
function explodingStore(): EventStore {
  return {
    append: () => Promise.reject(new Error(MARKER)),
    readPage: () => Promise.reject(new Error(MARKER)),
    close: () => Promise.resolve(),
  }
}

/**
 * `readPage`가 **던지지 않고** `serializePullResponse`가 거부하는 `PullPage`로 resolve하는
 * 스토어(`pull.ts` 결정 1 — `hasMore: true`인데 `events`가 비었다). `pull.serialize`는 예외가
 * 아니라 이 결과 타입 판정에서 나므로, `explodingStore`(던지는 쪽)로는 이 자리를 겨눌 수 없다.
 */
function corruptPullPageStore(): EventStore {
  return {
    append: () => Promise.reject(new Error(MARKER)),
    readPage: () => Promise.resolve({ events: [], hasMore: true, from: 'known' }),
    close: () => Promise.resolve(),
  }
}

describe('삼킨 스토어 예외의 진단 규율 (mori-nest #38)', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()))
      })
      server = undefined
    }
  })

  /**
   * 서버 하나를 띄우고 `baseUrl`과 훅이 받은 진단 목록을 돌려준다. `injectHook`이 거짓이면
   * `onDiagnostic` 필드를 **아예 넘기지 않는다** — 「부재가 곧 지금까지의 동작」을 보는
   * 테스트(④)가 그 경로를 탄다 (`exactOptionalPropertyTypes`라 `undefined`를 넘기는 것과
   * 필드를 빼는 것이 같지 않다).
   */
  async function start(
    overrides: Partial<TransportServerOptions> = {},
    injectHook = true,
  ): Promise<{ baseUrl: string; seen: TransportDiagnostic[] }> {
    const seen: TransportDiagnostic[] = []
    const base: TransportServerOptions = { store: explodingStore(), keys, now: () => NOW }
    const options: TransportServerOptions = injectHook
      ? { ...base, onDiagnostic: (diagnostic) => seen.push(diagnostic), ...overrides }
      : { ...base, ...overrides }
    server = createTransportServer(options)
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    return { baseUrl: `http://127.0.0.1:${String(address.port)}`, seen }
  }

  function append(baseUrl: string): Promise<Response> {
    return fetch(`${baseUrl}/v1/logs/${LOG_ID}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: '{"events":[{"id":"e1","payload":{"a":1}}]}',
    })
  }

  function pull(baseUrl: string): Promise<Response> {
    return fetch(`${baseUrl}/v1/logs/${LOG_ID}/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
  }

  it('① append: 봉투는 고정 문자열 503, 예외 원문은 훅에만 간다', async () => {
    const { baseUrl, seen } = await start()

    const res = await append(baseUrl)
    const raw = await res.text()

    expect(res.status).toBe(503)
    expect(raw).not.toContain(MARKER)
    expect(JSON.parse(raw)).toEqual({
      error: { code: 'not_durable', message: 'append could not be durably committed' },
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.site).toBe('append.store')
    expect(seen[0]?.logId).toBe(LOG_ID)
    expect((seen[0]?.error as Error).message).toBe(MARKER)
  })

  it('② pull: 봉투는 고정 문자열 500, 예외 원문은 훅에만 간다', async () => {
    const { baseUrl, seen } = await start()

    const res = await pull(baseUrl)
    const raw = await res.text()

    expect(res.status).toBe(500)
    expect(raw).not.toContain(MARKER)
    expect(JSON.parse(raw)).toEqual({
      error: { code: 'internal', message: 'pull page could not be read' },
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.site).toBe('pull.store')
    expect(seen[0]?.logId).toBe(LOG_ID)
    expect((seen[0]?.error as Error).message).toBe(MARKER)
  })

  it('③ subscribe: reset 프레임의 reason은 고정 문자열, 예외 원문은 훅에만 간다', async () => {
    const { baseUrl, seen } = await start()

    const res = await fetch(`${baseUrl}/v1/logs/${LOG_ID}/subscribe`, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' },
    })
    // 첫 `#drain`이 곧장 터지므로 `open`도 나오기 전에 스트림이 `reset` 하나로 끝난다.
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(body).not.toContain(MARKER)
    expect(body).toContain('event: reset')
    expect(body).toContain('subscribe could not read the log')

    expect(seen).toHaveLength(1)
    expect(seen[0]?.site).toBe('subscribe.store')
    expect(seen[0]?.logId).toBe(LOG_ID)
    expect((seen[0]?.error as Error).message).toBe(MARKER)
  })

  it('④ 훅을 주입하지 않으면 봉투가 이 이슈 이전과 같다 (기본값이 no-op)', async () => {
    const { baseUrl } = await start({}, false)

    const res = await append(baseUrl)
    const raw = await res.text()

    expect(res.status).toBe(503)
    expect(raw).not.toContain(MARKER)
    expect(JSON.parse(raw)).toEqual({
      error: { code: 'not_durable', message: 'append could not be durably committed' },
    })
  })

  it('⑤ 훅이 던져도 봉투가 바뀌지 않는다 (진단 실패가 요청 실패로 번지지 않는다)', async () => {
    const { baseUrl } = await start({
      onDiagnostic: () => {
        throw new Error('진단 평면이 고장났다')
      },
    })

    const res = await append(baseUrl)
    const raw = await res.text()

    expect(res.status).toBe(503)
    expect(raw).not.toContain(MARKER)
    expect(JSON.parse(raw)).toEqual({
      error: { code: 'not_durable', message: 'append could not be durably committed' },
    })
  })

  it('⑥ 라우트 핸들러 밖에서 난 예외도 같은 규율을 탄다 (site: "request")', async () => {
    // 게이트에 넘길 기준 시각을 얻는 자리에서 터뜨린다 — 라우트 판정 **전**이라 이 예외는
    // 세 핸들러 어디에도 닿지 않고 `handleRequest`를 감싼 자리로 곧장 올라간다.
    const { baseUrl, seen } = await start({
      now: () => {
        throw new Error(MARKER)
      },
    })

    const res = await append(baseUrl)
    const raw = await res.text()

    expect(res.status).toBe(500)
    expect(raw).not.toContain(MARKER)
    expect(JSON.parse(raw)).toEqual({
      error: { code: 'internal', message: 'unexpected server error' },
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.site).toBe('request')
    // 게이트 판정 전이라 대상 로그를 알 수 없다.
    expect(seen[0]?.logId).toBeUndefined()
    expect((seen[0]?.error as Error).message).toBe(MARKER)
  })

  it('⑦ pull: serializePullResponse 실패도 같은 규율을 탄다 (site: "pull.serialize", mori-nest #51)', async () => {
    const { baseUrl, seen } = await start({ store: corruptPullPageStore() })

    const res = await pull(baseUrl)
    const raw = await res.text()

    expect(res.status).toBe(500)
    expect(JSON.parse(raw)).toEqual({
      error: { code: 'internal', message: 'store returned a page the pull response cannot serialize' },
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.site).toBe('pull.serialize')
    expect(seen[0]?.logId).toBe(LOG_ID)
    // 예외가 아니라 `serializePullResponse`가 돌려준 실패 사유 그대로다.
    expect(seen[0]?.error).toBe('has_more_without_events')
  })
})
