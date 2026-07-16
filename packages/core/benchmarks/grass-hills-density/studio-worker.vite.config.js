import studioConfig from '../../../../apps/studio/vite.config.ts'

/**
 * The evidence page is a Studio entry point. Pin the workspace package alias to
 * this checkout so a worktree borrowing an existing locked install cannot
 * accidentally follow that install's relative @harness/core symlink elsewhere.
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
}
