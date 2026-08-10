import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openLauncherCredentialStore, type LauncherCredentialStore } from '../src/control/credential.js'
import { openControlDatabase, type ControlDatabase } from '../src/control/db.js'
import { openIdempotencyStore, type IdempotencyStore } from '../src/control/idempotency.js'
import type { ControlConfig } from '../src/control/index.js'
import { createControlServer, type ControlDiagnostic } from '../src/control/server.js'
import { openControlStore, type ControlStore } from '../src/control/store.js'
import { openWorkspaceStore, type WorkspaceStore } from '../src/control/workspace-store.js'
import { createVerificationKeySet, verifyWorkspaceToken } from '../src/transport/token.js'
import { KEY_ID, issuer } from './workspace-token.js'

/**
 * 제어 평면 라우트 (`0003 §2.1`·`§2.4`·`§1.4`·`§2.6`·`§4.2`·`§4.3`·`§4.4`·`§4.5`·`§4.6`·`§4.10`,
 * mori-nest #84·#93·#103·#113·#114·#115·#118).
 *
 * **동작 하나당 하나 — #84가 일곱 건, #93이 그 위에 세 건(`§2.6` revoke), #103이 다섯 건
 * (`§4.2` 개시), #113이 네 건(`§4.3` 하트비트), #114가 세 건(`§4.4`·`§4.5` 종료·폐기),
 * #115가 네 건(`§4.6` 목록·단건 조회), #118이 두 건(`§4.10` 하트비트 응답의 `forkAdvisory`
 * 배선, advisory 조각 2/2)을 더한다** (각 이슈 본문의 완료 조건). 겹침이 없을 때 키가 없다는
 * 것은 새 `it`을 만들지 않고 #113의 ⑯에 단언 한 줄을 더했다(이슈 #118 「테스트」 절 지시).
 * 게이트 판정
 * (자격·메서드·본문 형태·커서 형식)의 케이스는 여기서 다시 세우지 않는다 — `#83`·`#93`·`#102`가
 * `test/control-request.test.ts`에 이미 세웠고, 이 파일이 보는 것은 **판정 결과가 스토어
 * 호출로 이어진 뒤의 관찰 가능한 응답**이다. 토큰 와이어 형식의 재검증도 하지 않는다
 * (`test/control-token.test.ts`가 덮는다) — 아래 ⑪이 검증자를 부르는 것은 형식을 다시
 * 보기 위해서가 아니라 **이 라우트가 실제로 쓸 수 있는 토큰을 내는가**를 보기 위해서다.
 *
 * 두 평면을 함께 import하는 것(`src/transport/token.js`)은 경계 위반이 아니다 —
 * `test/`는 두 평면을 마주 세우는 자리이고, `test/control-token.test.ts`(#94)가 세운
 * 선례 그대로다.
 *
 * 기존 서버 테스트(`test/server*.test.ts`)를 복사해 변형하지 않는다 — 전송 평면 라우트와
 * 이 라우트는 계약이 다르다(이슈 본문).
 */

/** `0002 §1.1`: `logId := ^[A-Za-z0-9_-]{1,128}$`. */
const LOG_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** ⑦의 자식. `test/idempotency-race-child.mjs`(#73 ④)가 세운 별도 프로세스 경합 선례 그대로다. */
const RACE_CHILD = fileURLToPath(new URL('./control-server-race-child.mjs', import.meta.url))

type Reply = { readonly status: number; readonly text: string }

function bodyOf(reply: Reply): unknown {
  return JSON.parse(reply.text)
}

type RaceReply = { round: number; status: number; text: string }

/** `test/idempotency.test.ts`의 같은 이름 함수와 같은 모양 — 자식 하나의 JSON 한 줄을 받는다. */
function runRaceChild(
  dir: string,
  token: string,
  keyPrefix: string,
  startAt: number,
  rounds: number,
): Promise<readonly RaceReply[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RACE_CHILD, dir, token, keyPrefix, String(startAt), String(rounds)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
        resolve(JSON.parse(stdout) as RaceReply[])
      } catch {
        reject(new Error(`경쟁 자식의 출력이 JSON이 아니다 (${stdout.length}바이트)\n${stderr}`))
      }
    })
  })
}

/** `§4.2` 응답 `OpenWorkspaceResponse`의 여섯 필드. */
type OpenReply = {
  workspaceId: string
  token: string
  tokenId: string
  scope: string[]
  expiresAt: string
  heartbeatIntervalSeconds: number
}

/** `§4.3` 응답 — 개시의 여섯에 `state`가 더해진 일곱 필드. */
type HeartbeatReply = OpenReply & { state: string }

/** `§4.4`·`§4.5` 응답의 세 필드 (`WorkspaceTerminalResult` + `workspaceId`). */
type TerminalReply = { workspaceId: string; state: string; endedAt: string }

/** ㉘가 던지는 판정을 시험하기 위한 래퍼 — 나머지 메서드는 실제 스토어로 위임하고
 * `findForkAdvisory`만 거부한다. `SqliteWorkspaceStore`는 프라이빗 필드를 쓰므로 `Proxy`로
 * 감싸면 위임 호출의 `this`가 프록시가 되어 프라이빗 필드 접근이 깨진다 — 그래서 메서드마다
 * `bind`로 실제 인스턴스에 묶어 위임한다. */
function withFailingForkAdvisory(real: WorkspaceStore): WorkspaceStore {
  return {
    openWorkspace: real.openWorkspace.bind(real),
    insertMintedWorkspace: real.insertMintedWorkspace.bind(real),
    getWorkspace: real.getWorkspace.bind(real),
    heartbeat: real.heartbeat.bind(real),
    closeWorkspace: real.closeWorkspace.bind(real),
    revokeWorkspace: real.revokeWorkspace.bind(real),
    listWorkspaces: real.listWorkspaces.bind(real),
    findForkAdvisory: () => Promise.reject(new Error('forkAdvisory boom (시험용)')),
  }
}

/**
 * 시험용 발급 설정 — `§3.4`의 네 제약을 만족한다 (`parseControlConfig`가 강제하는 그것).
 * 검증 키 집합(`keys`)이 이 `keyId`의 공개키를 갖고 있어 아래 ⑪의 라운드트립이 성립한다.
 */
const CONFIG: ControlConfig = {
  signingKey: issuer.privateKey,
  keyId: KEY_ID,
  tokenTtlSeconds: 300,
  heartbeatIntervalSeconds: 30,
  gracePeriodSeconds: 600,
}

