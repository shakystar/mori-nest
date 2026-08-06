/**
 * append·pull·subscribe 라우트 배선 + 최소 HTTP 서버 (`node:http`, 빌트인). 런타임 의존성
 * 0을 유지한다.
 *
 * `POST /v1/logs/{logId}/events`(`0002 §2`) · `GET /v1/logs/{logId}/events`(`§3`) ·
 * `GET /v1/logs/{logId}/subscribe`(`§4`) 셋을 배선한다. 잇는 순서는 `request.ts` doc이 이미
 * 그어 둔 경계 그대로다: append는 `verifyTransportRequest`(요청 게이트) →
 * `parseAppendRequest`(본문 게이트) → `store.append` → 응답. pull은 `verifyTransportRequest`
 * → `store.readPage` → `serializePullResponse` → 응답. subscribe는 `verifyTransportRequest`
 * → (연결을 열고) `store.readPage`를 반복 호출하며 `sse.ts`로 프레임을 만들어 쓴다. 게이트
 * 판정은 이 파일에서 다시 구현하지 않고 기존 순수 함수를 그대로 부른다 — 커서 해석·정렬·
 * `limit` 적용·`hasMore`/`from` 판정은 전부 `store.readPage`가 이미 답한 `PullPage`를 그대로
 * 옮길 뿐이다 (mori-nest #29·#30 착수 시점 owner 코멘트).
 *
 * ## subscribe가 새 이벤트를 알아채는 방법 — `store.readPage`를 반복해서 부른다
 *
 * `sse.ts`·`pull.ts`·`request.ts`는 손대지 않는다(mori-nest #30 비범위) — subscribe가 커서를
 * 재개하는 방식은 pull과 **같은 함수**(`store.readPage`, `CursorStart`)를 그대로 타는 것이다.
 * 새 이벤트가 왔다는 것을 아는 방법은 {@link LogBroker}인데, 이 브로커는 **데이터를 싣지
 * 않는다** — "이 `logId`가 바뀌었다"는 신호일 뿐이고, 신호를 받은 연결은 마지막으로 보낸
 * 커서 다음을 `store.readPage`로 다시 읽어 따라잡는다. 그래서 신호를 놓치거나 중복으로
 * 받아도 결과가 같다(멱등) — 유일하게 지켜야 하는 것은 "연결을 열기 **전에** 구독부터 걸어야
 * 그 사이에 도착한 append를 놓치지 않는다"는 순서 하나뿐이고, {@link handleSubscribe}가
 * 그 순서를 지킨다.
 *
 * 이 알림은 `store.ts` 상단 doc이 이미 못박은 단일 프로세스 전제에 **의존한다** — 알림이
 * 나는 자리가 이 프로세스의 `append` 호출(아래 {@link handleAppend})뿐이므로, 다른
 * 프로세스가 같은 DB 파일에 쓴 이벤트는 이 신호를 만들지 않는다. 워커를 늘리는 날 이
 * 알림은 폴링이나 외부 큐로 바뀌어야 한다(`store.ts` doc).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { ErrorCodes, errorResponse } from './errors.js'
import { parseAppendRequest } from './event.js'
import { serializePullResponse, type PullPage } from './pull.js'
import { verifyTransportRequest, type CursorStart, type RawRequest } from './request.js'
import { serializeAppendFrame, serializeHeartbeatFrame, serializeOpenFrame, serializeResetFrame } from './sse.js'
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
  /**
   * subscribe 연결 하나가 물고 늘어질 수 있는 미확인(un-drained) 바이트의 상한
   * (`§4.5` MUST NOT — 느린 구독자를 무한히 버퍼링하지 않는다). {@link DEFAULT_SUBSCRIBE_BACKLOG_LIMIT_BYTES}
   * doc 참조. 배포가 §8 미결 7(유량 제한 구체값)을 닫을 때 이 값으로 주입한다 — 부재면
   * 기본값을 쓴다.
   */
  readonly subscribeBacklogLimitBytes?: number
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
 * append 본문 게이트 → 스토어 → 응답 → subscribe 알림.
 *
 * `§2.2`: `store.append`의 `Promise`가 resolve된 시점이 내구화 완료 시점이다 — 그 뒤에만
 * `200`을 쓴다. reject되면(내구화를 보장할 수 없으면) `503 not_durable`이다. 스토어 예외의
 * `message`를 에러 봉투로 그대로 옮기지 않는다 (`store.ts` doc — `§1.5` L145-146 MUST NOT):
 * 여기서 쓰는 메시지는 항상 고정 문자열이다.
 *
 * `broker.notify`는 커밋이 끝난 **뒤**, 응답을 쓰기 **전**에 부른다 — 순서 자체는 관찰
 * 가능한 차이를 만들지 않지만(둘 다 커밋 완료 뒤다), 이 파일이 가진 "내구화가 스트림 발화의
 * 선행"이라는 계약을 코드 순서로도 드러낸다 (`§4.4` MUST, mori-nest #30 착수 시점 owner
 * 코멘트). 요청이 전부 `duplicate`여도(새로 쓴 것이 없어도) 부른다 — 구독자의 다음 읽기는
 * 어차피 자기 커서 뒤에서 새 행을 찾지 못할 뿐이라 비용은 빈 조회 하나뿐이고, 조건을 갈라
 * "새로 쓴 게 있을 때만"으로 좁히면 그 판정 자체가 또 하나의 버그 표면이 된다.
 */
