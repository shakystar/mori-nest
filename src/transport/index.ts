/**
 * 전송 평면 엔트리 — 이 평면이 밖으로 내보내는 것 전부와, 이 평면의 설정 스키마.
 *
 * ## 왜 엔트리인가
 *
 * 경계는 **배포 단위**에 그어져 있고, 코드에서 그것을 표현하는 최소 단위가 엔트리
 * 모듈이다 (mori-nest #68 사람 결정 ① 정정 · #71). *"전송 평면은 서명하지 못한다"*는
 * 성질을 만드는 것은 코드 배치가 아니다 — Ed25519의 서명과 검증은 `node:crypto`라는
 * **같은 빌트인**에 있고, 디렉터리를 어떻게 갈라도 `import { sign } from "node:crypto"`를
 * 막지 못한다. 그 성질을 만드는 것은 **키 배포**다: 이 평면에 오는 것은 공개키뿐이고
 * (`0003 §3.3` MUST), private key를 받은 적이 없으므로 서명할 대상이 없다.
 *
 * 그래서 이 파일이 지는 책임은 하나다 — **private key가 들어올 자리를 만들지 않는 것.**
 * 아래 {@link parseTransportConfig}가 이 평면의 설정 스키마 전부이고, 거기에 private key
 * 필드는 없으며, 정의되지 않은 최상위 필드는 조용히 무시되지 않고 거부된다. private key가
 * 나타나는 설정 스키마는 리포 전체에서 `src/control/index.ts` 하나다.
 *
 * ## 한 앱 두 포트로도, 두 앱으로도
 *
 * 이 모듈은 **프로세스를 모른다** — env를 읽지 않고, `listen`하지 않고, 전역 상태를
 * 만들지 않는다. 설정은 호출자가 `unknown`으로 넘기고 여기서 파싱될 뿐이다. 그래서
 * 전송과 제어를 한 프로세스가 두 포트로 띄우든(양쪽 엔트리를 import하는 부트스트랩
 * 하나) 두 프로세스로 가르든(각자 자기 엔트리만 import), **이 모듈의 코드는 0줄
 * 바뀐다.** 달라지는 것은 호출자뿐이고, 호출자(프로세스 부트스트랩)는 배포가 정할 때
 * 별도 조각으로 온다.
 *
 * ## 무엇이 이 평면이고 무엇이 아닌가
 *
 * 게이트(`token.js`·`request.js`·`event.js`)·직렬화(`sse.js`·`pull.js`)·저장소
 * (`store.js`)·서버(`server.js`)가 여기다 — 전부 전송 계약(`0002`)과 그 게이트
 * (`0003 §3.2`·`§3.3`)를 구현한다. 어느 평면에도 속하지 않는 것(에러 봉투·`code`
 * 상수·최상위 필드 검증·`405` 판정)은 `src/index.ts`에 남아 있고 양쪽이 import한다.
 */

import { KeyObject } from 'node:crypto'

import { createVerificationKeySet, type VerificationKeySet } from './token.js'

export {
  parseAppendRequest,
  type AppendEvent,
  type AppendRequestErrorStatus,
  type AppendRequestResult,
} from './event.js'
export {
  createVerificationKeySet,
  verifyWorkspaceToken,
  checkLogScope,
  type VerificationKeySet,
  type WorkspaceTokenClaims,
  type VerifiedWorkspaceToken,
  type TokenVerificationResult,
  type ScopeCheckResult,
} from './token.js'
export {
  verifyTransportRequest,
  type RawRequest,
  type CursorStart,
  type TransportRoute,
  type TransportRequest,
  type TransportErrorStatus,
  type TransportRequestResult,
} from './request.js'
export {
  serializeOpenFrame,
  serializeAppendFrame,
  serializeHeartbeatFrame,
  serializeResetFrame,
  type OpenFrom,
  type AppendFrameEvent,
  type AppendFrameFailure,
  type AppendFrameResult,
} from './sse.js'
export {
  serializePullResponse,
  type PullEvent,
  type PullPage,
  type PullResponseFailure,
  type PullResponseResult,
} from './pull.js'
export {
  openEventStore,
  eventProvenanceOf,
  EventStoreError,
  DEFAULT_PAGE_LIMIT,
  type AppendResult,
  type EventProvenance,
  type EventStore,
  type EventStoreFailure,
  type StoredEventRef,
} from './store.js'
export {
  createTransportServer,
  type TransportDiagnostic,
  type TransportDiagnosticSite,
  type TransportServerOptions,
} from './server.js'

/** 이 평면의 설정 스키마가 정의한 최상위 필드 **전부**. 여기에 private key 자리는 없다. */
const TRANSPORT_CONFIG_FIELDS = ['verificationKeys'] as const

/**
 * 파싱을 통과한 전송 평면 설정.
 *
 * `verificationKeys`는 배열이 아니라 이미 **집합**이다 — 파싱 경계에서
 * {@link createVerificationKeySet}까지 끝내므로, 이 타입을 손에 쥔 코드가 다시 검사할
 * 것이 없다. 집합은 생성 시점 스냅샷이고 항목 단위 추가·삭제 API가 없다 (`0003 §3.3`
 * MUST — 회전은 집합 전체 교체다).
 */
