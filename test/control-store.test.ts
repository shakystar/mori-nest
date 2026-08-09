/**
 * 제어 평면 스토어 — `logId` mint와 (주체, 로그) 다대다 관계 (mori-nest #72), 그리고 폐기
 * (`§2.6`, mori-nest #92)의 스토어 표면.
 *
 * #72가 못박은 여섯 건에 #92 이슈 본문이 못박은 **다섯 건**(revoke 동작 하나당 하나)을
 * 더한다 — 그 이상 만들지 않는다. HTTP 상태코드·에러 봉투·`POST /v1/logs/{logId}/revoke`
 * 라우트 자체·파일 저장 형식은 여기서 다루지 않는다 — 라우트가 아직 없다.
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

describe('ControlStore.revoke', () => {
  it('revoke 후 isGranted가 false다', async () => {
    const store = await openControlStore(':memory:')
    const { logId } = await store.createLog('owner')

    await store.revoke('owner', logId)

    expect(await store.isGranted('owner', logId)).toBe(false)
  })

  it('revoke 후 listLogsForSubject에서 그 로그가 빠지고, 남은 건수·hasMore가 폐기분을 제외한 값이다', async () => {
    const store = await openControlStore(':memory:')
    const { logId: keptA } = await store.createLog('subject')
    const { logId: keptB } = await store.createLog('subject')
    const { logId: revokedA } = await store.createLog('subject')
    const { logId: revokedB } = await store.createLog('subject')
    const { logId: revokedC } = await store.createLog('subject')

    // 3건 중 1건만 폐기한다 — 남은 4건(kept 2 + 미폐기 2) 기준으로 hasMore를 판정한다는 것을
    // 확인하려면 폐기가 WHERE에서 일어나야 한다(라우트나 스토어 바깥에서 나중에 거르면 이
    // 페이지가 폐기된 로그로 채워지거나 hasMore가 거짓말이 된다).
    await store.revoke('subject', revokedA)

    const page = await store.listLogsForSubject('subject', { limit: 1 })
    expect(page.logs.map((log) => log.logId)).not.toContain(revokedA)
    expect(page.hasMore).toBe(true)

    const remaining = (await store.listLogsForSubject('subject')).logs.map((log) => log.logId)
    expect(remaining.sort()).toEqual([keptA, keptB, revokedB, revokedC].sort())
  })

  it('같은 (주체, 로그) revoke 2회가 같은 revokedAt을 돌려준다 — 멱등', async () => {
    const store = await openControlStore(':memory:')
    const { logId } = await store.createLog('owner')

    const first = await store.revoke('owner', logId)
    const second = await store.revoke('owner', logId)

    expect(second.revokedAt).toBe(first.revokedAt)
  })

  it('폐기된 로그에 대한 revoke가 여전히 성공한다 — 폐기가 자기 판정의 입력이 아니다', async () => {
    const store = await openControlStore(':memory:')
    const { logId } = await store.createLog('owner')
    await store.revoke('owner', logId)

    // isGranted는 폐기를 입력으로 삼아 이미 false다(§2.4·§3.6, 위 첫 테스트와 같은 사실).
    // revoke 자신의 자격 판정은 그렇지 않다는 것을, 이 상태에서도 재호출이 실패하지 않는
    // 것으로 확인한다 — 값이 같다는 것(위 세 번째 테스트)과는 다른 명제다.
    expect(await store.isGranted('owner', logId)).toBe(false)
    await expect(store.revoke('owner', logId)).resolves.toBeDefined()
  })

  it('관계 행이 없는 (주체, 로그)의 revoke가 404로 옮길 수 있는 형태로 실패한다', async () => {
    const store = await openControlStore(':memory:')
    const { logId } = await store.createLog('owner')

    const attempt = store.revoke('stranger', logId)

    await expect(attempt).rejects.toThrow(ControlStoreError)
    await expect(attempt).rejects.toMatchObject({ reason: 'log_not_found' })
  })
})
