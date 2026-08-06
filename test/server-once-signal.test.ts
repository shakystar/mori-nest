/**
 * `OnceSignal`(서버 내부, subscribe 연결의 종료 신호) — mori-nest #37 발견 2의 수정 불변식만
 * 본다: `wait()`가 반환한 프라미스 하나를 재사용하면 몇 번을 다시 기다리든 대기자가 늘지
 * 않는다. `SubscribeConnection`은 이 불변식 위에서 `#closePromise`를 필드 초기화 때 한 번만
 * `wait()`로 만들고 `#waitForDrainOrClose`(백프레셔가 날 때마다, 오래 사는 연결에서는 여러
 * 번 불린다)에서 그 프라미스에 `.then()`만 건다 — `wait()`를 다시 부르지 않는다
 * (`src/server.ts`의 `#closePromise` 필드 doc 참조). 그 배선 자체는 `SubscribeConnection`이
 * 밖으로 노출되지 않아 여기서 직접 볼 수 없으므로, 이 불변식(재사용된 프라미스는 새 대기자를
 * 만들지 않는다)을 `OnceSignal` 하나로 좁혀서 검증한다.
 */

import { describe, expect, it } from 'vitest'

import { OnceSignal } from '../src/server.js'

describe('OnceSignal — 재사용된 wait() 프라미스는 대기자를 다시 쌓지 않는다 (mori-nest #37)', () => {
  it('wait()를 한 번만 부르고 그 프라미스에 여러 번 then()을 걸어도 대기자 수가 1로 유지된다', () => {
    const signal = new OnceSignal()
    const shared = signal.wait()
    expect(signal.waiterCount).toBe(1)

    for (let i = 0; i < 50; i++) {
      shared.then(() => {})
    }
    expect(signal.waiterCount).toBe(1)
  })

  it('반대로 wait()를 호출마다 다시 부르면(고쳐지기 전 패턴) 대기자가 호출 수만큼 쌓인다', () => {
    const signal = new OnceSignal()
    for (let i = 0; i < 50; i++) {
      signal.wait().then(() => {})
    }
    expect(signal.waiterCount).toBe(50)
  })

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
