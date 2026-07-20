import { describe, expect, it } from 'vitest'

import { createShadingDiagnostics } from '../sketch'
import type { ShadingResult } from '../shadingStrategy'

const result: ShadingResult = {
  polylines: [
    [
      [0, 0],
      [3, 4],
    ],
    [
      [3, 4],
      [3, 6],
    ],
  ],
  termination: 'budget-exhausted',
}

describe('createShadingDiagnostics', () => {
  it('preserves the existing Scribble fidelity diagnostic', () => {
    expect(
      createShadingDiagnostics(result, {
        kind: 'scribble',
        residualError: 0.25,
      }),
    ).toEqual({
      termination: 'budget-exhausted',
      pathLength: 7,
      polylineCount: 2,
      penLiftCount: 1,
      fidelity: { kind: 'scribble', residualError: 0.25 },
    })
  })

  it('carries an immutable Stippling distribution diagnostic', () => {
    const diagnostics = createShadingDiagnostics(result, {
      kind: 'stippling',
      distributionError: 1.25,
    })

    expect(diagnostics).toEqual({
      termination: 'budget-exhausted',
      pathLength: 7,
      polylineCount: 2,
      penLiftCount: 1,
      fidelity: { kind: 'stippling', distributionError: 1.25 },
    })
    expect(Object.isFrozen(diagnostics)).toBe(true)
    expect(Object.isFrozen(diagnostics.fidelity)).toBe(true)
  })
})
