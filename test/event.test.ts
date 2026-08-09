import { describe, expect, it } from 'vitest'

import { ErrorCodes } from '../src/errors.js'
import { parseAppendRequest } from '../src/transport/event.js'

describe('parseAppendRequest', () => {
  it('유효한 요청은 요청 배열 순서대로 통과하고 payload 조각이 원문과 일치한다', () => {
    // 0002 §2.1 L193 — `accepted`가 요청 배열 순서를 쓴다.
    const raw = '{"events":[{"id":"e1","payload":{"a":1}},{"id":"e2","payload":[true,null]}]}'

    const result = parseAppendRequest(raw)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.events.map((event) => event.id)).toEqual(['e1', 'e2'])
    expect(result.events[0]?.payload).toBe('{"a":1}')
    expect(result.events[1]?.payload).toBe('[true,null]')
    // 조각은 본문에서 잘라낸 것이다 — 원문 안에 그대로 있다.
    for (const event of result.events) {
      expect(raw).toContain(event.payload)
    }
  })

  it('payload를 받은 바이트 그대로 돌려준다 — 정규화가 하나도 없다', () => {
    // 0002 §1.3 L96-101 (MUST). `JSON.parse`->`JSON.stringify` 왕복이 깨뜨리는 네 가지를
    // 그대로 세운다: 숫자 재표기 / 유니코드 이스케이프 / 키 순서 / 공백.
    // `roundTrip`은 파싱된 값을 payload로 썼다면 나갔을 값이다 — 대조군이 없으면
    // 위 단언이 "우연히 같은" 케이스와 구분되지 않는다. 키 순서만 왕복으로도 살아남는데,
    // JS 객체가 문자열 키의 삽입 순서를 보존하기 때문이다. 스펙이 금지한 재정렬은
    // 저장소(키를 정렬해 담는 jsonb 류)에서 생기고, 이 게이트가 고정하는 것은 거기까지
    // 원문 순서가 **그대로** 넘어간다는 것이다.
    const cases = [
      { what: '숫자 재표기', payload: '1.0', roundTrip: '1' },
      { what: '유니코드 이스케이프', payload: '"\\u0041"', roundTrip: '"A"' },
      { what: '키 순서', payload: '{"b":1,"a":2}', roundTrip: '{"b":1,"a":2}' },
      { what: '공백', payload: '{ "a" :  1 }', roundTrip: '{"a":1}' },
    ]

    for (const { what, payload, roundTrip } of cases) {
      const raw = `{"events":[{"id":"e1","payload":${payload}}]}`

      const result = parseAppendRequest(raw)

      expect(result.ok, what).toBe(true)
      if (!result.ok) continue
      // 원문의 그 구간과 문자 단위로 같다 (스냅샷이 아니라 원문과의 직접 비교여야
      // "정규화하지 않았다"가 검사된다).
      expect(result.events[0]?.payload, what).toBe(payload)
      expect(JSON.stringify(JSON.parse(payload)), what).toBe(roundTrip)
    }
  })

  it('events가 없거나 배열이 아니거나 비어 있으면 malformed_request다', () => {
    // 빈 배열이 400인 근거: 0002 §2.1 L204-206 (MUST).
    const cases = ['{}', '{"events":{"id":"e1"}}', '{"events":[]}']

    for (const raw of cases) {
      const result = parseAppendRequest(raw)

      expect(result.ok, raw).toBe(false)
      if (result.ok) continue
      expect(result.status, raw).toBe(400)
      expect(result.error.error.code, raw).toBe(ErrorCodes.malformed_request)
    }
  })

  it('최상위에 정의되지 않은 필드가 있으면 malformed_request다 (게이트가 parseBody를 부른다)', () => {
    const result = parseAppendRequest('{"events":[{"id":"e1","payload":1}],"logId":"x"}')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.error.error.code).toBe(ErrorCodes.malformed_request)
    // parseBody의 판정을 그대로 옮겼는지까지가 이 테스트의 범위다 —
    // 그 함수의 내부 동작은 test/body.test.ts가 덮는다.
    expect(result.error.error.details?.['unknownFields']).toEqual(['logId'])
  })

  it('id가 0002 §1.3 L86 정규식을 위반하면 invalid_event다', () => {
    const cases = [
      { what: '부재', event: '{"payload":1}' },
      { what: '빈 문자열', event: '{"id":"","payload":1}' },
      { what: '257자', event: `{"id":"${'a'.repeat(257)}","payload":1}` },
      { what: '공백 포함', event: '{"id":"e 1","payload":1}' },
      { what: '문자열 아님', event: '{"id":1,"payload":1}' },
    ]

    for (const { what, event } of cases) {
      const result = parseAppendRequest(`{"events":[${event}]}`)

      expect(result.ok, what).toBe(false)
      if (result.ok) continue
      expect(result.status, what).toBe(400)
      expect(result.error.error.code, what).toBe(ErrorCodes.invalid_event)
      // id를 신뢰할 수 없는 실패다 — eventId 대신 eventIndex가 이벤트를 짚는다.
      expect(result.error.error.details?.['eventId'], what).toBeUndefined()
      expect(result.error.error.details?.['eventIndex'], what).toBe(0)
    }
  })

  it('payload 키가 없으면 invalid_event이고, 값이 null인 이벤트는 통과한다', () => {
    // 0002 §1.3 L87 — `null`도 `false`도 `0`도 유효한 JSON 값이다. 값의 참거짓으로
    // 판정하면 안 되고, 보는 것은 **키의 존재**다.
    const missing = parseAppendRequest('{"events":[{"id":"e1"}]}')

    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.status).toBe(400)
    expect(missing.error.error.code).toBe(ErrorCodes.invalid_event)
    expect(missing.error.error.details?.['eventId']).toBe('e1')

    const nullPayload = parseAppendRequest('{"events":[{"id":"e1","payload":null}]}')

    expect(nullPayload.ok).toBe(true)
    if (!nullPayload.ok) return
    expect(nullPayload.events[0]?.payload).toBe('null')
  })

  it('한 요청 안에 같은 id가 두 번 이상 있으면 invalid_event다', () => {
    // 0002 §2.1 L209-210 (MUST). 요청 **간** dedup(저장소 몫)과 다른 판정이다.
    const result = parseAppendRequest(
      '{"events":[{"id":"e1","payload":1},{"id":"e1","payload":2}]}',
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.error.error.code).toBe(ErrorCodes.invalid_event)
    expect(result.error.error.details?.['eventId']).toBe('e1')
    expect(result.error.error.details?.['eventIndex']).toBe(1)
  })

  it('하나라도 실패하면 아무것도 통과하지 않고 details.eventId가 그 이벤트를 짚는다', () => {
    // 0002 §2.1 L207-208 (MUST) — all-or-nothing. 반환 타입에 부분 성공을 실을 자리가
    // 없다는 것을 여기서 확인한다.
    const result = parseAppendRequest(
      '{"events":[{"id":"ok-1","payload":1},{"id":"bad-2"}]}',
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.error.error.code).toBe(ErrorCodes.invalid_event)
    expect(result.error.error.details?.['eventId']).toBe('bad-2')
    expect(result.error.error.details?.['eventIndex']).toBe(1)
    expect(Object.keys(result)).toEqual(['ok', 'status', 'error'])
  })

  it('실패 응답 어디에도 payload 원문이 실리지 않는다', () => {
    // 0002 §1.5 L145-146 (MUST NOT). payload에 비밀을 담은 요청이 에러로 되비쳐지면
    // 그 자체가 유출 경로다.
    const secret = 'sekrit-payload-marker'
    const bodies = [
      `{"events":[{"id":"","payload":"${secret}"}]}`,
      `{"events":[{"id":1,"payload":"${secret}"}]}`,
      `{"events":[{"id":"e1","payload":"${secret}","ts":1}]}`,
      `{"events":[{"id":"e1","payload":"${secret}"},{"id":"e1","payload":"${secret}"}]}`,
      `{"events":[{"id":"e1","payload":"${secret}"},{"id":"e2"}]}`,
      `{"events":[{"id":"e1","payload":"${secret}"}],"logId":"x"}`,
    ]

    for (const raw of bodies) {
      const result = parseAppendRequest(raw)

      expect(result.ok, raw).toBe(false)
      if (result.ok) continue
      expect(JSON.stringify(result.error), raw).not.toContain(secret)
    }
  })
})