/** `issuer`의 공개키 하나만 주입된 집합 — 전송 평면이 받는 절반(`§3.3`)이다. */
const VERIFICATION_KEYS = createVerificationKeySet([[KEY_ID, issuer.publicKey]])

describe('제어 평면 라우트 (0003 §2.1·§2.4·§1.4·§2.6·§4.2·§4.3·§4.4·§4.5·§4.6)', () => {
  let dir: string
  /** 멱등 계층·자격증명·로그·작업공간 스토어가 공유하는 제어 평면 DB (mori-nest
   * #130·#131·#132). 닫는 것도 이쪽이다 — 넷 다 `close()`를 갖지 않는다. */
  let database: ControlDatabase
  let store: ControlStore
  let idempotency: IdempotencyStore
  let credentials: LauncherCredentialStore
  let workspaces: WorkspaceStore
  let server: Server
  let origin: string
  let tokenA: string
  let tokenB: string
  /** ⑭가 여는 두 번째 서버 — grace 창만 다르다. `afterEach`가 함께 닫는다. */
  const extraServers: Server[] = []

  async function send(path: string, init: RequestInit = {}, at: string = origin): Promise<Reply> {
    const response = await fetch(`${at}${path}`, init)
    return { status: response.status, text: await response.text() }
  }

  /** 설정만 갈아 끼운 서버 하나를 더 띄운다 — 스토어(= DB 파일)는 그대로 공유한다. */
  async function startServer(overrides: Partial<ControlConfig>): Promise<string> {
    const extra = createControlServer({
      database,
      store,
      idempotency,
      credentials,
      workspaces,
      config: { ...CONFIG, ...overrides },
    })
    await new Promise<void>((resolve) => {
      extra.listen(0, '127.0.0.1', resolve)
    })
    extraServers.push(extra)
    return `http://127.0.0.1:${String((extra.address() as AddressInfo).port)}`
  }

  function openWorkspace(token: string, key: string, body: string, at: string = origin): Promise<Reply> {
    return send(
      '/v1/workspaces',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': key },
        body,
      },
      at,
    )
  }

  /** `§4.3` 하트비트. 본문은 `{}`뿐이고 `Idempotency-Key`를 쓰지 않는다 (`§4.3`). */
  function heartbeat(workspaceId: string, token: string, at: string = origin): Promise<Reply> {
    return send(
      `/v1/workspaces/${workspaceId}/heartbeat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}',
      },
      at,
    )
  }

  /** `§4.4` 종료 선언. `reason`이 없다 — 개시·하트비트와 달리 이 라우트에 그 필드가 없다. */
  function closeWorkspace(
    workspaceId: string,
    token: string,
    outcome: 'flushed' | 'discarded',
    at: string = origin,
  ): Promise<Reply> {
    return send(
      `/v1/workspaces/${workspaceId}/close`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ outcome }),
      },
      at,
    )
  }

  /** `§4.5` 폐기. `reason`은 받지도 싣지도 않으므로(`§4.5`) 시험에서 보내지 않는다. */
  function revokeWorkspace(workspaceId: string, token: string, at: string = origin): Promise<Reply> {
    return send(
      `/v1/workspaces/${workspaceId}/revoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}',
      },
      at,
    )
  }

  /** 이 주체 앞으로 저장된 작업공간 수. 목록 라우트(#99)가 아직 없어 저장분을 직접 센다.
   * `workspaces`는 이제 `control-plane.db`(제어 평면 단일 DB, mori-nest #130)의 테이블이다 —
   * 별도 파일이 아니다. */
  function storedWorkspaceCount(subject: string): number {
    const db = new DatabaseSync(join(dir, 'control-plane.db'))
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE subject = ?').get(subject)
      return Number(row?.['n'])
    } finally {
      db.close()
    }
  }

  function createLog(token: string, key: string, body = '{}'): Promise<Reply> {
    return send('/v1/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': key },
      body,
    })
  }

  function read(path: string, token: string, at: string = origin): Promise<Reply> {
    return send(path, { headers: { Authorization: `Bearer ${token}` } }, at)
  }

  /** `Idempotency-Key`를 보내지 않는다 — `§2.6`이 이 라우트에 그 헤더를 요구하지 않는다. */
  function revokeLog(logId: string, token: string, body = '{}'): Promise<Reply> {
    return send(`/v1/logs/${logId}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
    })
  }

  /** `POST`가 `201`로 돌려준 `logId`. 실패하면 그 자리에서 시험을 세운다. */
  async function mintedLogId(token: string, key: string): Promise<string> {
    const reply = await createLog(token, key)
    expect(reply.status).toBe(201)
    return (bodyOf(reply) as { logId: string }).logId
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mori-nest-control-server-'))
    database = await openControlDatabase(join(dir, 'control-plane.db'))
    store = await openControlStore(database)
    idempotency = await openIdempotencyStore(database)
    credentials = await openLauncherCredentialStore(database)
    workspaces = await openWorkspaceStore(database)
    tokenA = (await credentials.issue('subject-a')).token
    tokenB = (await credentials.issue('subject-b')).token

    server = createControlServer({ database, store, idempotency, credentials, workspaces, config: CONFIG })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    origin = `http://127.0.0.1:${String(address.port)}`
  })

  afterEach(async () => {
    for (const running of [server, ...extraServers]) {
      // keep-alive로 살아 있는 소켓이 남으면 `close`가 끝나지 않는다 — 먼저 끊는다.
      running.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        running.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    }
    extraServers.length = 0
    // `store`·`workspaces` 둘 다 `database`의 연결 위에 선 리포지토리라 닫을 것이 없다
    // (mori-nest #131 · #132).
    await database.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('① POST /v1/logs가 201과 0002 §1.1을 만족하는 logId를 돌려준다 (§2.1)', async () => {
    const reply = await createLog(tokenA, 'key-create-1')

    expect(reply.status).toBe(201)
    const body = bodyOf(reply) as { logId: string }
    expect(body.logId).toMatch(LOG_ID_PATTERN)
    // 응답 `LogRecord`에 `logId` 외의 필드가 없다 (§2.4 — 메타데이터 자리는 §8-13 미결이다).
    expect(Object.keys(body)).toEqual(['logId'])
  })

  it('② 같은 키·같은 본문 재시도가 같은 201·같은 본문이고 자원은 하나뿐이다 (§1.4 MUST)', async () => {
    const first = await createLog(tokenA, 'key-retry')
    const retry = await createLog(tokenA, 'key-retry')

    // 같은 상태코드, 같은 본문 — 저장된 응답의 바이트가 그대로 재생된다.
    expect(retry.status).toBe(first.status)
    expect(retry.text).toBe(first.text)

    // 자원이 둘 생기지 않았음을 **결과로** 확인한다 (이슈 #84 테스트 ②).
    const listed = bodyOf(await read('/v1/logs', tokenA)) as { logs: { logId: string }[] }
    expect(listed.logs).toHaveLength(1)
  })

  it('③ 같은 키·다른 본문은 409 idempotency_key_reused다 (§1.4)', async () => {
    // `CreateLogRequest`는 정의된 필드가 없으므로(§2.1) 게이트를 통과하면서 다이제스트가
    // 갈리는 유일한 차이는 **바이트**다 — `{}`와 `{ }`가 그 대표다.
    await createLog(tokenA, 'key-reused', '{}')
    const conflicting = await createLog(tokenA, 'key-reused', '{ }')

    expect(conflicting.status).toBe(409)
    expect(bodyOf(conflicting)).toEqual({
      error: { code: 'idempotency_key_reused', message: expect.any(String) },
    })
  })

  it('④ GET /v1/logs 페이지네이션 — limit과 after가 스토어 판정 그대로 나온다 (§2.4)', async () => {
    for (const key of ['page-1', 'page-2', 'page-3']) {
      await mintedLogId(tokenA, key)
    }

    const firstPage = bodyOf(await read('/v1/logs?limit=2', tokenA)) as {
      logs: { logId: string }[]
      cursor?: string
      hasMore: boolean
    }
    expect(firstPage.logs).toHaveLength(2)
    expect(firstPage.hasMore).toBe(true)
    expect(firstPage.cursor).toBe(firstPage.logs[1]?.logId)

    const secondPage = bodyOf(await read(`/v1/logs?after=${String(firstPage.cursor)}`, tokenA)) as {
      logs: { logId: string }[]
      hasMore: boolean
    }
    expect(secondPage.logs).toHaveLength(1)
    expect(secondPage.hasMore).toBe(false)
    // 판정 → `logId` 사전순 정렬 → `limit` 순서가 스토어에서 이미 끝났다는 것 — 두 페이지를
    // 이으면 전체가 사전순이고 겹치지 않는다.
    const seen = [...firstPage.logs, ...secondPage.logs].map((log) => log.logId)
    expect(seen).toEqual([...seen].sort())
    expect(new Set(seen).size).toBe(3)

    // 서버 천장을 넘는 `limit`도 `200`이다 — 게이트는 형식만 보므로(§1.3에 이 판정의 code가
    // 없다) 상한을 라우트가 세우지 않으면 이 요청이 `500`이 된다. 깎는 것은 §2.4가 허락한
    // 동작이다("서버가 더 작게 깎을 수 있다").
    const huge = bodyOf(await read('/v1/logs?limit=99999999999', tokenA)) as {
      logs: { logId: string }[]
      hasMore: boolean
    }
    expect(huge.logs).toHaveLength(3)
    expect(huge.hasMore).toBe(false)
  })

  it('⑤ GET /v1/logs/{logId} — 남의 로그와 없는 로그의 404가 바이트 단위로 같다 (§2.4)', async () => {
    const mine = await mintedLogId(tokenA, 'own-log')
    const others = await mintedLogId(tokenB, 'other-log')

    const own = await read(`/v1/logs/${mine}`, tokenA)
    expect(own.status).toBe(200)
    expect(bodyOf(own)).toEqual({ logId: mine })

    // 존재하지만 이 주체에게 보이지 않는 로그와, 아예 없는 로그 — 열거 오라클이 되지 않게
    // 상태코드도 본문도 같아야 한다.
    const hidden = await read(`/v1/logs/${others}`, tokenA)
    const missing = await read('/v1/logs/does-not-exist', tokenA)
    expect(hidden.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(hidden.text).toBe(missing.text)
    expect(bodyOf(hidden)).toEqual({ error: { code: 'log_not_found', message: expect.any(String) } })
  })

  it('⑥ grant 판정을 통과하지 못하는 로그는 목록에서 빠진다 — 상태 필드가 아니다 (§2.4 MUST NOT)', async () => {
    const mine = await mintedLogId(tokenA, 'listed-log')
    const hidden = await mintedLogId(tokenB, 'hidden-log')

    const listed = bodyOf(await read('/v1/logs', tokenA)) as { logs: Record<string, unknown>[] }

    expect(listed.logs.map((log) => log['logId'])).toEqual([mine])
    expect(listed.logs.map((log) => log['logId'])).not.toContain(hidden)
    // 빠짐으로 표현하지 상태 표시로 표현하지 않는다 — `LogRecord`에 `state` 류 필드가 없다.
    for (const log of listed.logs) {
      expect(Object.keys(log)).toEqual(['logId'])
    }
  })

  it(
    '⑦ 원자성 회귀 — 같은 주체·키의 POST 두 건이 동시에 와도 로그는 정확히 하나다 (§1.4 MUST)',
    async () => {
      // 자식 각자가 **자기 프로세스에서 서버를 띄운다** — 두 서버가 같은 DB 파일들을 보므로
      // 경합이 라우트 배선을 통째로 지나 프로세스 경계를 건넌다 (`test/idempotency-race-child.mjs`가
      // 세운 선례 그대로: 스핀으로 시각을 맞추고 결과 한 줄을 JSON으로 낸다). 한 프로세스
      // 안의 두 요청으로는 이 자리가 시험되지 않는 이유는 자식 파일 머리말에 적혀 있다.
      const raceDir = join(dir, 'race')
      mkdirSync(raceDir)
      const raceDatabase = await openControlDatabase(join(raceDir, 'control-plane.db'))
      const raceCredentials = await openLauncherCredentialStore(raceDatabase)
      const raceToken = (await raceCredentials.issue('subject-race')).token
      await raceDatabase.close()

      const startAt = Date.now() + 1500
      const rounds = 5
      const replies = (
        await Promise.all([
          runRaceChild(raceDir, raceToken, 'race-key', startAt, rounds),
          runRaceChild(raceDir, raceToken, 'race-key', startAt, rounds),
        ])
      ).flat()

      // 진 쪽은 이긴 쪽이 아직 자원을 만드는 중이면 `503`, 이미 끝났으면 첫 응답의 재생(`201`)이다.
      // 어느 쪽이든 **새 자원을 만들지 않는다**는 것이 이 시험의 명제다.
      for (const reply of replies) {
        expect([201, 503]).toContain(reply.status)
      }
      // 라운드(= 키) 하나가 `201`로 돌려준 본문은 몇 건이 오든 전부 같은 하나여야 한다.
      for (let round = 0; round < rounds; round++) {
        const minted = replies.filter((reply) => reply.round === round && reply.status === 201).map((r) => r.text)
        expect(minted.length).toBeGreaterThanOrEqual(1)
        expect(new Set(minted).size).toBe(1)
      }

      // 자식들이 쓴 제어 평면 DB를 그대로 다시 연다 — 로그도 이제 그 DB에 산다
      // (mori-nest #131). 닫는 것은 연결의 소유자이므로 리포지토리가 아니라 이 DB를 닫는다.
      const verifyDatabase = await openControlDatabase(join(raceDir, 'control-plane.db'))
      try {
        const raceStore = await openControlStore(verifyDatabase)
        // 키 다섯 개 × 요청 두 건 = 열 건이 들어갔는데 로그는 키당 하나, 즉 다섯이다.
        const page = await raceStore.listLogsForSubject('subject-race')
        expect(page.logs).toHaveLength(rounds)
      } finally {
        await verifyDatabase.close()
      }
    },
    30_000,
  )

  it('⑧ 폐기 → 200 { logId, state: "revoked", revokedAt }, 재폐기는 바이트 단위로 같다 (§2.6 MUST)', async () => {
    const logId = await mintedLogId(tokenA, 'revoke-key-1')

    const first = await revokeLog(logId, tokenA)
    expect(first.status).toBe(200)
    const body = bodyOf(first) as { logId: string; state: string; revokedAt: string }
    expect(body).toEqual({ logId, state: 'revoked', revokedAt: expect.any(String) })

    const retry = await revokeLog(logId, tokenA)
    expect(retry.status).toBe(first.status)
    expect(retry.text).toBe(first.text)
  })

  it('⑨ 없는 logId와 남의 logId의 404가 바이트 단위로 같다 (§2.6)', async () => {
    const others = await mintedLogId(tokenB, 'other-revoke-log')

    const hidden = await revokeLog(others, tokenA)
    const missing = await revokeLog('does-not-exist', tokenA)

    expect(hidden.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(hidden.text).toBe(missing.text)
    expect(bodyOf(hidden)).toEqual({ error: { code: 'log_not_found', message: expect.any(String) } })
  })

  it('⑩ 폐기 후 GET /v1/logs 목록에서 빠지고 GET /v1/logs/{logId}가 404다 (§2.6)', async () => {
    const logId = await mintedLogId(tokenA, 'revoke-key-2')

    expect((await revokeLog(logId, tokenA)).status).toBe(200)

    const listed = bodyOf(await read('/v1/logs', tokenA)) as { logs: { logId: string }[] }
    expect(listed.logs.map((log) => log.logId)).not.toContain(logId)

    expect((await read(`/v1/logs/${logId}`, tokenA)).status).toBe(404)
  })

  it('⑪ 개시 → 201 + 여섯 필드, scope === logs, 그 토큰이 검증자를 통과한다 (§4.2·§3.6)', async () => {
    const logs = [await mintedLogId(tokenA, 'open-log-1'), await mintedLogId(tokenA, 'open-log-2')]

    const reply = await openWorkspace(tokenA, 'open-key-1', JSON.stringify({ logs }))

    expect(reply.status).toBe(201)
    const body = bodyOf(reply) as OpenReply
    expect(Object.keys(body).sort()).toEqual(
      ['expiresAt', 'heartbeatIntervalSeconds', 'scope', 'token', 'tokenId', 'workspaceId'].sort(),
    )
    // 서버가 넓히지도 조용히 좁히지도 않는다 (§3.6 MUST) — 순서까지 요청 그대로다.
    expect(body.scope).toEqual(logs)
    expect(body.heartbeatIntervalSeconds).toBe(CONFIG.heartbeatIntervalSeconds)

    // 이 조각의 핵심: 라우트 응답에서 꺼낸 토큰이 **전송 평면의 검증자**를 통과한다.
    // #94의 라운드트립과 다른 것은 토큰의 출처다 — 여기서는 클레임을 라우트가 지었다.
    const verified = verifyWorkspaceToken(body.token, VERIFICATION_KEYS)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.token.claims.workspaceId).toBe(body.workspaceId)
    expect(verified.token.claims.scope).toEqual(body.scope)
    expect(verified.token.claims.tokenId).toBe(body.tokenId)
    // 응답의 `expiresAt`이 토큰이 실은 만료와 같다 — 클라이언트가 토큰을 파싱하지 않고도
    // 만료를 알 수 있어야 한다는 §3.2의 전제가 이 등식이다.
    expect(verified.token.claims.expiresAt).toBe(body.expiresAt)
  })

  it('⑫ grant 불가 로그가 섞이면 403 not_grantable이고 작업공간이 만들어지지 않는다 (§3.6 MUST)', async () => {
    const mine = await mintedLogId(tokenA, 'grantable-log')
    const others = await mintedLogId(tokenB, 'not-mine-log')
    const missing = 'no-such-log'

    const reply = await openWorkspace(tokenA, 'open-key-403', JSON.stringify({ logs: [mine, others, missing] }))

    expect(reply.status).toBe(403)
    const error = bodyOf(reply) as { error: { code: string; details?: { logIds?: string[] } } }
    expect(error.error.code).toBe('not_grantable')
    // 첫 하나에서 멈추지 않는다 — 거부된 id가 **전부** 실려야 클라이언트가 한 번에 고친다.
    expect(error.error.details?.logIds).toEqual([others, missing])

    // all-or-nothing: 부분 성공이 없다.
    expect(storedWorkspaceCount('subject-a')).toBe(0)
  })

  it('⑬ 같은 키 재시도 → 같은 workspaceId·scope, 새 token·tokenId·expiresAt (§4.2 MUST)', async () => {
    const logs = [await mintedLogId(tokenA, 'retry-log')]
    const requestBody = JSON.stringify({ logs })

    const first = bodyOf(await openWorkspace(tokenA, 'open-key-retry', requestBody)) as OpenReply
    // `expiresAt`은 초 해상도다 (§3.2의 고정 20바이트) — 같은 초 안에서 재시도하면 값이
    // 같을 수밖에 없으므로, 그 필드가 **다시 계산된다**는 것을 보려면 초를 넘겨야 한다.
    await delay(1100)
    const retry = await openWorkspace(tokenA, 'open-key-retry', requestBody)

    expect(retry.status).toBe(201)
    const second = bodyOf(retry) as OpenReply
    expect(second.workspaceId).toBe(first.workspaceId)
    expect(second.scope).toEqual(first.scope)
    expect(second.heartbeatIntervalSeconds).toBe(first.heartbeatIntervalSeconds)
    // 서버가 토큰 문자열을 보관하면 §3.8을 깬다 — 재시도는 저장된 응답의 재생이 아니라
    // **새 발급**이다. `expiresAt`이 고정되면 늦은 재시도가 이미 지난 시각을 받는다.
    expect(second.token).not.toBe(first.token)
    expect(second.tokenId).not.toBe(first.tokenId)
    expect(second.expiresAt).not.toBe(first.expiresAt)
    // 새 토큰도 실제로 쓸 수 있어야 한다.
    expect(verifyWorkspaceToken(second.token, VERIFICATION_KEYS).ok).toBe(true)

    expect(storedWorkspaceCount('subject-a')).toBe(1)
  })

  it(
    '⑭ 재시도 대상이 종단 상태면 409 workspace_not_active + details 둘이다 (§4.2 MUST)',
    async () => {
      const logs = [await mintedLogId(tokenA, 'terminal-log')]
      const requestBody = JSON.stringify({ logs })

      // 오늘 도달 가능한 종단 경로는 `gracePeriod` 경과로 계산되는 `abandoned` 하나다
      // (§4.1 — 저장값이 아니라 조회 시각의 파생값). grace 창만 줄인 서버를 따로 띄운다:
      // `§3.4`가 `gracePeriod > tokenTtl ≥ 3 × heartbeat`을 요구하므로 이 넷이 최솟값이다.
      const impatient = await startServer({
        heartbeatIntervalSeconds: 1,
        tokenTtlSeconds: 3,
        gracePeriodSeconds: 4,
      })

      const first = bodyOf(await openWorkspace(tokenA, 'open-key-terminal', requestBody, impatient)) as OpenReply
      await delay(4200)

      const retry = await openWorkspace(tokenA, 'open-key-terminal', requestBody, impatient)

      expect(retry.status).toBe(409)
      // 첫 결과를 돌려주지 않는다 — 이 거부가 없으면 폐기·유기된 작업공간에 `tokenTtl`짜리
      // 새 토큰이 나가고, §3.5가 약속한 수렴 시간이 이 경로에서 성립하지 않는다.
      expect(bodyOf(retry)).toEqual({
        error: {
          code: 'workspace_not_active',
          message: expect.any(String),
          // 응답을 잃은 런처가 `supersedes`(§4.7)로 이을 수 있어야 한다 (MUST).
          details: { workspaceId: first.workspaceId, state: 'abandoned' },
        },
      })
    },
    20_000,
  )

  it('⑮ supersedes가 다른 주체의 작업공간이면 404 workspace_not_found다 (§4.2 MUST)', async () => {
    const othersLogs = [await mintedLogId(tokenB, 'supersedes-log')]
    const others = bodyOf(
      await openWorkspace(tokenB, 'open-key-others', JSON.stringify({ logs: othersLogs })),
    ) as OpenReply

    const mine = [await mintedLogId(tokenA, 'supersedes-mine-log')]
    const reply = await openWorkspace(
      tokenA,
      'open-key-supersedes',
      JSON.stringify({ logs: mine, supersedes: others.workspaceId }),
    )

    // "이어받음이 사실인가"는 판정할 수 없지만 "쓰는 사람이 그 기록의 주인인가"는 판정한다.
    expect(reply.status).toBe(404)
    expect(bodyOf(reply)).toEqual({ error: { code: 'workspace_not_found', message: expect.any(String) } })
    // 남의 유기 기록을 덮어쓰는 쓰기가 되지 않게, 이 실패는 작업공간을 만들지 않는다.
    expect(storedWorkspaceCount('subject-a')).toBe(0)
  })

  it('⑯ 하트비트 → 200 + 일곱 필드, 새 tokenId·앞으로 간 expiresAt, 그 토큰이 검증자를 통과한다 (§4.3)', async () => {
    const logs = [await mintedLogId(tokenA, 'hb-log-1'), await mintedLogId(tokenA, 'hb-log-2')]
    const opened = bodyOf(await openWorkspace(tokenA, 'hb-key-1', JSON.stringify({ logs }))) as OpenReply

    // `expiresAt`은 초 해상도다 (§3.2) — 같은 초 안에서 갱신하면 값이 같을 수밖에 없다.
    await delay(1100)
    const reply = await heartbeat(opened.workspaceId, tokenA)

    expect(reply.status).toBe(200)
    const body = bodyOf(reply) as HeartbeatReply
    expect(Object.keys(body).sort()).toEqual(
      ['expiresAt', 'heartbeatIntervalSeconds', 'scope', 'state', 'token', 'tokenId', 'workspaceId'].sort(),
    )
    expect(body.workspaceId).toBe(opened.workspaceId)
    expect(body.state).toBe('active')
    expect(body.scope).toEqual(logs)
    expect(body.heartbeatIntervalSeconds).toBe(CONFIG.heartbeatIntervalSeconds)
    // 겹침이 없으면 `forkAdvisory` 키 자체가 없다 (§4.10, exactOptionalPropertyTypes).
    expect('forkAdvisory' in body).toBe(false)
    // 갱신은 **새 발급**이다 (§3.4) — 저장된 토큰의 재생이 아니다. `expiresAt`이 앞으로 가지
    // 않으면 하트비트를 아무리 보내도 수명이 늘지 않아 §3.5의 수렴이 성립하지 않는다.
    expect(body.tokenId).not.toBe(opened.tokenId)
    expect(body.token).not.toBe(opened.token)
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.parse(opened.expiresAt))

    const verified = verifyWorkspaceToken(body.token, VERIFICATION_KEYS)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.token.claims.workspaceId).toBe(body.workspaceId)
    expect(verified.token.claims.scope).toEqual(body.scope)
  })

  it('⑰ 자격을 잃은 로그는 scope에서 빠지고, 전부 빠지면 403이며 lastHeartbeatAt이 안 옮겨진다 (§3.4 MUST)', async () => {
    const kept = await mintedLogId(tokenA, 'hb-narrow-keep')
    const lost = await mintedLogId(tokenA, 'hb-narrow-lost')
    const opened = bodyOf(
      await openWorkspace(tokenA, 'hb-key-narrow', JSON.stringify({ logs: [lost, kept] })),
    ) as OpenReply

    expect((await revokeLog(lost, tokenA)).status).toBe(200)
    const narrowed = await heartbeat(opened.workspaceId, tokenA)

    // 좁힘은 all-or-nothing이 아니다 — 남은 로그로의 flush 경로를 끊지 않는다. 그리고 좁아진
    // 결과가 **응답에 그대로 실린다**: 응답이 실제 스코프를 말하지 않으면 그게 조용한 좁힘이다.
    expect(narrowed.status).toBe(200)
    const narrowedBody = bodyOf(narrowed) as HeartbeatReply
    expect(narrowedBody.scope).toEqual([kept])
    // 토큰의 클레임도 같이 좁아져야 전송 평면이 실제 권한대로 판정한다 (§3.2).
    const verified = verifyWorkspaceToken(narrowedBody.token, VERIFICATION_KEYS)
    expect(verified.ok).toBe(true)
    if (verified.ok) expect(verified.token.claims.scope).toEqual([kept])

    const gracePeriodMs = CONFIG.gracePeriodSeconds * 1000
    const before = await workspaces.getWorkspace('subject-a', opened.workspaceId, { gracePeriodMs })
    // 좁아진 스코프는 저장되지 않는다 — 매 갱신이 **개시 시 스코프**를 다시 판정한다 (§4.6).
    expect(before?.logs).toEqual([lost, kept])

    expect((await revokeLog(kept, tokenA)).status).toBe(200)
    // `lastHeartbeatAt`은 초 해상도일 수 있다 — 초를 넘겨야 "안 옮겨졌다"가 관찰된다.
    await delay(1100)
    const denied = await heartbeat(opened.workspaceId, tokenA)

    expect(denied.status).toBe(403)
    expect(bodyOf(denied)).toEqual({
      error: {
        code: 'not_grantable',
        message: expect.any(String),
        // 빠진 로그를 **전부** 싣는다 — §4.2 개시의 403과 같은 모양이다.
        details: { logIds: [lost, kept] },
      },
    })
    // 403이 전이를 남기면, 자격을 전부 잃은 런처가 하트비트를 보낼 때마다 유기 시계가 뒤로
    // 밀려 그 작업공간은 토큰도 못 받으면서 영영 `abandoned`가 되지 않는다 (§4.7).
    const after = await workspaces.getWorkspace('subject-a', opened.workspaceId, { gracePeriodMs })
    expect(after?.lastHeartbeatAt).toBe(before?.lastHeartbeatAt)
  })

  it(
    '⑱ 종단 상태(gracePeriod 경과로 abandoned)의 하트비트는 409 workspace_not_active다 (§4.1)',
    async () => {
      // ⑭와 같은 이유·같은 최솟값의 서버다 (§3.4: gracePeriod > tokenTtl ≥ 3 × heartbeat).
      const impatient = await startServer({ heartbeatIntervalSeconds: 1, tokenTtlSeconds: 3, gracePeriodSeconds: 4 })
      const logs = [await mintedLogId(tokenA, 'hb-terminal-log')]
      const opened = bodyOf(
        await openWorkspace(tokenA, 'hb-key-terminal', JSON.stringify({ logs }), impatient),
      ) as OpenReply

      await delay(4200)
      const reply = await heartbeat(opened.workspaceId, tokenA, impatient)

      expect(reply.status).toBe(409)
      expect(bodyOf(reply)).toEqual({ error: { code: 'workspace_not_active', message: expect.any(String) } })
    },
    20_000,
  )

  it('⑲ 다른 주체의 workspaceId면 404 workspace_not_found다 (§4.6 MUST — 열거 오라클 방지)', async () => {
    const othersLogs = [await mintedLogId(tokenB, 'hb-others-log')]
    const others = bodyOf(
      await openWorkspace(tokenB, 'hb-key-others', JSON.stringify({ logs: othersLogs })),
    ) as OpenReply

    const reply = await heartbeat(others.workspaceId, tokenA)

    expect(reply.status).toBe(404)
    expect(bodyOf(reply)).toEqual({ error: { code: 'workspace_not_found', message: expect.any(String) } })
  })

  it('⑳ 종료 선언 → 200 + 세 필드, 같은 outcome 재시도는 같은 본문, 다른 outcome은 409 (§4.4 MUST)', async () => {
    const logs = [await mintedLogId(tokenA, 'close-log-1')]
    const opened = bodyOf(await openWorkspace(tokenA, 'close-key-1', JSON.stringify({ logs }))) as OpenReply

    const first = await closeWorkspace(opened.workspaceId, tokenA, 'flushed')
    expect(first.status).toBe(200)
    const firstBody = bodyOf(first) as TerminalReply
    expect(Object.keys(firstBody).sort()).toEqual(['endedAt', 'state', 'workspaceId'].sort())
    expect(firstBody.workspaceId).toBe(opened.workspaceId)
    expect(firstBody.state).toBe('closed_flushed')

    // 멱등성 키 없이 멱등이다 (§4.4 MUST) — 첫 endedAt이 그대로 다시 나온다. 새로 구현하지
    // 않는다: 스토어가 이미 갖고 있는 성질을 응답으로 그대로 흘려보낼 뿐이다.
    const retry = await closeWorkspace(opened.workspaceId, tokenA, 'flushed')
    expect(retry.status).toBe(200)
    expect(bodyOf(retry)).toEqual(firstBody)

    // 다른 outcome으로 다시 닫으려 하면 409 workspace_not_active다.
    const conflicting = await closeWorkspace(opened.workspaceId, tokenA, 'discarded')
    expect(conflicting.status).toBe(409)
    expect(bodyOf(conflicting)).toEqual({ error: { code: 'workspace_not_active', message: expect.any(String) } })
  })

  it('㉑ 폐기 → 200 + state: "revoked", 재시도가 같은 본문, 닫힌 작업공간의 폐기는 409 (§4.5 MUST)', async () => {
    const logs = [await mintedLogId(tokenA, 'revoke-log-1')]
    const opened = bodyOf(await openWorkspace(tokenA, 'revoke-key-1', JSON.stringify({ logs }))) as OpenReply

    const first = await revokeWorkspace(opened.workspaceId, tokenA)
    expect(first.status).toBe(200)
    const firstBody = bodyOf(first) as TerminalReply
    expect(firstBody.workspaceId).toBe(opened.workspaceId)
    expect(firstBody.state).toBe('revoked')

    const retry = await revokeWorkspace(opened.workspaceId, tokenA)
    expect(retry.status).toBe(200)
    expect(bodyOf(retry)).toEqual(firstBody)

    const closedLogs = [await mintedLogId(tokenA, 'revoke-log-closed')]
    const closedOpened = bodyOf(
      await openWorkspace(tokenA, 'revoke-key-closed', JSON.stringify({ logs: closedLogs })),
    ) as OpenReply
    expect((await closeWorkspace(closedOpened.workspaceId, tokenA, 'flushed')).status).toBe(200)

    const onClosed = await revokeWorkspace(closedOpened.workspaceId, tokenA)
    expect(onClosed.status).toBe(409)
    expect(bodyOf(onClosed)).toEqual({ error: { code: 'workspace_not_active', message: expect.any(String) } })
  })

  it('㉒ 다른 주체의 workspaceId면 종료·폐기 둘 다 404 workspace_not_found다 (§4.4·§4.5)', async () => {
    const othersLogs = [await mintedLogId(tokenB, 'terminal-others-log')]
    const others = bodyOf(
      await openWorkspace(tokenB, 'terminal-key-others', JSON.stringify({ logs: othersLogs })),
    ) as OpenReply

    const closeReply = await closeWorkspace(others.workspaceId, tokenA, 'flushed')
    expect(closeReply.status).toBe(404)
    expect(bodyOf(closeReply)).toEqual({ error: { code: 'workspace_not_found', message: expect.any(String) } })

    const revokeReply = await revokeWorkspace(others.workspaceId, tokenA)
    expect(revokeReply.status).toBe(404)
    expect(bodyOf(revokeReply)).toEqual({ error: { code: 'workspace_not_found', message: expect.any(String) } })
  })

  it('㉓ GET /v1/workspaces → 200, openedAt 오름차순, hasMore:false, logs가 개시 시 스코프 그대로 (§4.6)', async () => {
    const openedIds: string[] = []
    const scopes: string[][] = []
    for (const key of ['list-key-1', 'list-key-2', 'list-key-3']) {
      const logs = [await mintedLogId(tokenA, `${key}-log`)]
      const opened = bodyOf(await openWorkspace(tokenA, key, JSON.stringify({ logs }))) as OpenReply
      openedIds.push(opened.workspaceId)
      scopes.push(logs)
    }

    const reply = await read('/v1/workspaces', tokenA)

    expect(reply.status).toBe(200)
    const body = bodyOf(reply) as { workspaces: Record<string, unknown>[]; cursor?: string; hasMore: boolean }
    expect(body.workspaces.map((workspace) => workspace['workspaceId'])).toEqual(openedIds)
    expect(body.hasMore).toBe(false)
    // `cursor`는 스토어가 발급한 불투명 값이다 — `workspaceId`가 아니다 (§4.6).
    expect(body.cursor).toEqual(expect.any(String))
    // §4.6이 답한 스코프는 개시 시 요청 그대로다 — 갱신으로 좁아진 현재 스코프가 아니다.
    expect(body.workspaces.map((workspace) => workspace['logs'])).toEqual(scopes)
    // §3.8 MUST NOT — 조회 응답에 토큰이 실리지 않는다.
    for (const workspace of body.workspaces) {
      expect(workspace['token']).toBeUndefined()
    }
  })

  it('㉔ limit로 잘린 페이지의 cursor를 after에 넣으면 나머지가 나오고 hasMore가 맞다 (§4.6)', async () => {
    const openedIds: string[] = []
    for (const key of ['page-key-1', 'page-key-2', 'page-key-3']) {
      const logs = [await mintedLogId(tokenA, `${key}-log`)]
      const opened = bodyOf(await openWorkspace(tokenA, key, JSON.stringify({ logs }))) as OpenReply
      openedIds.push(opened.workspaceId)
    }

    const firstPage = bodyOf(await read('/v1/workspaces?limit=2', tokenA)) as {
      workspaces: { workspaceId: string }[]
      cursor?: string
      hasMore: boolean
    }
    expect(firstPage.workspaces).toHaveLength(2)
    expect(firstPage.hasMore).toBe(true)
    // `cursor`는 스토어가 발급한 불투명 값이다 — `workspaceId`가 아니다 (§4.6).
    expect(firstPage.cursor).toEqual(expect.any(String))

    const secondPage = bodyOf(await read(`/v1/workspaces?after=${String(firstPage.cursor)}`, tokenA)) as {
      workspaces: { workspaceId: string }[]
      hasMore: boolean
    }
    expect(secondPage.workspaces).toHaveLength(1)
    expect(secondPage.hasMore).toBe(false)

    // 필터 → 정렬 → limit이 스토어에서 이미 끝났다는 것 — 두 페이지를 이으면 개시 순서 그대로다.
    const seen = [...firstPage.workspaces, ...secondPage.workspaces].map((workspace) => workspace.workspaceId)
    expect(seen).toEqual(openedIds)
  })

  it('㉕ state=<다섯 밖>이면 400 invalid_state_filter, 깨진 after면 400 invalid_cursor (§4.6)', async () => {
    const invalidState = await read('/v1/workspaces?state=bogus', tokenA)
    expect(invalidState.status).toBe(400)
    expect(bodyOf(invalidState)).toEqual({ error: { code: 'invalid_state_filter', message: expect.any(String) } })

    const invalidCursor = await read('/v1/workspaces?after=not-a-cursor', tokenA)
    expect(invalidCursor.status).toBe(400)
    expect(bodyOf(invalidCursor)).toEqual({ error: { code: 'invalid_cursor', message: expect.any(String) } })

    // 반복 쿼리도 "해석 불가"로 같은 code에 합류한다 (state·after) — limit만 malformed_request.
    const repeatedState = await read('/v1/workspaces?state=open&state=closed', tokenA)
    expect(repeatedState.status).toBe(400)
    expect(bodyOf(repeatedState)).toEqual({ error: { code: 'invalid_state_filter', message: expect.any(String) } })

    const repeatedAfter = await read('/v1/workspaces?after=a&after=b', tokenA)
    expect(repeatedAfter.status).toBe(400)
    expect(bodyOf(repeatedAfter)).toEqual({ error: { code: 'invalid_cursor', message: expect.any(String) } })

    const repeatedLimit = await read('/v1/workspaces?limit=1&limit=2', tokenA)
    expect(repeatedLimit.status).toBe(400)
    expect(bodyOf(repeatedLimit)).toEqual({ error: { code: 'malformed_request', message: expect.any(String) } })
  })

  it(
    '㉖ 단건 조회 — 자기 것은 200, 남의 것은 404, gracePeriod 경과분은 abandoned고 endedAt이 두 조회에서 같다 (§4.6)',
    async () => {
      const logs = [await mintedLogId(tokenA, 'get-log-1')]
      const opened = bodyOf(await openWorkspace(tokenA, 'get-key-1', JSON.stringify({ logs }))) as OpenReply

      const own = await read(`/v1/workspaces/${opened.workspaceId}`, tokenA)
      expect(own.status).toBe(200)
      const ownBody = bodyOf(own) as Record<string, unknown>
      expect(ownBody['workspaceId']).toBe(opened.workspaceId)
      expect(ownBody['state']).toBe('active')
      expect(ownBody['logs']).toEqual(logs)
      expect(ownBody['token']).toBeUndefined()

      // 남의 작업공간과 없는 작업공간의 404가 바이트 단위로 같다 (열거 오라클 방지).
      const othersLogs = [await mintedLogId(tokenB, 'get-others-log')]
      const others = bodyOf(
        await openWorkspace(tokenB, 'get-key-others', JSON.stringify({ logs: othersLogs })),
      ) as OpenReply
      const hidden = await read(`/v1/workspaces/${others.workspaceId}`, tokenA)
      const missing = await read('/v1/workspaces/does-not-exist', tokenA)
      expect(hidden.status).toBe(404)
      expect(missing.status).toBe(404)
      expect(hidden.text).toBe(missing.text)
      expect(bodyOf(hidden)).toEqual({ error: { code: 'workspace_not_found', message: expect.any(String) } })

      // gracePeriod 경과로 abandoned — endedAt이 lastHeartbeatAt + gracePeriod이고, 조회 시각이
      // 아니므로 같은 기록을 두 번 조회해도 같은 값이 나온다 (§4.6 MUST).
      const impatient = await startServer({ heartbeatIntervalSeconds: 1, tokenTtlSeconds: 3, gracePeriodSeconds: 4 })
      const abandonLogs = [await mintedLogId(tokenA, 'get-abandon-log')]
      const abandonOpened = bodyOf(
        await openWorkspace(tokenA, 'get-abandon-key', JSON.stringify({ logs: abandonLogs }), impatient),
      ) as OpenReply

      await delay(4200)
      const firstAbandoned = await read(`/v1/workspaces/${abandonOpened.workspaceId}`, tokenA, impatient)
      expect(firstAbandoned.status).toBe(200)
      const firstBody = bodyOf(firstAbandoned) as { state: string; endedAt: string }
      expect(firstBody.state).toBe('abandoned')

      const secondAbandoned = await read(`/v1/workspaces/${abandonOpened.workspaceId}`, tokenA, impatient)
      expect(secondAbandoned.status).toBe(200)
      expect(bodyOf(secondAbandoned)).toEqual(firstBody)
    },
    20_000,
  )

  it('㉗ 같은 replicaId로 겹치는 두 작업공간 중 하나에 하트비트를 치면 200 + forkAdvisory, token은 정상 갱신된다 (§4.10)', async () => {
    const logsA = [await mintedLogId(tokenA, 'fork-log-a')]
    const openedA = bodyOf(
      await openWorkspace(tokenA, 'fork-key-a', JSON.stringify({ logs: logsA, replicaId: 'r1' })),
    ) as OpenReply
    const logsB = [await mintedLogId(tokenA, 'fork-log-b')]
    const openedB = bodyOf(
      await openWorkspace(tokenA, 'fork-key-b', JSON.stringify({ logs: logsB, replicaId: 'r1' })),
    ) as OpenReply

    const reply = await heartbeat(openedA.workspaceId, tokenA)

    expect(reply.status).toBe(200)
    const body = bodyOf(reply) as HeartbeatReply & {
      forkAdvisory?: { replicaId: string; overlappingWorkspaceId: string }
    }
    expect(body.forkAdvisory).toEqual({ replicaId: 'r1', overlappingWorkspaceId: openedB.workspaceId })
    // advisory가 실려도 성패·다른 필드는 바뀌지 않는다 — 갱신은 정상이다 (§4.10 MUST).
    expect(body.state).toBe('active')
    expect(body.scope).toEqual(logsA)
    expect(body.tokenId).not.toBe(openedA.tokenId)
    expect(body.token).not.toBe(openedA.token)
  })

  it('㉘ findForkAdvisory가 던져도 하트비트는 200이고 forkAdvisory 키만 빠진다 (§4.10 MUST NOT)', async () => {
    const diagnostics: ControlDiagnostic[] = []
    const failing = createControlServer({
      database,
      store,
      idempotency,
      credentials,
      workspaces: withFailingForkAdvisory(workspaces),
      config: CONFIG,
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic)
      },
    })
    await new Promise<void>((resolve) => {
      failing.listen(0, '127.0.0.1', resolve)
    })
    extraServers.push(failing)
    const at = `http://127.0.0.1:${String((failing.address() as AddressInfo).port)}`

    const logs = [await mintedLogId(tokenA, 'fork-fail-log')]
    const opened = bodyOf(await openWorkspace(tokenA, 'fork-fail-key', JSON.stringify({ logs }), at)) as OpenReply

    const reply = await heartbeat(opened.workspaceId, tokenA, at)

    expect(reply.status).toBe(200)
    const body = bodyOf(reply) as HeartbeatReply
    expect('forkAdvisory' in body).toBe(false)
    // 나머지 필드는 판정 실패와 무관하게 정상 갱신된다.
    expect(body.state).toBe('active')
    expect(body.scope).toEqual(logs)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.site).toBe('fork_advisory')
  })

  it('㉙ onDiagnostic 훅 자신이 던져도 하트비트는 200이다 (전송 평면 diagnosticSink 규율)', async () => {
    const throwing = createControlServer({
      database,
      store,
      idempotency,
      credentials,
      workspaces: withFailingForkAdvisory(workspaces),
      config: CONFIG,
      onDiagnostic: () => {
        throw new Error('onDiagnostic boom (시험용)')
      },
    })
    await new Promise<void>((resolve) => {
      throwing.listen(0, '127.0.0.1', resolve)
    })
    extraServers.push(throwing)
    const at = `http://127.0.0.1:${String((throwing.address() as AddressInfo).port)}`

    const logs = [await mintedLogId(tokenA, 'fork-hook-throw-log')]
    const opened = bodyOf(
      await openWorkspace(tokenA, 'fork-hook-throw-key', JSON.stringify({ logs }), at),
    ) as OpenReply

    const reply = await heartbeat(opened.workspaceId, tokenA, at)

    expect(reply.status).toBe(200)
    const body = bodyOf(reply) as HeartbeatReply
    expect('forkAdvisory' in body).toBe(false)
    expect(body.state).toBe('active')
  })
})
