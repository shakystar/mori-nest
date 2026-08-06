/**
 * pull 라우트 배선 (`0002 §3`) — `verifyTransportRequest` → `store.readPage` →
 * `serializePullResponse`가 옳은 순서로 이어지는가만 본다.
 *
 * 커서 해석·정렬·`limit` 적용·`hasMore`/`from` 판정 자체는 `store.readPage`(`test/store.test.ts`)가,
 * 응답 직렬화 자체는 `serializePullResponse`(`test/pull.test.ts`)가 이미 덮는다 — 여기서 다시
 * 쓰지 않는다. mori-nest #29 완료 조건이 요구한 동작 하나당 테스트 하나, 여섯 개뿐이다.
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

const LOG_ID = 'log_pull-route'
const TOKEN = mint(baseClaims({ scope: [LOG_ID] }))

type PullBody = {
  events: { id: string; payload: unknown; cursor: string }[]
  cursor?: string
  hasMore: boolean
  from: string
}

describe('pull 라우트 배선 (0002 §3)', () => {
  let dir: string
  let store: EventStore
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mori-nest-server-pull-'))
    store = await openEventStore(join(dir, 'events.db'))
    server = createTransportServer({ store, keys, now: () => NOW, maxLimit: 1000 })
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

  function pull(query = ''): Promise<Response> {
    return fetch(`${baseUrl}/v1/logs/${LOG_ID}/events${query}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
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

  it('① after 없음 → 처음부터 + from: "beginning"', async () => {
    const cursors = await seed(['e1', 'e2'])
    const res = await pull()

    expect(res.status).toBe(200)
    const body = (await res.json()) as PullBody
    expect(body.events.map((e) => e.id)).toEqual(['e1', 'e2'])
    expect(body.from).toBe('beginning')
    expect(body.cursor).toBe(cursors[1])
  })

  it('② 유효 커서 → 그 다음부터 + from: "known"', async () => {
    const cursors = await seed(['e1', 'e2', 'e3'])
    const res = await pull(`?after=${cursors[0] ?? ''}`)

    expect(res.status).toBe(200)
    const body = (await res.json()) as PullBody
    expect(body.events.map((e) => e.id)).toEqual(['e2', 'e3'])
    expect(body.from).toBe('known')
  })

  it('③ 미지 커서 → 처음부터 + from: "unknown" (200, 에러 아니다)', async () => {
    await seed(['e1', 'e2'])
    const res = await pull('?after=999999999')

    expect(res.status).toBe(200)
    const body = (await res.json()) as PullBody
    expect(body.events.map((e) => e.id)).toEqual(['e1', 'e2'])
    expect(body.from).toBe('unknown')
  })

  it('④ 미지 커서 + limit → 가장 오래된 구간이 온다 (§3.1 실패 모드를 직접 겨냥)', async () => {
    await seed(['e1', 'e2', 'e3'])
    const res = await pull('?after=999999999&limit=2')

    expect(res.status).toBe(200)
    const body = (await res.json()) as PullBody
    expect(body.events.map((e) => e.id)).toEqual(['e1', 'e2'])
    expect(body.hasMore).toBe(true)
  })

  it('⑤ 페이지 이어받기 → 두 페이지를 합치면 누락·중복 없이 전량, 순서 보존', async () => {
    await seed(['e1', 'e2', 'e3', 'e4', 'e5'])

    const first = (await (await pull('?limit=2')).json()) as PullBody
    expect(first.events.map((e) => e.id)).toEqual(['e1', 'e2'])
    expect(first.hasMore).toBe(true)

    const second = (await (await pull(`?after=${first.cursor ?? ''}&limit=10`)).json()) as PullBody
    expect(second.events.map((e) => e.id)).toEqual(['e3', 'e4', 'e5'])
    expect(second.hasMore).toBe(false)
  })

  it('⑥ 빈 로그 → 200 + { events: [], hasMore: false, from: "beginning" }', async () => {
    const res = await pull()

    expect(res.status).toBe(200)
    const body = (await res.json()) as PullBody
    expect(body).toEqual({ events: [], hasMore: false, from: 'beginning' })
  })
})
