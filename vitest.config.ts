import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // e2e boots a real dsh session and is opt-in; the file self-skips.
    passWithNoTests: false,
  },
})
