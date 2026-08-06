/**
 * `0002 §2.1` 원자적 dedup의 **자식 쪽** (`test/store.test.ts` ②).
 *
 * 같은 `id` 집합을 담은 append 요청 하나를 **다른 자식과 같은 시각에** 낸다. 프로세스가 둘인
 * 것이 요점이다: 한 프로세스 안에서 `Promise.all`로 두 번 부르면 구현이 내부에서 동기로 돌아
 * 애초에 겹치지 않으므로(`src/store.ts` 상단 doc), 그것은 경쟁이 아니라 순차 실행이다.
 *
 * 시작 시각을 벽시계로 맞춘다 (`startAtMs`). 파이프 핸드셰이크 대신 스핀을 쓰는 것은, stdin이
 * 논블로킹으로 잡히는 환경에서 동기 읽기가 `EAGAIN`으로 튀는 것을 피하기 위해서다 — 두
 * 프로세스가 수백 ms 도는 비용이 그 불안정성보다 싸다.
 *
 * 결과는 stdout에 JSON 한 줄이다: `{"accepted":[{id,cursor}…],"duplicate":[…]}`.
 *
 * argv: `<dbPath> <logId> <startAtMs> <id,id,…>`
 */

import { writeSync } from 'node:fs'

import { openEventStore } from '../src/store.ts'

const [dbPath, logId, startAtMs, idList] = process.argv.slice(2)
if (dbPath === undefined || logId === undefined || startAtMs === undefined || idList === undefined) {
  throw new Error('usage: store-race-child.mjs <dbPath> <logId> <startAtMs> <ids>')
}

const ids = idList.split(',')
const store = await openEventStore(dbPath)

// 열기(잠금·PRAGMA·스키마)를 먼저 끝내 놓고 시각만 기다린다. 열기까지 경쟁 구간에 넣으면
// 재는 대상이 dedup이 아니라 파일 열기가 된다.
const startAt = Number(startAtMs)
while (Date.now() < startAt) {
  // 스핀. 여기서 `await`를 쓰면 타이머 해상도만큼 시작이 어긋난다.
}

// `§1.6`의 출처 값. 이 시험이 재는 것은 dedup이므로 두 자식이 같은 값을 써도 되지만, 값이
// **필수**라는 것 자체가 계약이라 여기서도 넘긴다.
const result = await store.append(
  logId,
  ids.map((id) => ({ id, payload: `{"id":${JSON.stringify(id)}}` })),
  { workspaceId: `ws_race_${String(process.pid)}`, tokenId: `tok_race_${String(process.pid)}` },
)
writeSync(1, `${JSON.stringify(result)}\n`)
await store.close()