async function handleAppend(
  store: EventStore,
  broker: LogBroker,
  logId: string,
  rawBody: string,
  res: ServerResponse,
): Promise<void> {
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

  broker.notify(logId)

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

/**
 * subscribe가 새 이벤트를 알아채는 방법. **데이터를 싣지 않는다** — "이 `logId`가 바뀌었다"는
 * 신호일 뿐이고, 신호를 받은 연결은 `store.readPage`로 직접 따라잡는다 (파일 상단 doc).
 * 그래서 신호를 놓치거나 중복으로 받아도(예: 같은 `logId`에 두 번 연달아 append) 결과가
 * 같다 — 구독자는 언제나 "마지막으로 보낸 커서 다음"을 다시 읽을 뿐이다.
 */
class LogBroker {
  readonly #subscribers = new Map<string, Set<() => void>>()

  /** `logId` 하나에 대한 알림을 구독한다. 반환값을 부르면 구독을 끊는다(멱등). */
  subscribe(logId: string, onAppend: () => void): () => void {
    let set = this.#subscribers.get(logId)
    if (set === undefined) {
      set = new Set()
      this.#subscribers.set(logId, set)
    }
    set.add(onAppend)
    let unsubscribed = false
    return () => {
      if (unsubscribed) {
        return
      }
      unsubscribed = true
      set.delete(onAppend)
      if (set.size === 0) {
        this.#subscribers.delete(logId)
      }
    }
  }

  /** `logId`에 새 이벤트가 커밋됐음을 그 로그의 구독자 전원에게 알린다. */
  notify(logId: string): void {
    const set = this.#subscribers.get(logId)
    if (set === undefined) {
      return
    }
    for (const onAppend of set) {
      onAppend()
    }
  }
}

type WakeReason = 'notified' | 'timeout'

/**
 * 알림 하나를 기다리거나, 주어진 시간이 지나면 `'timeout'`으로 깨어나는 대기자.
 * `subscribe` 연결의 메인 루프가 "새 이벤트 왔음"과 "유휴 하트비트 시각 됐음"을 같은
 * `await` 하나로 받기 위한 것이다.
 *
 * **놓친 `wake()`를 기억한다.** `#drain()`이 페이지를 읽고 쓰는 동안(= 아무도 `wait()`로
 * 듣고 있지 않을 때) `broker.notify()`가 오면, 대기자가 없다고 그 신호를 버리면 다음
 * `wait()`가 `HEARTBEAT_INTERVAL_MS`(최대 10초)를 꼬박 기다린 뒤에야 그 이벤트를 따라잡는다
 * — 이벤트가 사라지진 않지만(다음 `#drain()`이 커서 다음을 다시 읽으므로) 배달이 불필요하게
 * 늦어진다. `#signaled` 플래그가 그 창을 없앤다: 대기자가 없을 때 온 `wake()`는 플래그를
 * 세우고, 다음 `wait()`는 새로 기다리지 않고 그 자리에서 `'notified'`로 돌아온다.
 */
class Waker {
  #signaled = false
  #pending: Array<(reason: WakeReason) => void> = []

  wake(): void {
    if (this.#pending.length === 0) {
      this.#signaled = true
      return
    }
    const pending = this.#pending
    this.#pending = []
    for (const resolve of pending) {
      resolve('notified')
    }
  }

  wait(timeoutMs: number): Promise<WakeReason> {
    if (this.#signaled) {
      this.#signaled = false
      return Promise.resolve('notified')
    }
    return new Promise((resolve) => {
      const onWake = (reason: WakeReason): void => {
        clearTimeout(timer)
        resolve(reason)
      }
      const timer = setTimeout(() => {
        this.#pending = this.#pending.filter((entry) => entry !== onWake)
        resolve('timeout')
      }, timeoutMs)
      this.#pending.push(onWake)
    })
  }
}

/**
 * 한 번만 발화하는 신호. 연결 종료를 여러 곳(백프레셔로 `drain`을 기다리는 자리, 메인
 * 루프)에서 동시에 기다릴 수 있어야 해서 {@link Waker}와 분리한다 — `Waker.wake()`는 그
 * 순간의 대기자만 깨우고 지나가지만, 종료는 그 뒤로 몇 번을 물어도 항상 "이미 끝났다"여야
 * 한다.
 */
export class OnceSignal {
  #fired = false
  #waiters: Array<() => void> = []

  fire(): void {
    if (this.#fired) {
      return
    }
    this.#fired = true
    const waiters = this.#waiters
    this.#waiters = []
    for (const resolve of waiters) {
      resolve()
    }
  }

  wait(): Promise<void> {
    if (this.#fired) {
      return Promise.resolve()
    }
    return new Promise((resolve) => this.#waiters.push(resolve))
  }

  /**
   * 아직 `fire()`되지 않은 `wait()` 호출 수. 프로덕션 경로는 이 값을 보지 않는다 — 테스트가
   * mori-nest #37 발견 2(`wait()`를 호출마다 다시 부르면 `#waiters`가 연결 수명 동안 단조
   * 증가한다)의 수정 불변식("프라미스 하나를 만들어 재사용하면 `wait()`를 몇 번 다시
   * `.then()` 걸어도 `#waiters`가 늘지 않는다")을 직접 관찰하기 위해 존재한다.
   */
  get waiterCount(): number {
    return this.#waiters.length
  }
}

/**
 * subscribe 연결 하나가 물고 늘어질 수 있는 미확인(un-drained) 바이트의 기본 상한
 * (`§4.5` MUST NOT — 느린 구독자를 무한히 버퍼링하지 않는다).
 *
 * **`res.write()`가 `false`를 돌려준 뒤에만 이 값을 본다** (아래 {@link SubscribeConnection.writeFrame}).
 * `false`는 Node가 이미 연결의 `highWaterMark`(런타임이 정하고 보통 수십 KB)를 넘겼다고
 * 판단한 시점이므로, 정상적인 순간 버스트(클라이언트가 따라가고 있지만 이번 틱에 잠깐
 * 밀린 경우)를 여기서 자르지 않는다 — `false`를 받고도 `drain`을 기다리는 것이 정상적인
 * 흐름 제어다. 그 상태에서 **쌓인 양**(`res.writableLength`)이 이 한도를 넘을 때만 "무한
 * 버퍼링"으로 판정해 자른다.
 *
 * **이 상수가 실제로 연결 하나의 메모리 상한을 정하지는 않는다.** `#writeFrame`이
 * `false`를 받은 뒤 하는 일은 이 값과 비교하는 것뿐이고, 정작 바이트를 버퍼에 쌓아 두는
 * 것은 Node의 소켓 쓰기 큐이며 그 크기는 `highWaterMark`(런타임 기본값, 보통 수십 KB)로
 * 묶여 있다 — `res.write()`가 흐름 제어를 위해 그 이상을 받아 주지 않기 때문이다. 그래서
 * `res.writableLength`는 정상적인 흐름 제어 아래서는 `highWaterMark` + 프레임 하나 남짓을
 * 넘지 않고, **기본값(1MB)에서 이 한도가 실제로 발화하는 경우는 프레임 하나가 그 자체로
 * ~1MB에 육박할 때뿐이다.** 이 상수는 그런 비정상적으로 큰 단일 프레임에 대한 안전망이지,
 * "연결 하나가 물고 늘어질 수 있는 메모리"의 실제 상한이 아니다 — 그 실제 상한은
 * `highWaterMark`가 정한다.
 *
 * **`drain`을 영원히 못 받는 정지한(완전히 멈춘) 구독자는 이 상수로 잘리지 않는다.**
 * `res.writableLength`가 `highWaterMark` 근방에서 더 자라지 않으므로, 소켓·브로커 구독·
 * 읽기 루프를 계속 붙잡고 있어도 이 한도를 넘기지 못한다. 이것은 `§4.5` MUST NOT(느린
 * 구독자를 무한히 버퍼링하지 않는다) 위반은 **아니다** — 흐름 제어가 이미 버퍼 크기를
 * 유한하게 묶고 있고, "정지한 연결을 붙잡아 두는 시간"에 상한을 두는 것은 `§8` 미결 7
 * (유량 제한 구체값)의 몫으로 남는다. 배포가 그 미결을 닫을 때, 시간 기반 상한(예:
 * 하트비트 간격의 배수 동안 `drain`이 없으면 자른다)이 필요하면 그때 추가한다.
 *
 * 1MB는 `§8` 미결 7이 아직 열려 있는 상태에서 고른 구조적 안전망이다 — 위에서 설명한
 * 대로 일반적인 흐름 제어 경로에서는 사실상 발화하지 않고, 오직 단일 프레임 크기
 * 이상치를 잡는다. 배포별 튜닝값을 대신하지 않으며, 배포가 미결 7을 닫을 때
 * `TransportServerOptions.subscribeBacklogLimitBytes`로 주입해 바꾼다.
 */
const DEFAULT_SUBSCRIBE_BACKLOG_LIMIT_BYTES = 1_000_000

/**
 * `§4.3` L405 "heartbeat는 유휴 15초 이내마다 보낸다" (MUST). 정확히 15,000ms로 걸면
 * 이벤트 루프가 밀리는 순간(다른 연결의 큰 페이지를 직렬화하는 동안 등) 타이머가 살짝
 * 늦게 돌아 15초를 넘길 수 있고, 클라이언트는 "하트비트 연속 2회 누락"을 그만큼 더 빨리
 * 채운다. 15초보다 짧게 잡아 그 지연을 흡수한다.
 */
const HEARTBEAT_INTERVAL_MS = 10_000

/**
 * subscribe 연결 하나의 수명 — `open` → (`append`|`heartbeat`)* → (자연 종료 또는 `reset`).
 *
 * 이 클래스가 들고 있는 가변 상태(`#cursor`·`#openSent`·`#closed`)는 연결 하나에 묶인
 * 것이지 라우트 전체의 것이 아니므로 클래스로 캡슐화한다 — `handleAppend`·`handlePull`처럼
 * 함수 하나로 끝나지 않는 이유가 이 상태의 수명이 연결의 수명과 같기 때문이다.
 */
class SubscribeConnection {
  readonly #store: EventStore
  readonly #req: IncomingMessage
  readonly #res: ServerResponse
  readonly #backlogLimitBytes: number
  readonly #logId: string
  readonly #waker = new Waker()
  readonly #closeSignal = new OnceSignal()
  // `#closeSignal.wait()`를 딱 한 번만 불러 그 프라미스를 재사용한다. `#waitForDrainOrClose`는
  // 백프레셔가 날 때마다(오래 사는 연결에서는 여러 번) 불리는데, 매번 새로
  // `#closeSignal.wait()`를 불렀다면 `drain`으로 끝난 호출의 resolver가 `OnceSignal.#waiters`에
  // 그대로 남아 연결 수명 동안 단조 증가했다(mori-nest #37 발견 2) — `fire()`(연결 종료)만
  // 그 배열을 비우기 때문이다. 프라미스 하나에 `.then()`을 여러 번 거는 것은 새 waiter를
  // 만들지 않으므로, 이 필드를 공유하면 `#waiters`에는 연결당 항목이 정확히 하나만 쌓인다.
  readonly #closePromise: Promise<void> = this.#closeSignal.wait()
  readonly #unsubscribe: () => void
  readonly #onClose: () => void
  #closed = false
  #cursor: CursorStart
  #openSent = false

  constructor(
    store: EventStore,
    broker: LogBroker,
    logId: string,
    start: CursorStart,
    req: IncomingMessage,
    res: ServerResponse,
    backlogLimitBytes: number,
  ) {
    this.#store = store
    this.#req = req
    this.#res = res
    this.#backlogLimitBytes = backlogLimitBytes
    this.#logId = logId
    this.#cursor = start

    // 구독을 **연결 전에** 건다 (race 방지 — 클래스 doc 참조). 이 등록과 아래 `run()`의 첫
    // `store.readPage` 사이에 도착하는 append는 여기서 건 리스너가 깨우고, 그 뒤
    // `#drain()`이 `#cursor` 다음을 다시 읽어 따라잡는다.
    this.#unsubscribe = broker.subscribe(logId, () => this.#waker.wake())

    this.#onClose = () => {
      this.#closed = true
      this.#closeSignal.fire()
      this.#waker.wake()
    }
    req.once('close', this.#onClose)
    res.once('error', this.#onClose)
  }

  /** 연결의 전체 수명을 돈다. `req`/`res`가 끝나거나 한도를 넘겨 자를 때까지 반환하지 않는다. */
  async run(): Promise<void> {
    try {
      this.#res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      })

      if (!(await this.#drain())) {
        return
      }
      while (!this.#closed) {
        const reason = await this.#waker.wait(HEARTBEAT_INTERVAL_MS)
        if (this.#closed) {
          break
        }
        if (reason === 'timeout') {
          if (!(await this.#writeFrame(serializeHeartbeatFrame()))) {
            this.#endWithReset('subscriber is not draining fast enough')
            break
          }
          continue
        }
        if (!(await this.#drain())) {
          break
        }
      }
    } finally {
      // 브로커 구독 해제 + `req`/`res`에 건 리스너 제거. `once()`로 걸었으므로 그 이벤트가
      // 실제로 난 경우는 Node가 이미 알아서 지웠지만, **그 이벤트 없이** 이 메서드가 끝나는
      // 경로(정상 종료, `#endWithReset`으로 자른 경우)에는 리스너가 그대로 남는다 — 그 남는
      // 자리를 여기서 닫는다 (완료 조건 "타이머·리스너·스토어 구독이 전부 해제된다").
      this.#unsubscribe()
      this.#req.off('close', this.#onClose)
      this.#res.off('error', this.#onClose)
    }
  }

  /**
   * `#cursor` 이후를 `hasMore`가 꺼질 때까지 페이지 단위로 읽어 보낸다. 신호 하나로 여러
   * 페이지를 이어 읽는 것은, 한 번에 `store.readPage`의 기본 페이지 크기(500)보다 많이
   * 쌓였을 때도 신호 하나를 놓치지 않고 전부 보내기 위해서다 — 페이지를 다 비우기 전에는
   * 다음 `Waker.wait`로 넘어가지 않는다.
   *
   * @returns 연결을 계속 이어갈 수 있으면 `true`, 끊겼거나(클라이언트) 잘랐으면(`reset`)
   *   `false`.
   */
  async #drain(): Promise<boolean> {
    for (;;) {
      if (this.#closed) {
        return false
      }
      let page: PullPage
      try {
        page = await this.#store.readPage(this.#logId, this.#cursor)
      } catch {
        this.#endWithReset('subscribe could not read the log')
        return false
      }

      if (!this.#openSent) {
        this.#openSent = true
        if (!(await this.#writeFrame(serializeOpenFrame(page.from)))) {
          this.#endWithReset('subscriber is not draining fast enough')
          return false
        }
      }

      for (const event of page.events) {
        // `sse.ts`의 기존 함수로만 프레임을 만든다 — 손조립하지 않는다. 실패
        // (`payload_not_representable`·`cursor_not_representable`)는 `§4.5` L433이 요구하는
        // `reset` 경로로 그대로 넘긴다 (`sse.ts` 결정 1·2).
        const framed = serializeAppendFrame(event)
        if (!framed.ok) {
          this.#endWithReset(framed.reason)
          return false
        }
        if (!(await this.#writeFrame(framed.frame))) {
          this.#endWithReset('subscriber is not draining fast enough')
          return false
        }
        this.#cursor = { kind: 'after', cursor: event.cursor }
      }

      if (!page.hasMore) {
        return true
      }
    }
  }

  /**
   * 프레임 하나를 쓴다. `res.write()`가 흐름 제어를 신호하면(`false`) 곧장 자르지 않고
   * `drain`을 기다린다 — 진짜 "느린 구독자"인지는 그 상태에서 쌓인 양이
   * {@link DEFAULT_SUBSCRIBE_BACKLOG_LIMIT_BYTES} doc이 설명한 기준으로 갈린다.
   *
   * @returns 정상적으로 (흐름 제어를 거쳐서라도) 끝났으면 `true`, 연결이 끊겼거나 한도를
   *   넘겨 잘라야 하면 `false`.
   */
  async #writeFrame(text: string): Promise<boolean> {
    if (this.#closed) {
      return false
    }
    let flushed: boolean
    try {
      flushed = this.#res.write(text)
    } catch {
      this.#closed = true
      return false
    }
    if (flushed) {
      return true
    }
    if (this.#res.writableLength > this.#backlogLimitBytes) {
      return false
    }
    await this.#waitForDrainOrClose()
    return !this.#closed
  }

  #waitForDrainOrClose(): Promise<void> {
    if (this.#closed) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) {
          return
        }
        settled = true
        this.#res.off('drain', onDrain)
        resolve()
      }
      const onDrain = (): void => finish()
      this.#res.once('drain', onDrain)
      // `#closeSignal.wait()`를 다시 부르지 않는다 — 필드 초기화 때 만든 `#closePromise` 하나를
      // 재사용한다 (위 필드 doc 참조). `.then()`은 매번 새로 걸지만 이것이 `OnceSignal.#waiters`에
      // 항목을 추가하지는 않는다.
      this.#closePromise.then(finish)
    })
  }

  /**
   * `§4.5` L433(MUST) — 이어갈 수 없거나 느린 구독자를 잘라야 하면 `reset`을 보내고 닫는다.
   * `reason`은 `reset` 프레임의 사람이 읽는 설명일 뿐이다(`§4.5` L443 — 클라이언트의 대응은
   * 이유와 무관하게 하나다).
   *
   * `#closed`가 이미 참이면 아무것도 하지 않는다 — 클라이언트가 먼저 끊었으면(`onClose`가
   * 이미 이 값을 세웠으면) 상대가 없는 소켓에 쓰지 않는다.
   */
  #endWithReset(reason: string): void {
    if (this.#closed) {
      return
    }
    this.#closed = true
    try {
      this.#res.write(serializeResetFrame(reason))
    } catch {
      // 이미 끊긴 연결 — 쓸 상대가 없다.
    }
    this.#res.end()
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: TransportServerOptions,
  broker: LogBroker,
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
    await handleAppend(options.store, broker, result.request.logId, rawBody, res)
    return
  }

  if (result.request.route === 'pull') {
    await handlePull(options.store, result.request.logId, result.request.start, result.request.limit, res)
    return
  }

  const backlogLimitBytes = options.subscribeBacklogLimitBytes ?? DEFAULT_SUBSCRIBE_BACKLOG_LIMIT_BYTES
  const connection = new SubscribeConnection(
    options.store,
    broker,
    result.request.logId,
    result.request.start,
    req,
    res,
    backlogLimitBytes,
  )
  await connection.run()
}

/**
 * 전송 평면 HTTP 서버를 만든다. `listen`은 부르는 쪽이 한다 — 포트를 이 함수가 정하지 않는다.
 *
 * `LogBroker`는 서버 하나에 하나다 — 이 서버가 배선한 `store`(mori-nest #27이 못박은 단일
 * 프로세스 전제, 파일 상단 doc)에 대한 append 알림 전부가 이 한 인스턴스를 지난다.
 */
export function createTransportServer(options: TransportServerOptions): Server {
  const broker = new LogBroker()
  return createServer((req, res) => {
    handleRequest(req, res, options, broker).catch(() => {
      // `req`/`res` 스트림 자체의 오류(연결이 끊기는 등)만 여기 닿는다 — 게이트·스토어의
      // 실패는 `handleRequest` 안에서 이미 응답으로 끝난다. 이미 끊긴 연결에 다시 쓰지 않는다.
      if (!res.writableEnded) {
        writeJson(res, 500, errorResponse(ErrorCodes.internal, 'unexpected server error'))
      }
    })
  })
}
