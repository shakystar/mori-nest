import { describe, expect, it } from 'vitest'

import { parseAppendRequest } from '../src/transport/event.js'
import {
  serializeAppendFrame,
  serializeHeartbeatFrame,
  serializeOpenFrame,
  serializeResetFrame,
} from '../src/transport/sse.js'

/**
 * `event.ts`가 잘라낸 **원문 조각**을 가져온다. 상수로 적어 두지 않고 실제 게이트를 통과시키는
 * 것은, `§1.3` L98-99의 관찰 조건이 *"append 요청 본문에서 잘라낸 슬라이스와 subscribe로 받은
 * 슬라이스가 바이트 동일하다"* 이기 때문이다 — 양쪽 끝을 다 갖는 것이 이 조각이다.
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

/**
 * 클라이언트가 접힌 줄을 되돌리는 규칙 그대로: 각 `data:` 줄의 값을 `\n`으로 잇는다
 * (필드명·콜론을 떼고, 선행 SPACE가 있으면 **하나만** 지운다).
 *
 * **SSE 파서가 아니다** — `src/sse.ts`의 접기 규칙을 테스트에서 직접 되돌린 것이다.
 * 파서는 이 리포 밖(클라이언트)이므로 여기서 새로 쓰지 않는다.
 */
function unfoldData(frame: string): string {
  return frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).replace(/^ /, ''))
    .join('\n')
}

