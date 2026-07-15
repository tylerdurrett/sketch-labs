import { describe, expect, it } from 'vitest'

import { parseCampaignArgs } from './cli.js'
import {
  LONG_CAMPAIGN_CONFIRMATION,
  MODE_POLICIES,
  censoredResult,
  validateCampaignRequest,
} from './protocol.js'
import { runCampaign } from './runner.js'

const OK_CANDIDATE_URL = `data:text/javascript,${encodeURIComponent(`
  export const benchmarkCandidate = {
    id: 'test-linear',
    complexity: 'linear',
    prepare(payload) {
      const base = payload.base
      return (t) => [base + t, base]
    },
    generate(payload, t) { return [payload.base + t, payload.base] },
    guard(result) { return result[0] + result[1] },
    inspect({ phase, value, payload }) {
      const resolved = typeof value === 'function' ? value(0) : value
      return { phase, base: payload.base, pointCount: resolved.length }
    },
  }
`)}`

function job(overrides = {}) {
  return {
    candidate: {
      id: 'test-linear',
      moduleUrl: OK_CANDIDATE_URL,
      complexity: 'linear',
      ...overrides.candidate,
    },
    fixture: {
      id: 'tiny-fixture',
      scale: 'tiny',
      payload: { base: 2 },
      ...overrides.fixture,
    },
  }
}

