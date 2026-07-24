import { describe, expect, it } from 'vitest'

import { createFlowingContoursAccounting } from '../sketches/flowing-contours/accounting'
import {
  buildFlowingContoursField,
  buildFlowingContoursFieldEnsemble,
  isAuthenticatedFlowingContoursField,
  sampleFlowingContoursEvidenceInto,
  sampleFlowingContoursField,
  sampleFlowingContoursTangent,
  type FlowingContoursEvidenceSampleScratch,
} from '../sketches/flowing-contours/field'
import { createFlowingContoursTestLimits } from '../sketches/flowing-contours/limits'
import type { PreparedFlowingContoursRaster } from '../sketches/flowing-contours/raster'
import type { FlowingContoursField } from '../sketches/flowing-contours/types'

function preparedRaster(
  width: number,
  height: number,
  luminanceAt: (x: number, y: number) => number,
  alphaAt: (x: number, y: number) => number = () => 1,
): PreparedFlowingContoursRaster {
  const luminance = new Array<number>(width * height)
  const alpha = new Array<number>(width * height)
  const positiveSupport = new Array<boolean>(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      const sampledAlpha = alphaAt(x, y)
      alpha[index] = sampledAlpha
      positiveSupport[index] = sampledAlpha > 0
      luminance[index] = sampledAlpha > 0 ? luminanceAt(x, y) : 0
    }
  }
  return {
    sourceWidth: width,
    sourceHeight: height,
    width,
    height,
    luminance,
    alpha,
    positiveSupport,
  }
}

function build(raster: PreparedFlowingContoursRaster) {
  const accounting = createFlowingContoursAccounting()
  const field = buildFlowingContoursField(raster, accounting)
  return { accounting, field }
}

function index(field: FlowingContoursField, x: number, y: number): number {
  return y * field.width + x
}

function axisAlignment(
  field: FlowingContoursField,
  x: number,
  y: number,
  expectedX: number,
  expectedY: number,
): number {
  const sampleIndex = index(field, x, y)
  return Math.abs(
    field.tangentX[sampleIndex]! * expectedX +
      field.tangentY[sampleIndex]! * expectedY,
  )
}

function orientationPair(overrides: {
  readonly evidence: readonly [number, number]
  readonly tangentX: readonly [number, number]
  readonly tangentY: readonly [number, number]
  readonly coherence?: readonly [number, number]
  readonly ambiguity?: readonly [number, number]
  readonly scale?: readonly [number, number]
}): FlowingContoursField {
  return Object.freeze({
    sourceWidth: 2,
    sourceHeight: 1,
    width: 2,
    height: 1,
    luminance: Object.freeze([0.5, 0.5]),
    alpha: Object.freeze([1, 1]),
    positiveSupport: Object.freeze([true, true]),
    contourEvidence: Object.freeze(Array.from(overrides.evidence)),
    tangentX: Object.freeze(Array.from(overrides.tangentX)),
    tangentY: Object.freeze(Array.from(overrides.tangentY)),
    tangentCoherence: Object.freeze(Array.from(overrides.coherence ?? [1, 1])),
    ambiguity: Object.freeze(Array.from(overrides.ambiguity ?? [0, 0])),
    ridgeScale: Object.freeze(Array.from(overrides.scale ?? [1, 1])),
  })
}

function sampledEvidence(
  field: Readonly<FlowingContoursField>,
  point: readonly [number, number],
): Readonly<FlowingContoursEvidenceSampleScratch> | null {
  const target: FlowingContoursEvidenceSampleScratch = {
    evidence: Number.NaN,
    coherence: Number.NaN,
    ambiguity: Number.NaN,
  }
  return sampleFlowingContoursEvidenceInto(field, point, target)
    ? { ...target }
    : null
}

function expectEvidenceSamplerEquivalent(
  field: Readonly<FlowingContoursField>,
  point: readonly [number, number],
): void {
  const complete = sampleFlowingContoursField(field, point)
  const evidence = sampledEvidence(field, point)
  expect(evidence).toEqual(
    complete === null
      ? null
      : {
          evidence: complete.evidence,
          coherence: complete.coherence,
          ambiguity: complete.ambiguity,
        },
  )
}

