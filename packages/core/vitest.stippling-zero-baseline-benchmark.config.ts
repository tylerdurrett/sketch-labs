import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: [
      'benchmarks/stippling-relaxation/zero-baseline.probe.js',
    ],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 3_600_000,
  },
})
