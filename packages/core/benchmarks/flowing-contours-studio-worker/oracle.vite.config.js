const outDir = process.env.FLOWING_CONTOURS_WORKER_ORACLE_OUT
if (outDir === undefined || outDir === '') {
  throw new Error('FLOWING_CONTOURS_WORKER_ORACLE_OUT is required')
}

export default {
  root: new URL('./oracle', import.meta.url).pathname,
  base: '/__flowing-contours-worker-oracle/',
  build: {
    outDir,
    emptyOutDir: true,
    minify: 'esbuild',
  },
}