function evidenceChecksum(
  samples: readonly (
    | Readonly<FlowingContoursEvidenceSampleScratch>
    | null
  )[],
): string {
  let checksum = 2_166_136_261
  for (const sample of samples) {
    const token =
      sample === null
        ? 'null;'
        : `${sample.evidence.toPrecision(17)},${sample.coherence.toPrecision(
            17,
          )},${sample.ambiguity.toPrecision(17)};`
    for (let index = 0; index < token.length; index += 1) {
      checksum ^= token.charCodeAt(index)
      checksum = Math.imul(checksum, 16_777_619)
    }
  }
  return (checksum >>> 0).toString(16).padStart(8, '0')
}

describe('Flowing Contours multiscale field', () => {
  it('preserves broad, mid, and local orientations without adding scale planes', () => {
    const raster = preparedRaster(81, 81, (x, y) =>
      Math.max(
        0,
        Math.min(
          1,
          (x < 40 ? 0.2 : 0.75) + 0.12 * Math.sin(y * Math.PI * 0.5),
        ),
      ),
    )
    const accounting = createFlowingContoursAccounting()
    const ensemble = buildFlowingContoursFieldEnsemble(raster, accounting)

    expect(ensemble.hypotheses.map(({ kind }) => kind)).toEqual([
      'broad-form',
      'mid-form',
      'local-detail',
    ])
    const broad = ensemble.hypotheses[0]!.field
    const mid = ensemble.hypotheses[1]!.field
    const local = ensemble.hypotheses[2]!.field
    expect(
      ensemble.hypotheses.every(({ field }) =>
        isAuthenticatedFlowingContoursField(field),
      ),
    ).toBe(true)
    expect(isAuthenticatedFlowingContoursField({ ...local })).toBe(false)
    const legacyLocal = buildFlowingContoursField(
      raster,
      createFlowingContoursAccounting(),
    )
    expect(local).toEqual(legacyLocal)
    expect(broad.positiveSupport).toEqual(local.positiveSupport)
    expect(mid.positiveSupport).toEqual(local.positiveSupport)
    expect(broad.ridgeScale.every((scale) => scale === 0 || scale === 16)).toBe(
      true,
    )
    expect(
      local.ridgeScale.every((scale) => [0, 1, 2, 4, 8].includes(scale)),
    ).toBe(true)
    expect(
      mid.ridgeScale.every((scale) => [0, 2, 4, 8].includes(scale)),
    ).toBe(true)
    expect(mid.ridgeScale).toContain(2)
    expect(
      mid.contourEvidence.every(
        (evidence, sampleIndex) =>
          evidence === 0 ||
          (local.contourEvidence[sampleIndex]! >= 0.04 &&
            evidence <= local.contourEvidence[sampleIndex]!),
      ),
    ).toBe(true)
    expect(
      broad.contourEvidence.every(
        (evidence, sampleIndex) =>
          evidence === 0 ||
          (local.contourEvidence[sampleIndex]! >= 0.04 &&
            evidence <= local.contourEvidence[sampleIndex]!),
      ),
    ).toBe(true)
    expect(
      broad.contourEvidence.some((evidence, sampleIndex) => {
        if (evidence <= 0 || local.contourEvidence[sampleIndex]! < 0.04) {
          return false
        }
        return (
          Math.abs(
            broad.tangentX[sampleIndex]! * local.tangentX[sampleIndex]! +
              broad.tangentY[sampleIndex]! * local.tangentY[sampleIndex]!,
          ) < 0.7
        )
      }),
    ).toBe(true)
    expect(accounting.termination).toBe('complete')
    expect(accounting.contourEvidenceSampleCount).toBeLessThanOrEqual(
      raster.width * raster.height,
    )
  })

  it('accounts the ensemble five-plane ceiling as one bounded transaction', () => {
    const raster = preparedRaster(41, 41, (x) => (x < 20 ? 0.1 : 0.9))
    const accounting = createFlowingContoursAccounting()
    const limits = createFlowingContoursTestLimits({
      'scale-plane-count': 4,
    })!

    const ensemble = buildFlowingContoursFieldEnsemble(
      raster,
      accounting,
      limits,
    )

    expect(ensemble.hypotheses).toEqual([])
    expect(accounting).toMatchObject({
      termination: 'limit-reached',
      limitedBy: 'scale-plane-count',
      contourEvidenceSampleCount: 0,
    })
  })

  it('keeps flat opaque and fully transparent inputs evidence-free', () => {
    const opaque = build(preparedRaster(25, 21, () => 0.42))
    const transparent = build(
      preparedRaster(
        25,
        21,
        () => 0.9,
        () => 0,
      ),
    )

    for (const result of [opaque, transparent]) {
      expect(result.field.contourEvidence.every((value) => value === 0)).toBe(
        true,
      )
      expect(result.field.tangentCoherence.every((value) => value === 0)).toBe(
        true,
      )
      expect(result.field.ambiguity.every((value) => value === 0)).toBe(true)
      expect(result.field.ridgeScale.every((value) => value === 0)).toBe(true)
      expect(result.accounting.contourEvidenceSampleCount).toBe(0)
    }
  })

  it('derives smooth horizontal, vertical, and diagonal tangents', () => {
    const vertical = build(
      preparedRaster(33, 33, (x) => (x >= 16 ? 1 : 0)),
    ).field
    const horizontal = build(
      preparedRaster(33, 33, (_, y) => (y >= 16 ? 1 : 0)),
    ).field
    const diagonal = build(
      preparedRaster(33, 33, (x, y) => (x + y >= 32 ? 1 : 0)),
    ).field

    expect(vertical.contourEvidence[index(vertical, 16, 16)]).toBeGreaterThan(
      0.2,
    )
    expect(axisAlignment(vertical, 16, 16, 0, 1)).toBeGreaterThan(0.98)
    expect(axisAlignment(horizontal, 16, 16, 1, 0)).toBeGreaterThan(0.98)
    expect(
      axisAlignment(diagonal, 16, 16, Math.SQRT1_2, -Math.SQRT1_2),
    ).toBeGreaterThan(0.96)
    expect(diagonal.tangentCoherence[index(diagonal, 16, 16)]).toBeGreaterThan(
      0.9,
    )
  })

  it('follows a curved signal without snapping its oblique tangent to the grid', () => {
    const center = 20
    const radius = 11
    const circle = build(
      preparedRaster(41, 41, (x, y) =>
        Math.hypot(x - center, y - center) <= radius ? 1 : 0,
      ),
    ).field

    expect(
      axisAlignment(circle, center, center - radius, 1, 0),
    ).toBeGreaterThan(0.95)
    const diagonalOffset = Math.round(radius * Math.SQRT1_2)
    expect(
      axisAlignment(
        circle,
        center + diagonalOffset,
        center - diagonalOffset,
        Math.SQRT1_2,
        Math.SQRT1_2,
      ),
    ).toBeGreaterThan(0.9)
  })

  it('uses an internal alpha transition but never invents an opaque perimeter', () => {
    const flatOpaque = build(preparedRaster(33, 25, () => 0.6)).field
    const alphaEdge = build(
      preparedRaster(
        33,
        25,
        () => 0.6,
        (x) => (x < 17 ? 1 : 0),
      ),
    ).field
    const edgeIndex = index(alphaEdge, 15, 12)

    expect(flatOpaque.contourEvidence.every((value) => value === 0)).toBe(true)
    expect(alphaEdge.contourEvidence[edgeIndex]).toBeGreaterThan(0.1)
    expect(axisAlignment(alphaEdge, 15, 12, 0, 1)).toBeGreaterThan(0.98)
    expect(alphaEdge.contourEvidence[index(alphaEdge, 17, 12)]).toBe(0)
    expect(alphaEdge.positiveSupport[index(alphaEdge, 17, 12)]).toBe(false)
  })

  it('marks crossings as ambiguous while retaining coherent arm evidence', () => {
    const crossing = build(
      preparedRaster(41, 41, (x, y) =>
        Math.abs(x - 20) <= 1 || Math.abs(y - 20) <= 1 ? 1 : 0,
      ),
    ).field
    const center = index(crossing, 20, 20)
    const verticalArm = index(crossing, 20, 10)

    expect(crossing.contourEvidence[center]).toBeGreaterThan(0.05)
    expect(crossing.tangentCoherence[center]).toBeLessThan(0.25)
    expect(crossing.ambiguity[center]).toBeGreaterThan(0.75)
    expect(crossing.tangentCoherence[verticalArm]).toBeGreaterThan(0.8)
    expect(crossing.ambiguity[verticalArm]).toBeLessThan(0.2)
  })

  it('selects bounded fixed scale bands and interpolates adjacent provenance', () => {
    const sharp = build(preparedRaster(65, 33, (x) => (x >= 32 ? 1 : 0))).field
    const broad = build(
      preparedRaster(65, 33, (x) => Math.max(0, Math.min(1, (x - 20) / 24))),
    ).field
    const fixedBands = new Set([0, 1, 2, 4, 8])

    expect(sharp.ridgeScale.every((scale) => fixedBands.has(scale))).toBe(true)
    expect(broad.ridgeScale.every((scale) => fixedBands.has(scale))).toBe(true)
    expect(broad.ridgeScale[index(broad, 32, 16)]).toBeGreaterThan(
      sharp.ridgeScale[index(sharp, 32, 16)]!,
    )

    const transitionX = sharp.ridgeScale.findIndex(
      (scale, sampleIndex) =>
        sampleIndex % sharp.width < sharp.width - 1 &&
        scale !== sharp.ridgeScale[sampleIndex + 1],
    )
    expect(transitionX).toBeGreaterThanOrEqual(0)
    const x = transitionX % sharp.width
    const y = Math.floor(transitionX / sharp.width)
    const sample = sampleFlowingContoursField(sharp, [x + 0.5, y])
    expect(sample).not.toBeNull()
    expect(sample!.scale).toBeCloseTo(
      (sharp.ridgeScale[transitionX]! + sharp.ridgeScale[transitionX + 1]!) / 2,
      12,
    )
  })

  it('samples scalar channels continuously and tangent axes sign-invariantly', () => {
    const manual = Object.freeze({
      sourceWidth: 2,
      sourceHeight: 2,
      width: 2,
      height: 2,
      luminance: Object.freeze([0, 1, 0, 1]),
      alpha: Object.freeze([1, 1, 1, 1]),
      positiveSupport: Object.freeze([true, true, true, true]),
      contourEvidence: Object.freeze([0, 1, 0, 1]),
      tangentX: Object.freeze([
        Math.SQRT1_2,
        -Math.SQRT1_2,
        Math.SQRT1_2,
        -Math.SQRT1_2,
      ]),
      tangentY: Object.freeze([
        Math.SQRT1_2,
        -Math.SQRT1_2,
        Math.SQRT1_2,
        -Math.SQRT1_2,
      ]),
      tangentCoherence: Object.freeze([0.8, 1, 0.8, 1]),
      ambiguity: Object.freeze([0.2, 0, 0.2, 0]),
      ridgeScale: Object.freeze([1, 2, 1, 2]),
    }) satisfies FlowingContoursField

    const quarter = sampleFlowingContoursField(manual, [0.25, 0.5])
    const half = sampleFlowingContoursField(manual, [0.5, 0.5])
    const threeQuarter = sampleFlowingContoursField(manual, [0.75, 0.5])
    const tangent = sampleFlowingContoursTangent(manual, [0.5, 0.5])

    expect([quarter!.evidence, half!.evidence, threeQuarter!.evidence]).toEqual(
      [0.25, 0.5, 0.75],
    )
    expect(half).toMatchObject({
      coherence: 1,
      ambiguity: 0,
      scale: 1.5,
      alpha: 1,
    })
    expect(Math.abs(tangent![0])).toBeCloseTo(Math.SQRT1_2, 12)
    expect(Math.abs(tangent![1])).toBeCloseTo(Math.SQRT1_2, 12)
    expect(Math.hypot(tangent![0], tangent![1])).toBeCloseTo(1, 12)
    expect(sampleFlowingContoursField(manual, [-0.01, 0])).toBeNull()
  })

  it('keeps the tube evidence sampler exactly equivalent on edges, interiors, and transparent support', () => {
    const synthetic = build(
      preparedRaster(
        13,
        11,
        (x, y) =>
          Math.max(
            0,
            Math.min(
              1,
              0.5 +
                0.31 * Math.sin(x * 0.71) -
                0.27 * Math.cos(y * 0.43),
            ),
          ),
        (x, y) =>
          x >= 10 ? 0 : x === 9 ? (y % 2 === 0 ? 0.25 : 0.75) : 1,
      ),
    ).field

    for (let quarterY = -1; quarterY <= synthetic.height * 4; quarterY += 1) {
      for (
        let quarterX = -1;
        quarterX <= synthetic.width * 4;
        quarterX += 1
      ) {
        expectEvidenceSamplerEquivalent(synthetic, [
          quarterX / 4,
          quarterY / 4,
        ])
      }
    }
  })

  it('preserves fail-closed null semantics for every malformed sampled channel', () => {
    const valid = orientationPair({
      evidence: [0.8, 0.4],
      tangentX: [Math.SQRT1_2, 0],
      tangentY: [Math.SQRT1_2, 1],
      coherence: [0.9, 0.6],
      ambiguity: [0.1, 0.35],
      scale: [2, 4],
    })
    const sampledChannels = [
      'alpha',
      'contourEvidence',
      'tangentX',
      'tangentY',
      'tangentCoherence',
      'ambiguity',
      'ridgeScale',
    ] as const

    expectEvidenceSamplerEquivalent(valid, [0.25, 0])
    for (const channel of sampledChannels) {
      const malformed = {
        ...valid,
        [channel]: Object.freeze([Number.NaN, valid[channel][1]!]),
      } as FlowingContoursField
      expectEvidenceSamplerEquivalent(malformed, [0.25, 0])
      expect(sampledEvidence(malformed, [0.25, 0])).toBeNull()
    }

    const truncated = {
      ...valid,
      tangentX: Object.freeze([1]),
    } as FlowingContoursField
    const noSupport = {
      ...valid,
      positiveSupport: Object.freeze([false, false]),
    } as FlowingContoursField
    const noAlpha = {
      ...valid,
      alpha: Object.freeze([0, 0]),
    } as FlowingContoursField
    for (const malformed of [truncated, noSupport, noAlpha]) {
      expectEvidenceSamplerEquivalent(malformed, [0.25, 0])
      expect(sampledEvidence(malformed, [0.25, 0])).toBeNull()
    }
    for (const point of [
      [Number.NaN, 0],
      [0, Number.POSITIVE_INFINITY],
      [-Number.EPSILON, 0],
      [2, 0],
    ] as const) {
      expectEvidenceSamplerEquivalent(valid, point)
      expect(sampledEvidence(valid, point)).toBeNull()
    }
  })

  it('holds an exact scalar checksum across a synthetic orientation field', () => {
    const synthetic = build(
      preparedRaster(
        19,
        17,
        (x, y) =>
          Math.sin(x * 0.37 + y * 0.19) * 0.22 +
          Math.cos(x * 0.11 - y * 0.41) * 0.18 +
          0.5,
        (x, y) => (x + y > 30 ? 0 : (x * 7 + y * 5) % 11 === 0 ? 0.4 : 1),
      ),
    ).field
    const points = Array.from({ length: 257 }, (_value, index) => {
      const x = ((index * 37) % 181) / 10 - 0.5
      const y = ((index * 61) % 161) / 10 - 0.5
      return [x, y] as const
    })
    const lightweight = points.map((point) =>
      sampledEvidence(synthetic, point),
    )
    const complete = points.map((point) => {
      const sample = sampleFlowingContoursField(synthetic, point)
      return sample === null
        ? null
        : {
            evidence: sample.evidence,
            coherence: sample.coherence,
            ambiguity: sample.ambiguity,
          }
    })

    expect(lightweight).toEqual(complete)
    expect(evidenceChecksum(lightweight)).toBe('833667e3')
    expect(evidenceChecksum(complete)).toBe('833667e3')
  })

  it('makes an orthogonal coherent midpoint explicitly unresolved', () => {
    const orthogonal = orientationPair({
      evidence: [1, 1],
      tangentX: [1, 0],
      tangentY: [0, 1],
    })

    const sample = sampleFlowingContoursField(orthogonal, [0.5, 0])

    expect(sample).not.toBeNull()
    expect(sample!.tangent).toEqual([0, 0])
    expect(sample!.coherence).toBe(0)
    expect(sample!.ambiguity).toBe(1)
    expect(sampleFlowingContoursTangent(orthogonal, [0.5, 0])).toEqual([0, 0])
  })

  it('does not let a zero-evidence default axis bleed into a neighbor', () => {
    const supportedDiagonal = orientationPair({
      evidence: [1, 0],
      tangentX: [Math.SQRT1_2, 1],
      tangentY: [Math.SQRT1_2, 0],
      coherence: [1, 0],
      ambiguity: [0, 0],
      scale: [2, 0],
    })

    const sample = sampleFlowingContoursField(supportedDiagonal, [0.5, 0])

    expect(sample).not.toBeNull()
    expect(sample!.evidence).toBe(0.5)
    expect(Math.abs(sample!.tangent[0])).toBeCloseTo(Math.SQRT1_2, 12)
    expect(Math.abs(sample!.tangent[1])).toBeCloseTo(Math.SQRT1_2, 12)
    expect(sample!.coherence).toBe(1)
    expect(sample!.ambiguity).toBe(0)
  })

  it('favors stronger evidence at a dominant-scale orientation transition', () => {
    const scaleTransition = orientationPair({
      evidence: [0.9, 0.3],
      tangentX: [0, 1],
      tangentY: [1, 0],
      scale: [1, 8],
    })

    const sample = sampleFlowingContoursField(scaleTransition, [0.5, 0])

    expect(sample).not.toBeNull()
    expect(Math.abs(sample!.tangent[0])).toBeCloseTo(0, 12)
    expect(Math.abs(sample!.tangent[1])).toBeCloseTo(1, 12)
    expect(sample!.coherence).toBeCloseTo(0.5, 12)
    expect(sample!.ambiguity).toBeCloseTo(0.5, 12)
    expect(sample!.scale).toBe(4.5)
  })

  it('returns null when continuous sampling reaches zero-alpha permission', () => {
    const alphaBoundary = build(
      preparedRaster(
        17,
        17,
        () => 0.5,
        (x) => (x < 8 ? 1 : 0),
      ),
    ).field

    expect(sampleFlowingContoursField(alphaBoundary, [7.5, 8])).not.toBeNull()
    expect(sampleFlowingContoursField(alphaBoundary, [8, 8])).toBeNull()
  })

  it('is deterministic, finite, frozen, exactly accounted, and cap bounded', () => {
    const raster = preparedRaster(37, 29, (x, y) =>
      Math.sin(x * 0.37 + y * 0.23) > 0 ? 0.8 : 0.15,
    )
    const first = build(raster)
    const second = build(raster)
    const numericArrays = [
      first.field.luminance,
      first.field.alpha,
      first.field.contourEvidence,
      first.field.tangentX,
      first.field.tangentY,
      first.field.tangentCoherence,
      first.field.ambiguity,
      first.field.ridgeScale,
    ]

    expect(first.field).toEqual(second.field)
    expect(first.field).not.toBe(second.field)
    expect(Object.isFrozen(first.field)).toBe(true)
    for (const values of numericArrays) {
      expect(values).toHaveLength(raster.width * raster.height)
      expect(values.every(Number.isFinite)).toBe(true)
      expect(Object.isFrozen(values)).toBe(true)
    }
    for (
      let sampleIndex = 0;
      sampleIndex < first.field.tangentX.length;
      sampleIndex += 1
    ) {
      expect(
        Math.hypot(
          first.field.tangentX[sampleIndex]!,
          first.field.tangentY[sampleIndex]!,
        ),
      ).toBeCloseTo(1, 12)
      expect(first.field.contourEvidence[sampleIndex]).toBeGreaterThanOrEqual(0)
      expect(first.field.contourEvidence[sampleIndex]).toBeLessThanOrEqual(1)
      expect(first.field.tangentCoherence[sampleIndex]).toBeGreaterThanOrEqual(
        0,
      )
      expect(first.field.tangentCoherence[sampleIndex]).toBeLessThanOrEqual(1)
      expect(first.field.ambiguity[sampleIndex]).toBeGreaterThanOrEqual(0)
      expect(first.field.ambiguity[sampleIndex]).toBeLessThanOrEqual(1)
    }
    expect(Object.isFrozen(first.field.positiveSupport)).toBe(true)
    expect(first.accounting.contourEvidenceSampleCount).toBe(
      first.field.contourEvidence.filter((value) => value > 0).length,
    )

    const cappedAccounting = createFlowingContoursAccounting()
    const limits = createFlowingContoursTestLimits({
      'scale-plane-count': 3,
    })
    expect(limits).not.toBeNull()
    const capped = buildFlowingContoursField(raster, cappedAccounting, limits!)
    expect(capped.width).toBe(0)
    expect(capped.contourEvidence).toEqual([])
    expect(cappedAccounting).toMatchObject({
      termination: 'limit-reached',
      limitedBy: 'scale-plane-count',
      contourEvidenceSampleCount: 0,
    })
  })
})
