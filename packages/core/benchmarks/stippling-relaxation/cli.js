import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { mergeRawArtifacts, summarizeRaw } from './protocol.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CONFIG_PATH = fileURLToPath(
  new URL(
    '../../vitest.stippling-relaxation-benchmark.config.ts',
    import.meta.url,
  ),
)

function runArguments(argv) {
  const input = {}
  let output
  for (const argument of argv) {
    if (argument === '--confirm-full') input.confirmFull = true
    else if (argument.startsWith('--output=')) output = argument.slice(9)
    else {
      const match =
        /^--(mode|warmups|samples|target|density|relaxation|phase|case-id|shard-index|shard-count)=(.+)$/.exec(
          argument,
        )
      if (match === null) throw new Error(`unknown run argument ${argument}`)
      const names = {
        mode: 'mode',
        warmups: 'warmups',
        samples: 'samples',
        target: 'target',
        density: 'density',
        relaxation: 'relaxation',
        phase: 'phase',
        'case-id': 'caseId',
        'shard-index': 'shardIndex',
        'shard-count': 'shardCount',
      }
      input[names[match[1]]] = match[2]
    }
  }
  return { input, output }
}

function run(argv) {
  const { input, output } = runArguments(argv)
  const executable = fileURLToPath(
    new URL('../../node_modules/.bin/vitest', import.meta.url),
  )
  const child = spawnSync(executable, ['run', '--config', CONFIG_PATH], {
    cwd: PACKAGE_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      STIPPLING_RELAXATION_BENCH_CONFIG: JSON.stringify(input),
      ...(output === undefined
        ? {}
        : { STIPPLING_RELAXATION_BENCH_OUTPUT: output }),
    },
  })
  if (child.error) throw child.error
  if (child.status !== 0) process.exitCode = child.status ?? 1
}

function aggregate(argv) {
  let output
  const paths = []
  for (const argument of argv) {
    if (argument.startsWith('--output=')) output = argument.slice(9)
    else if (argument.startsWith('--')) {
      throw new Error(`unknown aggregate argument ${argument}`)
    }
    else paths.push(argument)
  }
  if (paths.length === 0) {
    throw new Error('aggregate requires one or more raw JSON paths')
  }
  const merged = mergeRawArtifacts(
    paths.map((path) => JSON.parse(readFileSync(path, 'utf8'))),
  )
  if (output !== undefined) {
    writeFileSync(output, `${JSON.stringify(merged, null, 2)}\n`)
  }
  process.stdout.write(`${JSON.stringify(summarizeRaw(merged), null, 2)}\n`)
}

const [command, ...argv] = process.argv.slice(2)
try {
  if (command === 'run') run(argv)
  else if (command === 'aggregate') aggregate(argv)
  else {
    throw new Error(
      'usage: cli.js run [options] | aggregate <raw...> [--output=path]',
    )
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
