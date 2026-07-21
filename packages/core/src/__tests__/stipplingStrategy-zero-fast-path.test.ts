import { describe, expect, it, vi } from 'vitest'

const capture = vi.hoisted(() => ({
  refinedMarks: null as readonly unknown[] | null,
}))

vi.mock('../stipplingStrategy/refinement', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../stipplingStrategy/refinement')
  >()
  return {
    ...actual,
    refineStipples: (
      ...args: Parameters<typeof actual.refineStipples>
    ) => {
      const result = actual.refineStipples(...args)
      capture.refinedMarks = result.marks
      return result
    },
  }
})

import { createRandom } from '../random'
import { createShadingMask, createToneField } from '../shadingFields'
import { resolveProductionStipplingExecutionLimits } from '../stipplingStrategy'
import { createStipplingModel } from '../stipplingStrategy/model'
import { runStipplingOrchestrator } from '../stipplingStrategy/orchestrator'

describe('Stippling zero-relaxation structural fast path', () => {
  it('retains the exact post-refinement marks reference and never constructs relaxation', () => {
    const model = createStipplingModel(
      {
        toneField: createToneField(([x]) => (x < 60 ? 0.9 : 0.2)),
        shadingMask: createShadingMask(() => 1),
      },
      { width: 100, height: 100 },
      {
        stippleDensity: 0.25,
        distributionFidelity: 0.05,
        voronoiRelaxation: 0,
      },
    )
    expect(
      resolveProductionStipplingExecutionLimits(model)
        .maxRelaxationWorkUnits,
    ).toBe(0)
    let factoryInvocations = 0
    const outcome = runStipplingOrchestrator(
      {
        model,
        rng: createRandom('zero-reference-probe'),
        limits: {
          maxStipples: 1_000,
          maxPlacementAttempts: 100_000,
          maxRefinementAttempts: 10_000,
          maxRelaxationPasses: 8,
          maxRelaxationWorkUnits: Number.MAX_SAFE_INTEGER,
        },
      },
      () => {
        factoryInvocations++
        throw new Error('zero relaxation must not enter its factory')
      },
    )

    expect(capture.refinedMarks).not.toBeNull()
    expect(outcome.marks).toBe(capture.refinedMarks)
    expect(factoryInvocations).toBe(0)
    expect(outcome).not.toHaveProperty('relaxation')
  })
})
