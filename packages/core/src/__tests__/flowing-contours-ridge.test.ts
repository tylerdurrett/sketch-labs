import { describe, expect, it } from 'vitest'

import { sampleFlowingContoursField } from '../sketches/flowing-contours/field'
import { createFlowingContoursTestLimits } from '../sketches/flowing-contours/limits'
import {
  stepFlowingContoursRidge,
  type FlowingRidgeStepOptions,
} from '../sketches/flowing-contours/ridge'
import type {
  CorrectedFlowingRidgeSample,
  FlowingContoursField,
} from '../sketches/flowing-contours/types'
import type { Point } from '../types'

interface FieldValue {
  readonly evidence: number
  readonly tangent: Readonly<Point>
  readonly coherence?: number
  readonly ambiguity?: number
  readonly scale?: number
  readonly alpha?: number
}

function field(
  width: number,
  height: number,
  valueAt: (x: number, y: number) => FieldValue,
): FlowingContoursField {
  const luminance: number[] = []
  const alpha: number[] = []
  const positiveSupport: boolean[] = []
  const contourEvidence: number[] = []
  const tangentX: number[] = []
  const tangentY: number[] = []
  const tangentCoherence: number[] = []
  const ambiguity: number[] = []
  const ridgeScale: number[] = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = valueAt(x, y)
      const sampleAlpha = value.alpha ?? 1
      luminance.push(0.5)
      alpha.push(sampleAlpha)
      positiveSupport.push(sampleAlpha > 0)
      contourEvidence.push(value.evidence)
      tangentX.push(value.tangent[0])
      tangentY.push(value.tangent[1])
      tangentCoherence.push(value.coherence ?? 1)
      ambiguity.push(value.ambiguity ?? 0)
      ridgeScale.push(value.scale ?? 1)
    }
  }
  return Object.freeze({
    sourceWidth: width,
    sourceHeight: height,
    width,
    height,
    luminance: Object.freeze(luminance),
    alpha: Object.freeze(alpha),
    positiveSupport: Object.freeze(positiveSupport),
    contourEvidence: Object.freeze(contourEvidence),
    tangentX: Object.freeze(tangentX),
    tangentY: Object.freeze(tangentY),
    tangentCoherence: Object.freeze(tangentCoherence),
    ambiguity: Object.freeze(ambiguity),
    ridgeScale: Object.freeze(ridgeScale),
  })
}

function gaussian(distance: number, width = 0.7): number {
  return Math.exp(-(distance * distance) / (2 * width * width))
}

function at(
  source: Readonly<FlowingContoursField>,
  point: Readonly<Point>,
): Readonly<CorrectedFlowingRidgeSample> {
  const sample = sampleFlowingContoursField(source, point)
  if (sample === null) throw new Error(`Expected supported sample at ${point}`)
  return sample
}

function corrected(
  result: ReturnType<typeof stepFlowingContoursRidge>,
): Extract<typeof result, { kind: 'corrected' }> {
  expect(result.kind).toBe('corrected')
  if (result.kind !== 'corrected') {
    throw new Error(`Expected corrected result, received ${result.kind}`)
  }
  return result
}

const ONE_PIXEL_STEP = Object.freeze({
  stepLength: 1,
} satisfies FlowingRidgeStepOptions)