describe('SSE 프레임 직렬화 (0002 §4.3)', () => {
  it('open 프레임은 from 3변이를 그대로 싣는다 (§4.3 L395)', () => {
    // `from`을 가르는 것은 커서가 해석되는지 여부이고 그것은 저장소가 안다 — 이 함수는
    // 판정하지 않고 받는다.
    const cases = [
      { from: 'beginning', wire: 'event: open\ndata: {"from":"beginning"}\n\n' },
      { from: 'known', wire: 'event: open\ndata: {"from":"known"}\n\n' },
      { from: 'unknown', wire: 'event: open\ndata: {"from":"unknown"}\n\n' },
    ] as const

    for (const { from, wire } of cases) {
      expect(serializeOpenFrame(from), from).toBe(wire)
    }
  })

  it('append 프레임은 payload 원문 조각을 문자 단위로 그대로 싣고 id: 줄에 커서를 싣는다', () => {
    // §1.3 L96-101 (MUST) + §4.3 L396·L400 (MUST). 케이스는 #17의 바이트 보존 케이스에서
    // 가져왔다 — `JSON.parse`->`JSON.stringify` 왕복이 깨뜨리는 숫자 재표기와 공백이다.
    const cases = [
      {
        what: '숫자 재표기',
        payload: '1.0',
        wire: 'event: append\nid: c-1\ndata: {"id":"e1","payload":1.0,"cursor":"c-1"}\n\n',
      },
      {
        what: '공백',
        payload: '{ "a" :  1 }',
        wire: 'event: append\nid: c-1\ndata: {"id":"e1","payload":{ "a" :  1 },"cursor":"c-1"}\n\n',
      },
    ]

    for (const { what, payload, wire } of cases) {
      const slice = payloadSliceOf(`{"events":[{"id":"e1","payload":${payload}}]}`)
      expect(slice, what).toBe(payload)

      const result = serializeAppendFrame({ id: 'e1', payload: slice, cursor: 'c-1' })

      expect(result.ok, what).toBe(true)
      if (!result.ok) continue
      // 스냅샷이 아니라 원문과의 직접 비교여야 "정규화하지 않았다"가 검사된다.
      expect(result.frame, what).toBe(wire)
      expect(result.frame, what).toContain(`"payload":${payload},`)
    }
  })

  it('개행이 든 payload는 여러 data: 줄로 접히고, 되돌리면 원문과 같다', () => {
    // 들여쓰기(선행 SPACE)가 살아남는 것이 이 테스트의 절반이다 — 구분자로 SPACE를 하나
    // 쓰지 않으면 클라이언트가 값의 첫 칸을 지우고, 그 자리에서 §1.3 L96이 깨진다.
    const pretty = '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}'
    const slice = payloadSliceOf(`{"events":[{"id":"e1","payload":${pretty}}]}`)
    expect(slice).toBe(pretty)

    const result = serializeAppendFrame({ id: 'e1', payload: slice, cursor: 'c-1' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const dataLines = result.frame.split('\n').filter((line) => line.startsWith('data:'))
    expect(dataLines.length).toBe(6)
    // 왕복 무손실: 클라이언트 규칙으로 되돌린 값이 우리가 만든 data 문서와 문자 단위로 같고,
    // 그 안에 원문 조각이 그대로 들어 있다.
    expect(unfoldData(result.frame)).toBe(
      `{"id":"e1","payload":${pretty},"cursor":"c-1"}`,
    )
    expect(unfoldData(result.frame)).toContain(pretty)
  })

  it('heartbeat와 reset 프레임 (§4.3 L397·L398)', () => {
    expect(serializeHeartbeatFrame()).toBe('event: heartbeat\ndata: {}\n\n')
    expect(serializeResetFrame('subscriber buffer limit exceeded')).toBe(
      'event: reset\ndata: {"reason":"subscriber buffer limit exceeded"}\n\n',
    )
    // reason은 `JSON.stringify`를 지나므로 개행이 와도 줄을 끊지 못한다 (실패 경로가 없는 근거).
    expect(serializeResetFrame('a\nb')).toBe('event: reset\ndata: {"reason":"a\\nb"}\n\n')
  })

  it('모든 프레임은 빈 줄로 끝나고, 이어 붙여도 경계가 유지된다', () => {
    // 값 안의 빈 줄이 프레임 경계로 오인되지 않는 것까지가 이 테스트다 — 접힌 빈 조각은
    // `data: ` 한 줄이지 빈 줄이 아니다.
    const slice = payloadSliceOf('{"events":[{"id":"e1","payload":{\n\n"a": 1\n}}]}')
    const appended = serializeAppendFrame({ id: 'e1', payload: slice, cursor: 'c-1' })

    expect(appended.ok).toBe(true)
    if (!appended.ok) return
    const frames = [
      serializeOpenFrame('known'),
      appended.frame,
      serializeHeartbeatFrame(),
      serializeResetFrame('gap'),
    ]

    for (const frame of frames) {
      expect(frame.endsWith('\n\n')).toBe(true)
      // 프레임 안에 빈 줄은 마지막 하나뿐이다.
      expect(frame.indexOf('\n\n')).toBe(frame.length - 2)
    }

    const stream = frames.join('')
    const split = stream.split('\n\n').filter((part) => part !== '')

    expect(split.map((part) => `${part}\n\n`)).toEqual(frames)
  })

  it('실을 수 없는 payload·커서에는 프레임을 만들지 않는다 (결정 1·2, fail-closed)', () => {
    // 결정 1: CRLF로 찍힌 본문의 슬라이스는 `\r`를 실제로 담는다 (RFC 8259 §2의 공백 넷).
    // SSE의 줄 구분자는 `\r\n`·`\r`·`\n` 셋인데 클라이언트의 재결합은 `\n` 하나뿐이라
    // 이 값은 왕복하지 못한다 — §1.3 L96-101(MUST)을 지킬 수 없으므로 200으로 내보내지 않는다.
    const secret = 'sekrit-payload-marker'
    const crSlice = payloadSliceOf(
      `{"events":[{"id":"e1","payload":{\r\n  "a": "${secret}"\r\n}}]}`,
    )
    expect(crSlice).toContain('\r')

    const crResult = serializeAppendFrame({ id: 'e1', payload: crSlice, cursor: 'c-1' })

    expect(crResult.ok).toBe(false)
    if (crResult.ok) return
    expect(crResult.reason).toBe('payload_not_representable')
    // 실패에 payload 원문이 실리지 않는다 (§1.5 L145-146 MUST NOT) — 이 값은 §4.5 L433의
    // `reset`에 그대로 넘어가므로 담기면 그대로 와이어에 나간다.
    expect(JSON.stringify(crResult)).not.toContain(secret)
    expect(serializeResetFrame(crResult.reason)).not.toContain(secret)

    // 같은 판정이 빈 원문 조각에서 통째로 꺼지지 않는다 — 빈 조각을 그대로 이으면
    // `{"id":…,"payload":,"cursor":…}`, 즉 줄 구조는 멀쩡한데 JSON이 아닌 프레임이 나간다.
    // 공백만 든 조각(`" "`)도 같은 실패 모드다 — pull.ts의 trim 판정과 맞춘다.
    const emptyPayloads = [
      { what: '빈 문자열', payload: '' },
      { what: '공백만', payload: ' ' },
    ]
    for (const { payload } of emptyPayloads) {
      const emptyResult = serializeAppendFrame({ id: 'e1', payload, cursor: 'c-1' })

      expect(emptyResult.ok).toBe(false)
      if (emptyResult.ok) continue
      expect(emptyResult.reason).toBe('payload_not_representable')
    }

    // 결정 2: `id:` 줄을 끊거나 조용히 무시되게 만드는 커서.
    const cursors = [
      { what: '개행', cursor: 'c\n1' },
      { what: '캐리지 리턴', cursor: 'c\r1' },
      { what: 'NUL', cursor: `c${String.fromCharCode(0)}1` },
      { what: '빈 문자열', cursor: '' },
    ]

    for (const { what, cursor } of cursors) {
      const result = serializeAppendFrame({ id: 'e1', payload: '{"a":1}', cursor })

      expect(result.ok, what).toBe(false)
      if (result.ok) continue
      expect(result.reason, what).toBe('cursor_not_representable')
    }
  })
})
