import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `include`를 좁히지 않는다. `test/**`로 한정하면 나중에 `src/` 옆에 놓인 테스트가
    // 조용히 안 돌고 CI는 그대로 초록이 된다 — 게이트가 있는데 대상이 빠지는 쪽이
    // 게이트가 없는 것보다 나쁘다. 기본 include는 `dist/`·`node_modules/`를 제외한다.
    //
    // 테스트 파일이 0건이면 vitest는 exit 1이다 (`passWithNoTests` 기본 false).
    // 이 기본값에 기대고 있으므로 켜지 않는다.
    environment: 'node',
  },
})
