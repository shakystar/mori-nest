import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseAppendRequest } from '../src/event.js'
import type { PullEvent } from '../src/pull.js'
import type { CursorStart } from '../src/request.js'
import { EventStoreError, openEventStore, type EventProvenance, type EventStore } from '../src/store.js'

/**
 * 이 파일의 테스트는 **동작 하나당 하나**이고 아홉 개다 (mori-nest #27의 «테스트» 절 여섯 +
 * #46의 출처 축 셋). 커버리지 숫자용·스냅샷·구현 세부 결합 테스트를 여기에 더하지 않는다 —
 * 스토어의 계약은 `0002`의 MUST 줄들이고, 그 줄들이 여기 하나씩 대응한다.
 */

/** `§1.6`의 출처 값. 재는 대상이 출처가 아닌 시험들은 이것 하나를 그대로 쓴다. */
const PROVENANCE: EventProvenance = { workspaceId: 'ws_test', tokenId: 'tok_test' }

const DURABILITY_CHILD = fileURLToPath(new URL('./store-durability-child.mjs', import.meta.url))
const RACE_CHILD = fileURLToPath(new URL('./store-race-child.mjs', import.meta.url))

/**
 * `--experimental-strip-types`를 명시한다. Node 22.18+는 기본으로 켜지만, 명시해 두면 이
 * 테스트가 어느 22.x에서 도는지에 결과가 걸리지 않는다 (CI는 22.23.1로 핀돼 있다).
 */
const NODE_ARGS = ['--experimental-strip-types']

/**
 * 라운드 수. CI(ubuntu) 한 번에 이 테스트가 쓰는 시간이 대략 `ROUNDS × (spawn + kill 지연)`
 * ≈ 12 × 0.3s ≈ 4초가 되도록 골랐다 — `synchronous=FULL`이라 커밋마다 fsync가 걸리고, 그래도
 * 라운드당 수십~수백 건의 ack가 쌓여 표본은 충분하다. 라운드를 늘리는 것보다 **매 라운드가
 * 서로 다른 시점에 죽는 것**이 이 시험의 값이므로, kill 지연을 난수로 흩는 쪽에 무게를 뒀다.
 */
const ROUNDS = 12

/** kill 지연의 범위(ms). 하한이 0이 아닌 것은 ack 0건인 라운드를 만들지 않기 위해서다. */
const MIN_KILL_DELAY_MS = 40
const MAX_KILL_DELAY_MS = 250

/**
 * 기록된 행의 출처 컬럼을 **DB에서 직접** 읽는다.
 *
 * `EventStore`의 표면으로는 읽을 수 없는 것이 `§1.6`의 요점이다 — 출처는 pull·subscribe 응답에
 * 실리지 않으므로(MUST NOT), 「기록됐는가」를 재려면 기록 층을 직접 보는 수밖에 없다. 스토어를
 * 열어 두고 두 번째 연결로 읽는다 (WAL이라 커밋된 것은 그대로 보인다).
 */
function readProvenanceRow(path: string, logId: string, eventId: string): Record<string, SQLOutputValue> {
  const db = new DatabaseSync(path)
  try {
    const row = db
      .prepare('SELECT workspace_id, token_id FROM events WHERE log_id = ? AND event_id = ?')
      .get(logId, eventId)
    if (row === undefined) {
      throw new Error(`기록된 행이 없다: ${logId}/${eventId}`)
    }
    return row
  } finally {
    db.close()
  }
}

/** `event.ts`의 게이트를 실제로 통과시켜 **원문 조각**을 얻는다 (`test/pull.test.ts`와 같은 방식). */
function payloadSliceOf(body: string): string {
  const parsed = parseAppendRequest(body)
  if (!parsed.ok) {
    throw new Error('테스트 본문이 append 게이트를 통과하지 못했다')
  }
  const payload = parsed.events[0]?.payload
  if (payload === undefined) {
    throw new Error('테스트 본문에 이벤트가 없다')
  }
  return payload
}

/** 로그 전체를 페이지를 이어 받아 읽는다 (`§3.1`의 `hasMore` 이어받기 그대로). */
async function readAllEvents(store: EventStore, logId: string): Promise<PullEvent[]> {
  const events: PullEvent[] = []
  let start: CursorStart = { kind: 'beginning' }
  for (;;) {
    const page = await store.readPage(logId, start, 100)
    events.push(...page.events)
    const last = page.events[page.events.length - 1]
    if (!page.hasMore || last === undefined) {
      return events
    }
    start = { kind: 'after', cursor: last.cursor }
  }
}

