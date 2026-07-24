import { describe, expect, it, vi } from 'vitest'

import type { fitFlowingContoursCurve } from '../sketches/flowing-contours/curves'
import { runFlowingContoursPipeline } from '../sketches/flowing-contours/pipeline'
import type { FlowingContoursField } from '../sketches/flowing-contours/types'

type FitCurve = typeof fitFlowingContoursCurve
type ProvisionalFit = (
  actual: FitCurve,
  ...args: Parameters<FitCurve>
) => ReturnType<FitCurve>

const fitting = vi.hoisted(() => ({
  provisional: vi.fn<ProvisionalFit>(),
}))

vi.mock(
  '../sketches/flowing-contours/curves',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../sketches/flowing-contours/curves')
      >()
    return {
      ...actual,
      fitFlowingContoursCurve: (...args: Parameters<FitCurve>) =>
        fitting.provisional(actual.fitFlowingContoursCurve, ...args),
    }
  },
)

function parallelRidges(): Readonly<FlowingContoursField> {
  const width = 32
  const height = 15
  const count = width * height
  const ridgeRows = [5, 10]
  const contourEvidence = Array.from(
    { length: count },
    (_value, index) => {
      const y = Math.floor(index / width)
      const distance = Math.min(
        ...ridgeRows.map((ridge) => Math.abs(y - ridge)),
      )
      return Math.exp(-(distance * distance) / (2 * 0.55 * 0.55))
    },
  )
  return Object.freeze({
    sourceWidth: width,
    sourceHeight: height,
    width,
    height,
    luminance: Object.freeze(new Array<number>(count).fill(0.5)),
    alpha: Object.freeze(new Array<number>(count).fill(1)),
    positiveSupport: Object.freeze(new Array<boolean>(count).fill(true)),
    contourEvidence: Object.freeze(contourEvidence),
    tangentX: Object.freeze(new Array<number>(count).fill(1)),
    tangentY: Object.freeze(new Array<number>(count).fill(0)),
    tangentCoherence: Object.freeze(new Array<number>(count).fill(1)),
    ambiguity: Object.freeze(new Array<number>(count).fill(0)),
    ridgeScale: Object.freeze(new Array<number>(count).fill(1)),
  })
}

describe('Flowing Contours provisional fitting', () => {
  it('rejects one unfittable candidate without blanking later valid curves', () => {
    let fitAttempt = 0
    fitting.provisional.mockImplementation((actual, ...args) => {
      fitAttempt += 1
      if (fitAttempt === 1) {
        return Object.freeze({
          status: 'invalid-input',
          curve: null,
          fittedPointCount: 0,
          workCount: 1,
        })
      }
      return actual(...args)
    })

    const output = runFlowingContoursPipeline(parallelRidges(), {
      curveDetail: 1,
      continuity: 0.45,
      flowSmoothing: 0.7,
      minimumStrokeLength: 0.02,
    })

    expect(fitAttempt).toBeGreaterThan(1)
    expect(output.diagnostics.termination).toBe('complete')
    expect(output.acceptedTrajectories.length).toBeGreaterThan(0)
    expect(output.fittedCurves).toHaveLength(
      output.acceptedTrajectories.length,
    )
    expect(output.diagnostics.acceptedCandidateCount).toBe(
      output.acceptedTrajectories.length,
    )
    expect(output.diagnostics.primitiveCount).toBe(
      output.fittedCurves.length,
    )
  })
})
