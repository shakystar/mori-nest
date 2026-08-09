/**
 * `parseControlConfig`의 거부 경로 (mori-nest #72 — #77 리뷰에서 이관된 수용 기준)와
 * 발급 파라미터 넷의 `0003 §3.4` 강제 (mori-nest #103).
 *
 * `src/control/index.ts`의 `parseControlConfig`는 리포 전체에서 private key를 요구하는
 * 유일한 설정 스키마다. `test/entry-boundary.test.ts`가 대칭인 `parseTransportConfig`
 * 쪽 두 거부 경로를 이미 검사하므로, 이 파일은 그 짝을 `parseControlConfig`에 채운다.
 * `signingKey.asymmetricKeyType !== 'ed25519'` 경로는 아래 두 검사와 같은 구조라 별도
 * 테스트를 만들지 않는다(#72 이슈 코멘트의 테스트 증식 통제).
 *
 * `§3.4`의 네 제약을 **파싱 시점에** 강제하는 것이 #103이 더한 자리다 — 제약을 어긴 배포가
 * 첫 요청까지 살아 있으면 그 사이에 이미 `§3.4`를 어긴 토큰이 나간다.
 */

import { describe, expect, it } from 'vitest'

import { parseControlConfig } from '../src/control/index.js'
import { KEY_ID, issuer } from './workspace-token.js'

/** `§3.4`의 네 제약을 만족하는 설정 하나. 위반 케이스는 여기서 한 필드씩만 민다. */
function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    signingKey: issuer.privateKey,
    keyId: KEY_ID,
    tokenTtlSeconds: 300,
    heartbeatIntervalSeconds: 30,
    gracePeriodSeconds: 600,
    ...overrides,
  }
}

describe('parseControlConfig', () => {
  it('rejects a config carrying a top-level field the schema never defined', () => {
    // `0003 §1.3`의 MUST NOT("정의되지 않은 최상위 필드를 조용히 무시하지 않는다")을 설정
    // 로드에 적용한 자리다. `tokenTtl`이 걸리는 것은 이름이 낯설어서가 아니라 정의되지
    // 않았기 때문이고, 그래서 단위를 빠뜨린 오타(`tokenTtl` vs `tokenTtlSeconds`)가 조용히
    // 무시되지 않는다. **`§3.6`이 금지한 "스코프 판정을 끄는 스위치"도 같은 규율에 걸린다.**
    const result = parseControlConfig(validConfig({ tokenTtl: 900 }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.join('\n')).toContain('tokenTtl')

    // 같은 파서가 정의된 필드만 담은 설정은 통과시킨다 — 거부가 전면 거부가 아님을 함께 본다.
    expect(parseControlConfig(validConfig()).ok).toBe(true)
  })

  it('rejects a public KeyObject for signingKey', () => {
    // 이 평면이 "자기가 서명할 수 있다"고 믿은 채로 뜨는 것을 막는 자리다
    // (`type !== 'private'` 경로).
    const result = parseControlConfig(validConfig({ signingKey: issuer.publicKey }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.join('\n')).toContain('private')
  })

  it('발급 파라미터 넷이 파싱을 통과하고 값이 그대로 실린다 (§3.4)', () => {
    const result = parseControlConfig(validConfig())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 파서가 값을 깎거나 기본값으로 덮지 않는다 — 배포가 고른 값이 그대로 발급에 쓰인다.
    expect(result.config.keyId).toBe(KEY_ID)
    expect(result.config.tokenTtlSeconds).toBe(300)
    expect(result.config.heartbeatIntervalSeconds).toBe(30)
    expect(result.config.gracePeriodSeconds).toBe(600)
    expect(result.config.signingKey).toBe(issuer.privateKey)
  })

  it('§3.4의 네 제약 위반이 각각 거부된다 — 파싱 시점에', () => {
    // 넷은 같은 동작(«§3.4 강제»)의 네 입력이다. `it`을 넷으로 나누면 셋업만 복제된다.
    const violations: readonly [string, Record<string, unknown>, string][] = [
      // `keyId`가 `§3.2` 정규식 위반 — 구분자 `.`이 섞이면 토큰 세그먼트가 갈라진다.
      ['keyId', { keyId: 'k.2026' }, 'keyId'],
      // `tokenTtl ≤ 15분` (MUST). 폐기 수렴 시간의 상한이 곧 이 값이다 (`§3.5`).
      ['tokenTtl 상한', { tokenTtlSeconds: 901, gracePeriodSeconds: 1000 }, 'tokenTtlSeconds'],
      // `tokenTtl ≥ 3 × heartbeatIntervalSeconds` (MUST).
      ['하트비트 세 번', { tokenTtlSeconds: 60, heartbeatIntervalSeconds: 30 }, 'heartbeatIntervalSeconds'],
      // `gracePeriod > tokenTtl` (MUST). 접근 상실이 유기 판정보다 먼저 와야 한다.
      ['grace > ttl', { gracePeriodSeconds: 300 }, 'gracePeriodSeconds'],
    ]

    for (const [name, override, mentioned] of violations) {
      const result = parseControlConfig(validConfig(override))
      expect(result.ok, name).toBe(false)
      if (result.ok) continue
      expect(result.problems.join('\n'), name).toContain(mentioned)
    }
  })
})
