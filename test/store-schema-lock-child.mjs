/**
 * mori-nest #150 (#148 §3 C1) 시험의 자식 쪽 — 다른 연결이 쓰기 락을 쥔 채 더 높은 스키마
 * 버전을 적어 두는 쪽을 흉내낸다 (`test/store.test.ts` ⑩).
 *
 * `BEGIN IMMEDIATE`로 쓰기 락을 쥐고 `PRAGMA user_version = <version>`을 적은 뒤 **커밋하지
 * 않고** stdout에 `locked`를 적는다 — 이 시점에 부모가 읽으면 아직 이 값을 보지 못한다(WAL의
 * 읽기는 커밋 전 값을 보지 않는다). 그 신호를 받은 부모가 `openEventStore`를 부르면 그 열기는
 * 이 연결이 쥔 락을 기다리게 된다. `holdMs`만큼 기다린 뒤 커밋해 락을 넘긴다 — 부모의 열기가
 * 그 기다림 도중에 있으면, 커밋이 그 열기의 중간에 끼어드는 인터리브가 만들어진다.
 *
 * argv: `<dbPath> <version> <holdMs>`
 */

import { writeSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const [dbPath, version, holdMs] = process.argv.slice(2)
if (dbPath === undefined || version === undefined || holdMs === undefined) {
  throw new Error('usage: store-schema-lock-child.mjs <dbPath> <version> <holdMs>')
}

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA busy_timeout = 5000')
db.exec('BEGIN IMMEDIATE')
db.exec(`PRAGMA user_version = ${version}`)
writeSync(1, 'locked\n')

await new Promise((resolve) => setTimeout(resolve, Number(holdMs)))

db.exec('COMMIT')
db.close()