describe('Grass Hills density campaign protocol', () => {
  it('keeps smoke as the bounded default and pins every mode policy', () => {
    const campaign = validateCampaignRequest({ jobs: [job()] })

    expect(campaign.mode).toBe('smoke')
    expect(campaign.policy).toEqual({
      timeoutMs: 30_000,
      memoryMiB: 1_024,
      samples: { preparation: 1, cold: 1, warm: 1, warmups: 0 },
    })
    expect(MODE_POLICIES.screen).toEqual({
      timeoutMs: 90_000,
      memoryMiB: 1_024,
      samples: { preparation: 3, cold: 3, warm: 12, warmups: 1 },
    })
    expect(MODE_POLICIES.full).toEqual(MODE_POLICIES.adopted)
    expect(MODE_POLICIES.full).toEqual({
      timeoutMs: 600_000,
      memoryMiB: 2_048,
      samples: { preparation: 20, cold: 20, warm: 60, warmups: 3 },
    })
  })

  it('requires deliberate long-mode confirmation', () => {
    expect(() =>
      validateCampaignRequest({ mode: 'full', jobs: [job()] }),
    ).toThrow(/requires confirmation/)
    expect(
      validateCampaignRequest({
        mode: 'full',
        jobs: [job()],
        confirmation: LONG_CAMPAIGN_CONFIRMATION,
      }).mode,
    ).toBe('full')
    expect(() =>
      parseCampaignArgs(['--mode=adopted', '--config=x.js']),
    ).toThrow(/confirm-long-campaign/)
  })

  it('confines the legacy quadratic control to baseline and tiny fixtures', () => {
    const legacy = { id: 'legacy', complexity: 'legacy-quadratic' }
    expect(() =>
      validateCampaignRequest({
        jobs: [
          job({
            candidate: legacy,
            fixture: { id: 'dense', scale: 'dense' },
          }),
        ],
      }),
    ).toThrow(/restricted to baseline\/tiny/)
    expect(
      validateCampaignRequest({
        jobs: [job({ candidate: legacy })],
      }).jobs[0].fixture.scale,
    ).toBe('tiny')
  })

  it('runs one successful smoke child with separate measurement slots', async () => {
    const campaign = await runCampaign({
      jobs: [
        job(),
        job({ fixture: { id: 'second-fixture' } }),
      ],
    })
    const [result, secondResult] = campaign.results

    expect(result.status).toBe('ok')
    expect(result.candidateId).toBe('test-linear')
    expect(result.fixtureId).toBe('tiny-fixture')
    expect(result.phases.preparation.samples).toHaveLength(1)
    expect(result.phases.cold.samples).toHaveLength(1)
    expect(result.phases.warm.samples).toHaveLength(1)
    expect(result.phases.preparation.samples[0].metrics).toEqual({
      phase: 'preparation',
      base: 2,
      pointCount: 2,
    })
    expect(result.phases.cold.samples[0].metrics.phase).toBe('cold')
    expect(result.phases.warm.samples[0].metrics.phase).toBe('warm')
    expect(secondResult.status).toBe('ok')
    expect(secondResult.runtime.pid).not.toBe(result.runtime.pid)
    for (const phase of Object.values(result.phases)) {
      const sample = phase.samples[0]
      expect(sample.durationMs).toBeGreaterThanOrEqual(0)
      expect(sample.memory.before.heapUsedBytes).toBeGreaterThan(0)
      expect(sample.memory.after.rssBytes).toBeGreaterThan(0)
      expect(sample.memory.after.maxRssBytes).toBeGreaterThan(0)
    }
    expect(result.runtime.cpuModel).toEqual(expect.any(String))
    expect(result.runtime.logicalCpuCount).toBeGreaterThan(0)
    expect(result.runtime.totalMemoryBytes).toBeGreaterThan(0)
  })

  it('inspects only the first measured value in each explicit multi-sample phase', async () => {
    const campaign = await runCampaign({ mode: 'screen', jobs: [job()] })
    const result = campaign.results[0]

    expect(result.phases.preparation.samples).toHaveLength(3)
    expect(result.phases.cold.samples).toHaveLength(3)
    expect(result.phases.warm.samples).toHaveLength(12)
    for (const phase of Object.values(result.phases)) {
      expect(phase.samples[0].metrics).toBeDefined()
      expect(
        phase.samples
          .slice(1)
          .every((sample) => sample.metrics === undefined),
      ).toBe(true)
    }
  })

  it('turns candidate exceptions into structured censored results', async () => {
    const throwingUrl = `data:text/javascript,${encodeURIComponent(`
      export const benchmarkCandidate = {
        id: 'throws', complexity: 'linear',
        prepare() { throw new Error('intentional child failure') },
        generate() { return 1 }, guard(value) { return value },
      }
    `)}`
    const campaign = await runCampaign({
      jobs: [
        job({
          candidate: { id: 'throws', moduleUrl: throwingUrl },
        }),
      ],
    })

    expect(campaign.results[0]).toMatchObject({
      status: 'censored',
      candidateId: 'throws',
      fixtureId: 'tiny-fixture',
      censor: { kind: 'child-error' },
    })
    expect(campaign.results[0].censor.reason).toContain(
      'intentional child failure',
    )
  })

  it('reaps a successful child even when the candidate retains an active handle', async () => {
    const activeHandleUrl = `data:text/javascript,${encodeURIComponent(`
      setInterval(() => {}, 1_000)
      export const benchmarkCandidate = {
        id: 'active-handle', complexity: 'linear',
        prepare(payload) { return (t) => payload.base + t },
        generate(payload, t) { return payload.base + t },
        guard(value) { return value },
      }
    `)}`
    const started = performance.now()
    const campaign = await runCampaign({
      jobs: [
        job({
          candidate: { id: 'active-handle', moduleUrl: activeHandleUrl },
        }),
      ],
    })

    expect(campaign.results[0]).toMatchObject({
      status: 'ok',
      candidateId: 'active-handle',
      fixtureId: 'tiny-fixture',
    })
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  it.each(['timeout', 'oom', 'child-error'])(
    'uses the durable censored schema for %s termination',
    (kind) => {
      expect(
        censoredResult({
          job: job(),
          mode: 'screen',
          policy: MODE_POLICIES.screen,
          kind,
          reason: 'bounded failure',
          elapsedMs: 10,
        }),
      ).toMatchObject({
        status: 'censored',
        mode: 'screen',
        candidateId: 'test-linear',
        fixtureId: 'tiny-fixture',
        censor: { kind, reason: 'bounded failure', elapsedMs: 10 },
      })
    },
  )
})
