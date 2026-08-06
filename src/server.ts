/**
 * append·pull 라우트 배선 + 최소 HTTP 서버 (`node:http`, 빌트인). 런타임 의존성 0을 유지한다.
 *
 * `POST /v1/logs/{logId}/events`(`0002 §2`) · `GET /v1/logs/{logId}/events`(`§3`) 둘을
 * 배선한다. 잇는 순서는 `request.ts` doc이 이미 그어 둔 경계 그대로다: append는
 * `verifyTransportRequest`(요청 게이트) → `parseAppendRequest`(본문 게이트) →
 * `store.append` → 응답. pull은 `verifyTransportRequest` → `store.readPage` →
 * `serializePullResponse` → 응답. 게이트 판정은 이 파일에서 다시 구현하지 않고 기존 순수
 * 함수를 그대로 부른다 — 커서 해석·정렬·`limit` 적용·`hasMore`/`from` 판정은 전부
 * `store.readPage`가 이미 답한 `PullPage`를 그대로 옮길 뿐이다 (mori-nest #29 착수 시점
 * owner 코멘트).
 *
 * subscribe는 후속 조각이다 — `verifyTransportRequest`는 이미 그 라우트를 해석하지만
 * (`§0`의 표가 셋이다), 이 파일에는 핸들러가 없다. 해석된 라우트가 `append`·`pull`이
 * 아니면 `500 internal`로 fail-closed한다: `§1.5`의 상태코드 표에 "아직 안 만든 라우트"에
 * 맞는 code가 없고(`404`도 없다), 조용히 통과시키는 쪽보다 이 쪽이 안전하다.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { ErrorCodes, errorResponse } from './errors.js'
import { parseAppendRequest } from './event.js'
import { serializePullResponse } from './pull.js'
import { verifyTransportRequest, type CursorStart, type RawRequest } from './request.js'
import type { VerificationKeySet } from './token.js'
import type { EventStore } from './store.js'

export type TransportServerOptions = {
  readonly store: EventStore
  readonly keys: VerificationKeySet
  /** `§3.1` L304의 서버 상한. `verifyTransportRequest`가 `limit` 상한 판정에 그대로 쓴다. */
  readonly maxLimit?: number
  /**
   * 판정 기준 시각을 매 요청마다 얻는 함수. 부재면 `verifyTransportRequest`가 요청마다
   * `new Date()`를 쓴다 (운영 기본값). 테스트가 고정 시각의 토큰을 검증하려면 주입한다.
   */
  readonly now?: () => Date
}

