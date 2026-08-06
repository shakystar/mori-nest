/**
 * `OnceSignal`(서버 내부, subscribe 연결의 종료 신호) 자신의 계약만 본다: `fire()`가 대기자를
 * 전부 비우고, 그 뒤 `wait()`는 즉시 resolve되며 다시 쌓이지 않는다.
 *
 * 이 파일은 원래 mori-nest #37 발견 2("`OnceSignal`이 대기자를 호출마다 쌓지 않는다")를
 * `wait()`가 반환한 프라미스를 재사용하면 `.then()`을 몇 번 다시 걸어도 `OnceSignal.waiterCount`가
 * 늘지 않는다는 것으로 검증했다. PR #41 owner 반송(mori-nest #37): 그 검증은 **틀린
 * 지표였다** — `OnceSignal.#waiters`는 늘지 않았지만, 재사용된 프라미스에 반복해서 건
 * `.then()`이 ECMAScript 엔진 내부 `PromiseReaction` 목록에 그대로 쌓여 연결 수명 동안
 * 단조 증가했다. `OnceSignal.waiterCount`는 그 목록을 보지 못하므로 문제가 사라진 것처럼
 * 보였을 뿐이다. 실제 수정(백프레셔 이벤트마다 `.then()`을 거는 대신, 생성자에서 단 한 번만
 * 걸고 스칼라 필드로 finisher를 등록·해제하는 방식)은 `src/server.ts`의
 * `SubscribeConnection.#drainWaiter` 필드 doc을 본다 — 그 불변식(연결 수명 동안 reaction이
 * 상수 1)은 `#writeFrame`이 `run()`의 단일 순차 흐름에서만 호출된다는 상호배제 논증에
 * 근거하고, 결정론적 CI 테스트로 관측 가능한 자리가 없어 doc으로 고정한다(테스트를 달면
 * `TESTING.md`가 금지하는 구현 세부 결합이 된다).
 */

import { describe, expect, it } from 'vitest'

import { OnceSignal } from '../src/server.js'

describe('OnceSignal — fire()는 대기자를 전부 비우고, 그 뒤 재호출로 다시 쌓이지 않는다', () => {
  it('fire() 이후에는 대기자가 전부 비워지고, 그 뒤 wait()는 즉시 resolve되며 쌓이지 않는다', async () => {
    const signal = new OnceSignal()
    const shared = signal.wait()
    expect(signal.waiterCount).toBe(1)

    signal.fire()
    await shared
    expect(signal.waiterCount).toBe(0)

    await signal.wait()
    expect(signal.waiterCount).toBe(0)
  })
})
