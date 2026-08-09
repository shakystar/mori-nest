/**
 * `0003 §1.4` 원자성의 **자식 쪽** (`test/idempotency.test.ts` ④), `store-race-child.mjs`와
 * 같은 형태다.
 *
 * 같은 `(subject, key, body)`를 담은 예약 요청 하나를 **다른 자식과 같은 시각에** 낸다.
 * `reserve`가 `'reserved'`를 돌려준 자식만 "자원을 만든다"(여기서는 `complete` 호출로
 * 흉내 낸다) — 재는 것은 `reserve` 호출 중 `'reserved'`를 받은 것이 몇 건인가다.
 *
 * argv: `<dbPath> <subject> <key> <startAtMs> <body>`
 */

import { writeSync } from 'node:fs'

import { openIdempotencyStore } from '../src/control/idempotency.ts'

const [dbPath, subject, key, startAtMs, body] = process.argv.slice(2)
if (dbPath === undefined || subject === undefined || key === undefined || startAtMs === undefined || body === undefined) {
  throw new Error('usage: idempotency-race-child.mjs <dbPath> <subject> <key> <startAtMs> <body>')
}

const store = await openIdempotencyStore(dbPath)

const startAt = Number(startAtMs)
while (Date.now() < startAt) {
  // 스핀. `store-race-child.mjs`와 같은 이유 — `await`를 쓰면 타이머 해상도만큼 시작이 어긋난다.
}

const outcome = await store.reserve(subject, key, body)
let created = false
if (outcome.kind === 'reserved') {
  created = true
  await store.complete(subject, key, { status: 201, body: '{"logId":"raced"}' })
}
writeSync(1, `${JSON.stringify({ kind: outcome.kind, created })}\n`)
await store.close()
