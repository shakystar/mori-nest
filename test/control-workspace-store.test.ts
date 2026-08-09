/**
 * 작업공간 생애 추적 — 개시 + 단건 조회 + 파생 상태 (mori-nest #97, #68 범위 5번 조각 1/3).
 *
 * 이슈 본문이 못박은 대로 **다섯 건**이고, 그 이상 만들지 않는다. 하트비트·종료·폐기
 * 전이(조각 2/3)와 목록 조회(조각 3/3)는 여기서 다루지 않는다 — 그 라우트가 아직 없다.
 */

import { describe, expect, it } from 'vitest'

import type { RandomBytesFn } from '../src/control/store.js'
import { mintWorkspaceId, openWorkspaceStore, WorkspaceStoreError } from '../src/control/workspace-store.js'

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