/**
 * `needle`이 `haystack`의 **부분열**인가 (순서를 지키며 등장하는가).
 *
 * `§2.2`가 요구하는 것이 정확히 이것이다 — *"모든 id가 그대로, 같은 상대 순서로 나타난다."*
 * 동등 비교가 아닌 이유: 커밋은 됐는데 ack를 적기 전에 죽은 이벤트는 로그에 남아 있어도
 * 되고(`§2.2` *"역은 보장되지 않는다"*), 그것을 위반으로 세면 스펙이 허용한 것을 테스트가
 * 금지하게 된다.
 */
function isSubsequence(needle: readonly string[], haystack: readonly string[]): boolean {
  let index = 0
  for (const item of haystack) {
    if (index < needle.length && needle[index] === item) {
      index++
    }
  }
  return index === needle.length
}

/** 자식을 띄워 append를 돌리다 임의 시점에 SIGKILL하고, 그때까지 ack된 id들을 돌려준다. */
function runDurabilityRound(dbPath: string, logId: string, round: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...NODE_ARGS, DURABILITY_CHILD, dbPath, logId, String(round)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const acks: string[] = []
    let pending = ''
    let stderr = ''
    let killTimer: ReturnType<typeof setTimeout> | undefined

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (line === 'ready') {
          const delay =
            MIN_KILL_DELAY_MS + Math.floor(Math.random() * (MAX_KILL_DELAY_MS - MIN_KILL_DELAY_MS))
          killTimer = setTimeout(() => child.kill('SIGKILL'), delay)
        } else if (line !== '') {
          acks.push(line)
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', () => {
      if (killTimer !== undefined) {
        clearTimeout(killTimer)
      }
      if (acks.length === 0) {
        reject(new Error(`라운드 ${round}: 자식이 ack를 하나도 남기지 않았다\n${stderr}`))
        return
      }
      resolve(acks)
    })
  })
}

type RaceResult = {
  accepted: { id: string; cursor: string }[]
  duplicate: { id: string; cursor: string }[]
}

/** 같은 id 집합을 `startAt`에 맞춰 동시에 미는 자식 하나. */
function runRaceChild(dbPath: string, logId: string, startAt: number, ids: readonly string[]): Promise<RaceResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...NODE_ARGS, RACE_CHILD, dbPath, logId, String(startAt), ids.join(',')],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`경쟁 자식이 ${String(code)}로 끝났다\n${stderr}`))
        return
      }
      // `JSON.parse`를 감싸는 이유: 자식이 `0`으로 끝났는데 stdout이 비면(출력 경로가 깨진
      // 경우) 여기서 던진 예외는 **리스너 안의 미포착 예외**가 되어 테스트가 실패가 아니라
      // 크래시로 끝난다. 실패는 실패로 보여야 한다.
      try {
        resolve(JSON.parse(stdout) as RaceResult)
      } catch {
        reject(new Error(`경쟁 자식의 출력이 JSON이 아니다 (${stdout.length}바이트)\n${stderr}`))
      }
    })
  })
}

