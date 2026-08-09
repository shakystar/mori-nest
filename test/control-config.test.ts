/**
 * `parseControlConfig`의 거부 경로 (mori-nest #72 — #77 리뷰에서 이관된 수용 기준).
 *
 * `src/control/index.ts`의 `parseControlConfig`는 리포 전체에서 private key를 요구하는
 * 유일한 설정 스키마다. `test/entry-boundary.test.ts`가 대칭인 `parseTransportConfig`
 * 쪽 두 거부 경로를 이미 검사하므로, 이 파일은 그 짝을 `parseControlConfig`에 채운다.
 * `signingKey.asymmetricKeyType !== 'ed25519'` 경로는 아래 두 검사와 같은 구조라 별도
 * 테스트를 만들지 않는다(#72 이슈 코멘트의 테스트 증식 통제).
 */

import { describe, expect, it } from 'vitest'

import { parseControlConfig } from '../src/control/index.js'
import { issuer } from './workspace-token.js'

describe('parseControlConfig', () => {
  it('rejects a config carrying a top-level field the schema never defined', () => {
    const result = parseControlConfig({
      signingKey: issuer.privateKey,
      keyId: 'k-2026-08',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.join('\n')).toContain('keyId')

    // 같은 파서가 정의된 필드만 담은 설정은 통과시킨다 — 거부가 전면 거부가 아님을 함께 본다.
    expect(parseControlConfig({ signingKey: issuer.privateKey }).ok).toBe(true)
  })

  it('rejects a public KeyObject for signingKey', () => {
    // 이 평면이 "자기가 서명할 수 있다"고 믿은 채로 뜨는 것을 막는 자리다
    // (`type !== 'private'` 경로).
    const result = parseControlConfig({ signingKey: issuer.publicKey })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.join('\n')).toContain('private')
  })
})
