import { describe, expect, it } from 'vitest'

import {
  FULL_CASES,
  PHASES,
  mergeRawArtifacts,
  resolveRunConfig,
  summarizeRaw,
} from './protocol.js'
import { PREREGISTERED_PINS } from './pins.js'
import { runBenchmarkCampaign } from './campaign.js'

function artifact({ input, samples = [] } = {}) {
  const config = resolveRunConfig({ mode: 'smoke', ...input })
  return {
    environment: { node: 'test', sourceCommit: 'abc' },
    config,
    samples,
  }
}

function completedSamples(config) {
  return config.selectedExpectedSampleIds.map((id) => {
    const [caseId, phase, sampleIndex] = id.split('/')
    return {
      id,
      caseId,
      phase,
      sampleIndex: Number(sampleIndex),
      elapsedMs: 1,
      status: 'ok',
    }
  })
}

describe('Stippling relaxation benchmark protocol', () => {
  it('pins the full cartesian matrix and preregistered smoke subset', () => {
    expect(FULL_CASES).toHaveLength(27)
    const smoke = resolveRunConfig({ mode: 'smoke' })
    expect(smoke).toMatchObject({ warmups: 1, samples: 3 })
    expect(smoke.cases.map(({ id }) => id)).toEqual([
      'flat:density=1:relaxation=0',
      'ramp:density=100:relaxation=0.5',
    ])
    expect(smoke.phases).toEqual(PHASES)
    expect(Object.keys(PREREGISTERED_PINS).sort()).toEqual(
      smoke.cases.map(({ id }) => id).sort(),
    )
  })

  it('validates override caps and applies filters before stable sharding', () => {
    expect(() => resolveRunConfig({ samples: 26 })).toThrow('[1, 25]')
    expect(() => resolveRunConfig({ warmups: 11 })).toThrow('[0, 10]')
    const first = resolveRunConfig({
      mode: 'full',
      confirmFull: true,
      target: 'flat',
      shardCount: 2,
      shardIndex: 0,
    })
    const second = resolveRunConfig({
      mode: 'full',
      confirmFull: true,
      target: 'flat',
      shardCount: 2,
      shardIndex: 1,
    })
    expect([...first.cases, ...second.cases].map(({ id }) => id).sort()).toEqual(
      FULL_CASES.filter(({ target }) => target === 'flat')
        .map(({ id }) => id)
        .sort(),
    )
    expect(
      first.cases.filter(({ id }) =>
        second.cases.some((candidate) => candidate.id === id),
      ),
    ).toEqual([])
    expect(first.campaign.caseIds).toEqual(FULL_CASES.map(({ id }) => id))
    expect(first.selectedExpectedSampleIds).not.toEqual(
      first.campaignExpectedSampleIds,
    )
  })

  it('accepts partial and repeated artifacts, dedupes IDs, and reports missing work', () => {
    const sample = {
      id: 'flat:density=1:relaxation=0/placement/0',
      caseId: 'flat:density=1:relaxation=0',
      phase: 'placement',
      sampleIndex: 0,
      elapsedMs: 1,
      status: 'ok',
    }
    const first = artifact({ samples: [sample] })
    const repeated = artifact({ samples: [{ ...sample, elapsedMs: 2 }] })
    const merged = mergeRawArtifacts([first, repeated])
    expect(merged.samples).toEqual([sample])
    expect(merged.missingSampleIds).not.toHaveLength(0)
    expect(summarizeRaw(merged).completedSamples).toBe(1)
    expect(merged.config.selection).toBeNull()
    expect(merged.config.campaign).toEqual(first.config.campaign)
  })

  it('derives missing work from the canonical campaign when a shard is absent', () => {
    const firstConfig = resolveRunConfig({
      mode: 'smoke',
      samples: 1,
      shardCount: 2,
      shardIndex: 0,
    })
    const first = {
      environment: { node: 'test', sourceCommit: 'abc' },
      config: firstConfig,
      samples: completedSamples(firstConfig),
    }
    const merged = mergeRawArtifacts([first])
    expect(merged.missingSampleIds).toHaveLength(
      firstConfig.campaignExpectedSampleIds.length -
        firstConfig.selectedExpectedSampleIds.length,
    )
    expect(merged.missingSampleIds[0]).toContain(
      resolveRunConfig({
        mode: 'smoke', samples: 1, shardCount: 2, shardIndex: 1,
      }).cases[0].id,
    )
  })

  it('allows cross-shard aggregation but rejects cross-shard output reuse', () => {
    const configs = [0, 1].map((shardIndex) =>
      resolveRunConfig({
        mode: 'smoke',
        samples: 1,
        shardCount: 2,
        shardIndex,
      }),
    )
    const environment = { node: 'test', sourceCommit: 'abc' }
    const artifacts = configs.map((config) => ({
      environment,
      config,
      samples: completedSamples(config),
    }))
    expect(mergeRawArtifacts(artifacts).missingSampleIds).toEqual([])
    expect(() =>
      runBenchmarkCampaign({
        config: configs[1],
        environment,
        previous: artifacts[0],
        runCase: () => [],
        checkpoint: () => {},
      }),
    ).toThrow('exact run')
  })

  it('checkpoints completed cases and resumes after a later case crashes', () => {
    const config = resolveRunConfig({
      mode: 'smoke',
      samples: 1,
      warmups: 0,
      phase: 'placement',
    })
    const environment = { node: 'test', sourceCommit: 'abc' }
    const checkpoints = []
    let calls = 0
    expect(() =>
      runBenchmarkCampaign({
        config,
        environment,
        runCase: (benchmarkCase) => {
          calls++
          if (calls === 2) throw new Error('simulated crash')
          return completedSamples({
            selectedExpectedSampleIds: config.selectedExpectedSampleIds.filter(
              (id) => id.startsWith(`${benchmarkCase.id}/`),
            ),
          })
        },
        checkpoint: (raw) => checkpoints.push(raw),
      }),
    ).toThrow('simulated crash')
    expect(checkpoints.at(-1).samples).toHaveLength(1)

    const resumedCases = []
    const resumed = runBenchmarkCampaign({
      config,
      environment,
      previous: checkpoints.at(-1),
      runCase: (benchmarkCase) => {
        resumedCases.push(benchmarkCase.id)
        return completedSamples({
          selectedExpectedSampleIds: config.selectedExpectedSampleIds.filter(
            (id) => id.startsWith(`${benchmarkCase.id}/`),
          ),
        })
      },
      checkpoint: () => {},
    })
    expect(resumedCases).toEqual([config.cases[1].id])
    expect(resumed.samples).toHaveLength(2)
  })

  it('rejects incompatible environment or campaign configuration', () => {
    const first = artifact()
    expect(() =>
      mergeRawArtifacts([
        first,
        {
          ...first,
          environment: { node: 'different', sourceCommit: 'abc' },
        },
      ]),
    ).toThrow('incompatible')
    expect(() =>
      mergeRawArtifacts([
        first,
        artifact({ input: { samples: 2 } }),
      ]),
    ).toThrow('incompatible')
  })
})
