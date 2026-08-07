/**
 * append·pull·subscribe 라우트 배선 + 최소 HTTP 서버 (`node:http`, 빌트인). 런타임 의존성
 * 0을 유지한다.
 *
 * `POST /v1/logs/{logId}/events`(`0002 §2`) · `GET /v1/logs/{logId}/events`(`§3`) ·
 * `GET /v1/logs/{logId}/subscribe`(`§4`) 셋을 배선한다. 잇는 순서는 `request.ts` doc이 이미
 * 그어 둔 경계 그대로다: append는 `verifyTransportRequest`(요청 게이트) → `readBody`(본문
 * 크기 게이트, `§1.3` L103 — `maxRequestBytes`를 스트리밍 중에 검사한다) →
 * `parseAppendRequest`(본문 게이트, 이벤트 하나당 `maxEventBytes`도 여기서 본다) →
 * `store.append` → 응답. pull은 `verifyTransportRequest` → `store.readPage` →
 * `serializePullResponse` → 응답. subscribe는 `verifyTransportRequest` → (연결을 열고)
 * `store.readPage`를 반복 호출하며 `sse.ts`로 프레임을 만들어 쓴다. 게이트 판정은 이
 * 파일에서 다시 구현하지 않고 기존 순수 함수를 그대로 부른다 — 커서 해석·정렬·`limit` 적용·
 * `hasMore`/`from` 판정은 전부 `store.readPage`가 이미 답한 `PullPage`를 그대로 옮길 뿐이다
 * (mori-nest #29·#30 착수 시점 owner 코멘트).
 *
 * **두 `413` 경로(본문 전체 `request_too_large`, 단일 이벤트 `event_too_large`) 어느 쪽도
 * `store.append`에 닿지 않는다** — 둘 다 그 앞에서 응답을 끝낸다. 그래서 두 경로는 아무것도
 * 기록하지 않는다: 리포 전체에 `console.*` 호출이 0건이고, 아래 진단 훅을 부르는 자리는
 * **다섯 자리**({@link TransportDiagnosticSite})뿐인데 두 `413`은 그 다섯 중 어디에도 닿지
 * 않는다 (둘 다 예외도, 고정 문자열로 덮는 결과 판정도 아니라 게이트의 정상 판정이다).
 *
 * ## 삼킨 예외의 진단 — 주입된 훅 하나로 통일한다 (mori-nest #38, #51)
 *
 * 세 라우트가 스토어 예외를 `catch`로 삼키고 고정 문자열만 내보내는 것은 `§1.5` L145-146
 * MUST NOT(예외 `message`를 봉투에 싣지 않는다)의 요구다 — **그 규율은 바뀌지 않는다.**
 * 문제는 삼킨 예외가 서버 쪽에도 남지 않아, 스토어가 깨졌을 때 운영자가 볼 수 있는 것이
 * 상태코드 하나뿐이었다는 것이다. 셋을 재고 (1)을 골랐다.
 *
 * - **(1) 호출자가 주입하는 훅 — 골랐다.** *닫는 것*: 삼킨 예외 전부가 배포가 정한 진단
 *   평면에 닿는다. 봉투는 그대로이므로 와이어 계약은 0건 바뀐다. *대가*: 아무것도 주입하지
 *   않은 배포에서는 여전히 아무 흔적도 남지 않는다(기본값이 no-op이다) — 진단을 켜는 것이
 *   배포의 명시적 행위가 된다. 라이브러리 표면이 필드 하나 늘고, 주입된 콜백이 던지는
 *   경우를 이 파일이 감당해야 한다(아래 {@link diagnosticSink}).
 * - **(2) `console.error` 직접 호출 — 버렸다.** *닫는 것*: 가장 짧고 아무 주입 없이도 흔적이
 *   남는다. *대가*: 라이브러리가 배포의 로그 평면을 대신 정한다. `createTransportServer`는
 *   라이브러리 표면이고 이 파일은 이미 「배포가 정하는 것」(`now`·`subscribeBacklogLimitBytes`·
 *   `maxEventBytes`)을 전부 주입으로 받는 관례 위에 서 있다 — stderr 점유는 그 축을 깨고,
 *   테스트마다 그것을 억제해야 하며, 구조화 로그를 쓰는 배포는 이 출력을 다시 파싱해야 한다.
 * - **(3) 아무것도 하지 않고 근거만 남긴다 — 버렸다.** *닫는 것*: 표면이 0으로 유지된다.
 *   *대가*: 운영 진단이 계속 없다. 이 이슈가 열린 이유 자체가 그 상태이므로 근거를 적는
 *   것으로 닫히지 않는다.
 *
 * 훅은 **런타임 의존성을 늘리지 않는다** — 로거 라이브러리를 붙이는 대신 출력 매체를 정하지
 * 않고 배포에 넘기는 것이 (1)의 요점이다 (`package.json`의 `dependencies`는 여전히 없다).
 *
 * **이것은 리포 전역 관례다 — 축은 `catch`가 아니라 「고정 문자열로 덮는 자리」다 (#51).**
 * `catch`로 예외를 삼키는 자리 넷(`append.store`·`pull.store`·`subscribe.store`·`request`)이
 * 지금까지 이 훅을 타는 전부였던 것은 **우연히 그 넷이 전부 `catch`였기 때문**이지, 훅을
 * 부르는 조건이 `catch` 자체이기 때문이 아니다. `pull.serialize`(아래 {@link handlePull})가
 * 그 우연을 깬다 — `serializePullResponse`가 실패를 돌려주는 것은 `catch`가 아니라 **결과
 * 타입 판정**이지만, 서버가 그 결함을 고정 문자열 `500`으로 덮고 운영자에게 아무 흔적도
 * 남기지 않는다는 점은 스토어 예외와 같다. 그래서 새 라우트·새 실패 경로가 생겼을 때 훅을
 * 태울지 판단하는 기준은 *"이 자리가 `catch`인가"*가 아니라 *"이 자리가 결함을 고정
 * 문자열로 덮어 클라이언트에게도 운영자에게도 원래 정보를 남기지 않는가"*다. 그런 자리를
 * 새로 만들면 {@link TransportDiagnosticSite}에 이름을 하나 더하고 그 자리에서 `emit`을
 * 부른다. 훅을 부르지 **않는** 자리는 두 종류뿐이고 둘 다 「진단할 사건」이 아니어서다 —
 * (a) 클라이언트 입력을 판정하는 파서의 `catch` (`body.ts`·`event.ts`·`token.ts`: 예외가 곧
 * "이 입력은 유효하지 않다"라는 답이고, 정상 운영에서 늘 난다), (b) 이미 끊긴 소켓에 쓰다
 * 나는 `catch` (`SubscribeConnection.#writeFrame`·`#endWithReset`: 연결 종료는 결함이 아니라
 * 수명의 끝이다) — 이 둘은 새 축에서도 여전히 제외다: (a)는 애초에 「결함」이 아니라 입력
 * 판정의 정상 결과이고, (b)는 고정 문자열로 **덮는** 것이 아니라 이미 끊긴 대상에 쓰기를
 * 포기하는 것이다.
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
import { MIN_MAX_EVENT_BYTES, parseAppendRequest } from './event.js'
import { serializePullResponse, type PullPage } from './pull.js'
import { verifyTransportRequest, type CursorStart, type RawRequest } from './request.js'
import { serializeAppendFrame, serializeHeartbeatFrame, serializeOpenFrame, serializeResetFrame } from './sse.js'
import type { VerificationKeySet, VerifiedWorkspaceToken } from './token.js'
import { EventStoreError, eventProvenanceOf, type EventStore } from './store.js'

/**
 * 결함을 고정 문자열로 덮는 자리의 이름 (파일 상단 doc의 「리포 전역 관례」 — 축은 `catch`가
 * 아니다). 값 하나가 코드 한 자리에 1:1로 대응한다 — 운영자가 이 값만 보고 어느 라우트의 어느
 * 호출이 깨졌는지 알 수 있어야 하므로, 라우트만도 호출만도 아닌 `<라우트>.<호출>` 꼴로 적는다
 * (`append.`로 prefix 매칭하면 그 라우트만 걸린다).
 *
 * 여기 없는 자리는 훅을 부르지 않는다 — 무엇이 빠져 있고 왜인지는 파일 상단 doc의
 * 「리포 전역 관례」 문단이 적는다.
 */
