/**
 * 출처(`Origin`)가 응답 세 자리 — append(`accepted`·`duplicate`)·pull(`events[]`)·
 * SSE(`append` 프레임) — 에 실리는가 (`0002 §1.6` 「노출」, mori-nest #63).
 *
 * 세 라우트 자신의 배선(게이트 순서·커서·`hasMore`·백프레셔 등)은 `test/server.test.ts`·
 * `test/server-pull.test.ts`·`test/server-subscribe.test.ts`가 이미 덮는다 — 여기서 다시
 * 쓰지 않는다. mori-nest #63이 구체 지정한 다섯 동작, 다섯 개뿐이다.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTransportServer } from '../src/server.js'
import { openEventStore, type EventStore } from '../src/store.js'
import { NOW, baseClaims, keys, mint } from './workspace-token.js'

const LOG_ID = 'log_origin-route'

type Frame = { readonly event: string; readonly id: string | null; readonly data: string }

function parseFrame(raw: string): Frame {
  let event = ''
  let id: string | null = null
  const dataLines: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) {
      event = line.slice('event: '.length)
    } else if (line.startsWith('id: ')) {
      id = line.slice('id: '.length)
    } else if (line.startsWith('data: ')) {
      dataLines.push(line.slice('data: '.length))
    }
  }
  return { event, id, data: dataLines.join('\n') }
}

/** SSE 응답 바디를 프레임 단위로 잘라 준다 (`test/server-subscribe.test.ts`와 같은 헬퍼). */
class SseFrameReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>
  readonly #decoder = new TextDecoder()
  #buffer = ''

  constructor(body: ReadableStream<Uint8Array>) {
    this.#reader = body.getReader()
  }

  async next(): Promise<Frame | null> {
    for (;;) {
      const boundary = this.#buffer.indexOf('\n\n')
      if (boundary !== -1) {
        const raw = this.#buffer.slice(0, boundary)
        this.#buffer = this.#buffer.slice(boundary + 2)
        return parseFrame(raw)
      }
      const { value, done } = await this.#reader.read()
      if (done) {
        return null
      }
      this.#buffer += this.#decoder.decode(value, { stream: true })
    }
  }

  async cancel(): Promise<void> {
    await this.#reader.cancel().catch(() => {
      // 이미 끊긴 스트림 — 취소할 것이 없다.
    })
  }
}

