import { basename, dirname } from 'node:path'

const entry = process.env.GRASS_HILLS_CANDIDATE_ENTRY
const output = process.env.GRASS_HILLS_CANDIDATE_OUTPUT
if (!entry || !output) {
  throw new Error(
    'candidate bundle requires GRASS_HILLS_CANDIDATE_ENTRY and GRASS_HILLS_CANDIDATE_OUTPUT',
  )
}

export default {
  logLevel: 'error',
  build: {
    ssr: entry,
    outDir: dirname(output),
    emptyOutDir: false,
    copyPublicDir: false,
    minify: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        format: 'es',
        entryFileNames: basename(output),
        inlineDynamicImports: true,
      },
    },
  },
  // Candidate bundles must be self-contained. The measured worker should load
  // only this artifact plus Node builtins, not resolve workspace/dependency
  // modules or start a transform service inside the child.
  ssr: { noExternal: true },
}
