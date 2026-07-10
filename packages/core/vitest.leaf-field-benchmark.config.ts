import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['benchmarks/leaf-field.benchmark.js'],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 120_000,
  },
})