export type TransportDiagnosticSite =
  /** {@link handleAppend}의 `store.append`가 던졌다 → `503 not_durable` (또는 `missing_provenance`면 `500 internal`) */
  | 'append.store'
  /** {@link handlePull}의 `store.readPage`가 던졌다 → `500 internal` */
  | 'pull.store'
  /**
   * {@link handlePull}의 `serializePullResponse`가 `{ok:false}`를 돌려줬다 → `500 internal`.
   * 다른 넷과 달리 **예외가 아니다** — 던지는 자리가 없고, `store.readPage`가 정상적으로
   * resolve한 `PullPage`를 `serializePullResponse`가 결과 타입으로 거부한 것이다(`pull.ts`
   * 결정 1·3, 저장소 쪽 결함). `TransportDiagnostic.error`가 이 자리에서 무엇을 싣는지는
   * 그 필드 doc을 본다.
   */
  | 'pull.serialize'
  /** `SubscribeConnection.#drain`의 `store.readPage`가 던졌다 → `reset` 프레임 */
  | 'subscribe.store'
  /** 라우트 핸들러 **밖**에서 예외가 올라왔다 (`req`/`res` 스트림 오류 등) → `500 internal` */
  | 'request'

/**
 * 진단 훅이 받는 사건 하나. **와이어에 나가는 값이 아니다** — 이 타입의 어떤 필드도 응답
 * 본문이나 `reset` 프레임에 실리지 않는다 (`§1.5` L145-146 MUST NOT). 반대 방향으로 읽으면:
 * 훅이 받는 것이 원문 그대로인 것은, 이 값이 배포의 진단 평면으로만 가고 클라이언트로 가지
 * 않기 때문이다.
 */
