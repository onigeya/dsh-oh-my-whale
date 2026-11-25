import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // e2e boots a real dsh session and is opt-in; the file self-skips.
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // The built output and the scripts are checked by other gates; coverage is
      // about the plugin's own behaviour.
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      // Epic 2 DoD: 行 ≥80%、分支 ≥70%（用户 2026-11-23 确认）。
      thresholds: {
        lines: 80,
        branches: 70,
      },
    },
  },
})
