/**
 * 전송 엔트리의 경계 (mori-nest #71).
 *
 * 지키려는 명제는 **«전송 엔트리가 서명자에 닿지 않는다»**이고, 그것을 만드는 것은 코드
 * 배치가 아니라 **키 배포**다 (`0003 §3.3` — 검증 키는 설정으로 주입되고, 그 키는
 * 공개키다). 그래서 이 파일의 무게는 아래 **설정 파서 두 검사**에 있다: private key가
 * 전송 평면 설정으로 들어올 길이 두 방향 모두 막혀 있는가.
 *
 * 세 번째 검사(**트립와이어**)는 그 명제의 증명이 **아니다.** import 그래프에 서명
 * 심볼이 없다는 것은 지금 아무도 실수로 그것을 끌어오지 않았다는 뜻일 뿐이고,
 * `node:crypto`는 언제든 다시 import될 수 있다 — 그 한 줄을 리뷰가 아니라 CI가 먼저
 * 보게 하는 것이 트립와이어의 값이다. 이름표를 정직하게 단다.
 */

import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { parseTransportConfig } from '../src/transport/index.js'
import { KEY_ID, issuer } from './workspace-token.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const TRANSPORT_ENTRY = resolve(REPO_ROOT, 'src/transport/index.ts')
const ISSUER_HELPER = resolve(REPO_ROOT, 'test/workspace-token.ts')

/** 트립와이어가 보는 심볼. `0003 §3.2`가 검증하는 쪽에 주지 않기로 한 능력의 이름들이다. */
const SIGNING_BINDINGS = ['sign', 'generateKeyPairSync']

/**
 * `import`/`export … from '…'` 한 문장. 클로즈(1)와 모듈 지정자(2)를 잡는다.
 *
 * 정규식이지 파서가 아니다 — 이 리포의 import는 전부 파일 머리의 정적 문장이고, 트립
 * 와이어의 목적(사고 결합 탐지)에는 그것으로 충분하다. 정적 문장을 지나가는 우회로
 * (동적 `import()`·`require()`)는 {@link DYNAMIC_CRYPTO}가 따로 본다.
 */
const STATEMENT = /(?:^|[\n;])[ \t]*(?:import|export)\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g

/** `import 'x'` — 부수효과 전용 import. 이 리포에는 없지만 그래프에서 빠뜨리지 않는다. */
const SIDE_EFFECT = /(?:^|[\n;])[ \t]*import\s+['"]([^'"]+)['"]/g

/**
 * 동적 `import('node:crypto')`·`require('crypto')` — 정적 문장을 보는 위 둘을 그대로
 * 지나간다. 트립와이어가 정적 import만 본다면 그 우회로 하나가 게이트를 무의미하게
 * 만들므로, 여기서 함께 잡아 **모듈 전체 접근**(`*`)으로 기록한다.
 */
const DYNAMIC_CRYPTO = /(?:import|require)\s*\(\s*['"](?:node:)?crypto['"]\s*\)/g

/** `node:crypto`와 접두 없는 `crypto`는 같은 빌트인이다 — 한쪽만 보면 다른 쪽이 우회로다. */
function isCrypto(specifier: string): boolean {
  return specifier === 'node:crypto' || specifier === 'crypto'
}

type Graph = {
  /** 도달한 소스 파일 (리포 루트 상대 경로). */
  readonly files: readonly string[]
  /**
   * 도달한 파일들이 `node:crypto`(또는 접두 없는 `crypto`)에서 가져온 바인딩 이름.
   * 네임스페이스·기본 import와 동적 import는 이름을 감춘 채 모듈 전체를 주므로 `*`.
   */
  readonly cryptoBindings: readonly string[]
}

/** import 절에서 가져온 이름들을 뽑는다. `* as crypto`·기본 import는 `*`(전체 접근)로 본다. */
function bindingsOf(clause: string): string[] {
  const body = clause.replace(/^type\s+/, '').trim()
  if (body.startsWith('*') || !body.startsWith('{')) {
    return ['*']
  }
  const inner = body.slice(body.indexOf('{') + 1, body.lastIndexOf('}'))
  return inner
    .split(',')
    .map((part) => part.replace(/^\s*type\s+/, '').split(/\s+as\s+/)[0]?.trim() ?? '')
    .filter((name) => name.length > 0)
}

/** 상대 지정자를 소스 파일 경로로 되돌린다 (`./x.js` → `./x.ts`). */
function resolveSource(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier)
  return base.endsWith('.ts') ? base : base.replace(/\.js$/, '.ts')
}

/** `entry`에서 상대 import만 따라가며 도달 가능한 소스 전부를 훑는다. */
function walk(entry: string): Graph {
  const seen = new Set<string>()
  const cryptoBindings = new Set<string>()
  const queue = [entry]

  while (queue.length > 0) {
    const file = queue.pop()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)

    const source = readFileSync(file, 'utf8')
    const specifiers: [string, string][] = []
    for (const match of source.matchAll(STATEMENT)) {
      specifiers.push([match[1] ?? '', match[2] ?? ''])
    }
    for (const match of source.matchAll(SIDE_EFFECT)) {
      specifiers.push(['', match[1] ?? ''])
    }

    if (DYNAMIC_CRYPTO.test(source)) {
      cryptoBindings.add('*')
    }
    DYNAMIC_CRYPTO.lastIndex = 0

    for (const [clause, specifier] of specifiers) {
      if (isCrypto(specifier)) {
        for (const binding of bindingsOf(clause)) cryptoBindings.add(binding)
        continue
      }
      if (!specifier.startsWith('.')) continue
      queue.push(resolveSource(file, specifier))
    }
  }

  return {
    files: [...seen].map((file) => relative(REPO_ROOT, file)).sort(),
    cryptoBindings: [...cryptoBindings].sort(),
  }
}

