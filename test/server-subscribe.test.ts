/**
 * subscribe 라우트 배선 (`0002 §4`) — 연결 수명·재개·백프레셔만 본다.
 *
 * 프레임 문자열 자체(`sse.ts`)는 `test/sse.test.ts`가, 커서 해석·정렬·`hasMore`/`from` 판정
 * (`store.readPage`)은 `test/store.test.ts`·`test/server-pull.test.ts`가 이미 덮는다 — 여기서
 * 다시 쓰지 않는다. mori-nest #30 완료 조건이 요구한 동작 하나당 테스트 하나, 여섯 개뿐이다.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTransportServer } from '../src/server.js'
import { openEventStore, type EventStore } from '../src/store.js'
import { NOW, baseClaims, keys, mint } from './workspace-token.js'

const LOG_ID = 'log_subscribe-route'
const TOKEN = mint(baseClaims({ scope: [LOG_ID] }))

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

/** SSE 응답 바디를 프레임(빈 줄로 끝나는 `event:`/`id:`/`data:` 블록) 단위로 잘라 준다. */
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

describe('subscribe 라우트 배선 — 연결 수명·재개·백프레셔 (0002 §4)', () => {
  let dir: string
  let store: EventStore
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mori-nest-server-subscribe-'))
    store = await openEventStore(join(dir, 'events.db'))
    server = createTransportServer({ store, keys, now: () => NOW })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${String(address.port)}`
  })

  afterEach(async () => {
    await store.close()
    await new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve()
        return
      }
      server.close((error) => (error ? reject(error) : resolve()))
    })
    rmSync(dir, { recursive: true, force: true })
  })

  function subscribeRequest(query = '', extraHeaders: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}/v1/logs/${LOG_ID}/subscribe${query}`, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream', ...extraHeaders },
    })
  }

  /** append 라우트로 이벤트를 심고, 심은 순서대로 발급된 커서를 돌려준다. */
  async function seed(ids: string[]): Promise<string[]> {
    const events = ids.map((id) => ({ id, payload: { id } }))
    const res = await fetch(`${baseUrl}/v1/logs/${LOG_ID}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
    })
    const body = (await res.json()) as { accepted: { id: string; cursor: string }[] }
    return ids.map((id) => {
      const cursor = body.accepted.find((e) => e.id === id)?.cursor
      if (cursor === undefined) {
        throw new Error(`시드 실패: ${id}가 accepted에 없다`)
      }
      return cursor
    })
  }

  it('① 연결 직후 첫 프레임이 open', async () => {
    const res = await subscribeRequest()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')

    const reader = new SseFrameReader(res.body as ReadableStream<Uint8Array>)
    const first = await reader.next()
    expect(first?.event).toBe('open')
    expect(JSON.parse(first?.data ?? '')).toEqual({ from: 'beginning' })

    await reader.cancel()
  })

  it('② append 발생 → append 프레임 하나가 커서를 id: 줄에 달고 나온다', async () => {
    const res = await subscribeRequest()
    const reader = new SseFrameReader(res.body as ReadableStream<Uint8Array>)
    await reader.next() // open

    const [cursor] = await seed(['e1'])

    const appended = await reader.next()
    expect(appended?.event).toBe('append')
    expect(appended?.id).toBe(cursor)
    expect(JSON.parse(appended?.data ?? '')).toEqual({ id: 'e1', payload: { id: 'e1' }, cursor })

    await reader.cancel()
  })

  it('③ Last-Event-ID로 재접속 → 그 커서 다음부터 이어진다', async () => {
    const [c1] = await seed(['e1', 'e2'])

    const res = await subscribeRequest('', { 'last-event-id': c1 ?? '' })
    const reader = new SseFrameReader(res.body as ReadableStream<Uint8Array>)

    const open = await reader.next()
    expect(JSON.parse(open?.data ?? '')).toEqual({ from: 'known' })

    const appended = await reader.next()
    expect(JSON.parse(appended?.data ?? '')).toMatchObject({ id: 'e2' })

    await reader.cancel()
  })

  it('④ 미지 Last-Event-ID로 재접속 → 처음부터 재생 + from: "unknown"', async () => {
    await seed(['e1', 'e2'])

    const res = await subscribeRequest('', { 'last-event-id': '999999999' })
    const reader = new SseFrameReader(res.body as ReadableStream<Uint8Array>)

    const open = await reader.next()
    expect(JSON.parse(open?.data ?? '')).toEqual({ from: 'unknown' })

    const first = await reader.next()
    expect(JSON.parse(first?.data ?? '')).toMatchObject({ id: 'e1' })
    const second = await reader.next()
    expect(JSON.parse(second?.data ?? '')).toMatchObject({ id: 'e2' })

    await reader.cancel()
  })

  it('⑤ 백프레셔 한도 초과 → reset 프레임이 나가고 스트림이 닫힌다', async () => {
    // 기본 서버(무제한에 가까운 기본 한도)를 닫고, 테스트 안에서만 한도를 작게 잡은
    // 서버로 다시 연다 — 실제로 몇 메가바이트를 밀어 넣지 않고도 결정적으로 한도를
    // 넘기기 위해서다.
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
    server = createTransportServer({ store, keys, now: () => NOW, subscribeBacklogLimitBytes: 1024 })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${String(address.port)}`

    const res = await subscribeRequest()
    const reader = new SseFrameReader(res.body as ReadableStream<Uint8Array>)
    const open = await reader.next()
    expect(open?.event).toBe('open')

    // 여기서부터 스트림을 읽지 않는다 — 서버가 쓰는 대로 소켓에 쌓이게 둔다. 한도(1KB)를
    // 훌쩍 넘는 양(이벤트 300개 × 각 300+바이트)을 한 번에 심어 Node의 내부 버퍼가
    // 실제로 밀리게 만든다.
    const events = Array.from({ length: 300 }, (_, index) => ({
      id: `e${String(index)}`,
      payload: { padding: 'x'.repeat(300) },
    }))
    const appendRes = await fetch(`${baseUrl}/v1/logs/${LOG_ID}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
    })
    expect(appendRes.status).toBe(200)

    // 이제서야 읽는다 — 밀려 쌓인 append 프레임들 뒤에 reset이 있고, 그 뒤로 스트림이
    // 끝나야 한다 (중간을 버리고 이어가지 않는다 — 버려진 이벤트를 나타내는 "구멍" 없이
    // reset이 스트림의 마지막 프레임이다).
    let resetFrame: Frame | null = null
    for (;;) {
      const frame = await reader.next()
      if (frame === null) {
        break
      }
      if (frame.event === 'reset') {
        resetFrame = frame
        break
      }
      expect(frame.event).toBe('append')
    }
    expect(resetFrame).not.toBeNull()
    expect(() => JSON.parse(resetFrame?.data ?? '')).not.toThrow()

    const afterReset = await reader.next()
    expect(afterReset).toBeNull()
  })

  it('⑥ 연결 종료 후 타이머·리스너가 남지 않는다 (server.close()가 지연 없이 끝난다)', async () => {
    const res = await subscribeRequest()
    const reader = new SseFrameReader(res.body as ReadableStream<Uint8Array>)
    await reader.next() // open
    await reader.cancel()

    // 서버 쪽 정리(브로커 구독 해제, req/res 리스너 제거)가 안 됐다면 Node의
    // `server.close()`는 이 연결이 자연히 끊길 때까지 콜백을 미룬다. 지연 없이 끝나는
    // 것이 "타이머·리스너·스토어 구독이 전부 해제된다"의 관찰 가능한 증거다.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('server.close()가 지연됐다 — 연결이 정리되지 않았다'))
      }, 2000)
      server.close((error) => {
        clearTimeout(timer)
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
  })
})
