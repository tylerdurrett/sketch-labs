import studioConfig from '../../../../apps/studio/vite.config.ts'

const outDir = process.env.FLOWING_CONTOURS_WORKER_STUDIO_OUT
if (outDir === undefined || outDir === '') {
  throw new Error('FLOWING_CONTOURS_WORKER_STUDIO_OUT is required')
}

/**
 * Build the real Studio against this checkout. The explicit alias prevents a
 * worktree borrowing a locked install from following that install's workspace
 * symlink back to another checkout.
 */
export default {
  ...studioConfig,
  resolve: {
    ...studioConfig.resolve,
    alias: {
      ...studioConfig.resolve?.alias,
      '@harness/core': new URL('../../src/index.ts', import.meta.url).pathname,
    },
  },
  build: {
    ...studioConfig.build,
    outDir,
    emptyOutDir: true,
    minify: 'esbuild',
  },
}
