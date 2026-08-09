/**
 * 제어 평면 스토어 — `logId` mint와 (주체, 로그) 다대다 관계 (mori-nest #72).
 *
 * 이슈 본문이 못박은 대로 **여섯 건**이고, 그 이상 만들지 않는다. HTTP 상태코드·에러
 * 봉투·폐기(§2.6)·파일 저장 형식 자체는 여기서 다루지 않는다 — 라우트가 아직 없다.
 */

import { describe, expect, it } from 'vitest'

import { ControlStoreError, mintLogId, openControlStore, type RandomBytesFn } from '../src/control/store.js'

describe('mintLogId', () => {
  it('mint된 logId가 0002 §1.1 정규식을 만족한다', () => {
    const logId = mintLogId()
    expect(logId).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
  })
})

describe('ControlStore.createLog', () => {
  it('고정 난수원이 이미 존재하는 id를 다시 뽑으면 그 로그를 다른 주체에게 돌려주지 않는다 (§2.1 MUST NOT)', async () => {
    const fixedRandomBytes: RandomBytesFn = () => Buffer.from('0123456789abcdef', 'utf8')
    const store = await openControlStore(':memory:', { randomBytes: fixedRandomBytes })

    const first = await store.createLog('subject-a')
    await expect(store.createLog('subject-b')).rejects.toThrow(ControlStoreError)

    // subject-b의 실패한 시도가 subject-a의 로그를 가로채지 않았다.
    expect(await store.isGranted('subject-b', first.logId)).toBe(false)
    expect(await store.isGranted('subject-a', first.logId)).toBe(true)
  })

  it('관계 행 추가가 실패하면 방금 mint된 로그도 남지 않는다 — 원자성', async () => {
    const fixedRandomBytes: RandomBytesFn = () => Buffer.from('atomicity-fixed!', 'utf8')
    const store = await openControlStore(':memory:', { randomBytes: fixedRandomBytes })

    // 빈 주체는 관계 행 삽입 단계(로그 삽입 *다음*)에서 거부된다 — 로그 삽입 자체는
    // 이 시도에서 이미 통과했었다는 뜻이다.
    await expect(store.createLog('')).rejects.toThrow(ControlStoreError)

    // 실패한 시도가 로그 행을 남겼다면, 같은 고정 난수원은 같은 id를 다시 뽑고 그 id는
    // 이미 있는 것이므로 mint 재시도가 전부 소진되어 이 호출도 실패한다. 성공한다는 것
    // 자체가 첫 시도의 로그·관계가 롤백으로 함께 사라졌다는 증거다.
    const retry = await store.createLog('valid-subject')
    expect(await store.isGranted('valid-subject', retry.logId)).toBe(true)
  })
})

describe('ControlStore — (주체, 로그) 다대다', () => {
  it('로그 하나에 주체 둘, 주체 하나에 로그 둘이 각 방향 조회에서 모두 보인다', async () => {
    const store = await openControlStore(':memory:')

    const { logId: logA } = await store.createLog('x')
    await store.grant('y', logA)
    const { logId: logB } = await store.createLog('x')

    // 로그 하나(logA)에 주체 둘(x, y).
    expect(await store.isGranted('x', logA)).toBe(true)
    expect(await store.isGranted('y', logA)).toBe(true)

    // 주체 하나(x)에 로그 둘(logA, logB).
    const xLogs = (await store.listLogsForSubject('x')).logs.map((log) => log.logId).sort()
    expect(xLogs).toEqual([logA, logB].sort())

    // y는 grant받은 logA만 본다 — logB는 x 전용이다.
    const yLogs = (await store.listLogsForSubject('y')).logs.map((log) => log.logId)
    expect(yLogs).toEqual([logA])
  })
})

describe('ControlStore.isGranted', () => {
  it('관계에 없는 (주체, 로그)의 grant 판정은 불통과다 — fail-closed', async () => {
    const store = await openControlStore(':memory:')
    const { logId } = await store.createLog('owner')

    expect(await store.isGranted('stranger', logId)).toBe(false)
  })
})

describe('ControlStore.listLogsForSubject', () => {
  it('다른 주체의 로그를 포함하지 않고, logId 사전순이며, limit이 grant 판정 뒤에 걸린다', async () => {
    const store = await openControlStore(':memory:')

    const xLogIds = [
      (await store.createLog('x')).logId,
      (await store.createLog('x')).logId,
      (await store.createLog('x')).logId,
    ]
    const { logId: yLogId } = await store.createLog('y')
    const sortedX = [...xLogIds].sort()

    const page1 = await store.listLogsForSubject('x', { limit: 2 })
    expect(page1.logs.map((log) => log.logId)).toEqual(sortedX.slice(0, 2))
    expect(page1.hasMore).toBe(true)

    const cursor = page1.logs[1]
    expect(cursor).toBeDefined()
    if (cursor === undefined) return

    const page2 = await store.listLogsForSubject('x', { after: cursor.logId, limit: 2 })
    expect(page2.logs.map((log) => log.logId)).toEqual(sortedX.slice(2))
    expect(page2.hasMore).toBe(false)

    const allReturned = [...page1.logs, ...page2.logs].map((log) => log.logId)
    expect(allReturned).not.toContain(yLogId)
  })
})
