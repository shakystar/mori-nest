/**
 * 작업공간 생애 추적 — 개시 + 단건 조회 + 파생 상태 (mori-nest #97, #68 범위 5번 조각 1/3),
 * 하트비트·종료·폐기 전이 (#98 조각 2/3), 목록 조회 (#99 조각 3/3, #109가 배치
 * `supersededBy` 해소 검증 1건을 얹었다), 그리고 포크 판정 (#117, `§4.10` advisory 조각 1/2).
 *
 * 세 이슈 본문이 못박은 대로 **다섯 건 + 여섯 건 + 다섯 건**(+ #109의 1건 + #117의 세 건)이고,
 * 그 이상 만들지 않는다.
 *
 * 목록 조회·포크 판정 테스트는 `openedAt` 순서/겹침을 검증해야 하는데 `openWorkspace`는
 * `new Date()`로 `openedAt`을 정하므로(주입 지점이 없다), 같은 밀리초에 걸리면 순서·경계
 * 단언이 들쭉날쭉해진다. `vi.useFakeTimers()` + `vi.setSystemTime`으로 각 개시 사이의 시각을
 * 고정해 결정적으로 만든다.
 */

import { describe, expect, it, vi } from 'vitest'

import type { RandomBytesFn } from '../src/control/store.js'
import {
  mintWorkspaceId,
  openWorkspaceStore,
  WorkspaceStoreError,
  type WorkspaceStore,
  type WorkspaceStoreFailure,
} from '../src/control/workspace-store.js'

/** 개시 사이에 `vi.setSystemTime`으로 시각을 옮기며 여러 작업공간을 연다 — 파일 상단 doc
 * "목록 조회 테스트는 openedAt 순서를 검증해야 하는데" 참고. `store.openWorkspace`의
 * `openedAt`이 옮긴 시각 그대로가 되도록 매 반복 사이에 시계를 앞으로 옮긴다. */
async function openSequenced(
  store: WorkspaceStore,
  subject: string,
  timesMs: readonly number[],
): Promise<string[]> {
  const ids: string[] = []
  vi.useFakeTimers()
  try {
    for (const timeMs of timesMs) {
      vi.setSystemTime(timeMs)
      const { workspaceId } = await store.openWorkspace(subject, { logs: ['log-a'] })
      ids.push(workspaceId)
    }
  } finally {
    vi.useRealTimers()
  }
  return ids
}

