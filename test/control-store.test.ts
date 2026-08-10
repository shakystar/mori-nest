/**
 * 제어 평면 스토어 — `logId` mint와 (주체, 로그) 다대다 관계 (mori-nest #72), 그리고 폐기
 * (`§2.6`, mori-nest #92)의 스토어 표면.
 *
 * #72가 못박은 여섯 건에 #92 이슈 본문이 못박은 **다섯 건**(revoke 동작 하나당 하나)을
 * 더한다 — 그 이상 만들지 않는다. HTTP 상태코드·에러 봉투·`POST /v1/logs/{logId}/revoke`
 * 라우트 자체·파일 저장 형식은 여기서 다루지 않는다 — 라우트가 아직 없다.
 *
 * mori-nest #131(UoW 조각 2/4)에서 **여는 방식만** 바뀌었다 — 스토어가 경로가 아니라
 * `ControlDatabase`를 받으므로 `openTestControlDatabase()`(`./control-db.ts`)가 임시 디렉터리
 * 파일을 열어 준다(`:memory:`는 내구성 PRAGMA를 걸 수 없어 거부된다). 명제는 그대로다.
 * 거기에 시험 하나가 더해졌다 — 구 스키마 보정(`addMissingRevocationColumn`)이 UoW 아래에서도
 * 도는지는 이 전환으로 실제로 깨질 수 있는 자리인데 덮는 시험이 없었다.
 *
 * `ControlStore.createLog`는 라우트가 안 쓰게 된 자기 트랜잭션 재시도 경로라 걷혔다
 * (mori-nest #140, PR #139 교차 지적 회수) — 이 파일의 로그 픽스처는 이제 {@link createTestLog}
 * 하나로 `mintLogId` + `insertMintedLog`를 라우트와 같은 순서로 조합한다.
 */

import { describe, expect, it } from 'vitest'

import type { ControlDatabase } from '../src/control/db.js'
import { ControlStoreError, mintLogId, openControlStore, type ControlStore, type RandomBytesFn } from '../src/control/store.js'
import { openTestControlDatabase } from './control-db.js'

/** 라우트가 하는 mint + insert 조합을 시험에서 재현한다 — `ControlStore.createLog`가 걷힌 뒤
 * (mori-nest #140) 로그 픽스처를 만드는 유일한 경로다. */
async function createTestLog(database: ControlDatabase, store: ControlStore, subject: string): Promise<{ readonly logId: string }> {
  const logId = store.mintLogId()
  await database.withTransaction(() => {
    store.insertMintedLog(logId, subject)
  })
  return { logId }
}

describe('mintLogId', () => {
  it('mint된 logId가 0002 §1.1 정규식을 만족한다', () => {
    const logId = mintLogId()
    expect(logId).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
  })
})

describe('openControlStore — 구 스키마 보정', () => {
  it('revoked_at 없이 만들어진 logs 테이블을 열면 그 컬럼을 붙이고 폐기가 동작한다', async () => {
    const database = await openTestControlDatabase()
    // `revoked_at`을 모르던 시절의 `logs`를 그대로 만든다. `SCHEMA`의 `CREATE TABLE IF NOT
    // EXISTS`는 이 테이블을 건드리지 않으므로, 컬럼을 붙이는 것은 보정 경로뿐이다.
    database.connection.exec('CREATE TABLE logs (log_id TEXT PRIMARY KEY) STRICT')

    const store = await openControlStore(database)

    // 보정이 돌지 않았다면 `revoked_at`이 없어 `revoke`의 `UPDATE`가 여기서 던진다.
    const { logId } = await createTestLog(database, store, 'owner')
    const { revokedAt } = await store.revoke('owner', logId)
    expect(revokedAt).toEqual(expect.any(String))
    expect(await store.isGranted('owner', logId)).toBe(false)
  })
})

describe('ControlStore.insertMintedLog', () => {
  it('고정 난수원이 이미 존재하는 id를 다시 뽑으면 그 로그를 다른 주체에게 돌려주지 않는다 (§2.1 MUST NOT)', async () => {
    const fixedRandomBytes: RandomBytesFn = () => Buffer.from('0123456789abcdef', 'utf8')
    const database = await openTestControlDatabase()
    const store = await openControlStore(database, { randomBytes: fixedRandomBytes })

    const { logId } = await createTestLog(database, store, 'subject-a')

    // 같은 고정 난수원이 같은 id를 다시 뽑는다 — subject-b의 시도는 PRIMARY KEY 충돌이다.
    await expect(database.withTransaction(() => store.insertMintedLog(store.mintLogId(), 'subject-b'))).rejects.toThrow(
      ControlStoreError,
    )

    // subject-b의 실패한 시도가 subject-a의 로그를 가로채지 않았다.
    expect(await store.isGranted('subject-b', logId)).toBe(false)
    expect(await store.isGranted('subject-a', logId)).toBe(true)
  })

  it('관계 행 추가가 실패하면 방금 mint된 로그도 남지 않는다 — 원자성', async () => {
    const database = await openTestControlDatabase()
    const store = await openControlStore(database)
    const logId = store.mintLogId()

    // 빈 주체는 관계 행 삽입 단계(로그 삽입 *다음*)에서 거부된다 — 로그 삽입 자체는
    // 이 시도에서 이미 통과했었다는 뜻이다.
    await expect(database.withTransaction(() => store.insertMintedLog(logId, ''))).rejects.toThrow(ControlStoreError)

    // 실패한 시도가 로그 행을 남겼다면, 같은 id로 다시 삽입할 때 PRIMARY KEY 충돌
    // (log_id_collision)이 난다. 통과한다는 것 자체가 첫 시도의 로그·관계가 롤백으로
    // 함께 사라졌다는 증거다.
    await database.withTransaction(() => store.insertMintedLog(logId, 'valid-subject'))
    expect(await store.isGranted('valid-subject', logId)).toBe(true)
  })
})

