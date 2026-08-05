import { describe, expect, it } from 'vitest'

import { ErrorCodes } from '../src/errors.js'
import { checkMethod } from '../src/method.js'

describe('checkMethod', () => {
  it('허용 메서드 집합에 없는 메서드만 method_not_allowed다', () => {
    // 0002 §0 · 0003 §0 — "위 표에 없는 메서드는 405".
    const allowed = ['GET']

    const rejected = checkMethod('POST', allowed)
    expect(rejected.ok).toBe(false)
    if (rejected.ok) return
    expect(rejected.error.error.code).toBe(ErrorCodes.method_not_allowed)

    expect(checkMethod('GET', allowed)).toEqual({ ok: true })
  })
})
