import { pathToFileURL } from 'node:url'

import { bundleCandidate } from './candidate-bundle.js'

export function parseBundleArgs(argv) {
  let entryPath
  let outputPath
  for (const argument of argv) {
    if (argument.startsWith('--entry=')) entryPath = argument.slice(8)
    else if (argument.startsWith('--out=')) outputPath = argument.slice(6)
    else throw new Error(`unknown candidate bundle argument ${argument}`)
  }
  if (!entryPath) throw new Error('--entry=<candidate module> is required')
  if (!outputPath) throw new Error('--out=<plain .mjs artifact> is required')
  return { entryPath, outputPath }
}

export async function runBundleCli(argv) {
  const output = await bundleCandidate(parseBundleArgs(argv))
  process.stdout.write(`${output}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runBundleCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  })
}