describe('출처가 응답 세 자리에 실린다 (0002 §1.6 「노출」)', () => {
  let dir: string
  let dbPath: string
  let store: EventStore
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mori-nest-server-origin-'))
    dbPath = join(dir, 'events.db')
    store = await openEventStore(dbPath)
    server = createTransportServer({ store, keys, now: () => NOW })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${String(address.port)}`
  })

  afterEach(async () => {
    await store.close()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
    rmSync(dir, { recursive: true, force: true })
  })

  function post(token: string, body: string): Promise<Response> {
    return fetch(`${baseUrl}/v1/logs/${LOG_ID}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    })
  }

  function pull(token: string, query = ''): Promise<Response> {
    return fetch(`${baseUrl}/v1/logs/${LOG_ID}/events${query}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  }

  it('① accepted의 출처가 요청 토큰의 workspaceId다', async () => {
    const claims = baseClaims({ scope: [LOG_ID] })
    const token = mint(claims)

    const res = await post(token, '{"events":[{"id":"e1","payload":{"a":1}}]}')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { accepted: { id: string; origin?: { workspaceId: string } }[] }
    expect(body.accepted[0]?.origin).toEqual({ workspaceId: claims.workspaceId })
  })

  it('② duplicate의 출처가 먼저 저장된 사본의 것이다 — 나중에 미는 쪽(B)이 자기 것으로 바꾸지 못한다', async () => {
    const tokenA = mint(baseClaims({ workspaceId: 'ws_A', tokenId: 'tok_A', scope: [LOG_ID] }))
    const tokenB = mint(baseClaims({ workspaceId: 'ws_B', tokenId: 'tok_B', scope: [LOG_ID] }))

    await post(tokenA, '{"events":[{"id":"x","payload":{"a":1}}]}')
    const res = await post(tokenB, '{"events":[{"id":"x","payload":{"a":2}}]}')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { duplicate: { id: string; origin?: { workspaceId: string } }[] }
    expect(body.duplicate[0]?.origin).toEqual({ workspaceId: 'ws_A' })
  })

  it('③ 세 자리(append·pull·SSE)가 같은 이벤트에 대해 같은 origin을 싣는다', async () => {
    const claims = baseClaims({ scope: [LOG_ID] })
    const token = mint(claims)

    const appendRes = await post(token, '{"events":[{"id":"e1","payload":{"a":1}}]}')
    const appendBody = (await appendRes.json()) as { accepted: { origin?: { workspaceId: string } }[] }

    const pullRes = await pull(token)
    const pullBody = (await pullRes.json()) as { events: { origin?: { workspaceId: string } }[] }

    const sseRes = await fetch(`${baseUrl}/v1/logs/${LOG_ID}/subscribe`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    })
    const reader = new SseFrameReader(sseRes.body as ReadableStream<Uint8Array>)
    await reader.next() // open — 이미 쌓인 e1이 재생된다 (from: "beginning")
    const appended = await reader.next()
    const sseOrigin = (JSON.parse(appended?.data ?? '{}') as { origin?: { workspaceId: string } }).origin
    await reader.cancel()

    const expected = { workspaceId: claims.workspaceId }
    expect(appendBody.accepted[0]?.origin).toEqual(expected)
    expect(pullBody.events[0]?.origin).toEqual(expected)
    expect(sseOrigin).toEqual(expected)
  })

  it('④ 출처 없는(v1 시절 모양) 행은 세 응답 어디에도 origin 키가 없다', async () => {
    // v2 스키마 위에 v1 시절 행을 직접 만든다 — 출처 컬럼이 NULL(`§1.6`, 물을 수 없는 행).
    // `test/store.test.ts` ⑨의 이주 시험과 같은 판정을 pull 응답 문자열에서 관찰한다.
    const raw = new DatabaseSync(dbPath)
    raw
      .prepare('INSERT INTO events (log_id, event_id, payload, workspace_id, token_id) VALUES (?, ?, ?, NULL, NULL)')
      .run(LOG_ID, 'legacy0', Buffer.from('{"legacy":true}', 'utf8'))
    raw.close()

    const token = mint(baseClaims({ scope: [LOG_ID] }))
    const pullText = await (await pull(token)).text()
    expect(pullText).not.toContain('"origin"')

    const sseRes = await fetch(`${baseUrl}/v1/logs/${LOG_ID}/subscribe`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    })
    const reader = new SseFrameReader(sseRes.body as ReadableStream<Uint8Array>)
    await reader.next() // open
    const appended = await reader.next()
    expect(appended?.data ?? '').not.toContain('"origin"')
    await reader.cancel()
  })

  it('⑤ tokenId는 append·pull·SSE 응답 원문 어디에도 부분문자열로도 없다', async () => {
    const claims = baseClaims({ tokenId: 'tok_leak-check_9f3', scope: [LOG_ID] })
    const token = mint(claims)

    const appendText = await (await post(token, '{"events":[{"id":"e1","payload":{"a":1}}]}')).text()
    expect(appendText).not.toContain(claims.tokenId)

    const pullText = await (await pull(token)).text()
    expect(pullText).not.toContain(claims.tokenId)

    const sseRes = await fetch(`${baseUrl}/v1/logs/${LOG_ID}/subscribe`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    })
    const reader = new SseFrameReader(sseRes.body as ReadableStream<Uint8Array>)
    const open = await reader.next()
    const appended = await reader.next()
    expect(open?.data ?? '').not.toContain(claims.tokenId)
    expect(appended?.data ?? '').not.toContain(claims.tokenId)
    await reader.cancel()
  })
})