export type TransportDiagnostic = {
  /** 결함을 고정 문자열로 덮은 자리. */
  readonly site: TransportDiagnosticSite
  /**
   * 대상 로그. 게이트를 통과한 값이므로 `§1.1` 정규식을 만족한다 — payload도 토큰도 아니다.
   * `'request'`처럼 게이트 판정 전이라 알 수 없는 자리에서는 부재다.
   */
  readonly logId?: string
  /**
   * 덮인 결함의 원문. 넷(`append.store`·`pull.store`·`subscribe.store`·`request`)은 **삼킨
   * 예외 그대로**다 — `Error`라는 보장은 없다(던지는 쪽이 무엇이든 던질 수 있다). 이 넷의
   * 의미는 `pull.serialize`가 생긴 뒤에도 바뀌지 않는다.
   *
   * `pull.serialize`는 예외가 없으므로 다르다 — `serializePullResponse`가 돌려준
   * `PullResponseFailure` 값(`pull.ts`) 그대로를 싣는다. 타입을 좁히지 않고 기존
   * `unknown`을 그대로 쓴 것은, 이 필드가 이미 "무엇이든 올 수 있다"는 계약이라 예외가 아닌
   * 값을 받는 것도 그 계약 안이고, 다섯 자리를 매번 구분해 읽어야 하는 판별 유니온을 여기
   * 새로 만들 근거가 없기 때문이다 — 어느 자리든 운영자는 `site`로 먼저 갈래를 타고 그 다음
   * `error`를 그 자리에 맞게 해석한다.
   */
  readonly error: unknown
}

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
  /**
   * append 단일 이벤트(원소 원문 구간 전체)의 바이트 상한 (`§1.3` L103 MUST —
   * `maxEventBytes ≥ 1 MiB`). {@link createTransportServer}가 이 하한을 만족하지 않으면
   * 서버를 만들지 않고 던진다. 부재면 계약 하한(`MIN_MAX_EVENT_BYTES`, 1 MiB)을 쓴다 —
   * 배포용 값은 §8 미결 8이 아직 열려 있어 이 코드가 고르지 않는다.
   */
  readonly maxEventBytes?: number
  /**
   * append 요청 본문 전체의 바이트 상한 (`§1.3` L103 MUST — `maxRequestBytes ≥ maxEventBytes`).
   * `readBody`가 스트리밍 중에 누적 바이트를 세다가 이 값을 넘는 순간 더 읽지 않고 끊는다 —
   * `Content-Length`가 없거나(chunked) 거짓이어도 이 검사는 항상 돈다. 부재면
   * `maxEventBytes`와 같은 값을 쓴다(둘 다 배포가 아직 정하지 않은 값이므로 계약 하한
   * 하나를 공유한다 — 서로 다른 임의값을 지어내지 않는다).
   */
  readonly maxRequestBytes?: number
  /**
   * 삼킨 예외 하나를 배포의 진단 평면으로 넘기는 훅 (파일 상단 doc의 「삼킨 예외의 진단」).
   * 부재면 no-op이다 — **부재가 곧 지금까지의 동작**이고, 주입해도 응답·프레임 봉투는 한
   * 글자도 바뀌지 않는다.
   *
   * 이 훅은 **응답을 쓰기 전에, 동기로** 불린다. 그래서 두 가지를 지켜야 한다: (a) 오래 붙잡지
   * 말 것 — 여기서 블로킹하면 그만큼 응답이 늦는다. (b) 던져도 된다 — 이 파일이 그 예외를
   * 받아 삼키고 응답 경로를 그대로 이어간다 ({@link diagnosticSink}). 진단 실패가 요청 실패로
   * 번지지 않는다.
   *
   * **진단 평면을 민감한 곳으로 다뤄라.** `§1.5` MUST NOT이 막는 것은 예외 원문이 **와이어에**
   * 실리는 것이고, 이 훅은 그 반대편이다 — 훅이 받는 `error`는 이 파일이 편집하지 않은 원문
   * 그대로이므로, 스토어 아래 계층(`node:sqlite` 등)이 던진 예외라면 그 `message`에 SQL 조각이나
   * payload 바이트가 섞여 있을 수 있다. 그것을 **다시 클라이언트로 돌려보내는 배포는 이 조항을
   * 우회하는 것이다**: 훅에 넣는 출력은 운영자만 보는 평면으로 보내고, 응답으로 되돌리지 않는다.
   */
  readonly onDiagnostic?: (diagnostic: TransportDiagnostic) => void
}

