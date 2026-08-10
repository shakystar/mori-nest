/**
 * `0003 §1.4` 원자성의 **자식 쪽** (`test/control-server.test.ts` ⑦).
 * `idempotency-race-child.mjs`(#73 ④)가 세운 별도 프로세스 경합 선례와 같은 형태다 — 같은
 * 시각까지 스핀으로 기다렸다 요청 하나를 내고, 결과 한 줄을 JSON으로 stdout에 쓴다.
 *
 * 다른 점 하나: 이 자식은 스토어를 직접 부르지 않고 **자기 프로세스에서 제어 평면 서버를
 * 띄워 자기에게 HTTP 요청을 낸다.** 두 자식의 서버가 같은 DB 파일 셋(`<dir>/*.db`)을 보므로
 * 경합이 라우트 배선(`reserve` → `createLog` → `complete`)을 통째로 지나 프로세스 경계를
 * 실제로 건넌다.
 *
 * **한 프로세스 안의 두 요청으로는 이 자리가 시험되지 않는다.** 스토어가 `node:sqlite`의
 * 동기 API 위에 있어 `reserve`→`createLog`→`complete` 사슬에 이벤트 루프로 넘어가는 지점이
 * 없고, 그래서 같은 프로세스의 두 요청은 언제나 차례로 처리된다 — 경합이 아예 일어나지
 * 않는다. 자식을 프로세스로 가르는 이유가 이것이다.
 *
 * **라운드가 여럿인 이유.** 경합이 실제로 겹치려면 진 쪽의 `reserve`가 이긴 쪽의
 * `reserve`와 `complete` 사이(= `createLog` 한 번, 밀리초 미만)에 들어와야 하는데, 프로세스
 * 둘의 도착 편차가 그보다 크면 진 쪽은 그냥 재생(`replay`)을 받고 겹침이 일어나지 않는다 —
 * 한 번만 재면 «겹치지 않아서 초록»과 «겹쳤는데도 초록»을 구분할 수 없다. 그래서 시각을
 * 조금씩 밀며 여러 라운드를 돌린다: 라운드 하나라도 겹치면 그 라운드가 판정하고, 겹치지
 * 않은 라운드도 «자원 하나»라는 같은 명제를 그대로 검사한다.
 *
 * argv: `<dir> <token> <keyPrefix> <startAtMs> <rounds>`
 */

import { once } from 'node:events'
import { writeSync } from 'node:fs'
import { register } from 'node:module'

// `src/**`가 서로를 `.js`로 부르는 것을 소스로 되돌린다 (훅 파일 머리말). 훅은 등록 이후의
// **동적** import부터 적용되므로 아래 import들은 정적일 수 없다.
register(new URL('./ts-source-loader.mjs', import.meta.url))

const [dir, token, keyPrefix, startAtMs, roundsArg] = process.argv.slice(2)
if (
  dir === undefined ||
  token === undefined ||
  keyPrefix === undefined ||
  startAtMs === undefined ||
  roundsArg === undefined
) {
  throw new Error('usage: control-server-race-child.mjs <dir> <token> <keyPrefix> <startAtMs> <rounds>')
}

/** 라운드 사이 간격. 앞 라운드의 응답이 끝나고도 남을 만큼만 둔다. */
const ROUND_INTERVAL_MS = 120

const { openLauncherCredentialStore } = await import('../src/control/credential.ts')
const { openControlDatabase } = await import('../src/control/db.ts')
const { openIdempotencyStore } = await import('../src/control/idempotency.ts')
const { createControlServer } = await import('../src/control/server.ts')
const { openControlStore } = await import('../src/control/store.ts')
const { openWorkspaceStore } = await import('../src/control/workspace-store.ts')

// 멱등 계층·자격증명·로그·작업공간 스토어 넷 다 제어 평면 DB 하나를 공유한다 (mori-nest
// #130·#131·#132) — 이 자식이 여는 DB 파일은 이제 하나뿐이다. 부모(`test/control-server.test.ts`)와
// 같은 이름을 써야 같은 DB를 본다.
const database = await openControlDatabase(`${dir}/control-plane.db`)
const store = await openControlStore(database)
const idempotency = await openIdempotencyStore(database)
const credentials = await openLauncherCredentialStore(database)
const workspaces = await openWorkspaceStore(database)

// 이 자식이 내는 요청은 `POST /v1/logs` 하나이고 발급 경로를 지나지 않는다. 그래도 설정은
// **선택 필드가 아니므로**(`ControlServerOptions`) 여기서도 채운다 — `§3.4`의 네 제약을
// 만족하는 값 하나면 족하다. 키를 자식이 직접 만드는 것은 부모와 나눠 가질 이유가 없어서다.
const { generateKeyPairSync } = await import('node:crypto')
const config = {
  signingKey: generateKeyPairSync('ed25519').privateKey,
  keyId: 'k-race',
  tokenTtlSeconds: 300,
  heartbeatIntervalSeconds: 30,
  gracePeriodSeconds: 600,
}

const server = createControlServer({ database, store, idempotency, credentials, workspaces, config })
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const { port } = server.address()

// 스핀 **전에** 연결을 데운다. 이것을 하지 않으면 스핀이 끝난 뒤 TCP 연결 수립부터
// 시작하게 되고, 그 지연의 편차(자식마다 다르다)가 두 요청의 도착을 밀리초 단위로 벌려
// 경합이 일어나지 않은 채 초록이 나올 수 있다. 목록 조회는 자원을 만들지 않으므로 이
// 워밍업이 시험 대상 상태를 건드리지 않는다.
await fetch(`http://127.0.0.1:${port}/v1/logs`, { headers: { Authorization: `Bearer ${token}` } }).then((warmup) =>
  warmup.text(),
)

const startAt = Number(startAtMs)
const rounds = Number(roundsArg)
const replies = []

for (let round = 0; round < rounds; round++) {
  const firesAt = startAt + round * ROUND_INTERVAL_MS
  while (Date.now() < firesAt) {
    // 스핀. `idempotency-race-child.mjs`와 같은 이유 — `await`를 쓰면 타이머 해상도만큼
    // 시작이 어긋난다. `listen`과 워밍업은 위에서 이미 끝났다.
  }

  const response = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': `${keyPrefix}-${round}`,
    },
    body: '{}',
  })
  replies.push({ round, status: response.status, text: await response.text() })
}

writeSync(1, `${JSON.stringify(replies)}\n`)

server.closeAllConnections()
server.close()
// `store`·`workspaces` 둘 다 `database`의 연결 위에 선 리포지토리라 닫을 것이 없다
// (mori-nest #131 · #132).
await database.close()
