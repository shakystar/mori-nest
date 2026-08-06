/**
 * `0002 §2.2` 내구성 회귀의 **자식 쪽** (`test/store.test.ts` ①).
 *
 * 하는 일: 이벤트를 하나씩 append하고, **커밋이 성공해서 돌아온 직후마다** stdout에 그 id를
 * 한 줄로 적는다. 그 한 줄이 와이어의 `200` 응답에 해당한다 — 부모는 임의 시점에 이 프로세스를
 * `SIGKILL`하고, DB를 다시 열어 여기서 적힌 id가 전부 같은 상대 순서로 남아 있는지 대조한다
 * (#15 결정의 실측 ②와 같은 방법이고, 그 실측이 macOS/APFS였던 자리를 ubuntu CI로 옮긴 것이
 * 이 테스트다).
 *
 * ack를 `console.log`가 아니라 `writeSync(1, …)`로 적는 것이 중요하다. `console.log`는 파이프에
 * 대해 비동기로 흘러 SIGKILL 시점에 아직 큐에 남아 있을 수 있고, 그러면 **커밋됐는데 부모가
 * 모르는** ack가 생긴다. 그 방향의 오차는 테스트를 느슨하게만 만들지 틀리게 만들지는 않지만
 * (부모는 "ack된 것이 남아 있는가"만 본다), 검증 표본을 이유 없이 줄일 이유가 없다.
 *
 * `.mjs`인 것은 이 파일이 `node`로 **직접 실행**되기 때문이다. 타입 스트리핑이 `../src/store.ts`
 * 쪽을 처리하므로 스토어는 소스 그대로 쓰인다 (빌드 산출물에 의존하지 않는다 — 의존하면
 * `pnpm test`만 돌렸을 때 이 테스트가 옛 `dist/`를 검증한다).
 *
 * argv: `<dbPath> <logId> <round>`
 */

import { writeSync } from 'node:fs'

import { openEventStore } from '../src/store.ts'

const [dbPath, logId, round] = process.argv.slice(2)
if (dbPath === undefined || logId === undefined || round === undefined) {
  throw new Error('usage: store-durability-child.mjs <dbPath> <logId> <round>')
}

const store = await openEventStore(dbPath)

// 부모가 "이제 append가 돌고 있다"를 아는 신호. 이 줄 이후부터 SIGKILL 타이머가 돈다 —
// 열기(스키마·PRAGMA)에 걸리는 시간이 kill 지연을 통째로 먹으면 라운드마다 ack가 0건이 된다.
writeSync(1, 'ready\n')

for (let index = 0; ; index++) {
  const id = `r${round}-${index}`
  await store.append(logId, [{ id, payload: `{"round":${round},"index":${index}}` }])
  writeSync(1, `${id}\n`)
}
