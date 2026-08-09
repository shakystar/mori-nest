/**
 * 작업공간 생애 추적 — 개시 + 단건 조회 + 파생 상태 (mori-nest #97, #68 범위 5번 조각 1/3),
 * 그리고 하트비트·종료·폐기 전이 (#98 조각 2/3).
 *
 * 두 이슈 본문이 못박은 대로 **다섯 건 + 여섯 건**이고, 그 이상 만들지 않는다. 목록
 * 조회(조각 3/3)는 여기서 다루지 않는다 — 그 라우트가 아직 없다.
 */

import { describe, expect, it } from 'vitest'

import type { RandomBytesFn } from '../src/control/store.js'
import {
  mintWorkspaceId,
  openWorkspaceStore,
  WorkspaceStoreError,
  type WorkspaceStore,
  type WorkspaceStoreFailure,
} from '../src/control/workspace-store.js'

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