describe('WorkspaceStore.openWorkspace + getWorkspace', () => {
  it('개시 직후 단건 조회는 active이고 lastHeartbeatAt === openedAt, logs가 요청 그대로이며 replicaId 미신고 시 그 필드가 없다', async () => {
    const store = await openWorkspaceStore(':memory:')

    const { workspaceId } = await store.openWorkspace('alice', { logs: ['log-a', 'log-b'] })
    const record = await store.getWorkspace('alice', workspaceId, { gracePeriodMs: 60_000 })

    expect(record).toBeDefined()
    if (record === undefined) return
    expect(record.state).toBe('active')
    expect(record.lastHeartbeatAt).toBe(record.openedAt)
    expect(record.logs).toEqual(['log-a', 'log-b'])
    expect('replicaId' in record).toBe(false)
  })

  it('lastHeartbeatAt + gracePeriod가 지난 now로 조회하면 abandoned이고, endedAt은 조회 시각과 무관하게 같다', async () => {
    const store = await openWorkspaceStore(':memory:')
    const gracePeriodMs = 1_000

    const { workspaceId } = await store.openWorkspace('alice', { logs: ['log-a'] })
    const opened = await store.getWorkspace('alice', workspaceId, { gracePeriodMs })
    expect(opened).toBeDefined()
    if (opened === undefined) return

    const deadline = new Date(opened.lastHeartbeatAt).getTime() + gracePeriodMs
    const shortlyAfter = new Date(deadline + 1)
    const muchLater = new Date(deadline + 5 * 60_000)

    const record1 = await store.getWorkspace('alice', workspaceId, { gracePeriodMs, now: shortlyAfter })
    const record2 = await store.getWorkspace('alice', workspaceId, { gracePeriodMs, now: muchLater })

    expect(record1?.state).toBe('abandoned')
    expect(record2?.state).toBe('abandoned')
    expect(record1?.endedAt).toBe(new Date(deadline).toISOString())
    expect(record2?.endedAt).toBe(record1?.endedAt)
  })

  it('다른 주체가 같은 workspaceId를 조회하면 없는 것과 같은 실패다', async () => {
    const store = await openWorkspaceStore(':memory:')

    const { workspaceId } = await store.openWorkspace('alice', { logs: ['log-a'] })

    expect(await store.getWorkspace('mallory', workspaceId, { gracePeriodMs: 60_000 })).toBeUndefined()
  })

  it('supersedes로 같은 주체의 이전 작업공간을 이으면 개시가 성공하고, 이전 작업공간의 조회에 supersededBy가 붙는다', async () => {
    const store = await openWorkspaceStore(':memory:')

    const { workspaceId: first } = await store.openWorkspace('alice', { logs: ['log-a'] })
    const { workspaceId: second } = await store.openWorkspace('alice', { logs: ['log-a'], supersedes: first })

    const firstRecord = await store.getWorkspace('alice', first, { gracePeriodMs: 60_000 })
    const secondRecord = await store.getWorkspace('alice', second, { gracePeriodMs: 60_000 })

    expect(firstRecord?.supersededBy).toBe(second)
    expect(secondRecord?.supersedes).toBe(first)
  })

  it('supersedes가 다른 주체의 작업공간이면 개시가 실패하고 기록이 남지 않는다', async () => {
    // 첫 호출은 alice의 기존 작업공간을, 둘째 호출은 mallory가 시도할(그리고 실패할)
    // 작업공간을 mint한다 — 서로 다른 고정 바이트라 두 id가 겹치지 않는다.
    const fixedIds = [Buffer.from('0123456789abcdef', 'utf8'), Buffer.from('fedcba9876543210', 'utf8')]
    let callIndex = 0
    const sequencedRandomBytes: RandomBytesFn = () => {
      const bytes = fixedIds[callIndex]
      callIndex += 1
      if (bytes === undefined) throw new Error('test exhausted its fixed id sequence')
      return bytes
    }

    const store = await openWorkspaceStore(':memory:', { randomBytes: sequencedRandomBytes })
    const { workspaceId: aliceWorkspaceId } = await store.openWorkspace('alice', { logs: ['log-a'] })

    const mallorysAttemptedBytes = fixedIds[1]
    expect(mallorysAttemptedBytes).toBeDefined()
    if (mallorysAttemptedBytes === undefined) return
    const predictedId = mintWorkspaceId(() => mallorysAttemptedBytes)
    expect(predictedId).not.toBe(aliceWorkspaceId)

    await expect(
      store.openWorkspace('mallory', { logs: ['log-b'], supersedes: aliceWorkspaceId }),
    ).rejects.toThrow(WorkspaceStoreError)

    expect(await store.getWorkspace('mallory', predictedId, { gracePeriodMs: 60_000 })).toBeUndefined()
  })
})

/** 실패 이유까지 본다 — 라우트가 `404`(`workspace_not_found`)와 `409`(`workspace_not_active`)로
 * 가르는 근거가 이 문자열이므로, 던졌다는 것만으로는 이 조각의 계약이 확인되지 않는다. */
async function expectFailure(work: Promise<unknown>, reason: WorkspaceStoreFailure): Promise<void> {
  await expect(work).rejects.toThrow(WorkspaceStoreError)
  await work.catch((error: unknown) => {
    expect((error as WorkspaceStoreError).reason).toBe(reason)
  })
}

/** 개시하고 그 `lastHeartbeatAt`(== `openedAt`)을 돌려준다 — 시각 단언의 기준점이다. */
async function openAt(store: WorkspaceStore, gracePeriodMs: number): Promise<{ workspaceId: string; openedAt: number }> {
  const { workspaceId } = await store.openWorkspace('alice', { logs: ['log-a'] })
  const record = await store.getWorkspace('alice', workspaceId, { gracePeriodMs })
  if (record === undefined) throw new Error('개시 직후 조회가 비었다')
  return { workspaceId, openedAt: new Date(record.lastHeartbeatAt).getTime() }
}