describe('parseTransportConfig', () => {
  it('rejects a config carrying a top-level field the schema never defined', () => {
    // 0003 §1.3의 MUST NOT("정의되지 않은 최상위 필드를 조용히 무시하지 않는다")을
    // 설정 로드에 적용한 자리다. `signingKey`가 걸리는 것은 이름 때문이 아니라
    // 정의되지 않았기 때문이고, 그래서 오타 난 `verificatonKeys`도 같이 걸린다.
    const result = parseTransportConfig({
      verificationKeys: [[KEY_ID, issuer.publicKey]],
      signingKey: issuer.privateKey,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.join('\n')).toContain('signingKey')

    // 같은 파서가 정의된 필드만 담은 설정은 통과시킨다 — 거부가 전면 거부가 아님을 함께 본다.
    expect(parseTransportConfig({ verificationKeys: [[KEY_ID, issuer.publicKey]] }).ok).toBe(true)
  })

  it('rejects a key list with a private KeyObject mixed in', () => {
    // `createVerificationKeySet`(src/transport/token.ts)이 이미 던지는 경로다.
    // 파싱 경계에서 그것이 다른 거부와 같은 모양으로 드러나는지를 본다.
    const result = parseTransportConfig({
      verificationKeys: [
        [KEY_ID, issuer.publicKey],
        ['k-leaked', issuer.privateKey],
      ],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.join('\n')).toContain('k-leaked')
  })
})

describe('전송 엔트리 트립와이어 (tripwire — 불변식의 증명이 아니다)', () => {
  it('tripwire: no signing symbol is reachable from the transport entry import graph', () => {
    const graph = walk(TRANSPORT_ENTRY)

    // 훑기가 실제로 그래프를 걸었는지부터 본다 — 0개를 훑고 초록이 되는 트립와이어는
    // 게이트가 아니라 장식이다.
    expect(graph.files).toContain('src/transport/server.ts')
    expect(graph.files).toContain('src/transport/token.ts')
    expect(graph.files).toContain('src/errors.ts')

    // `node:crypto` import를 읽어내고 있다는 것도 본다 (전송 게이트는 `verify`를 쓴다).
    expect(graph.cryptoBindings).toContain('verify')

    for (const binding of SIGNING_BINDINGS) {
      expect(graph.cryptoBindings).not.toContain(binding)
    }
    // 네임스페이스·기본 import는 이름을 감춘 채 같은 능력을 준다.
    expect(graph.cryptoBindings).not.toContain('*')

    // 비어 있지 않은 검사임을 같은 자리에서 증명한다: 발급자 흉내(test/workspace-token.ts)를
    // 시작점으로 두면 같은 훑기가 두 심볼을 그대로 잡아낸다.
    const issuerGraph = walk(ISSUER_HELPER)
    for (const binding of SIGNING_BINDINGS) {
      expect(issuerGraph.cryptoBindings).toContain(binding)
    }

    // 정적 이름만 보는 트립와이어는 두 갈래로 새어 나간다 — 접두 없는 `crypto`와
    // 동적 import. 둘을 실제로 잡는지를 여기서 함께 못박는다 (파일 하나를 그렇게
    // 고쳐 두고 초록을 보는 것이 이 게이트의 유일한 실패 모드다).
    expect(isCrypto('crypto')).toBe(true)
    expect(DYNAMIC_CRYPTO.test("const { sign } = await import('crypto')")).toBe(true)
    DYNAMIC_CRYPTO.lastIndex = 0
    expect(DYNAMIC_CRYPTO.test("await import('node:crypto')")).toBe(true)
    DYNAMIC_CRYPTO.lastIndex = 0
  })
})