describe('ControlStore — (주체, 로그) 다대다', () => {
  it('로그 하나에 주체 둘, 주체 하나에 로그 둘이 각 방향 조회에서 모두 보인다', async () => {
    const database = await openTestControlDatabase()
    const store = await openControlStore(database)

    const { logId: logA } = await createTestLog(database, store, 'x')
    await store.grant('y', logA)
    const { logId: logB } = await createTestLog(database, store, 'x')

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
    const database = await openTestControlDatabase()
    const store = await openControlStore(database)
    const { logId } = await createTestLog(database, store, 'owner')

    expect(await store.isGranted('stranger', logId)).toBe(false)
  })
})

describe('ControlStore.listLogsForSubject', () => {
  it('다른 주체의 로그를 포함하지 않고, logId 사전순이며, limit이 grant 판정 뒤에 걸린다', async () => {
    const database = await openTestControlDatabase()
    const store = await openControlStore(database)

    const xLogIds = [
      (await createTestLog(database, store, 'x')).logId,
      (await createTestLog(database, store, 'x')).logId,
      (await createTestLog(database, store, 'x')).logId,
    ]
    const { logId: yLogId } = await createTestLog(database, store, 'y')
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
    const database = await openTestControlDatabase()
    const store = await openControlStore(database)
    const { logId } = await createTestLog(database, store, 'owner')

    await store.revoke('owner', logId)

    expect(await store.isGranted('owner', logId)).toBe(false)
  })

  it('revoke 후 listLogsForSubject에서 그 로그가 빠지고, 남은 건수·hasMore가 폐기분을 제외한 값이다', async () => {
    const database = await openTestControlDatabase()
    const store = await openControlStore(database)
    const { logId: kept } = await createTestLog(database, store, 'subject')
    const { logId: revokedA } = await createTestLog(database, store, 'subject')
    const { logId: revokedB } = await createTestLog(database, store, 'subject')

    // 3건 중 2건을 폐기해 적격을 1건으로 만든다. 거르는 자리가 WHERE면 이 질의가 읽어 오는
    // 행이 1건뿐이라 hasMore가 false다. 읽어 온 뒤(= LIMIT+1행을 받은 뒤) 밖에서 거르는
    // 구현이면 2행을 읽어 hasMore가 true가 된다 — 그 거짓말이 여기서 빨개져야 한다.
    await store.revoke('subject', revokedA)
    await store.revoke('subject', revokedB)

    const page = await store.listLogsForSubject('subject', { limit: 1 })
    expect(page.logs.map((log) => log.logId)).toEqual([kept])
    expect(page.hasMore).toBe(false)
  })

  it('같은 (주체, 로그) revoke 2회가 같은 revokedAt을 돌려준다 — 멱등', async () => {
    const database = await openTestControlDatabase()
    const store = await openControlStore(database)
    const { logId } = await createTestLog(database, store, 'owner')

    const first = await store.revoke('owner', logId)
    const second = await store.revoke('owner', logId)

    expect(second.revokedAt).toBe(first.revokedAt)
  })

  it('폐기된 로그에 대한 revoke가 여전히 성공한다 — 폐기가 자기 판정의 입력이 아니다', async () => {
    const database = await openTestControlDatabase()
    const store = await openControlStore(database)
    const { logId } = await createTestLog(database, store, 'owner')
    await store.revoke('owner', logId)

    // isGranted는 폐기를 입력으로 삼아 이미 false다(§2.4·§3.6, 위 첫 테스트와 같은 사실).
    // revoke 자신의 자격 판정은 그렇지 않다는 것을, 이 상태에서도 재호출이 실패하지 않는
    // 것으로 확인한다 — 값이 같다는 것(위 세 번째 테스트)과는 다른 명제다.
    expect(await store.isGranted('owner', logId)).toBe(false)
    await expect(store.revoke('owner', logId)).resolves.toBeDefined()
  })

  it('관계 행이 없는 (주체, 로그)의 revoke가 404로 옮길 수 있는 형태로 실패한다', async () => {
    const database = await openTestControlDatabase()
    const store = await openControlStore(database)
    const { logId } = await createTestLog(database, store, 'owner')

    const attempt = store.revoke('stranger', logId)

    await expect(attempt).rejects.toThrow(ControlStoreError)
    await expect(attempt).rejects.toMatchObject({ reason: 'log_not_found' })
  })
})
