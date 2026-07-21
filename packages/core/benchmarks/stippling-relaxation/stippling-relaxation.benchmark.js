import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { environmentFingerprint } from './artifacts.js'
import {
  atomicWriteRawArtifact,
  runBenchmarkCampaign,
} from './campaign.js'
import { runBenchmarkCase } from './harness.js'
import { resolveRunConfig, summarizeRaw } from './protocol.js'

function inputFromEnvironment() {
  return JSON.parse(process.env.STIPPLING_RELAXATION_BENCH_CONFIG ?? '{}')
}

describe('opt-in Stippling relaxation benchmark', () => {
  it('writes deterministic resumable phase samples', () => {
    const config = resolveRunConfig(inputFromEnvironment())
    const outputPath = resolve(
      process.env.STIPPLING_RELAXATION_BENCH_OUTPUT ??
        `/tmp/stippling-relaxation-${config.mode}-shard-${config.shardIndex}.raw.json`,
    )
    const previous = existsSync(outputPath)
      ? JSON.parse(readFileSync(outputPath, 'utf8'))
      : undefined
    const environment = environmentFingerprint()
    const raw = runBenchmarkCampaign({
      config,
      environment,
      previous,
      runCase: runBenchmarkCase,
      checkpoint: (artifact) => atomicWriteRawArtifact(outputPath, artifact),
    })
    const summary = summarizeRaw({
      ...raw,
      missingSampleIds: config.selectedExpectedSampleIds.filter(
        (id) => !raw.samples.some((sample) => sample.id === id),
      ),
    })
    console.log(
      `\nStippling relaxation benchmark\nraw ${outputPath}\n${JSON.stringify(summary, null, 2)}`,
    )
    expect(raw.samples.length).toBeGreaterThan(0)
  })
})
