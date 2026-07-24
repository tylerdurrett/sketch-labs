import { fileURLToPath } from 'node:url'

export default {
  root: fileURLToPath(new URL('.', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    // Named functions make the optional CDP sampling profile actionable.
    // Ordinary timing runs stay minified production bundles.
    minify:
      process.env.FLOWING_CONTOURS_PROFILE === '1' ? false : 'esbuild',
  },
  server: {
    host: '127.0.0.1',
    port: 4318,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4318,
    strictPort: true,
  },
}
