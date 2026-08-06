/**
 * append 라우트 배선 (`0002 §2`) — `verifyTransportRequest` → `parseAppendRequest` →
 * `store.append` → 응답이 옳은 순서로 이어지는가와, 스토어 결과가 계약대로 응답에 옮겨지는가만
 * 본다.
 *
 * 게이트 자신의 동작(토큰·봉투·바이트 슬라이스)은 `test/token.test.ts`·`test/event.test.ts`·
 * `test/request.test.ts`가 이미 덮는다 — 여기서 다시 쓰지 않는다 (mori-nest #28의 «비범위»).
 * 동작 하나당 테스트 하나, 여섯 개뿐이다 (여섯째는 `§1.6`의 출처 배선 — mori-nest #46).
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

const LOG_ID = 'log_append-route'
const TOKEN = mint(baseClaims({ scope: [LOG_ID] }))

describe('append 라우트 배선 + 최소 HTTP 서버 (0002 §2)', () => {
  let dir: string
  let dbPath: string
  let store: EventStore
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mori-nest-server-'))
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

  function post(body: string): Promise<Response> {
    return fetch(`${baseUrl}/v1/logs/${LOG_ID}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body,
    })
  }

  async function loggedIds(): Promise<string[]> {
    const page = await store.readPage(LOG_ID, { kind: 'beginning' }, 100)
    return page.events.map((event) => event.id)
  }

  it('① 정상 append → 200, accepted에 실린 id가 스토어에서 읽힌다', async () => {
    const res = await post('{"events":[{"id":"e1","payload":{"a":1}}]}')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { accepted: { id: string }[]; duplicate: { id: string }[] }
    expect(body.accepted.map((e) => e.id)).toEqual(['e1'])
    expect(body.duplicate).toEqual([])
    expect(await loggedIds()).toEqual(['e1'])
  })

  it('② 같은 id 재요청 → 200, duplicate에 실리고 로그에는 한 번만 있다', async () => {
    await post('{"events":[{"id":"e1","payload":{"a":1}}]}')
    const res = await post('{"events":[{"id":"e1","payload":{"a":2}}]}')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { accepted: { id: string }[]; duplicate: { id: string }[] }
    expect(body.accepted).toEqual([])
    expect(body.duplicate.map((e) => e.id)).toEqual(['e1'])
    expect(await loggedIds()).toEqual(['e1'])
  })

  it('③ 빈 events → 400 malformed_request, 로그 무변경', async () => {
    const res = await post('{"events":[]}')

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('malformed_request')
    expect(await loggedIds()).toEqual([])
  })

  it('④ 이벤트 하나가 검증 실패 → 400 + details.eventId, 그 요청의 어떤 이벤트도 로그에 없다', async () => {
    const res = await post(
      '{"events":[{"id":"e1","payload":{"a":1}},{"id":"e1","payload":{"a":2}}]}',
    )

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; details?: { eventId?: string } } }
    expect(body.error.code).toBe('invalid_event')
    expect(body.error.details?.eventId).toBe('e1')
    expect(await loggedIds()).toEqual([])
  })

  it('⑤ 성공 응답 본문에 head 커서가 없다', async () => {
    const res = await post('{"events":[{"id":"e1","payload":{"a":1}}]}')

    const body = (await res.json()) as Record<string, unknown>
    expect(Object.hasOwn(body, 'head')).toBe(false)
    expect(Object.keys(body).sort()).toEqual(['accepted', 'duplicate'])
  })

  it('⑥ 라우트를 통과한 append가 그 토큰의 workspaceId·tokenId를 기록에 남긴다 (§1.6)', async () => {
    const claims = baseClaims({ scope: [LOG_ID] })

    const res = await post('{"events":[{"id":"e1","payload":{"a":1}}]}')
    expect(res.status).toBe(200)

    // 스토어 단위 시험으로는 «배선이 끊겼다»를 잡을 수 없다 — `§1.6`이 지목한 실패 형태가
    // 검증 결과가 기록 층까지 닿지 않는 것이므로, 라우트를 실제로 통과하는 검사가 필요하다.
    // 출처는 응답에 실리지 않으므로(MUST NOT) 기록 층을 직접 본다.
    const db = new DatabaseSync(dbPath)
    const row = db
      .prepare('SELECT workspace_id, token_id FROM events WHERE log_id = ? AND event_id = ?')
      .get(LOG_ID, 'e1')
    db.close()
    expect(row?.['workspace_id']).toBe(claims.workspaceId)
    expect(row?.['token_id']).toBe(claims.tokenId)
  })
})
