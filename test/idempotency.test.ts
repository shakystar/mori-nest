import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openControlDatabase, type ControlDatabase } from '../src/control/db.js'
import { openIdempotencyStore, parseIdempotencyKey, type IdempotencyStore } from '../src/control/idempotency.js'

/**
 * `0003 §1.4`의 MUST 줄마다 하나 — 다섯 건, 그 이상 만들지 않는다 (mori-nest #73 완료 조건).
 * 키 형식 정규식의 문자별 케이스는 여기서 별도 시험을 두지 않고 ①에 유효·무효 대표값
 * 하나씩으로 접는다 (완료 조건의 "만들지 않는 것" 절).
 *
 * ⑥은 완료 조건 밖 — PR #79 owner 수정요청이 요구한 회귀 시험이다 (`complete()`가
 * `status IS NULL` 없이 무조건 `UPDATE`했을 때 이미 완료된 예약을 조용히 덮어쓰던 결함).
 */

const RACE_CHILD = fileURLToPath(new URL('./idempotency-race-child.mjs', import.meta.url))
const NODE_ARGS = ['--experimental-strip-types']
const RETENTION_MS = 24 * 60 * 60 * 1000

type RaceResult = { kind: string; created: boolean }

function runRaceChild(
  dbPath: string,
  subject: string,
  key: string,
  startAt: number,
  body: string,
): Promise<RaceResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...NODE_ARGS, RACE_CHILD, dbPath, subject, key, String(startAt), body],
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
      try {
        resolve(JSON.parse(stdout) as RaceResult)
      } catch {
        reject(new Error(`경쟁 자식의 출력이 JSON이 아니다 (${stdout.length}바이트)\n${stderr}`))
      }
    })
  })
}

describe('제어 평면 멱등성 계층 (0003 §1.4)', () => {
  let dir: string
  let dbPath: string
  let database: ControlDatabase
  let store: IdempotencyStore

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mori-nest-idempotency-'))
    // 파일 하나가 제어 평면 DB 전체다 (mori-nest #130) — 이 계층은 그 위의 리포지토리이고
    // 연결을 소유하지 않으므로, 닫는 것도 스토어가 아니라 아래 `database`다.
    dbPath = join(dir, 'control-plane.db')
    database = await openControlDatabase(dbPath)
    store = await openIdempotencyStore(database)
  })

  afterEach(async () => {
    await database.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('① 같은 주체·키·본문의 재시도가 첫 결과를 그대로 돌려주고 자원이 하나뿐이다 (§1.4)', async () => {
    // 키 형식 판정 — 이 시험의 키(대표 유효값)와 대표 무효값 하나로 접는다 (완료 조건의
    // "만들지 않는 것" 절). HTTP를 모르는 순수 판정이라는 것도 여기서 함께 본다.
    expect(parseIdempotencyKey('retry-key-1')).toEqual({ ok: true, key: 'retry-key-1' })
    expect(parseIdempotencyKey('has a space')).toEqual({ ok: false })
    expect(parseIdempotencyKey(undefined)).toEqual({ ok: false })

    const body = '{"logs":["a"]}'
    const first = await store.reserve('subject-a', 'retry-key-1', body)
    expect(first).toEqual({ kind: 'reserved' })
    await store.complete('subject-a', 'retry-key-1', { status: 201, body: '{"logId":"log_1"}' })

    // 재시도 — 자원을 다시 만들지 않고 첫 응답을 그대로 재생한다.
    const retry = await store.reserve('subject-a', 'retry-key-1', body)
    expect(retry).toEqual({
      kind: 'replay',
      record: { status: 201, body: '{"logId":"log_1"}' },
    })
  })

  it('② 같은 주체·키에 다른 본문이 오면 idempotency_key_reused에 해당하는 판정이 나온다 (§1.4)', async () => {
    await store.reserve('subject-a', 'reused-key', '{"logs":["a"]}')

    const conflicting = await store.reserve('subject-a', 'reused-key', '{"logs":["b"]}')
    expect(conflicting).toEqual({ kind: 'conflict' })
  })

  it('③ 같은 키라도 주체가 다르면 서로 부딪히지 않는다 (§1.4 네임스페이스 MUST)', async () => {
    const body = '{"logs":["a"]}'

    const first = await store.reserve('subject-a', 'shared-key', body)
    const second = await store.reserve('subject-b', 'shared-key', body)

    expect(first).toEqual({ kind: 'reserved' })
    expect(second).toEqual({ kind: 'reserved' })
  })

  it(
    '④ 동시 도착 두 건에 자원이 정확히 하나만 생긴다 (§1.4, 다중 프로세스)',
    async () => {
      const startAt = Date.now() + 400
      const [first, second] = await Promise.all([
        runRaceChild(dbPath, 'subject-race', 'race-key', startAt, '{"logs":["a"]}'),
        runRaceChild(dbPath, 'subject-race', 'race-key', startAt, '{"logs":["a"]}'),
      ])

      const createdCount = [first, second].filter((r) => r.created).length
      expect(createdCount).toBe(1)
      // `'reserved'`를 받은 쪽만 자원을 만들었다는 것도 함께 본다.
      const reservedCount = [first, second].filter((r) => r.kind === 'reserved').length
      expect(reservedCount).toBe(1)
    },
    30_000,
  )

  it('⑤ 보관 창 — 24시간 직전은 재생되고, 그 뒤는 새 자원이 된다 (§1.4 MUST)', async () => {
    const body = '{"logs":["a"]}'
    const t0 = new Date('2026-01-01T00:00:00.000Z')

    await store.reserve('subject-a', 'retention-key', body, t0)
    await store.complete('subject-a', 'retention-key', { status: 201, body: '{"logId":"log_ret"}' })

    const justBeforeRetention = new Date(t0.getTime() + RETENTION_MS - 1)
    const stillReplayed = await store.reserve('subject-a', 'retention-key', body, justBeforeRetention)
    expect(stillReplayed).toEqual({
      kind: 'replay',
      record: { status: 201, body: '{"logId":"log_ret"}' },
    })

    const afterRetention = new Date(t0.getTime() + RETENTION_MS)
    const freshResource = await store.reserve('subject-a', 'retention-key', body, afterRetention)
    expect(freshResource).toEqual({ kind: 'reserved' })
  })

  it('⑥ 이미 완료된 예약에 complete를 두 번 부르면 두 번째는 실패하고 첫 응답이 그대로 남는다', async () => {
    await store.reserve('subject-a', 'double-complete-key', '{"logs":["a"]}')
    await store.complete('subject-a', 'double-complete-key', { status: 201, body: '{"logId":"log_first"}' })

    await expect(
      store.complete('subject-a', 'double-complete-key', { status: 201, body: '{"logId":"log_second"}' }),
    ).rejects.toMatchObject({ reason: 'reservation_not_found' })

    const replay = await store.reserve('subject-a', 'double-complete-key', '{"logs":["a"]}')
    expect(replay).toEqual({
      kind: 'replay',
      record: { status: 201, body: '{"logId":"log_first"}' },
    })
  })
})
