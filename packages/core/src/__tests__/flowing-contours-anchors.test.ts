import { describe, expect, it } from 'vitest'

import {
  admitFlowingContoursAnchors,
  buildFlowingContoursAnchorInventory,
} from '../sketches/flowing-contours/anchors'
import { createFlowingContoursAccounting } from '../sketches/flowing-contours/accounting'
import { buildFlowingContoursField } from '../sketches/flowing-contours/field'
import { createFlowingContoursTestLimits } from '../sketches/flowing-contours/limits'
import type { PreparedFlowingContoursRaster } from '../sketches/flowing-contours/raster'
import type { FlowingContoursField } from '../sketches/flowing-contours/types'

function manualField(
  width: number,
  height: number,
  sampleAt: (
    x: number,
    y: number,
  ) => {
    readonly evidence?: number
    readonly tangent?: readonly [number, number]
    readonly coherence?: number
    readonly ambiguity?: number
    readonly alpha?: number
    readonly scale?: number
  },
): FlowingContoursField {
  const count = width * height
  const luminance = new Array<number>(count).fill(0.5)
  const alpha = new Array<number>(count)
  const positiveSupport = new Array<boolean>(count)
  const contourEvidence = new Array<number>(count)
  const tangentX = new Array<number>(count)
  const tangentY = new Array<number>(count)
  const tangentCoherence = new Array<number>(count)
  const ambiguity = new Array<number>(count)
  const ridgeScale = new Array<number>(count)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      const sample = sampleAt(x, y)
      const sampledAlpha = sample.alpha ?? 1
      const tangent = sample.tangent ?? [0, 1]
      alpha[index] = sampledAlpha
      positiveSupport[index] = sampledAlpha > 0
      contourEvidence[index] = sample.evidence ?? 0
      tangentX[index] = tangent[0]
      tangentY[index] = tangent[1]
      tangentCoherence[index] = sample.coherence ?? 1
      ambiguity[index] = sample.ambiguity ?? 0
      ridgeScale[index] = sample.scale ?? 1
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
      alpha[index] = alphaAt(x, y)
      positiveSupport[index] = alpha[index]! > 0
      luminance[index] = positiveSupport[index] ? luminanceAt(x, y) : 0
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

function inventory(field: FlowingContoursField, maximumCurveDetail = 1) {
  const accounting = createFlowingContoursAccounting()
  return {
    accounting,
    inventory: buildFlowingContoursAnchorInventory(
      field,
      accounting,
      undefined,
      maximumCurveDetail,
    ),
  }
}

describe('Flowing Contours anchor inventory', () => {
  it('returns no anchors for flat opaque or fully transparent FC05 fields', () => {
    for (const raster of [
      preparedRaster(25, 21, () => 0.42),
      preparedRaster(
        25,
        21,
        () => 0.9,
        () => 0,
      ),
    ]) {
      const accounting = createFlowingContoursAccounting()
      const field = buildFlowingContoursField(raster, accounting)
      const result = buildFlowingContoursAnchorInventory(field, accounting)

      expect(result.anchors).toEqual([])
      expect(result.correctedRidgeSampleCount).toBe(0)
      expect(accounting.correctedRidgeSampleCount).toBe(0)
      expect(
        admitFlowingContoursAnchors(result, 1, accounting).anchors,
      ).toEqual([])
      expect(accounting.eligibleAnchorCount).toBe(0)
    }
  })

  it('corrects ridge positions off lattice along the continuous normal', () => {
    const field = manualField(11, 7, (x, y) => {
      if (y !== 3) return {}
      if (x === 4) return { evidence: 0.6 }
      if (x === 5) return { evidence: 1 }
      if (x === 6) return { evidence: 0.8 }
      return {}
    })

    const result = inventory(field).inventory

    expect(result.anchors).toHaveLength(1)
    expect(result.anchors[0]!.fieldSampleIndex).toBe(3 * 11 + 5)
    expect(result.anchors[0]!.sample.point[0]).toBeCloseTo(5 + 1 / 6, 12)
    expect(result.anchors[0]!.sample.point[1]).toBe(3)
    expect(result.anchors[0]!.sample.tangent[0]).toBeCloseTo(0, 12)
    expect(result.anchors[0]!.sample.tangent[1]).toBeCloseTo(1, 12)
  })

  it('preflights the exact three-sample normal-correction budget', () => {
    const field = manualField(11, 7, (x, y) => ({
      evidence: x === 5 && y === 3 ? 0.8 : 0,
    }))
    const exactAccounting = createFlowingContoursAccounting()
    const exact = buildFlowingContoursAnchorInventory(
      field,
      exactAccounting,
      createFlowingContoursTestLimits({
        'normal-search-sample-count': 3,
      })!,
    )
    const shortAccounting = createFlowingContoursAccounting()
    const short = buildFlowingContoursAnchorInventory(
      field,
      shortAccounting,
      createFlowingContoursTestLimits({
        'normal-search-sample-count': 2,
      })!,
    )

    expect(exact.anchors).toHaveLength(1)
    expect(exactAccounting.termination).toBe('complete')
    expect(exactAccounting.limitedBy).toBeNull()
    expect(short.anchors).toEqual([])
    expect(short.correctedRidgeSampleCount).toBe(0)
    expect(shortAccounting.correctedRidgeSampleCount).toBe(0)
    expect(shortAccounting.eligibleAnchorCount).toBe(0)
    expect(shortAccounting.termination).toBe('limit-reached')
    expect(shortAccounting.limitedBy).toBe('normal-search-sample-count')
  })

  it('rejects non-finite tangents even where no evidence is present', () => {
    for (const evidence of [0, 0.8]) {
      const accounting = createFlowingContoursAccounting()
      const field = manualField(7, 7, (x, y) => ({
        evidence: x === 3 && y === 3 ? evidence : 0,
        tangent: x === 3 && y === 3 ? [Number.NaN, 0] : [0, 1],
      }))

      const result = buildFlowingContoursAnchorInventory(field, accounting)

      expect(result.anchors).toEqual([])
      expect(result.correctedRidgeSampleCount).toBe(0)
      expect(accounting.termination).toBe('invalid-input')
      expect(accounting.limitedBy).toBeNull()
      expect(accounting.correctedRidgeSampleCount).toBe(0)
      expect(accounting.eligibleAnchorCount).toBe(0)
    }
  })

  it('uses stable lexicographic ties and enforces corrected-point separation', () => {
    const peaks = new Set(['3,3', '6,3', '9,3', '3,9', '9,9'])
    const field = manualField(13, 13, (x, y) => ({
      evidence: peaks.has(`${x},${y}`) ? 0.8 : 0,
    }))
    const first = inventory(field).inventory
    const second = inventory(field).inventory

    expect(first).toEqual(second)
    expect(first.anchors.map((anchor) => anchor.fieldSampleIndex)).toEqual([
      3 * 13 + 3,
      3 * 13 + 6,
      3 * 13 + 9,
      9 * 13 + 3,
      9 * 13 + 9,
    ])
    for (let left = 0; left < first.anchors.length; left += 1) {
      for (let right = left + 1; right < first.anchors.length; right += 1) {
        const a = first.anchors[left]!.sample.point
        const b = first.anchors[right]!.sample.point
        expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThanOrEqual(
          first.minimumSeparation,
        )
      }
    }
  })

  it('admits only nested prefixes while retaining strong anchors and adding weaker evidence', () => {
    const strengths = new Map([
      ['4,4', 0.95],
      ['12,4', 0.75],
      ['20,4', 0.5],
      ['4,12', 0.3],
      ['12,12', 0.18],
      ['20,12', 0.08],
    ])
    const result = inventory(
      manualField(25, 17, (x, y) => ({
        evidence: strengths.get(`${x},${y}`) ?? 0,
      })),
    )
    const sweeps = [0, 0.2, 0.4, 0.6, 0.8, 1].map((detail) =>
      admitFlowingContoursAnchors(
        result.inventory,
        detail,
        result.accounting,
      ),
    )

    expect(sweeps[0]!.anchors).toEqual([])
    expect(sweeps.at(-1)!.anchors.length).toBeGreaterThan(
      result.inventory.strongAnchorCount,
    )
    expect(sweeps.at(-1)!.anchors.at(-1)!.strength).toBe('secondary')
    for (let index = 1; index < sweeps.length; index += 1) {
      const previous = sweeps[index - 1]!.anchors
      const current = sweeps[index]!.anchors
      expect(current.slice(0, previous.length)).toEqual(previous)
      expect(current.map((anchor) => anchor.id)).toEqual(
        result.inventory.anchors
          .slice(0, current.length)
          .map((anchor) => anchor.id),
      )
    }
  })

  it('preserves the exact legacy prefix through 1 and adds a nested coherent extension at 1.5 and 2', () => {
    const strengths = new Map([
      ['4,4', { evidence: 0.9, coherence: 1, ambiguity: 0 }],
      ['12,4', { evidence: 0.5, coherence: 1, ambiguity: 0 }],
      ['20,4', { evidence: 0.2, coherence: 1, ambiguity: 0 }],
      ['4,12', { evidence: 0.11, coherence: 0.25, ambiguity: 0.6 }],
      ['12,12', { evidence: 0.095, coherence: 0.25, ambiguity: 0.6 }],
      ['20,12', { evidence: 0.07, coherence: 0.25, ambiguity: 0.6 }],
    ])
    const source = manualField(
      25,
      17,
      (x, y) => strengths.get(`${x},${y}`) ?? {},
    )
    const legacy = inventory(source, 1).inventory
    const extended = inventory(source, 2).inventory
    const legacyHalf = admitFlowingContoursAnchors(
      legacy,
      0.5,
      createFlowingContoursAccounting(),
    )
    const extendedHalf = admitFlowingContoursAnchors(
      extended,
      0.5,
      createFlowingContoursAccounting(),
    )
    const atOne = admitFlowingContoursAnchors(
      extended,
      1,
      createFlowingContoursAccounting(),
    )
    const atOneAndHalf = admitFlowingContoursAnchors(
      extended,
      1.5,
      createFlowingContoursAccounting(),
    )
    const atTwo = admitFlowingContoursAnchors(
      extended,
      2,
      createFlowingContoursAccounting(),
    )

    expect(extended.anchors.slice(0, legacy.anchors.length)).toEqual(
      legacy.anchors,
    )
    expect(extendedHalf.anchors).toEqual(legacyHalf.anchors)
    expect(atOne.anchors).toEqual(legacy.anchors)
    expect(atOneAndHalf.anchors.slice(0, atOne.anchors.length)).toEqual(
      atOne.anchors,
    )
    expect(atTwo.anchors.slice(0, atOneAndHalf.anchors.length)).toEqual(
      atOneAndHalf.anchors,
    )
    expect(atOneAndHalf.anchors.length).toBeGreaterThan(
      atOne.anchors.length,
    )
    expect(atTwo.anchors.length).toBeGreaterThan(
      atOneAndHalf.anchors.length,
    )
    expect(
      atTwo.anchors.slice(extended.legacyAnchorCount).every(
        (anchor) => anchor.strength === 'extended',
      ),
    ).toBe(true)
  })

  it('is independent of authored detail before admission', () => {
    const field = manualField(33, 25, (x, y) => ({
      evidence:
        (x * 17 + y * 29) % 11 === 0
          ? 0.2 + (((x * 7 + y * 5) % 7) / 10)
          : 0,
    }))
    const first = inventory(field)
    const second = inventory(field)

    const low = admitFlowingContoursAnchors(
      first.inventory,
      0.25,
      first.accounting,
    )
    const high = admitFlowingContoursAnchors(
      second.inventory,
      0.9,
      second.accounting,
    )

    expect(first.inventory).toEqual(second.inventory)
    expect(high.anchors.slice(0, low.anchors.length)).toEqual(low.anchors)
    expect(high.anchors.length).toBeGreaterThanOrEqual(low.anchors.length)
  })

  it('caps noisy evidence through FC03 without changing its strongest prefix', () => {
    const field = manualField(67, 61, (x, y) => {
      const phase = (x * 73 + y * 151 + x * y * 17) % 997
      const angle = ((phase % 180) * Math.PI) / 180
      return {
        evidence: 0.35 + (phase % 53) / 100,
        tangent: [Math.cos(angle), Math.sin(angle)],
        coherence: 0.55,
        ambiguity: 0.45,
      }
    })
    const uncapped = inventory(field).inventory
    const accounting = createFlowingContoursAccounting()
    const limits = createFlowingContoursTestLimits({ 'anchor-count': 7 })!
    const capped = buildFlowingContoursAnchorInventory(
      field,
      accounting,
      limits,
    )

    expect(capped.anchors).toHaveLength(7)
    expect(capped.anchors).toEqual(uncapped.anchors.slice(0, 7))
    expect(accounting.termination).toBe('limit-reached')
    expect(accounting.limitedBy).toBe('anchor-count')
    const admitted = admitFlowingContoursAnchors(capped, 1, accounting)
    expect(admitted.anchors.length).toBeLessThanOrEqual(7)
    expect(accounting.eligibleAnchorCount).toBe(admitted.anchors.length)
  })

  it('keeps the high-detail extension bounded by the same noisy-field anchor cap', () => {
    const source = manualField(67, 61, (x, y) => {
      const phase = (x * 73 + y * 151 + x * y * 17) % 997
      const angle = ((phase % 180) * Math.PI) / 180
      return {
        evidence: 0.06 + (phase % 23) / 100,
        tangent: [Math.cos(angle), Math.sin(angle)],
        coherence: 0.3,
        ambiguity: 0.6,
      }
    })
    const uncapped = inventory(source, 2).inventory
    const accounting = createFlowingContoursAccounting()
    const limits = createFlowingContoursTestLimits({ 'anchor-count': 7 })!
    const capped = buildFlowingContoursAnchorInventory(
      source,
      accounting,
      limits,
      2,
    )
    const admitted = admitFlowingContoursAnchors(capped, 2, accounting)

    expect(capped.anchors).toHaveLength(7)
    expect(capped.anchors).toEqual(uncapped.anchors.slice(0, 7))
    expect(admitted.anchors.length).toBeLessThanOrEqual(7)
    expect(accounting.termination).toBe('limit-reached')
    expect(accounting.limitedBy).toBe('anchor-count')
  })

  it('returns deterministic finite deeply frozen results and exact accounting', () => {
    const field = manualField(19, 19, (x, y) => ({
      evidence: (x + y * 3) % 5 === 0 ? 0.7 : 0,
      tangent: [Math.SQRT1_2, Math.SQRT1_2],
      coherence: 0.9,
      ambiguity: 0.1,
      scale: 2,
    }))
    const first = inventory(field)
    const second = inventory(field)
    const admitted = admitFlowingContoursAnchors(
      first.inventory,
      0.75,
      first.accounting,
    )

    expect(first.inventory).toEqual(second.inventory)
    expect(Object.isFrozen(first.inventory)).toBe(true)
    expect(Object.isFrozen(first.inventory.anchors)).toBe(true)
    expect(Object.isFrozen(admitted)).toBe(true)
    expect(Object.isFrozen(admitted.anchors)).toBe(true)
    expect(first.accounting.correctedRidgeSampleCount).toBe(
      first.inventory.correctedRidgeSampleCount,
    )
    expect(first.accounting.eligibleAnchorCount).toBe(admitted.anchors.length)
    for (const anchor of first.inventory.anchors) {
      expect(Object.isFrozen(anchor)).toBe(true)
      expect(Object.isFrozen(anchor.sample)).toBe(true)
      expect(Object.isFrozen(anchor.sample.point)).toBe(true)
      expect(Object.isFrozen(anchor.sample.tangent)).toBe(true)
      expect(
        [
          anchor.selectionScore,
          anchor.sample.point[0],
          anchor.sample.point[1],
          anchor.sample.evidence,
          anchor.sample.coherence,
          anchor.sample.ambiguity,
          anchor.sample.scale,
          anchor.sample.alpha,
        ].every(Number.isFinite),
      ).toBe(true)
    }
  })
})
