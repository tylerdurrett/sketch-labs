import studioConfig from '../../../../apps/studio/vite.config.ts'

export default {
  ...studioConfig,
  resolve: {
    ...studioConfig.resolve,
    alias: {
      ...studioConfig.resolve?.alias,
      '@harness/core': new URL('../../src/index.ts', import.meta.url).pathname,
    },
  },
}