describe('Flowing Contours predictor-corrector ridge step', () => {
  it('advances continuously along a straight ridge and sign-aligns its tangent', () => {
    const straight = field(15, 13, (_x, y) => ({
      evidence: gaussian(y - 6),
      tangent: [-1, 0],
    }))
    const result = corrected(
      stepFlowingContoursRidge(
        straight,
        at(straight, [3.25, 6]),
        [1, 0],
        ONE_PIXEL_STEP,
      ),
    )

    expect(result.predictedPoint).toEqual([4.25, 6])
    expect(result.sample.point[0]).toBeCloseTo(4.25, 12)
    expect(result.sample.point[1]).toBeCloseTo(6, 12)
    expect(result.sample.tangent).toEqual([1, -0])
    expect(result.normalSampleCount).toBe(9)
  })

  it('tracks a diagonal ridge without quantizing its prediction to the lattice', () => {
    const diagonal = field(17, 17, (x, y) => ({
      evidence: gaussian((y - x) * Math.SQRT1_2),
      tangent: [Math.SQRT1_2, Math.SQRT1_2],
    }))
    const result = corrected(
      stepFlowingContoursRidge(diagonal, at(diagonal, [4, 4]), [1, 1], {
        stepLength: 0.9,
      }),
    )

    expect(result.predictedPoint[0]).toBeCloseTo(4 + 0.9 * Math.SQRT1_2, 12)
    expect(result.predictedPoint[1]).toBeCloseTo(4 + 0.9 * Math.SQRT1_2, 12)
    expect(result.sample.point[1] - result.sample.point[0]).toBeCloseTo(0, 12)
    expect(result.sample.tangent[0]).toBeCloseTo(Math.SQRT1_2, 12)
    expect(result.sample.tangent[1]).toBeCloseTo(Math.SQRT1_2, 12)
  })

  it('follows a smooth curved ridge with a subpixel normal correction', () => {
    const center = [9, 9] as const
    const radius = 5
    const arc = field(19, 19, (x, y) => {
      const dx = x - center[0]
      const dy = y - center[1]
      const distance = Math.hypot(dx, dy)
      const inverse = distance > 0 ? 1 / distance : 0
      return {
        evidence: gaussian(distance - radius, 0.8),
        tangent: [-dy * inverse, dx * inverse],
      }
    })
    const result = corrected(
      stepFlowingContoursRidge(arc, at(arc, [14, 9]), [0, 1], ONE_PIXEL_STEP),
    )

    expect(result.predictedPoint).toEqual([14, 10])
    expect(result.sample.point[0]).toBeLessThan(14)
    expect(
      Math.abs(
        Math.hypot(
          result.sample.point[0] - center[0],
          result.sample.point[1] - center[1],
        ) - radius,
      ),
    ).toBeLessThan(0.12)
    expect(result.sample.tangent[1]).toBeGreaterThan(0.95)
  })

  it('corrects a deliberate normal prediction offset back to the same ridge', () => {
    const straight = field(15, 13, (_x, y) => ({
      evidence: gaussian(y - 6, 0.6),
      tangent: [1, 0],
    }))
    const result = corrected(
      stepFlowingContoursRidge(
        straight,
        at(straight, [3, 5.55]),
        [1, 0],
        ONE_PIXEL_STEP,
      ),
    )

    expect(result.predictedPoint).toEqual([4, 5.55])
    expect(result.sample.point[1]).toBeCloseTo(6, 1)
    expect(result.sample.point[0]).toBe(4)
  })

  it('accepts adjacent coherent scales and rejects larger scale jumps', () => {
    const transition = (nextScale: number) =>
      field(12, 11, (x, y) => ({
        evidence: gaussian(y - 5),
        tangent: [1, 0],
        scale: x < 5 ? 1 : nextScale,
      }))

    const adjacent = transition(2)
    const largeJump = transition(4)

    expect(
      stepFlowingContoursRidge(
        adjacent,
        at(adjacent, [4, 5]),
        [1, 0],
        ONE_PIXEL_STEP,
      ).kind,
    ).toBe('corrected')
    expect(
      stepFlowingContoursRidge(
        largeJump,
        at(largeJump, [4, 5]),
        [1, 0],
        ONE_PIXEL_STEP,
      ).kind,
    ).toBe('weak')
  })

  it('classifies an excessive tangent turn as curvature', () => {
    const sharpTurn = (70 * Math.PI) / 180
    const corner = field(12, 11, (x, y) => ({
      evidence: gaussian(y - 5),
      tangent: x < 5 ? [1, 0] : [Math.cos(sharpTurn), Math.sin(sharpTurn)],
    }))

    expect(
      stepFlowingContoursRidge(
        corner,
        at(corner, [4, 5]),
        [1, 0],
        ONE_PIXEL_STEP,
      ).kind,
    ).toBe('curvature')
  })

  it('stops at two close parallel maxima within the ambiguity margin', () => {
    const parallels = field(15, 15, (_x, y) => ({
      evidence: Math.max(gaussian(y - 6, 0.35), gaussian(y - 8, 0.35)),
      tangent: [1, 0],
      scale: 3,
    }))

    expect(
      stepFlowingContoursRidge(parallels, at(parallels, [4, 6]), [1, 0], {
        ...ONE_PIXEL_STEP,
        ambiguityMargin: 0.3,
      }).kind,
    ).toBe('ambiguity')
  })

  it('never hops from a weakening ridge to its stronger parallel neighbor', () => {
    const parallels = field(15, 15, (x, y) => {
      const weakening = (x < 5 ? 0.85 : 0.35) * gaussian(y - 6, 0.28)
      const stronger = 0.95 * gaussian(y - 8, 0.28)
      return {
        evidence: Math.max(weakening, stronger),
        tangent: [1, 0],
        scale: 3,
      }
    })
    const result = stepFlowingContoursRidge(
      parallels,
      at(parallels, [4, 6]),
      [1, 0],
      { ...ONE_PIXEL_STEP, ambiguityMargin: 0.02 },
    )

    expect(result.kind).toBe('ambiguity')
    expect(result.kind === 'corrected' ? result.sample.point[1] : 6).toBe(6)

    const vanished = field(15, 15, (x, y) => ({
      evidence:
        x < 5 ? 0.85 * gaussian(y - 6, 0.28) : 0.95 * gaussian(y - 7, 0.28),
      tangent: [1, 0],
      scale: 3,
    }))
    const loneNeighbor = stepFlowingContoursRidge(
      vanished,
      at(vanished, [4, 6]),
      [1, 0],
      ONE_PIXEL_STEP,
    )

    expect(loneNeighbor.kind).toBe('weak')
  })

  it('rejects an outward parabolic refinement beyond the ownership tube', () => {
    const ridge = field(12, 12, (_x, y) => ({
      evidence: y === 6 ? 1 : 0,
      tangent: [1, 0],
    }))
    const limits = createFlowingContoursTestLimits({
      'normal-search-sample-count': 5,
    })
    expect(limits).not.toBeNull()

    const result = stepFlowingContoursRidge(
      ridge,
      at(ridge, [4, 5.45]),
      [1, 0],
      ONE_PIXEL_STEP,
      limits!,
    )

    expect(result.kind).toBe('weak')
  })

  it('classifies source and exact alpha boundaries separately', () => {
    const opaque = field(7, 7, (_x, y) => ({
      evidence: gaussian(y - 3),
      tangent: [1, 0],
    }))
    const alphaEdge = field(9, 7, (x, y) => ({
      evidence: gaussian(y - 3),
      tangent: [1, 0],
      alpha: x < 5 ? 1 : 0,
    }))

    expect(
      stepFlowingContoursRidge(
        opaque,
        at(opaque, [5.5, 3]),
        [1, 0],
        ONE_PIXEL_STEP,
      ).kind,
    ).toBe('source-boundary')
    expect(
      stepFlowingContoursRidge(
        alphaEdge,
        at(alphaEdge, [4, 3]),
        [1, 0],
        ONE_PIXEL_STEP,
      ).kind,
    ).toBe('alpha-boundary')
  })

  it('stops when supported endpoints cross a transparent lattice column', () => {
    const transparentColumn = field(10, 7, (x, y) => ({
      evidence: gaussian(y - 3),
      tangent: [1, 0],
      alpha: x === 5 ? 0 : 1,
    }))

    expect(
      stepFlowingContoursRidge(
        transparentColumn,
        at(transparentColumn, [4, 3]),
        [1, 0],
        { stepLength: 2 },
      ).kind,
    ).toBe('alpha-boundary')
  })

  it('classifies a hard-unresolved orientation crossed between valid endpoints', () => {
    const unresolvedColumn = field(10, 7, (x, y) => ({
      evidence: gaussian(y - 3),
      tangent: [1, 0],
      coherence: x === 5 ? 0 : 1,
      ambiguity: x === 5 ? 1 : 0,
    }))

    expect(
      stepFlowingContoursRidge(
        unresolvedColumn,
        at(unresolvedColumn, [4, 3]),
        [1, 0],
        { stepLength: 2 },
      ).kind,
    ).toBe('ambiguity')
  })

  it('returns weak for an off-ridge prediction with no compatible maximum', () => {
    const fading = field(12, 9, (x, y) => ({
      evidence: x < 5 ? gaussian(y - 4) : 0.01,
      tangent: [1, 0],
    }))
    const result = stepFlowingContoursRidge(
      fading,
      at(fading, [4, 4]),
      [1, 0],
      ONE_PIXEL_STEP,
    )

    expect(result.kind).toBe('weak')
    if (result.kind === 'weak') {
      expect(result.sample).not.toBeNull()
      expect(result.sample!.point).toEqual(result.predictedPoint)
    }
  })

  it('requires coherent, unambiguous evidence at the corrected maximum', () => {
    const varyingConfidence = (
      next: Pick<FieldValue, 'coherence' | 'ambiguity'>,
    ) =>
      field(12, 9, (x, y) => ({
        evidence: gaussian(y - 4),
        tangent: [1, 0],
        coherence: x < 5 ? 1 : next.coherence,
        ambiguity: x < 5 ? 0 : next.ambiguity,
      }))
    const incoherent = varyingConfidence({ coherence: 0.1, ambiguity: 0 })
    const ambiguous = varyingConfidence({ coherence: 1, ambiguity: 0.9 })

    expect(
      stepFlowingContoursRidge(
        incoherent,
        at(incoherent, [4, 4]),
        [1, 0],
        ONE_PIXEL_STEP,
      ).kind,
    ).toBe('weak')
    expect(
      stepFlowingContoursRidge(
        ambiguous,
        at(ambiguous, [4, 4]),
        [1, 0],
        ONE_PIXEL_STEP,
      ).kind,
    ).toBe('weak')
  })

  it('stops on an unresolved zero tangent instead of inventing an axis', () => {
    const unresolved = field(9, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [0, 0],
      coherence: 0,
      ambiguity: 1,
    }))

    expect(
      stepFlowingContoursRidge(unresolved, at(unresolved, [3, 4]), [1, 0]).kind,
    ).toBe('ambiguity')
  })

  it('treats hard-zero orientation confidence as ambiguity at every stage', () => {
    const straight = field(12, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
    }))
    const current = {
      ...at(straight, [4, 4]),
      tangent: [1, 0] as Point,
      coherence: 0,
      ambiguity: 0,
    }
    expect(
      stepFlowingContoursRidge(straight, current, [1, 0], {
        ...ONE_PIXEL_STEP,
        minimumCoherence: 0,
        maximumAmbiguity: 1,
      }).kind,
    ).toBe('ambiguity')

    const unresolvedPrediction = field(12, 9, (x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
      coherence: x < 5 ? 1 : 0,
      ambiguity: 0,
    }))
    expect(
      stepFlowingContoursRidge(
        unresolvedPrediction,
        at(unresolvedPrediction, [4, 4]),
        [1, 0],
        {
          ...ONE_PIXEL_STEP,
          minimumCoherence: 0,
          maximumAmbiguity: 1,
        },
      ).kind,
    ).toBe('ambiguity')

    const unresolvedCorrection = field(12, 12, (_x, y) => ({
      evidence: y === 6 ? 1 : 0.2,
      tangent: [1, 0],
      coherence: y === 6 ? 0 : 1,
      ambiguity: 0,
    }))
    const fiveSamples = createFlowingContoursTestLimits({
      'normal-search-sample-count': 5,
    })
    expect(fiveSamples).not.toBeNull()
    expect(
      stepFlowingContoursRidge(
        unresolvedCorrection,
        at(unresolvedCorrection, [4, 5.625]),
        [1, 0],
        {
          ...ONE_PIXEL_STEP,
          minimumCoherence: 0,
          maximumAmbiguity: 1,
        },
        fiveSamples!,
      ).kind,
    ).toBe('ambiguity')
  })

  it('honors an exact lowered odd stencil cap and reproduces byte-for-byte values', () => {
    const straight = field(15, 13, (_x, y) => ({
      evidence: gaussian(y - 6),
      tangent: [1, 0],
    }))
    const limits = createFlowingContoursTestLimits({
      'normal-search-sample-count': 5,
    })
    expect(limits).not.toBeNull()
    const current = at(straight, [3.25, 6])
    const first = stepFlowingContoursRidge(
      straight,
      current,
      [1, 0],
      ONE_PIXEL_STEP,
      limits!,
    )
    const second = stepFlowingContoursRidge(
      straight,
      current,
      [1, 0],
      ONE_PIXEL_STEP,
      limits!,
    )

    expect(first).toEqual(second)
    expect(first.normalSampleCount).toBe(5)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.predictedPoint)).toBe(true)
    if (first.kind === 'corrected') {
      expect(Object.isFrozen(first.sample)).toBe(true)
      expect(Object.isFrozen(first.sample.point)).toBe(true)
      expect(Object.isFrozen(first.sample.tangent)).toBe(true)
    }
  })

  it('fails closed for malformed policy and exact zero normal-search work', () => {
    const straight = field(9, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
    }))
    const current = at(straight, [3, 4])
    const noSamples = createFlowingContoursTestLimits({
      'normal-search-sample-count': 0,
    })

    expect(
      stepFlowingContoursRidge(straight, current, [1, 0], {
        stepLength: Number.NaN,
      }).kind,
    ).toBe('safety-limit')
    expect(
      stepFlowingContoursRidge(
        straight,
        current,
        [1, 0],
        ONE_PIXEL_STEP,
        noSamples!,
      ).kind,
    ).toBe('safety-limit')
  })

  it('fails closed without escaping a hostile current-point getter', () => {
    const straight = field(9, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
    }))
    const current = at(straight, [3, 4])
    const hostile = new Proxy(current, {
      get(target, property, receiver) {
        if (property === 'point') throw new Error('hostile point')
        return Reflect.get(target, property, receiver)
      },
    })

    const result = stepFlowingContoursRidge(straight, hostile, [1, 0])

    expect(result.kind).toBe('safety-limit')
    expect(result.predictedPoint).toEqual([0, 0])
  })

  it('snapshots one current-point value instead of synthesizing coordinates', () => {
    const straight = field(9, 9, (_x, y) => ({
      evidence: gaussian(y - 4),
      tangent: [1, 0],
    }))
    const current = at(straight, [3, 4])
    let pointReads = 0
    const alternating = new Proxy(
      { ...current },
      {
        get(target, property, receiver) {
          if (property === 'point') {
            pointReads += 1
            return pointReads % 2 === 1 ? [3, 4] : [3, 100]
          }
          return Reflect.get(target, property, receiver)
        },
      },
    )

    const result = stepFlowingContoursRidge(
      straight,
      alternating,
      [1, 0],
      ONE_PIXEL_STEP,
    )

    expect(pointReads).toBe(1)
    expect(result.kind).toBe('corrected')
    expect(result.predictedPoint).toEqual([4, 4])
  })
})