describe('WorkspaceStore 전이 — 하트비트·종료·폐기', () => {
  it('하트비트가 lastHeartbeatAt을 앞으로 옮기고 state는 active 그대로다', async () => {
    const store = await openWorkspaceStore(':memory:')
    const gracePeriodMs = 60_000
    const { workspaceId, openedAt } = await openAt(store, gracePeriodMs)

    const beatAt = new Date(openedAt + 5_000)
    const beat = await store.heartbeat('alice', workspaceId, { gracePeriodMs, now: beatAt })
    expect(beat).toEqual({ state: 'active', lastHeartbeatAt: beatAt.toISOString() })

    const record = await store.getWorkspace('alice', workspaceId, { gracePeriodMs, now: beatAt })
    expect(record?.state).toBe('active')
    expect(record?.lastHeartbeatAt).toBe(beatAt.toISOString())
    // 유기 판정의 기준선도 함께 밀렸다 — 옛 기준선이면 이 시각은 이미 유기다.
    expect((await store.getWorkspace('alice', workspaceId, { gracePeriodMs, now: new Date(openedAt + 61_000) }))?.state).toBe(
      'active',
    )
  })

  it('유기 시각이 지난 뒤의 하트비트가 실패하고, 그 뒤 유기 시각 이전의 now로 조회해도 abandoned다', async () => {
    const store = await openWorkspaceStore(':memory:')
    const gracePeriodMs = 1_000
    const { workspaceId, openedAt } = await openAt(store, gracePeriodMs)
    const deadline = openedAt + gracePeriodMs

    await expectFailure(
      store.heartbeat('alice', workspaceId, { gracePeriodMs, now: new Date(deadline + 1) }),
      'workspace_not_active',
    )

    // 확정 + 부활 금지 (`§4.1` MUST NOT): 확정하지 않는 구현이면 여기서 active로 돌아온다.
    const record = await store.getWorkspace('alice', workspaceId, { gracePeriodMs, now: new Date(openedAt + 1) })
    expect(record?.state).toBe('abandoned')
    // 확정된 endedAt은 lastHeartbeatAt + gracePeriod다 — 확정 시각(deadline + 1)도 조회 시각도 아니다.
    expect(record?.endedAt).toBe(new Date(deadline).toISOString())
    // 늦은 하트비트가 두 번 와도 마찬가지다.
    await expectFailure(
      store.heartbeat('alice', workspaceId, { gracePeriodMs, now: new Date(deadline + 10_000) }),
      'workspace_not_active',
    )
    expect((await store.getWorkspace('alice', workspaceId, { gracePeriodMs, now: new Date(openedAt + 1) }))?.state).toBe(
      'abandoned',
    )
  })

  it("close('flushed') 뒤 조회가 closed_flushed이고 endedAt이 RFC 3339로 실린다", async () => {
    const store = await openWorkspaceStore(':memory:')
    const gracePeriodMs = 60_000
    const { workspaceId, openedAt } = await openAt(store, gracePeriodMs)

    const closedAt = new Date(openedAt + 3_000)
    const closed = await store.closeWorkspace('alice', workspaceId, 'flushed', { gracePeriodMs, now: closedAt })
    expect(closed).toEqual({ state: 'closed_flushed', endedAt: closedAt.toISOString() })

    // 종단 상태는 재판정하지 않는다 — grace 창을 한참 넘긴 now로 조회해도 abandoned가 아니다.
    const record = await store.getWorkspace('alice', workspaceId, { gracePeriodMs, now: new Date(openedAt + 600_000) })
    expect(record?.state).toBe('closed_flushed')
    expect(record?.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(record?.endedAt).toBe(closedAt.toISOString())
  })

  it('같은 outcome의 재close는 같은 결과이고, 다른 outcome은 실패한다', async () => {
    const store = await openWorkspaceStore(':memory:')
    const gracePeriodMs = 60_000
    const { workspaceId, openedAt } = await openAt(store, gracePeriodMs)

    const first = await store.closeWorkspace('alice', workspaceId, 'discarded', {
      gracePeriodMs,
      now: new Date(openedAt + 1_000),
    })
    const again = await store.closeWorkspace('alice', workspaceId, 'discarded', {
      gracePeriodMs,
      now: new Date(openedAt + 2_000),
    })
    // 멱등: 두 번째 now로 endedAt을 다시 쓰지 않는다.
    expect(again).toEqual(first)

    await expectFailure(
      store.closeWorkspace('alice', workspaceId, 'flushed', { gracePeriodMs, now: new Date(openedAt + 3_000) }),
      'workspace_not_active',
    )
    expect((await store.getWorkspace('alice', workspaceId, { gracePeriodMs }))?.endedAt).toBe(first.endedAt)
  })

  it('revokeWorkspace가 멱등이고, closed_*인 작업공간에 대한 폐기는 실패한다', async () => {
    const store = await openWorkspaceStore(':memory:')
    const gracePeriodMs = 60_000
    const { workspaceId, openedAt } = await openAt(store, gracePeriodMs)

    const first = await store.revokeWorkspace('alice', workspaceId, { gracePeriodMs, now: new Date(openedAt + 1_000) })
    expect(first.state).toBe('revoked')
    expect(await store.revokeWorkspace('alice', workspaceId, { gracePeriodMs, now: new Date(openedAt + 9_000) })).toEqual(
      first,
    )

    const other = await openAt(store, gracePeriodMs)
    await store.closeWorkspace('alice', other.workspaceId, 'flushed', { gracePeriodMs, now: new Date(other.openedAt + 1) })
    await expectFailure(
      store.revokeWorkspace('alice', other.workspaceId, { gracePeriodMs, now: new Date(other.openedAt + 2) }),
      'workspace_not_active',
    )
    expect((await store.getWorkspace('alice', other.workspaceId, { gracePeriodMs }))?.state).toBe('closed_flushed')
  })

  it('닫힌 작업공간에 대한 하트비트가 실패하고 state가 그대로다 — 없는/다른 주체의 것과는 다른 이유다', async () => {
    const store = await openWorkspaceStore(':memory:')
    const gracePeriodMs = 60_000
    const { workspaceId, openedAt } = await openAt(store, gracePeriodMs)
    const closedAt = new Date(openedAt + 1_000)
    await store.closeWorkspace('alice', workspaceId, 'flushed', { gracePeriodMs, now: closedAt })

    await expectFailure(
      store.heartbeat('alice', workspaceId, { gracePeriodMs, now: new Date(openedAt + 2_000) }),
      'workspace_not_active',
    )

    const record = await store.getWorkspace('alice', workspaceId, { gracePeriodMs })
    expect(record?.state).toBe('closed_flushed')
    expect(record?.endedAt).toBe(closedAt.toISOString())
    expect(record?.lastHeartbeatAt).toBe(new Date(openedAt).toISOString())

    // 라우트가 404와 409로 갈라야 하므로 이 둘은 서로 다른 이유다.
    await expectFailure(
      store.heartbeat('mallory', workspaceId, { gracePeriodMs, now: new Date(openedAt + 2_000) }),
      'workspace_not_found',
    )
    await expectFailure(
      store.heartbeat('alice', 'ws_nonexistent', { gracePeriodMs, now: new Date(openedAt + 2_000) }),
      'workspace_not_found',
    )
  })
})

describe('WorkspaceStore.listWorkspaces', () => {
  it('필터 없이 나열하면 openedAt 오름차순이고, 다른 주체의 작업공간은 실리지 않는다', async () => {
    const store = await openWorkspaceStore(':memory:')
    const gracePeriodMs = 60_000

    // 삽입 순서(2_000 → 3_000 → 1_000)와 openedAt 오름차순(1_000 → 2_000 → 3_000)이 다르게
    // 되도록 일부러 시각을 뒤섞는다 — 응답 순서가 삽입 순서를 우연히 따라가는 것이 아니라
    // 실제로 `openedAt`으로 정렬됐음을 확인한다.
    const [second, third, first] = await openSequenced(store, 'alice', [2_000, 3_000, 1_000])
    await openSequenced(store, 'mallory', [1_500])

    const page = await store.listWorkspaces('alice', { gracePeriodMs })

    expect(page.workspaces.map((w) => w.workspaceId)).toEqual([first, second, third])
    expect(page.hasMore).toBe(false)
  })

  it('§4.7 관찰 조건: 하트비트 뒤 방치된 작업공간이 state=abandoned 필터에 잡히고, endedAt이 lastHeartbeatAt + gracePeriod이며 logs가 개시 시 스코프 그대로다', async () => {
    const store = await openWorkspaceStore(':memory:')
    const gracePeriodMs = 1_000
    const [workspaceId] = await openSequenced(store, 'alice', [0])
    const beatAt = new Date(100)
    await store.heartbeat('alice', workspaceId!, { gracePeriodMs, now: beatAt })
    const deadline = beatAt.getTime() + gracePeriodMs

    const page = await store.listWorkspaces('alice', {
      state: 'abandoned',
      gracePeriodMs,
      now: new Date(deadline + 5_000),
    })

    expect(page.workspaces).toHaveLength(1)
    expect(page.workspaces[0]?.workspaceId).toBe(workspaceId)
    expect(page.workspaces[0]?.state).toBe('abandoned')
    expect(page.workspaces[0]?.endedAt).toBe(new Date(deadline).toISOString())
    expect(page.workspaces[0]?.logs).toEqual(['log-a'])
  })

  it('필터 → 정렬 → limit 순서: 유기 1건 + 그보다 나중에 열린 active 여러 건에서 state=abandoned + limit=1이 그 유기 1건을 돌려주고 hasMore가 false다', async () => {
    const store = await openWorkspaceStore(':memory:')
    const gracePeriodMs = 1_000

    // ws1은 개시 후 하트비트 없이 방치된다 — 나머지 둘은 ws1의 유기 시각(1_000)이 지난
    // 뒤에 열려 아직 자기 grace 안이다(개시 시각 == lastHeartbeatAt이 그 시각의 deadline).
    // 조회 시각(now)도 gracePeriodMs + 2로 고정한다 — 실시각을 쓰면(그때는 이미 세 작업공간
    // 모두 grace를 한참 넘긴 뒤이므로) 나머지 둘도 abandoned로 잡혀 이 시험이 성립하지 않는다.
    const [abandonedId] = await openSequenced(store, 'alice', [0])
    await openSequenced(store, 'alice', [gracePeriodMs + 1, gracePeriodMs + 2])

    const page = await store.listWorkspaces('alice', {
      state: 'abandoned',
      limit: 1,
      gracePeriodMs,
      now: new Date(gracePeriodMs + 2),
    })

    expect(page.workspaces.map((w) => w.workspaceId)).toEqual([abandonedId])
    expect(page.hasMore).toBe(false)
  })

  it('커서로 다음 페이지를 이어 받으면 앞 페이지 항목이 반복되지 않고 전량이 정확히 한 번씩 나온다', async () => {
    const store = await openWorkspaceStore(':memory:')
    const gracePeriodMs = 60_000
    const ids = await openSequenced(store, 'alice', [0, 1_000, 2_000, 3_000, 4_000])

    const firstPage = await store.listWorkspaces('alice', { limit: 2, gracePeriodMs })
    expect(firstPage.workspaces.map((w) => w.workspaceId)).toEqual(ids.slice(0, 2))
    expect(firstPage.hasMore).toBe(true)
    const firstCursor = firstPage.cursor
    if (firstCursor === undefined) throw new Error('cursor가 비어 있다')

    const secondPage = await store.listWorkspaces('alice', { limit: 2, after: firstCursor, gracePeriodMs })
    expect(secondPage.workspaces.map((w) => w.workspaceId)).toEqual(ids.slice(2, 4))
    expect(secondPage.hasMore).toBe(true)
    const secondCursor = secondPage.cursor
    if (secondCursor === undefined) throw new Error('cursor가 비어 있다')

    const thirdPage = await store.listWorkspaces('alice', { limit: 2, after: secondCursor, gracePeriodMs })
    expect(thirdPage.workspaces.map((w) => w.workspaceId)).toEqual(ids.slice(4, 5))
    expect(thirdPage.hasMore).toBe(false)

    const seen = [...firstPage.workspaces, ...secondPage.workspaces, ...thirdPage.workspaces].map((w) => w.workspaceId)
    expect(seen).toEqual(ids)
    expect(new Set(seen).size).toBe(ids.length)
  })

  it('mori-nest #109: 승계자가 둘 이상인 작업공간을 포함한 목록 조회에서 supersededBy가 getWorkspace와 같은 값(workspaceId 사전순 최소)이고, 승계되지 않은 행에는 그 필드가 없다', async () => {
    const store = await openWorkspaceStore(':memory:')
    const gracePeriodMs = 60_000

    const [target] = await openSequenced(store, 'alice', [0])
    const [untouched] = await openSequenced(store, 'alice', [1_000])
    await store.openWorkspace('alice', { logs: ['log-a'], supersedes: target! })
    await store.openWorkspace('alice', { logs: ['log-a'], supersedes: target! })

    const targetFromGet = await store.getWorkspace('alice', target!, { gracePeriodMs })
    const page = await store.listWorkspaces('alice', { gracePeriodMs })

    const targetFromList = page.workspaces.find((w) => w.workspaceId === target)
    const untouchedFromList = page.workspaces.find((w) => w.workspaceId === untouched)
    expect(targetFromList?.supersededBy).toBeDefined()
    expect(targetFromList?.supersededBy).toBe(targetFromGet?.supersededBy)
    expect('supersededBy' in (untouchedFromList ?? {})).toBe(false)
  })

  it('state가 다섯 이름 밖이면 실패하고, 해석 불가 커서도 실패한다 (둘 다 «전부 반환»으로 떨어지지 않는다)', async () => {
    const store = await openWorkspaceStore(':memory:')
    const gracePeriodMs = 60_000
    await openSequenced(store, 'alice', [0])

    await expectFailure(store.listWorkspaces('alice', { state: 'bogus', gracePeriodMs }), 'invalid_state_filter')
    await expectFailure(store.listWorkspaces('alice', { state: '', gracePeriodMs }), 'invalid_state_filter')
    await expectFailure(store.listWorkspaces('alice', { after: 'not-a-cursor', gracePeriodMs }), 'invalid_cursor')
  })
})

/** 고정 시각에 `replicaId`를 신고하며 개시한다 — `openSequenced`와 같은 이유(파일 상단 doc)로
 * `openedAt`을 결정적으로 만든다. 호출 전에 `vi.useFakeTimers()`가 이미 걸려 있어야 한다. */
async function openReplicaAt(
  store: WorkspaceStore,
  subject: string,
  replicaId: string | undefined,
  atMs: number,
): Promise<string> {
  vi.setSystemTime(atMs)
  const { workspaceId } = await store.openWorkspace(subject, { logs: ['log-a'], ...(replicaId === undefined ? {} : { replicaId }) })
  return workspaceId
}

describe('WorkspaceStore.findForkAdvisory (§4.10 포크 판정, advisory 조각 1/2)', () => {
  it('겹치면 advisory가 나온다 — 같은 replicaId의 두 active, 그리고 abandoned(파생) ↔ active', async () => {
    // 모양 1: 같은 replicaId의 두 active 작업공간.
    const store1 = await openWorkspaceStore(':memory:')
    vi.useFakeTimers()
    const a1 = await openReplicaAt(store1, 'alice', 'r1', 0)
    const b1 = await openReplicaAt(store1, 'alice', 'r1', 1_000)
    vi.useRealTimers()

    expect(await store1.findForkAdvisory('alice', a1, { gracePeriodMs: 60_000, now: new Date(2_000) })).toEqual({
      replicaId: 'r1',
      overlappingWorkspaceId: b1,
    })

    // 모양 2: a2는 하트비트 없이 방치돼 조회 시각(1_400)엔 이미 파생 abandoned(deadline 1_000)다
    // — 그래도 b2가 열린 시각(500)엔 a2가 아직 안 닫혀 있었으므로 두 활성 구간이 겹친다.
    // a2 구간 [0, 1_000), b2 구간 [500, 1_400)(b2는 조회 시각에도 아직 active).
    const store2 = await openWorkspaceStore(':memory:')
    const gracePeriodMs2 = 1_000
    vi.useFakeTimers()
    const a2 = await openReplicaAt(store2, 'alice', 'r1', 0)
    const b2 = await openReplicaAt(store2, 'alice', 'r1', 500)
    vi.useRealTimers()

    expect(await store2.findForkAdvisory('alice', b2, { gracePeriodMs: gracePeriodMs2, now: new Date(1_400) })).toEqual({
      replicaId: 'r1',
      overlappingWorkspaceId: a2,
    })
  })

  it('안 겹치면 undefined다 — close 뒤에 열린 경우와, endedAt과 openedAt이 정확히 맞닿는 경계 접촉', async () => {
    const gracePeriodMs = 60_000

    // close 뒤에 열린 경우: b의 openedAt(200)이 a의 endedAt(100)보다 뒤다.
    const store1 = await openWorkspaceStore(':memory:')
    vi.useFakeTimers()
    const a1 = await openReplicaAt(store1, 'alice', 'r1', 0)
    vi.setSystemTime(100)
    await store1.closeWorkspace('alice', a1, 'flushed', { gracePeriodMs, now: new Date(100) })
    const b1 = await openReplicaAt(store1, 'alice', 'r1', 200)
    vi.useRealTimers()

    expect(await store1.findForkAdvisory('alice', b1, { gracePeriodMs, now: new Date(300) })).toBeUndefined()

    // 경계 접촉: c의 openedAt이 a2의 endedAt과 정확히 같다 — 반열린 구간이라 겹침이 아니다.
    const store2 = await openWorkspaceStore(':memory:')
    vi.useFakeTimers()
    const a2 = await openReplicaAt(store2, 'alice', 'r1', 0)
    vi.setSystemTime(100)
    await store2.closeWorkspace('alice', a2, 'flushed', { gracePeriodMs, now: new Date(100) })
    const c = await openReplicaAt(store2, 'alice', 'r1', 100)
    vi.useRealTimers()

    expect(await store2.findForkAdvisory('alice', c, { gracePeriodMs, now: new Date(200) })).toBeUndefined()
  })

  it('제외 규칙 — 자기 자신뿐인 경우, 다른 주체의 같은 replicaId, 상대의 replicaId 미신고는 모두 undefined다', async () => {
    const store = await openWorkspaceStore(':memory:')
    const gracePeriodMs = 60_000
    vi.useFakeTimers()
    const self = await openReplicaAt(store, 'alice', 'r1', 0)
    vi.useRealTimers()
    expect(await store.findForkAdvisory('alice', self, { gracePeriodMs, now: new Date(1_000) })).toBeUndefined()

    // 다른 주체가 같은 replicaId·겹치는 시간으로 열려도, subject가 다르면 비교되지 않는다.
    vi.useFakeTimers()
    await openReplicaAt(store, 'mallory', 'r1', 500)
    vi.useRealTimers()
    expect(await store.findForkAdvisory('alice', self, { gracePeriodMs, now: new Date(1_000) })).toBeUndefined()

    // 같은 주체·겹치는 시간이라도 상대가 replicaId를 신고하지 않았으면 비교되지 않는다.
    vi.useFakeTimers()
    await openReplicaAt(store, 'alice', undefined, 600)
    vi.useRealTimers()
    expect(await store.findForkAdvisory('alice', self, { gracePeriodMs, now: new Date(1_000) })).toBeUndefined()
  })
})
