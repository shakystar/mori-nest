/**
 * append 라우트 배선 + 최소 HTTP 서버 (`node:http`, 빌트인). 런타임 의존성 0을 유지한다.
 *
 * `POST /v1/logs/{logId}/events` 한 라우트만 배선한다 (`0002 §2`). 잇는 순서는 `request.ts`
 * doc이 이미 그어 둔 경계 그대로다: `verifyTransportRequest`(요청 게이트) →
 * `parseAppendRequest`(본문 게이트) → `store.append` → 응답. 게이트 판정은 이 파일에서
 * 다시 구현하지 않고 기존 순수 함수를 그대로 부른다.
 *
 * pull·subscribe는 후속 조각이다 — `verifyTransportRequest`는 이미 그 둘의 라우트를
 * 해석하지만(`§0`의 표가 셋이다), 이 파일에는 핸들러가 없다. 해석된 라우트가 `append`가
 * 아니면 `500 internal`로 fail-closed한다: `§1.5`의 상태코드 표에 "아직 안 만든 라우트"에
 * 맞는 code가 없고(`404`도 없다), 조용히 통과시키는 쪽보다 이 쪽이 안전하다.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { ErrorCodes, errorResponse } from './errors.js'
import { parseAppendRequest } from './event.js'
import { verifyTransportRequest, type RawRequest } from './request.js'
import type { VerificationKeySet } from './token.js'
import type { EventStore } from './store.js'

export type TransportServerOptions = {
  readonly store: EventStore
  readonly keys: VerificationKeySet
  /** `§3.1` L304의 서버 상한. pull 라우트가 생기기 전까지는 `verifyTransportRequest`가 통과만 시킨다. */
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

  if (result.request.route !== 'append') {
    writeJson(res, 500, errorResponse(ErrorCodes.internal, 'this route is not wired up yet'))
    return
  }

  const rawBody = await readBody(req)
  await handleAppend(options.store, result.request.logId, rawBody, res)
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