describe('이벤트 스토어 (0002 §1.3·§1.4·§2.1·§2.2·§3.1·§3.2)', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mori-nest-store-'))
    dbPath = join(dir, 'events.db')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it(
    '① kill -9 뒤에도 ack된 전량이 같은 상대 순서로 남는다 (§2.2)',
    async () => {
      const acked: string[] = []

      for (let round = 0; round < ROUNDS; round++) {
        acked.push(...(await runDurabilityRound(dbPath, 'durable', round)))

        // 재기동. 여는 것 자체가 WAL 복구를 돌린다.
        const store = await openEventStore(dbPath)
        const stored = await readAllEvents(store, 'durable')
        await store.close()

        const storedIds = stored.map((event) => event.id)
        // 중복 기록이 없다 — 재기동이 이벤트를 두 번 만들지 않는다.
        expect(new Set(storedIds).size).toBe(storedIds.length)
        // `§2.2`의 관찰 조건 그 자체.
        expect(isSubsequence(acked, storedIds)).toBe(true)
        // `§1.4`: 한 번 확정된 상대 순서는 재부팅에도 바뀌지 않는다 — 커서가 그 근거이므로
        // 전순서대로 읽은 커서는 단조 증가해야 한다.
        const cursors = stored.map((event) => Number(event.cursor))
        expect(cursors).toEqual([...cursors].sort((a, b) => a - b))
      }

      // 표본이 실제로 쌓였는지 — 라운드가 전부 빈손이면 위 단언이 공허하게 통과한다.
      expect(acked.length).toBeGreaterThan(ROUNDS)
    },
    120_000,
  )

  it(
    '② 같은 id를 담은 두 프로세스의 동시 append가 정확히 한 번만 기록된다 (§2.1)',
    async () => {
      // 스키마를 먼저 만들어 둔다 — 재는 대상은 dedup이지 DDL 경쟁이 아니다.
      const seed = await openEventStore(dbPath)
      await seed.close()

      const ids = ['x1', 'x2', 'x3', 'x4', 'x5']
      const startAt = Date.now() + 400
      const [first, second] = await Promise.all([
        runRaceChild(dbPath, 'raced', startAt, ids),
        runRaceChild(dbPath, 'raced', startAt, ids),
      ])

      for (const id of ids) {
        const acceptedIn = [first, second].filter((r) => r.accepted.some((e) => e.id === id))
        const duplicateIn = [first, second].filter((r) => r.duplicate.some((e) => e.id === id))
        // 정확히 한 요청만 `accepted`, 나머지는 `duplicate` (§2.1 L196-200 MUST).
        expect(acceptedIn.length).toBe(1)
        expect(duplicateIn.length).toBe(1)
        // `duplicate`의 커서는 **먼저 저장돼 있던 사본**의 것이다 (L194) — 두 값이 같아야 한다.
        const acceptedCursor = acceptedIn[0]?.accepted.find((e) => e.id === id)?.cursor
        const duplicateCursor = duplicateIn[0]?.duplicate.find((e) => e.id === id)?.cursor
        expect(duplicateCursor).toBe(acceptedCursor)
      }

      const store = await openEventStore(dbPath)
      const stored = await readAllEvents(store, 'raced')
      await store.close()
      // 로그에 정확히 한 번씩.
      expect([...stored.map((e) => e.id)].sort()).toEqual([...ids].sort())
    },
    60_000,
  )

  it('③ 한 요청의 이벤트가 요청 배열 순서 그대로 기록된다 (§1.4)', async () => {
    const store = await openEventStore(dbPath)
    // 사전순으로도 삽입순으로도 정렬돼 있지 않은 id들 — 저장소가 몰래 정렬하면 드러난다.
    const ids = ['zeta', 'alpha', 'mu', 'beta', 'chi']

    const result = await store.append(
      'ordered',
      ids.map((id, index) => ({ id, payload: `{"i":${index}}` })),
      PROVENANCE,
    )

    expect(result.accepted.map((e) => e.id)).toEqual(ids)
    expect(result.duplicate).toEqual([])

    const stored = await readAllEvents(store, 'ordered')
    expect(stored.map((e) => e.id)).toEqual(ids)
    await store.close()
  })

  it('④ 요청 안 하나가 실패하면 그 요청의 이벤트가 하나도 남지 않는다 (§2.1 L207-208)', async () => {
    const store = await openEventStore(dbPath)
    await store.append('atomic', [{ id: 'before', payload: '{"kept":true}' }], PROVENANCE)

    // 두 번째 이벤트가 실패한다 — **첫 번째는 이미 INSERT된 뒤**이므로 이 단언은 롤백을 본다
    // (요청 전체를 미리 검사하고 트랜잭션을 열지 않는 구현이면 이 시험은 아무것도 재지 못한다).
    await expect(
      store.append(
        'atomic',
        [
          { id: 'ok', payload: '{"a":1}' },
          { id: 'bad', payload: '   ' },
          { id: 'never', payload: '{"b":2}' },
        ],
        PROVENANCE,
      ),
    ).rejects.toBeInstanceOf(EventStoreError)

    const stored = await readAllEvents(store, 'atomic')
    expect(stored.map((e) => e.id)).toEqual(['before'])
    await store.close()
  })

  it('⑤ payload가 바이트 그대로 왕복한다 (§1.3 L96-101)', async () => {
    const store = await openEventStore(dbPath)
    // `JSON.parse` -> `JSON.stringify` 왕복이 깨뜨리는 것들 + UTF-8 다바이트 + 이스케이프 원문.
    const bodies = [
      '{"events":[{"id":"a","payload":{ "b" : 1 , "a" : 2 }}]}',
      '{"events":[{"id":"b","payload":1.0}]}',
      '{"events":[{"id":"c","payload":"한글 😀 é"}]}',
      '{"events":[{"id":"d","payload":"\\u00e9 \\u0000 \\ud83d\\ude00"}]}',
      '{"events":[{"id":"e","payload":[1,   2,\t3]}]}',
    ]
    const slices = bodies.map(payloadSliceOf)

    await store.append(
      'bytes',
      slices.map((payload, index) => ({ id: `p${index}`, payload })),
      PROVENANCE,
    )

    const stored = await readAllEvents(store, 'bytes')
    expect(stored.map((e) => e.payload)).toEqual(slices)
    // 문자열 동등만으로는 "바이트 동일"을 말할 수 없다 — 실제 UTF-8 바이트로도 대조한다.
    for (const [index, event] of stored.entries()) {
      expect(Buffer.from(event.payload, 'utf8').equals(Buffer.from(slices[index] ?? '', 'utf8'))).toBe(true)
    }
    await store.close()
  })

  it('⑥ 커서가 쿼리스트링 왕복을 견디고, 미지 커서가 미지로 판정된다 (§1.4·§3.2)', async () => {
    const store = await openEventStore(dbPath)
    const ids = ['c0', 'c1', 'c2', 'c3']
    const { accepted } = await store.append(
      'cursors',
      ids.map((id) => ({ id, payload: `{"id":${JSON.stringify(id)}}` })),
      PROVENANCE,
    )
    // 다른 로그의 커서를 얻어 둔다 (`§1.4` — 다른 로그의 커서는 미지다).
    const foreign = await store.append('other-log', [{ id: 'f0', payload: '{"x":1}' }], PROVENANCE)
    const foreignCursor = foreign.accepted[0]?.cursor ?? ''
    const cursor = accepted[0]?.cursor ?? ''

    // 알파벳: `+`·공백·`&`·`=`·`%`·`#`가 나타나지 않는다 (#15의 14:31 제약).
    expect(cursor).toMatch(/^[0-9]+$/)
    for (const forbidden of ['+', ' ', '&', '=', '%', '#']) {
      expect(cursor).not.toContain(forbidden)
    }

    // `application/x-www-form-urlencoded` 왕복. `request.ts`의 `queryValue`가 하는 표준
    // 디코딩과 같은 경로다 — `+`를 쓰는 알파벳이면 여기서 공백이 되어 돌아온다.
    const encoded = new URLSearchParams([['after', cursor]]).toString()
    const decoded = new URLSearchParams(encoded).get('after')
    expect(decoded).toBe(cursor)

    // 왕복한 커서가 **같은 자리**를 가리킨다. 커서로 페이지를 잇는 것이 `§3.1`의 이어받기이므로
    // `limit`을 함께 쓴다.
    const known = await store.readPage('cursors', { kind: 'after', cursor: decoded ?? '' }, 2)
    expect(known.from).toBe('known')
    expect(known.events.map((e) => e.id)).toEqual(['c1', 'c2'])
    expect(known.hasMore).toBe(true)
    // `limit`이 페이지 크기를 통째로 끄지 못한다 — SQLite는 음수 `LIMIT`을 "제한 없음"으로
    // 해석하므로, 이 거부가 없으면 로그 전체가 한 응답에 실린다.
    await expect(store.readPage('cursors', { kind: 'beginning' }, -1)).rejects.toBeInstanceOf(EventStoreError)

    // 미지 커서 셋 — 형식 위반, 이 로그에 없는 자리, 다른 로그의 커서. 대응은 하나다:
    // **에러가 아니라** 로그의 처음부터 전량 (`§3.2` MUST / head부터는 MUST NOT).
    for (const unknown of ['not-a-cursor', '999999', foreignCursor]) {
      const page = await store.readPage('cursors', { kind: 'after', cursor: unknown })
      expect(page.from).toBe('unknown')
      expect(page.events.map((e) => e.id)).toEqual(ids)
    }

    await store.close()
  })

  it('⑦ append가 검증된 토큰의 workspaceId·tokenId를 기록에 남긴다 (§1.6)', async () => {
    const store = await openEventStore(dbPath)
    const provenance: EventProvenance = { workspaceId: 'ws_01HAAA', tokenId: 'tok_01HAAA' }

    await store.append('provenance', [{ id: 'p0', payload: '{"a":1}' }], provenance)
    await store.close()

    const row = readProvenanceRow(dbPath, 'provenance', 'p0')
    expect(row['workspace_id']).toBe(provenance.workspaceId)
    expect(row['token_id']).toBe(provenance.tokenId)
  })

  it('⑧ 다른 작업공간이 같은 id를 다시 밀어도 기존 행의 출처가 바뀌지 않는다 (§1.6 MUST NOT)', async () => {
    const store = await openEventStore(dbPath)
    const first: EventProvenance = { workspaceId: 'ws_first', tokenId: 'tok_first' }
    const impostor: EventProvenance = { workspaceId: 'ws_impostor', tokenId: 'tok_impostor' }

    await store.append('spoof', [{ id: 's0', payload: '{"a":1}' }], first)
    const result = await store.append('spoof', [{ id: 's0', payload: '{"a":2}' }], impostor)
    await store.close()

    expect(result.accepted).toEqual([])
    expect(result.duplicate.map((e) => e.id)).toEqual(['s0'])
    // 사칭 불가가 이 축을 세운 이유다 — 나중에 미는 쪽이 남의 이벤트 출처를 자기 것으로
    // 바꿀 수 있으면 축 자체가 뜻을 잃는다.
    const row = readProvenanceRow(dbPath, 'spoof', 's0')
    expect(row['workspace_id']).toBe(first.workspaceId)
    expect(row['token_id']).toBe(first.tokenId)
  })

  it('⑨ v1 DB를 열면 v2로 올라가고, 그 전에 쌓인 이벤트가 그대로 읽힌다 (스키마 이주)', async () => {
    // v1 그대로의 DB를 손으로 만든다 — 출처 컬럼이 없고 `user_version = 1`이다.
    const v1 = new DatabaseSync(dbPath)
    v1.exec('PRAGMA journal_mode = WAL')
    v1.exec('PRAGMA synchronous = FULL')
    v1.exec(`
      CREATE TABLE events (
        seq      INTEGER PRIMARY KEY AUTOINCREMENT,
        log_id   TEXT NOT NULL,
        event_id TEXT NOT NULL,
        payload  BLOB NOT NULL,
        UNIQUE (log_id, event_id)
      ) STRICT;
      CREATE INDEX events_log_seq ON events (log_id, seq);
    `)
    v1.prepare('INSERT INTO events (log_id, event_id, payload) VALUES (?, ?, ?)').run(
      'legacy',
      'old0',
      Buffer.from('{"old":true}', 'utf8'),
    )
    v1.exec('PRAGMA user_version = 1')
    v1.close()

    const store = await openEventStore(dbPath)
    // v1 시절 이벤트가 그대로 읽힌다 — 이주가 로그를 버리지 않는다 (`§1.4`).
    const stored = await readAllEvents(store, 'legacy')
    expect(stored.map((e) => e.id)).toEqual(['old0'])
    expect(stored[0]?.payload).toBe('{"old":true}')
    // 이주 뒤의 append는 출처를 정상적으로 남긴다.
    await store.append('legacy', [{ id: 'new0', payload: '{"new":true}' }], PROVENANCE)
    await store.close()

    const migrated = new DatabaseSync(dbPath)
    const version = migrated.prepare('PRAGMA user_version').get()?.['user_version']
    migrated.close()
    expect(Number(version)).toBe(2)
    // 고른 이주 경로가 그대로 관찰된다: v1 행의 출처는 `NULL`(= 물을 수 없는 행)이고,
    // 지어낸 값이 채워져 있지 않다. v2가 쓴 행에는 값이 있다.
    const legacyRow = readProvenanceRow(dbPath, 'legacy', 'old0')
    expect(legacyRow['workspace_id']).toBeNull()
    expect(legacyRow['token_id']).toBeNull()
    const freshRow = readProvenanceRow(dbPath, 'legacy', 'new0')
    expect(freshRow['workspace_id']).toBe(PROVENANCE.workspaceId)
    expect(freshRow['token_id']).toBe(PROVENANCE.tokenId)
  })
})
