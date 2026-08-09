/**
 * append 본문·이벤트 크기 한도 (`0002 §1.3` L103-104, `§1.5` L158-159) — mori-nest #34.
 *
 * 동작 하나당 테스트 하나, 넷뿐이다 (이슈 완료 조건이 그렇게 못박았다). 한도는 항상
 * **작은(계약 하한만큼 작은) 값을 주입**해서 쓴다 — `createTransportServer`가 `maxEventBytes`에
 * `MIN_MAX_EVENT_BYTES`(1 MiB) 미만을 거절하므로(④가 그 자체를 검사한다), 그보다 작은
 * 한도를 주입할 방법이 없다. 그래서 여기서 "작다"는 건 *배포가 고를 값(수십~수백 MiB)보다
 * 작다*는 뜻이지 계약 하한 아래라는 뜻이 아니다 — 넘길 본문은 그래도 1 MiB 안팎이 필요하고,
 * 문자열 생성·루프백 전송 둘 다 밀리초 단위라 실측으로도 느리지 않다.
 *
 * ①·③은 **요청 전체**가 `maxRequestBytes`를 넘는 경우이고, ②는 **단일 이벤트**가
 * `maxEventBytes`를 넘는 경우다. 서버는 본문을 다 읽은 뒤에야 이벤트를 파싱하므로
 * (`server.ts` 파일 상단 doc), ②를 `request_too_large`와 섞이지 않게 관찰하려면
 * `maxRequestBytes`를 `maxEventBytes`보다 넉넉히 크게 둬야 한다 — 그러지 않으면 딱 그
 * 이벤트 하나만으로도 요청 한도가 먼저 걸린다.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTransportServer } from '../src/transport/server.js'
import { MIN_MAX_EVENT_BYTES } from '../src/transport/event.js'
import { openEventStore, type EventStore } from '../src/transport/store.js'
import { NOW, baseClaims, keys, mint } from './workspace-token.js'

const LOG_ID = 'log_size-limits'
const TOKEN = mint(baseClaims({ scope: [LOG_ID] }))

/** id·payload 봉투 하나. `payloadChars`는 payload 문자열 값의 글자 수(= ASCII라 바이트 수). */
function eventJson(id: string, payloadChars: number): string {
  return `{"id":"${id}","payload":"${'a'.repeat(payloadChars)}"}`
}

function requestBody(events: readonly string[]): string {
  return `{"events":[${events.join(',')}]}`
}

describe('append 본문·이벤트 크기 한도 (0002 §1.3, mori-nest #34)', () => {
  let dir: string
  let store: EventStore
  let server: Server | undefined
  let baseUrl: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mori-nest-size-limits-'))
    store = await openEventStore(join(dir, 'events.db'))
  })

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()))
      })
      server = undefined
    }
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function startServer(options: { maxEventBytes: number; maxRequestBytes: number }): Promise<void> {
    server = createTransportServer({ store, keys, now: () => NOW, ...options })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
    const address = server?.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${String(address.port)}`
  }

  function post(body: string): Promise<Response> {
    return fetch(`${baseUrl}/v1/logs/${LOG_ID}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body,
    })
  }

  /** `body`를 조각내어 청크로 흘려보낸다 — `Content-Length`가 없는 chunked 전송이 된다. */
  function postChunked(body: string): Promise<Response> {
    const bytes = new TextEncoder().encode(body)
    const CHUNK_SIZE = 64 * 1024
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
          controller.enqueue(bytes.subarray(offset, offset + CHUNK_SIZE))
        }
        controller.close()
      },
    })
    return fetch(`${baseUrl}/v1/logs/${LOG_ID}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit)
  }

  async function loggedIds(): Promise<string[]> {
    const page = await store.readPage(LOG_ID, { kind: 'beginning' }, 100)
    return page.events.map((event) => event.id)
  }

  it('① 본문이 maxRequestBytes 초과 → 413 request_too_large + details.maxRequestBytes, 로그 무변경', async () => {
    await startServer({ maxEventBytes: MIN_MAX_EVENT_BYTES, maxRequestBytes: MIN_MAX_EVENT_BYTES })
    // 이벤트 하나하나는 한도 안이지만(각 ~600,020바이트 < 1 MiB), 둘을 합친 요청 본문은
    // maxRequestBytes(1 MiB)를 넘는다 — event_too_large가 아니라 request_too_large여야 한다.
    const body = requestBody([eventJson('e1', 600_000), eventJson('e2', 600_000)])

    const res = await post(body)

    expect(res.status).toBe(413)
    const parsed = (await res.json()) as { error: { code: string; details?: { maxRequestBytes?: number } } }
    expect(parsed.error.code).toBe('request_too_large')
    expect(parsed.error.details?.maxRequestBytes).toBe(MIN_MAX_EVENT_BYTES)
    expect(await loggedIds()).toEqual([])
  })

  it('② 단일 이벤트가 maxEventBytes 초과 → 413 event_too_large + details.maxEventBytes, 로그 무변경', async () => {
    // maxRequestBytes를 maxEventBytes보다 크게 둔다 — 그러지 않으면 이 이벤트 하나만으로도
    // 요청 한도(①)가 먼저 걸려서 이 테스트가 실제로는 ①을 재검증하는 꼴이 된다.
    await startServer({ maxEventBytes: MIN_MAX_EVENT_BYTES, maxRequestBytes: MIN_MAX_EVENT_BYTES * 2 })
    const body = requestBody([eventJson('e1', 1_200_000)])

    const res = await post(body)

    expect(res.status).toBe(413)
    const parsed = (await res.json()) as { error: { code: string; details?: { maxEventBytes?: number } } }
    expect(parsed.error.code).toBe('event_too_large')
    expect(parsed.error.details?.maxEventBytes).toBe(MIN_MAX_EVENT_BYTES)
    expect(await loggedIds()).toEqual([])
  })

  it('③ Content-Length 없이(chunked) 보낸 초과 본문 → 여전히 ①과 같은 응답', async () => {
    await startServer({ maxEventBytes: MIN_MAX_EVENT_BYTES, maxRequestBytes: MIN_MAX_EVENT_BYTES })
    const body = requestBody([eventJson('e1', 600_000), eventJson('e2', 600_000)])

    const res = await postChunked(body)

    expect(res.status).toBe(413)
    const parsed = (await res.json()) as { error: { code: string; details?: { maxRequestBytes?: number } } }
    expect(parsed.error.code).toBe('request_too_large')
    expect(parsed.error.details?.maxRequestBytes).toBe(MIN_MAX_EVENT_BYTES)
    expect(await loggedIds()).toEqual([])
  })

  it('④ maxRequestBytes < maxEventBytes 이거나 maxEventBytes < 1 MiB인 설정으로 부르면 throw', () => {
    expect(() =>
      createTransportServer({ store, keys, maxEventBytes: MIN_MAX_EVENT_BYTES - 1, maxRequestBytes: MIN_MAX_EVENT_BYTES }),
    ).toThrow()
    expect(() =>
      createTransportServer({ store, keys, maxEventBytes: MIN_MAX_EVENT_BYTES, maxRequestBytes: MIN_MAX_EVENT_BYTES - 1 }),
    ).toThrow()
  })
})