/** 삼킨 예외 하나를 진단 훅으로 넘긴다. 주입이 없으면 아무것도 하지 않는다. */
type DiagnosticSink = (diagnostic: TransportDiagnostic) => void

/**
 * 주입된 훅을 {@link DiagnosticSink}로 감싼다. 감싸는 이유는 하나뿐이다: **훅이 던져도 요청
 * 경로가 그것 때문에 무너지지 않아야 한다.** 훅은 배포가 준 코드이고 이 파일이 그 동작을
 * 보장할 수 없는데, 훅의 예외가 그대로 올라가면 `503`으로 끝났어야 할 요청이 `500`이 되거나
 * (`handleRequest`를 감싼 자리가 받는다) subscribe 연결이 `reset` 없이 끊긴다 — 진단을 켰다는
 * 이유로 관찰 가능한 동작이 바뀌는 셈이라, 봉투 불변("주입해도 봉투는 바뀌지 않는다")을 깬다.
 *
 * 훅의 예외를 다시 훅으로 보고하지 않는다 — 그 훅이 또 던지면 끝나지 않는다. 진단 평면 자신의
 * 고장을 이 파일이 보고할 자리는 없다(그것을 보고할 곳이 바로 고장난 그 평면이다).
 */
function diagnosticSink(hook: ((diagnostic: TransportDiagnostic) => void) | undefined): DiagnosticSink {
  if (hook === undefined) {
    return () => {
      // no-op — 주입하지 않은 배포의 동작은 이 이슈 이전과 같다.
    }
  }
  return (diagnostic) => {
    try {
      hook(diagnostic)
    } catch {
      // 진단 실패가 요청 실패로 번지지 않는다 (위 doc).
    }
  }
}

