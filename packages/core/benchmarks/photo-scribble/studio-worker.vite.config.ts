import { resolve } from 'node:path'

import studioConfig from '../../../../apps/studio/vite.config.ts'

export default {
  ...studioConfig,
  root: resolve(import.meta.dirname, '../../../../apps/studio'),
  build: {
    ...studioConfig.build,
    outDir: resolve(
      import.meta.dirname,
      '../../../../.tmp/photo-scribble-evidence-dist',
    ),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(
        import.meta.dirname,
        '../../../../apps/studio/photo-scribble-evidence.html',
      ),
    },
  },
  resolve: {
    ...studioConfig.resolve,
    alias: {
      ...studioConfig.resolve?.alias,
      '@harness/core': new URL('../../src/index.ts', import.meta.url).pathname,
    },
  },
}
