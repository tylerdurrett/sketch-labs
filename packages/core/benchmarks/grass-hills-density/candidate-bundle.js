import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const studioRequire = createRequire(
  new URL('../../../../apps/studio/package.json', import.meta.url),
)
const VITE_CLI = join(
  dirname(studioRequire.resolve('vite/package.json')),
  'bin/vite.js',
)
const VITE_CONFIG = fileURLToPath(
  new URL('./candidate.vite.config.js', import.meta.url),
)

/**
 * Bundle one benchmark candidate and all non-Node imports into a plain ESM file.
 * This runs in the orchestration process, before a measured worker is started.
 */
export async function bundleCandidate({ entryPath, outputPath }) {
  const entry = resolve(entryPath)
  const output = resolve(outputPath)
  if (!existsSync(entry)) {
    throw new Error(`candidate entry does not exist: ${entry}`)
  }
  if (entry === output) throw new Error('candidate output must differ from entry')
  if (!output.endsWith('.mjs')) {
    throw new Error('candidate output must use the .mjs extension')
  }

  await mkdir(dirname(output), { recursive: true })
  await execFileAsync(
    process.execPath,
    [VITE_CLI, 'build', '--config', VITE_CONFIG],
    {
      cwd: dirname(entry),
      env: {
        ...process.env,
        GRASS_HILLS_CANDIDATE_ENTRY: entry,
        GRASS_HILLS_CANDIDATE_OUTPUT: output,
      },
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  if (!existsSync(output)) {
    throw new Error(`candidate bundle was not produced: ${output}`)
  }
  return output
}