function toRawRequest(req: IncomingMessage): RawRequest {
  return {
    method: req.method ?? '',
    url: req.url ?? '',
    headers: req.headers,
  }
}

type ReadBodyResult = { readonly ok: true; readonly body: string } | { readonly ok: false }

/**
 * 본문을 읽는다. `maxRequestBytes`를 넘으면 남은 본문을 마저 읽지 않고 `{ ok: false }`로
 * 끝낸다 (`§1.3` L103 MUST — 다 모은 뒤 길이를 재면 메모리를 못 막는다).
 *
 * `Content-Length` 헤더가 있고 그 값만으로 이미 초과가 확정되면 청크를 하나도 읽지 않고
 * 곧장 끝낸다 — 이건 최적화다. **진짜 판정은 그 아래 누적 카운터다**: 헤더가 없거나
 * (chunked) 거짓이어도 똑같이 걸린다.
 */
function readBody(req: IncomingMessage, maxRequestBytes: number): Promise<ReadBodyResult> {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength > maxRequestBytes) {
      resolve({ ok: false })
      return
    }

    const chunks: Buffer[] = []
    let total = 0
    let settled = false

    const cleanup = (): void => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
    }

    const onData = (chunk: Buffer): void => {
      if (settled) {
        return
      }
      total += chunk.length
      if (total > maxRequestBytes) {
        settled = true
        // 더 받지 않는다 — 이후 청크를 배열에 쌓지 않는 것뿐 아니라 스트림 자체를 멈춘다.
        req.pause()
        cleanup()
        resolve({ ok: false })
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve({ ok: true, body: Buffer.concat(chunks).toString('utf8') })
    }
    const onError = (error: Error): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(error)
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
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
 *
 * `§1.6`: 이 핸들러가 **검증된 토큰**을 받는 것은 출처 값을 기록 층까지 내리기 위해서다. 값을
 * 만드는 것은 `eventProvenanceOf` 하나이고 이 파일은 그 결과를 `store.append`에 넘길 뿐이다 —
 * 요청 본문·헤더·쿼리에서 출처를 읽지 않는다 (MUST NOT). **와이어 계약은 이 변경으로 늘지
 * 않는다**: 응답 본문은 여전히 `{accepted, duplicate}` 그대로이고 출처는 실리지 않는다.
 */
async function handleAppend(
  store: EventStore,
  broker: LogBroker,
  logId: string,
  token: VerifiedWorkspaceToken,
  rawBody: string,
  maxEventBytes: number,
  emit: DiagnosticSink,
  res: ServerResponse,
): Promise<void> {
  const parsed = parseAppendRequest(rawBody, { maxEventBytes })
  if (!parsed.ok) {
    writeJson(res, parsed.status, parsed.error)
    return
  }

  let result
  try {
    // `§1.6`: 출처 값의 유일한 출처는 이 요청이 통과한 토큰의 클레임이다 (MUST). 꺼내는 자리는
    // `eventProvenanceOf` 하나이고, `parsed`(요청 본문)에서 오는 값은 `events`뿐이다 — 본문·
    // 헤더·쿼리에서 출처를 읽는 코드가 이 파일에 없다 (MUST NOT).
    result = await store.append(logId, parsed.events, eventProvenanceOf(token))
  } catch (error) {
    // 삼키기 **전에** 진단으로 넘긴다 (파일 상단 doc). 아래 두 응답 어느 쪽으로 갈라지든 이
    // 훅은 이미 예외 원문을 받았다 — 갈림길 바깥에 두는 것이 "하나만 남는 자리가 없다"의 형태다.
    emit({ site: 'append.store', logId, error })
    // 출처를 얻지 못한 상태는 내구성 문제가 아니라 서버 자신의 결함이다 — `§1.6`이 그 경우를
    // `503`이 아니라 `500 internal`로 못 박았다 (MUST). 스토어의 다른 실패는 종전대로 `503`이다.
    if (error instanceof EventStoreError && error.reason === 'missing_provenance') {
      writeJson(res, 500, errorResponse(ErrorCodes.internal, 'append could not derive its provenance'))
      return
    }
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
 *
 * `serializePullResponse`의 실패도 `store.readPage`의 예외와 같은 자격으로 진단 훅을 탄다
 * (mori-nest #51, 파일 상단 doc의 「리포 전역 관례」) — `catch`가 아니라 `{ok:false}` 결과
 * 판정이지만, 응답이 고정 문자열 `500`으로 결함을 덮고 운영자에게도 아무 흔적이 남지 않는
 * 것은 같다. `emit`을 부르는 위치는 이 실패를 판정한 직후, 응답을 쓰기 **전**이다 —
 * `store.readPage`가 던진 경우와 같은 자리(갈림길 안이 아니라 판정 바로 뒤)에 두어 두 실패
 * 원인이 같은 규칙으로 보고된다.
 */
async function handlePull(
  store: EventStore,
  logId: string,
  start: CursorStart,
  limit: number | undefined,
  emit: DiagnosticSink,
  res: ServerResponse,
): Promise<void> {
  let page
  try {
    page = await store.readPage(logId, start, limit)
  } catch (error) {
    emit({ site: 'pull.store', logId, error })
    writeJson(res, 500, errorResponse(ErrorCodes.internal, 'pull page could not be read'))
    return
  }

  const serialized = serializePullResponse(page)
  if (!serialized.ok) {
    emit({ site: 'pull.serialize', logId, error: serialized.reason })
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
   * `OnceSignal` 자신의 계약(`fire()`가 대기자를 전부 비우고, 그 뒤 `wait()`는 다시 쌓이지
   * 않는다)을 직접 관찰하기 위해 존재한다.
   *
   * **`SubscribeConnection`의 백프레셔 대기자 누적을 관측하는 용도로는 쓰지 않는다** —
   * 예전에 그런 용도로 쓰였으나(`mori-nest #37` 최초 시도), 문제였던 누적은 `OnceSignal`이
   * 아니라 재사용된 프라미스에 반복해서 건 `.then()`이 엔진 내부에 쌓는 reaction 목록에서
   * 일어났고 이 값은 그것을 보지 못한다(PR #41 owner 반송 코멘트). 그 자리의 수정은
   * `SubscribeConnection.#drainWaiter` 필드 doc을 본다.
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
  readonly #emit: DiagnosticSink
  readonly #logId: string
  readonly #waker = new Waker()
  readonly #closeSignal = new OnceSignal()
  readonly #unsubscribe: () => void
  readonly #onClose: () => void
  #closed = false
  #cursor: CursorStart
  #openSent = false
  /**
   * `#waitForDrainOrClose`가 현재 기다리고 있는 finisher(최대 하나). `mori-nest #37` PR #41
   * 반송 코멘트가 지적한 문제: `#closeSignal.wait()`가 돌려준 프라미스를 재사용해도(필드로
   * 캐싱해도) 백프레셔가 날 때마다 그 프라미스에 `.then()`을 다시 걸면, `OnceSignal.#waiters`는
   * 늘지 않지만(재사용된 프라미스라서) **ECMAScript 엔진이 그 pending 프라미스에 붙이는
   * `PromiseReaction` 목록(`[[PromiseFulfillReactions]]`)은 `.then()` 호출 수만큼 그대로
   * 쌓인다** — settle(= `fire()` = 연결 종료) 전까지 비워지지 않는다. `OnceSignal.waiterCount`는
   * `OnceSignal` 자신의 배열만 보므로 이 누적을 관측하지 못한다: 누적이 사라진 게 아니라
   * 관측 가능한 자리에서 관측 불가능한 자리(엔진 내부 reaction 목록)로 옮겨갔을 뿐이었다.
   *
   * 진짜 고침: `.then()` 자체를 백프레셔 이벤트마다 걸지 않는다. `#closeSignal.wait()`에
   * `.then()`을 이 클래스 생성자에서 **딱 한 번**만 걸어(아래 참조), 연결이 닫히면 그 순간
   * `#drainWaiter`에 등록된 것이 있으면 그것 하나만 불러 깨운다. `#waitForDrainOrClose`는
   * `.then()`을 걸지 않고 이 필드에 자기 finisher를 등록했다가 `drain`이나 종료로 끝나면
   * 스스로 `null`로 되돌린다.
   *
   * **왜 배열이 아니라 스칼라로 충분한가**: `#drainWaiter`를 채우는 유일한 자리는
   * `#waitForDrainOrClose`이고, 그 유일한 호출자는 `#writeFrame`이며, `#writeFrame`은
   * `run()`의 메인 루프 한 곳에서만 매번 `await`되어 불린다(`#drain()` 안의 프레임 쓰기,
   * 하트비트 쓰기 전부 같은 순차 흐름). 즉 이 연결에서 `#waitForDrainOrClose`가 동시에
   * 두 번 진행 중일 수 없다 — 새 호출이 시작되는 시점엔 이전 finisher가 이미 `finish()`로
   * 스스로를 `null`로 정리한 뒤다. 따라서 연결 수명 동안 `#closeSignal.wait()`의 프라미스에
   * 걸리는 `.then()` reaction은 **생성자의 한 번**이 전부이고, 백프레셔 횟수와 무관하게
   * 상수(1)로 고정된다. (이 전제가 깨질 수 있다고 판단되면 스칼라를 `Set`으로 바꾸되, 그때는
   * 등록·해제가 짝을 이루는지가 새 검증 대상이다.)
   */
  #drainWaiter: (() => void) | null = null

  constructor(
    store: EventStore,
    broker: LogBroker,
    logId: string,
    start: CursorStart,
    req: IncomingMessage,
    res: ServerResponse,
    backlogLimitBytes: number,
    emit: DiagnosticSink,
  ) {
    this.#store = store
    this.#req = req
    this.#res = res
    this.#backlogLimitBytes = backlogLimitBytes
    this.#emit = emit
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

    // `#closeSignal.wait()`에 `.then()`을 여기, 생성자에서 **한 번만** 건다 — `#drainWaiter`
    // 필드 doc 참조. 연결이 닫히면 그 순간 등록돼 있는 finisher 하나(없으면 아무 일도 안 함)를
    // 불러 깨우고 비운다. `#waitForDrainOrClose`는 이 프라미스에 다시 `.then()`을 걸지 않는다.
    this.#closeSignal.wait().then(() => {
      const waiter = this.#drainWaiter
      this.#drainWaiter = null
      waiter?.()
    })
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
      } catch (error) {
        // `reset`의 `reason`은 종전대로 고정 문자열이다 (`§4.5` L443 — 클라이언트의 대응은
        // 이유와 무관하게 하나다). 예외 원문이 가는 곳은 진단 훅뿐이다.
        this.#emit({ site: 'subscribe.store', logId: this.#logId, error })
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
        // 자신이 여전히 현재 등록된 finisher일 때만 비운다 — 이론상으로만 유효한 방어다
        // (`#drainWaiter` doc의 상호배제 전제대로면 다른 finisher가 그 사이 등록될 수 없다).
        if (this.#drainWaiter === finish) {
          this.#drainWaiter = null
        }
        resolve()
      }
      const onDrain = (): void => finish()
      this.#res.once('drain', onDrain)
      // `#closeSignal.wait()`에 `.then()`을 걸지 않는다 — 생성자에서 건 단 하나의 `.then()`이
      // 종료 시 이 필드를 봐 준다 (`#drainWaiter` 필드 doc 참조). 여기서는 등록만 한다.
      this.#drainWaiter = finish
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
  maxEventBytes: number,
  maxRequestBytes: number,
  emit: DiagnosticSink,
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
    const body = await readBody(req, maxRequestBytes)
    if (!body.ok) {
      writeJson(res, 413, errorResponse(ErrorCodes.request_too_large, 'request body exceeds the maximum allowed size', {
        maxRequestBytes,
      }))
      // 본문을 끝까지 읽지 않았으므로 소켓에는 아직 이 연결의 나머지 본문 바이트가 남아
      // 있을 수 있다 — keep-alive로 재사용하면 다음 요청 파서가 그 잔여 바이트를 다음
      // 요청의 시작으로 오인한다. 응답을 다 쓴 뒤 연결을 끊어 그 자리를 없앤다.
      res.on('finish', () => req.destroy())
      return
    }
    // `§1.6`: 검증된 토큰이 그대로 라우트 핸들러까지 내려간다. 이 인자가 «검증 결과가 기록
    // 층까지 닿지 않은 구현»(§1.6이 지목한 실패 형태)을 닫는 자리다.
    await handleAppend(
      options.store,
      broker,
      result.request.logId,
      result.request.token,
      body.body,
      maxEventBytes,
      emit,
      res,
    )
    return
  }

  if (result.request.route === 'pull') {
    await handlePull(options.store, result.request.logId, result.request.start, result.request.limit, emit, res)
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
    emit,
  )
  await connection.run()
}

/**
 * 전송 평면 HTTP 서버를 만든다. `listen`은 부르는 쪽이 한다 — 포트를 이 함수가 정하지 않는다.
 *
 * `LogBroker`는 서버 하나에 하나다 — 이 서버가 배선한 `store`(mori-nest #27이 못박은 단일
 * 프로세스 전제, 파일 상단 doc)에 대한 append 알림 전부가 이 한 인스턴스를 지난다.
 *
 * `maxEventBytes`·`maxRequestBytes`는 여기서 한 번만 검증하고(요청마다 다시 재지 않는다)
 * `handleRequest`에 그대로 흘려보낸다 — `§1.3` L103-104의 MUST(`maxEventBytes ≥ 1 MiB`,
 * `maxRequestBytes ≥ maxEventBytes`)를 어기는 설정으로는 서버 자체를 만들지 않는다.
 * 값을 결정하는 것은 이 코드가 아니라 배포다(§8 미결 8) — 부재 시 기본값은 계약 하한
 * 하나(`MIN_MAX_EVENT_BYTES`, 1 MiB)를 두 옵션이 공유한다.
 */
export function createTransportServer(options: TransportServerOptions): Server {
  const maxEventBytes = options.maxEventBytes ?? MIN_MAX_EVENT_BYTES
  const maxRequestBytes = options.maxRequestBytes ?? MIN_MAX_EVENT_BYTES
  if (maxEventBytes < MIN_MAX_EVENT_BYTES) {
    throw new Error(
      `maxEventBytes must be >= ${String(MIN_MAX_EVENT_BYTES)} bytes (1 MiB, 0002 §1.3 MUST); got ${String(maxEventBytes)}`,
    )
  }
  if (maxRequestBytes < maxEventBytes) {
    throw new Error(
      `maxRequestBytes must be >= maxEventBytes (0002 §1.3 MUST); got maxRequestBytes=${String(maxRequestBytes)}, maxEventBytes=${String(maxEventBytes)}`,
    )
  }

  const broker = new LogBroker()
  const emit = diagnosticSink(options.onDiagnostic)
  return createServer((req, res) => {
    handleRequest(req, res, options, broker, maxEventBytes, maxRequestBytes, emit).catch((error: unknown) => {
      // `req`/`res` 스트림 자체의 오류(연결이 끊기는 등)만 여기 닿는다 — 게이트·스토어의
      // 실패는 `handleRequest` 안에서 이미 응답으로 끝난다. 이미 끊긴 연결에 다시 쓰지 않는다.
      //
      // 이 자리도 예외를 삼키므로 같은 규율을 탄다 (파일 상단 doc). `logId`를 싣지 않는 것은
      // 게이트 판정 결과가 여기까지 내려오지 않아서다 — 예외가 게이트 **전에** 났을 수도 있다.
      // 응답을 쓸 수 있는지와 무관하게 부른다: 응답이 이미 끝난 뒤라 아무 상태코드도 못 남기는
      // 경우가 오히려 흔적이 가장 필요한 경우다.
      emit({ site: 'request', error })
      if (!res.writableEnded) {
        writeJson(res, 500, errorResponse(ErrorCodes.internal, 'unexpected server error'))
      }
    })
  })
}
