import { describe, expect, it } from 'vitest'

import { parseAppendRequest } from '../src/transport/event.js'
import { serializePullResponse } from '../src/transport/pull.js'

/**
 * `event.ts`가 잘라낸 **원문 조각**을 가져온다. 상수로 적어 두지 않고 실제 게이트를 통과시키는
 * 것은, `§1.3` L98-99의 관찰 조건이 *"append 요청 본문에서 잘라낸 슬라이스와 pull로 받은
 * 응답의 슬라이스가 바이트 동일하다"* 이기 때문이다 — 이 조각이 그 조건의 **pull 쪽 끝**이다
 * (`test/sse.test.ts`가 subscribe 쪽에 대해 쓴 것과 같은 방식이다).
 */
function payloadSliceOf(body: string): string {
  const parsed = parseAppendRequest(body)
  if (!parsed.ok) {
    throw new Error('테스트 본문이 append 게이트를 통과하지 못했다')
  }
  const payload = parsed.events[0]?.payload
  if (payload === undefined) {
    throw new Error('테스트 본문에 이벤트가 없다')
  }
  return payload
}

describe('pull 응답 직렬화 (0002 §3.1)', () => {
  it('빈 페이지는 §3.1 L298-299가 적은 그 문서이고 cursor 키가 부재한다 (L292)', () => {
    const result = serializePullResponse({ events: [], hasMore: false, from: 'beginning' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.body).toBe('{"events":[],"hasMore":false,"from":"beginning"}')
    // 값이 아니라 **키 부재**다 — `null`이나 `""`을 실으면 클라이언트가 그것을 커서로 믿고
    // 되돌려보낸다.
    expect(Object.hasOwn(JSON.parse(result.body) as object, 'cursor')).toBe(false)
  })

  it('payload 원문 조각이 문자 단위로 그대로 실린다 (§1.3 L96-101 MUST)', () => {
    // 케이스는 #17의 바이트 보존 케이스다 — `JSON.parse`->`JSON.stringify` 왕복이 깨뜨리는
    // 숫자 재표기와 공백이다.
    const cases = [
      { what: '숫자 재표기', payload: '1.0' },
      { what: '공백', payload: '{ "a" :  1 }' },
    ]

    for (const { what, payload } of cases) {
      const slice = payloadSliceOf(`{"events":[{"id":"e1","payload":${payload}}]}`)
      expect(slice, what).toBe(payload)

      const result = serializePullResponse({
        events: [{ id: 'e1', payload: slice, cursor: 'c-1' }],
        hasMore: false,
        from: 'known',
      })

      expect(result.ok, what).toBe(true)
      if (!result.ok) continue
      // 스냅샷이 아니라 원문과의 직접 비교여야 "정규화하지 않았다"가 검사된다.
      expect(result.body, what).toBe(
        `{"events":[{"id":"e1","payload":${payload},"cursor":"c-1"}],"cursor":"c-1","hasMore":false,"from":"known"}`,
      )
      expect(result.body, what).toContain(`"payload":${payload},`)
    }
  })

  it('\\r가 든 원문 조각도 바이트 그대로 실린다 — sse.ts가 거부하는 그 값이다', () => {
    // CRLF로 찍힌 본문의 슬라이스는 `\r`를 실제로 담는다 (RFC 8259 §2의 공백 넷). `sse.ts`는
    // 이 값에 프레임을 만들지 않는다 — SSE의 줄 문법을 왕복하지 못하기 때문이다(PR #22 결정 1).
    // **pull은 줄 문법이 아니므로 그대로 실어 나른다**: 그래서 그 실패가 이벤트의 소실이 아니라
    // 경로의 강등이고, 이 비대칭이 PR #22 결정 1의 전제다. 2번과 별개로 고정한다.
    const pretty = '{\r\n  "a": 1\r\n}'
    const slice = payloadSliceOf(`{"events":[{"id":"e1","payload":${pretty}}]}`)
    expect(slice).toBe(pretty)
    expect(slice).toContain('\r')

    const result = serializePullResponse({
      events: [{ id: 'e1', payload: slice, cursor: 'c-1' }],
      hasMore: false,
      from: 'known',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.body).toContain(`"payload":${pretty},`)
    // 왕복 무손실: 클라이언트가 `JSON.parse`한 값을 다시 이 문서에서 잘라낸 것이 원문과 같다.
    const parsed = JSON.parse(result.body) as { events: { payload: unknown }[] }
    expect(JSON.stringify(parsed.events[0]?.payload)).toBe('{"a":1}')
    const start = result.body.indexOf('"payload":') + '"payload":'.length
    expect(result.body.slice(start, start + pretty.length)).toBe(pretty)
  })

  it('다건 페이지는 준 순서 그대로 실리고 cursor는 마지막 이벤트의 것이다 (L301 MUST · L292)', () => {
    // 정렬은 저장소의 일이다 — 이 함수는 받은 순서를 그대로 싣는 것으로 L301을 지킨다.
    // 최상위 `cursor`를 입력으로 받지 않고 파생하는 것이 결정 2다 (어긋난 커서는 조용한 누락).
    const events = [
      { id: 'e1', payload: '1', cursor: 'c-1' },
      { id: 'e2', payload: '{"a":2}', cursor: 'c-2' },
      { id: 'e3', payload: '"three"', cursor: 'c-3' },
    ]

    const result = serializePullResponse({ events, hasMore: true, from: 'known' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.body).toBe(
      '{"events":[' +
        '{"id":"e1","payload":1,"cursor":"c-1"},' +
        '{"id":"e2","payload":{"a":2},"cursor":"c-2"},' +
        '{"id":"e3","payload":"three","cursor":"c-3"}' +
        '],"cursor":"c-3","hasMore":true,"from":"known"}',
    )
  })

  it('hasMore: true인데 events가 빈 페이지는 직렬화하지 않는다 (L303 MUST, 결정 1)', () => {
    // 그대로 내보내면 서버가 자기 MUST를 어긴 200을 내보내고, 클라이언트는 다음 페이지를
    // 요청해야 하는데 커서가 없어(L292) 순회가 그 자리에서 멈춘다.
    const result = serializePullResponse({ events: [], hasMore: true, from: 'unknown' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('has_more_without_events')

    // 같은 fail-closed가 값 없는 원문 조각에도 걸린다 (결정 3) — 그대로 이으면
    // `{"id":…,"payload":,"cursor":…}`, 즉 JSON으로 파싱되지 않는 본문이 200으로 나간다.
    // 공백만 든 조각은 그것과 문자 하나 차이일 뿐이므로 판정이 거기서 꺼지지 않아야 한다.
    const secret = 'sekrit-payload-marker'
    for (const { what, payload } of [
      { what: '빈 조각', payload: '' },
      { what: '공백만', payload: ' ' },
    ]) {
      const broken = serializePullResponse({
        events: [
          { id: 'e1', payload: `{"a":"${secret}"}`, cursor: 'c-1' },
          { id: 'e2', payload, cursor: 'c-2' },
        ],
        hasMore: false,
        from: 'known',
      })

      expect(broken.ok, what).toBe(false)
      if (broken.ok) continue
      expect(broken.reason, what).toBe('empty_payload')
      // 실패에 payload 원문도 커서도 실리지 않는다 (§1.5 L145-146 MUST NOT) — 이 값은
      // 로그나 에러 봉투로 그대로 나갈 수 있다.
      expect(JSON.stringify(broken), what).not.toContain(secret)
      expect(JSON.stringify(broken), what).not.toContain('c-1')
    }
  })

  it('from 3변이가 그대로 실린다 (L294 · L312)', () => {
    // 셋을 가르는 것은 커서가 해석되는지 여부이고 그것은 저장소가 안다 (§3.2) — 이 함수는
    // 판정하지 않고 받는다.
    const cases = ['beginning', 'known', 'unknown'] as const

    for (const from of cases) {
      const result = serializePullResponse({ events: [], hasMore: false, from })

      expect(result.ok, from).toBe(true)
      if (!result.ok) continue
      expect(result.body, from).toBe(`{"events":[],"hasMore":false,"from":"${from}"}`)
    }
  })
})