function toRawRequest(req: IncomingMessage): RawRequest {
  return {
    method: req.method ?? '',
    url: req.url ?? '',
    headers: req.headers,
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * `serializePullResponse`가 이미 만든 JSON 텍스트를 그대로 내보낸다. `writeJson`과 갈라
 * 두는 이유: `body`가 이미 와이어 텍스트이므로 여기서 `JSON.stringify`를 또 부르면
 * `pull.ts`가 손조립한 payload 원문(`event.payload`)이 문자열 리터럴로 한 번 더 감싸진다
 * (`pull.ts` 파일 상단 doc — "이 파일이 `JSON.stringify(응답객체)` 한 번이 아닌 이유").
 */
function writeRaw(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body)
}

/**
 * append 본문 게이트 → 스토어 → 응답.
 *
 * `§2.2`: `store.append`의 `Promise`가 resolve된 시점이 내구화 완료 시점이다 — 그 뒤에만
 * `200`을 쓴다. reject되면(내구화를 보장할 수 없으면) `503 not_durable`이다. 스토어 예외의
 * `message`를 에러 봉투로 그대로 옮기지 않는다 (`store.ts` doc — `§1.5` L145-146 MUST NOT):
 * 여기서 쓰는 메시지는 항상 고정 문자열이다.
 */
async function handleAppend(store: EventStore, logId: string, rawBody: string, res: ServerResponse): Promise<void> {
  const parsed = parseAppendRequest(rawBody)
  if (!parsed.ok) {
    writeJson(res, parsed.status, parsed.error)
    return
  }

  let result
  try {
    result = await store.append(logId, parsed.events)
  } catch {
    writeJson(res, 503, errorResponse(ErrorCodes.not_durable, 'append could not be durably committed'))
    return
  }

  // `result`는 `{accepted, duplicate}` 그대로다 — head 커서를 싣는 자리가 없다 (`§2.1` MUST).
  writeJson(res, 200, result)
}

/**
 * `store.readPage` → `serializePullResponse` → 응답. 커서 해석·정렬·`limit` 적용·
 * `hasMore`/`from` 판정은 여기서 다시 계산하지 않는다 — `readPage`가 돌려준 `PullPage`를
 * `serializePullResponse`에 그대로 넘긴다 (mori-nest #29 착수 시점 owner 코멘트).
 *
 * 두 실패는 둘 다 이 라우트가 넘긴 값의 결함이 아니라 저장소 쪽 결함이므로(`pull.ts`의
 * 결정 1·3 — `hasMore: true`인데 `events`가 비었거나 payload 원문이 빈 이벤트가 스토어에서
 * 나왔다는 뜻이다) 클라이언트 요청 형식과 무관한 `500 internal`로 fail-closed한다.
 * `store.readPage`의 예외(`limit`이 양의 안전 정수가 아니면 등)도 같은 code로 옮긴다 —
 * 게이트가 이미 `limit` 형식·상한을 판정했으므로 정상 경로에서는 닿지 않는다.
 */
async function handlePull(
  store: EventStore,
  logId: string,
  start: CursorStart,
  limit: number | undefined,
  res: ServerResponse,
): Promise<void> {
  let page
  try {
    page = await store.readPage(logId, start, limit)
  } catch {
    writeJson(res, 500, errorResponse(ErrorCodes.internal, 'pull page could not be read'))
    return
  }

  const serialized = serializePullResponse(page)
  if (!serialized.ok) {
    writeJson(res, 500, errorResponse(ErrorCodes.internal, 'store returned a page the pull response cannot serialize'))
    return
  }

  writeRaw(res, 200, serialized.body)
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: TransportServerOptions,
): Promise<void> {
  const gateOptions: { now?: Date; maxLimit?: number } = {}
  if (options.now !== undefined) {
    gateOptions.now = options.now()
  }
  if (options.maxLimit !== undefined) {
    gateOptions.maxLimit = options.maxLimit
  }

  const result = verifyTransportRequest(toRawRequest(req), options.keys, gateOptions)
  if (!result.ok) {
    writeJson(res, result.status, result.error, result.headers)
    return
  }

  if (result.request.route === 'append') {
    const rawBody = await readBody(req)
    await handleAppend(options.store, result.request.logId, rawBody, res)
    return
  }

  if (result.request.route === 'pull') {
    await handlePull(options.store, result.request.logId, result.request.start, result.request.limit, res)
    return
  }

  writeJson(res, 500, errorResponse(ErrorCodes.internal, 'this route is not wired up yet'))
}

/**
 * 전송 평면 HTTP 서버를 만든다. `listen`은 부르는 쪽이 한다 — 포트를 이 함수가 정하지 않는다.
 */
export function createTransportServer(options: TransportServerOptions): Server {
  return createServer((req, res) => {
    handleRequest(req, res, options).catch(() => {
      // `req`/`res` 스트림 자체의 오류(연결이 끊기는 등)만 여기 닿는다 — 게이트·스토어의
      // 실패는 `handleRequest` 안에서 이미 응답으로 끝난다. 이미 끊긴 연결에 다시 쓰지 않는다.
      if (!res.writableEnded) {
        writeJson(res, 500, errorResponse(ErrorCodes.internal, 'unexpected server error'))
      }
    })
  })
}
