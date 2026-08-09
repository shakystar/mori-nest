/**
 * `.ts` 소스끼리의 `.js` 지정자를 소스 파일로 되돌리는 ESM resolve 훅.
 *
 * `src/**`의 상대 import는 **빌드 산출물 기준**이다(`./errors.js`) — `tsc`가 그대로 내보내야
 * `dist/`에서 해석되기 때문이다. vitest 안에서는 Vite 리졸버가 그것을 `.ts`로 되돌려 주므로
 * 이 간극이 보이지 않지만, `node`가 소스를 직접 띄우면(타입 스트리핑) 그 되돌림이 없어
 * `ERR_MODULE_NOT_FOUND`가 난다.
 *
 * 그래서 **별도 프로세스에서 서버를 소스 그대로 띄우는 자식**
 * (`control-server-race-child.mjs`)만 이 훅을 등록한다. 적용 범위를 좁게 잡는다: 상대
 * 지정자이고, `.js`로 끝나고, 같은 자리에 `.ts` 파일이 실제로 있을 때만 바꾼다.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL !== undefined) {
    const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL)
    if (existsSync(fileURLToPath(candidate))) {
      return nextResolve(candidate.href, context)
    }
  }
  return nextResolve(specifier, context)
}
