/**
 * 제어 평면 단일 DB + 트랜잭션 관리자 (mori-nest #130 — UoW 조각 1/4).
 *
 * 이슈 본문이 못박은 **둘**이 ①·②다. ①은 이 조각의 존재 이유 그 자체다 — 파일 경계를 넘던
 * 원자성이 실제로 성립하는지를 재는 유일한 자리이고, 그래서 리포지토리 둘을 한 트랜잭션에
 * 넣는다. ②는 채택한 중첩 정책(**금지**) 쪽 동작 하나만 잰다 — savepoint 쪽은 채택하지
 * 않았으므로 시험하지 않는다.
 *
 * ③은 이슈 본문의 «이미 커버돼 있으면 추가하지 않는다» 단서에 걸리지 않는다: 제어 평면의
 * PRAGMA 되읽기 검증은 이관 전 어떤 테스트도 잡지 않았고(`durability_pragmas_not_applied`를
 * 단언하는 시험이 `test/`에 없었다), 이 조각이 그 자리를 옮기면서 **`:memory:`가 거부로
 * 바뀐다** — 스토어 셋을 열던 기존 호출자가 실제로 쓰던 입력이라 사유와 함께 못박는다.
 * 라우트 동작·멱등 판정·자격증명 판정은 여기서 다시 재지 않는다 (각자의 파일에 있다).
 */

import { describe, expect, it } from 'vitest'

import { openLauncherCredentialStore } from '../src/control/credential.js'
import { openControlDatabase } from '../src/control/db.js'
import { openIdempotencyStore } from '../src/control/idempotency.js'
import { openTestControlDatabase } from './control-db.js'

describe('제어 평면 단일 DB + Unit of Work (mori-nest #130)', () => {
  it('① 한 트랜잭션 안의 멱등 쓰기와 자격증명 쓰기가 함께 롤백된다 — 파일 경계를 넘던 원자성', async () => {
    const database = await openTestControlDatabase()
    const idempotency = await openIdempotencyStore(database)
    const credentials = await openLauncherCredentialStore(database)

    let issuedToken = ''
    await expect(
      database.withTransaction(async () => {
        const reservation = await idempotency.reserve('subject-a', 'atomic-key', '{"logs":["a"]}')
        expect(reservation.kind).toBe('reserved')
        issuedToken = (await credentials.issue('subject-a')).token
        // 자원 생성이 실패하는 자리 — 이관 전에는 여기서 던지면 예약만 `in_progress`로
        // 잔류하고 자격증명은 다른 파일에 그대로 커밋돼 있었다 (`0003 §1.4` 결함).
        throw new Error('자원 생성 실패')
      }),
    ).rejects.toThrow('자원 생성 실패')

    expect(issuedToken).not.toBe('')

    // 예약이 남지 않았다: 남아 있었다면 같은 키의 재예약은 `in_progress`다.
    const retry = await idempotency.reserve('subject-a', 'atomic-key', '{"logs":["a"]}')
    expect(retry.kind).toBe('reserved')
    // 자격증명도 남지 않았다.
    expect((await credentials.verify(issuedToken)).ok).toBe(false)
  })

  it('② 중첩 트랜잭션은 금지다 — 재진입이 nested_transaction으로 즉시 실패한다', async () => {
    const database = await openTestControlDatabase()

    await expect(
      database.withTransaction(async () => {
        await database.withTransaction(() => undefined)
      }),
    ).rejects.toMatchObject({ name: 'ControlDatabaseError', reason: 'nested_transaction' })

    // 바깥 트랜잭션은 롤백으로 닫혔다 — 재진입 실패가 이 연결을 못 쓰게 만들지 않는다.
    await expect(database.withTransaction(() => 'committed')).resolves.toBe('committed')
  })

  it('③ 내구성 PRAGMA가 걸리지 않는 DB는 열리지 않는다 (durability_pragmas_not_applied)', async () => {
    // `:memory:`는 WAL을 걸 수 없다 — 되읽기 검증이 그것을 잡는다. 사유 문자열은 이관 전
    // 멱등 스토어의 것과 같고, `src/control/server.ts`가 `503 not_durable`로 옮기는 값이다.
    await expect(openControlDatabase(':memory:')).rejects.toMatchObject({
      name: 'ControlDatabaseError',
      reason: 'durability_pragmas_not_applied',
    })
  })
})
