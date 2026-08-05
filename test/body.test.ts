import { describe, expect, it } from 'vitest'

import { parseBody } from '../src/body.js'
import { ErrorCodes } from '../src/errors.js'

describe('parseBody', () => {
  it('정의되지 않은 최상위 필드가 있으면 malformed_request로 거부한다', () => {
    // 0003 §1.3 MUST NOT — 무시하면 클라이언트는 자기가 보낸 것이 반영됐다고 믿는다.
    const result = parseBody('{"events":[],"logId":"abc"}', ['events'])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.error.code).toBe(ErrorCodes.malformed_request)
    expect(result.error.error.details?.['unknownFields']).toEqual(['logId'])
  })

  it('JSON이 아닌 본문은 malformed_request로 거부한다', () => {
    const result = parseBody('not json at all', ['events'])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.error.code).toBe(ErrorCodes.malformed_request)
    // 파서 예외 메시지에 실리는 본문 조각이 새어 나가지 않는다 (0002 §1.5 MUST NOT).
    expect(result.error.error.message).not.toContain('not json at all')
  })

  it('스키마에 정의된 필드만 있는 본문은 통과한다', () => {
    const result = parseBody('{"events":[{"id":"e1","payload":1}]}', ['events'])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.body).toEqual({ events: [{ id: 'e1', payload: 1 }] })
  })
})