export type TransportConfig = {
  readonly verificationKeys: VerificationKeySet
}

/**
 * 설정 파싱 결과. 실패는 예외가 아니라 값이다 — `problems`는 **거부한 이유 전부**이고,
 * 운영자가 한 번에 고칠 수 있게 첫 실패에서 멈추지 않는다.
 *
 * 성공 분기에만 `config`가 있으므로 호출자가 검사를 건너뛰고 설정을 꺼낼 수 없다.
 */
export type TransportConfigResult =
  | { ok: true; config: TransportConfig }
  | { ok: false; problems: readonly string[] }

/**
 * `unknown`을 전송 평면 설정으로 파싱한다.
 *
 * **정의되지 않은 최상위 필드는 조용히 무시하지 않고 거부한다** — `0003 §1.3`이 요청
 * 본문에 대해 못박은 규율(*"무시하면 클라이언트는 자기가 보낸 것이 반영됐다고 믿는다"*,
 * MUST NOT)을 설정 로드에 그대로 적용한 것이다. 설정에서는 그 오차가 더 나쁘다: 오타 난
 * `verificatonKeys`를 무시하면 **키가 하나도 주입되지 않은 채로** 서버가 뜨고, 그때 모든
 * 요청은 `401`이 된다 (`§3.3` MUST — `test/token.test.ts`의 *"rejects every token when the
 * injected key set is empty"*). 조용한 무시는 그 상태를 설정 오류가 아니라 인증 실패처럼
 * 보이게 만든다.
 *
 * `signingKey` 같은 이름이 여기 걸리는 것은 특별 취급이 아니라 **정의되지 않았기
 * 때문**이다. 이 스키마에 private key 필드를 더하지 않는 한 그 이름은 영영 걸린다.
 *
 * 키 목록에 private `KeyObject`가 섞이는 경로는 {@link createVerificationKeySet}이 이미
 * 던져서 막고 있다 (`src/transport/token.ts`). 여기서는 그 예외를 잡아 다른 거부와 같은
 * 모양으로 돌려준다 — 설정이 거부되는 이유가 두 갈래로 갈라지면(값이거나 예외이거나)
 * 호출자가 한쪽만 다루게 된다.
 *
 * @param input 호출자가 어디서 읽어 왔든 상관없는 날것. 출처(env·파일·테스트 리터럴)는
 *   이 모듈의 관심이 아니다 — 그것을 정하는 것이 프로세스 부트스트랩이고, 이 조각의
 *   「엔트리」는 모듈 경계이지 프로세스가 아니다.
 */
export function parseTransportConfig(input: unknown): TransportConfigResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, problems: ['transport config must be an object'] }
  }

  const problems: string[] = []

  const defined = new Set<string>(TRANSPORT_CONFIG_FIELDS)
  const unknownFields = Object.keys(input).filter((key) => !defined.has(key))
  if (unknownFields.length > 0) {
    problems.push(`transport config has fields not defined by the schema: ${unknownFields.join(', ')}`)
  }

  const raw = (input as Record<string, unknown>)['verificationKeys']
  const entries: (readonly [string, KeyObject])[] = []
  if (!Array.isArray(raw)) {
    problems.push('transport config field "verificationKeys" must be an array of [keyId, publicKey] pairs')
  } else {
    raw.forEach((entry: unknown, index: number) => {
      if (!Array.isArray(entry) || entry.length !== 2) {
        problems.push(`verificationKeys[${index}] must be a [keyId, publicKey] pair`)
        return
      }
      const [keyId, key] = entry as [unknown, unknown]
      if (typeof keyId !== 'string' || keyId.length === 0) {
        problems.push(`verificationKeys[${index}] keyId must be a non-empty string`)
        return
      }
      if (!(key instanceof KeyObject)) {
        problems.push(`verificationKeys[${index}] ("${keyId}") key must be a KeyObject`)
        return
      }
      entries.push([keyId, key])
    })
  }

  if (problems.length > 0) {
    return { ok: false, problems }
  }

  let verificationKeys: VerificationKeySet
  try {
    verificationKeys = createVerificationKeySet(entries)
  } catch {
    // `createVerificationKeySet`이 던지는 자리는 하나다 — public이 아닌 키. 잡은 예외의
    // 메시지를 되싣지 않는 것은 `src/body.ts`가 JSON 파서 예외에 대해 한 판단과 같다:
    // 남의 예외 텍스트에 무엇이 실려 오는지를 이 자리가 보증할 수 없다. 대신 **어느
    // 항목이 걸렸는지**를 keyId로 적는다 — 고치는 데 필요한 것은 그것이고, keyId는
    // 토큰 문자열에 평문으로 실려 다니는 값이라 새로 드러나는 것이 없다.
    const offending = entries.filter(([, key]) => key.type !== 'public').map(([keyId]) => keyId)
    return {
      ok: false,
      problems: [
        offending.length > 0
          ? `verificationKeys accepts public keys only; rejected: ${offending.join(', ')}`
          : 'verificationKeys was rejected by the key set',
      ],
    }
  }

  return { ok: true, config: { verificationKeys } }
}
