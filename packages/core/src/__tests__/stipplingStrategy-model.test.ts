import { describe, expect, it, vi } from 'vitest'

import { type CoordinateSpace } from '../scene'
import {
  createShadingMask,
  createToneField,
  type ToneSource,
} from '../shadingFields'
import {
  createStipplingModel,
  normalizeStipplingControls,
  resolveStipplingScales,
} from '../stipplingStrategy/model'
import {
  defaultStipplingControls,
  stipplingControlSchema,
  type StippleMark,
} from '../stipplingStrategy/types'

const FRAME = Object.freeze({ width: 1000, height: 1000 })

function source(tone = 1, permission = 1): ToneSource {
  return {
    toneField: createToneField(() => tone),
    shadingMask: createShadingMask(() => permission),
  }
}

function mark(
  center: readonly [number, number],
  orientation = 0,
): Readonly<StippleMark> {
  return Object.freeze({
    center: Object.freeze([...center] as [number, number]),
    orientation,
  })
}

describe('Stippling authored controls', () => {
  it('declares exactly two independent bounded controls and derives defaults', () => {
    expect(Object.keys(stipplingControlSchema)).toEqual([
      'stippleDensity',
      'distributionFidelity',
    ])

    for (const [name, spec] of Object.entries(stipplingControlSchema)) {
      expect(spec.kind, name).toBe('number')
      expect(spec.min, name).toBeLessThan(spec.max)
      expect(spec.default, name).toBeGreaterThanOrEqual(spec.min)
      expect(spec.default, name).toBeLessThanOrEqual(spec.max)
      expect(
        defaultStipplingControls[
          name as keyof typeof defaultStipplingControls
        ],
      ).toBe(spec.default)
    }
  })

  it('defaults non-finite inputs, clamps authored bounds, and freezes output', () => {
    const normalized = normalizeStipplingControls({
      stippleDensity: Number.NaN,
      distributionFidelity: 20,
    })

    expect(normalized).toEqual({
      stippleDensity: defaultStipplingControls.stippleDensity,
      distributionFidelity: stipplingControlSchema.distributionFidelity.max,
    })
    expect(
      normalizeStipplingControls({ stippleDensity: -20 }).stippleDensity,
    ).toBe(stipplingControlSchema.stippleDensity.min)
    expect(
      normalizeStipplingControls({
        distributionFidelity: Number.NEGATIVE_INFINITY,
      }).distributionFidelity,
    ).toBe(defaultStipplingControls.distributionFidelity)
    expect(Object.isFrozen(normalized)).toBe(true)
    expect(Object.isFrozen(defaultStipplingControls)).toBe(true)
    expect(Object.isFrozen(stipplingControlSchema)).toBe(true)
    expect(Object.isFrozen(stipplingControlSchema.stippleDensity)).toBe(true)
  })
})

describe('Stippling scale model', () => {
  it.each([
    { width: 0, height: 100 },
    { width: -1, height: 100 },
    { width: 100, height: Number.NaN },
    { width: Number.POSITIVE_INFINITY, height: 100 },
    { width: Number.MAX_VALUE, height: Number.MAX_VALUE },
  ])('rejects malformed frame $width × $height', (frame) => {
    expect(() => resolveStipplingScales(frame)).toThrow(
      /finite positive dimensions and area/,
    )
    expect(() => createStipplingModel(source(), frame)).toThrow(
      /finite positive dimensions and area/,
    )
  })

  it('keeps near-dot and permission-check geometry fixed across controls', () => {
    const looseSparse = resolveStipplingScales(FRAME, {
      stippleDensity: stipplingControlSchema.stippleDensity.min,
      distributionFidelity: stipplingControlSchema.distributionFidelity.min,
    })
    const faithfulDense = resolveStipplingScales(FRAME, {
      stippleDensity: stipplingControlSchema.stippleDensity.max,
      distributionFidelity: stipplingControlSchema.distributionFidelity.max,
    })

    expect(looseSparse.stippleLength).toBe(3)
    expect(looseSparse.maskCheckSpacing).toBe(0.75)
    expect(faithfulDense.stippleLength).toBe(looseSparse.stippleLength)
    expect(faithfulDense.maskCheckSpacing).toBe(
      looseSparse.maskCheckSpacing,
    )
  })

  it('uses density alone to increase abundance and tighten spacing', () => {
    const sparse = resolveStipplingScales(FRAME, { stippleDensity: 0.5 })
    const dense = resolveStipplingScales(FRAME, {
      stippleDensity: 2,
      distributionFidelity: 1,
    })
    const denseLoose = resolveStipplingScales(FRAME, {
      stippleDensity: 2,
      distributionFidelity: 0,
    })

    expect(dense.targetCount).toBe(sparse.targetCount * 4)
    expect(dense.minimumSpacing).toBeCloseTo(
      sparse.minimumSpacing / 2,
      12,
    )
    expect(denseLoose).toEqual(dense)
    expect(Object.isFrozen(dense)).toBe(true)
  })
})

describe('Stippling effective-demand model', () => {
  it('samples tone times permission on equal-area center cells', () => {
    const model = createStipplingModel(source(0.8, 0.5), {
      width: 120,
      height: 80,
    })

    expect(model.lattice.sampleCount).toBe(
      model.lattice.columns * model.lattice.rows,
    )
    expect(model.lattice.cellArea).toBeCloseTo(
      (120 * 80) / model.lattice.sampleCount,
      12,
    )
    expect(model.lattice.samples[0]).toMatchObject({
      tone: 0.8,
      permission: 0.5,
      demand: 0.4,
    })
    expect(model.lattice.samples[0]!.point).toEqual([
      model.lattice.cellWidth / 2,
      model.lattice.cellHeight / 2,
    ])
    expect(model.lattice.averageDemand).toBeCloseTo(0.4, 12)
  })

  it('applies soft permission linearly to demand and target abundance', () => {
    const full = createStipplingModel(source(1, 1), FRAME)
    const soft = createStipplingModel(source(1, 0.5), FRAME)

    expect(soft.lattice.demandSum).toBeCloseTo(
      full.lattice.demandSum * 0.5,
      12,
    )
    expect(soft.scales.targetCount).toBe(full.scales.targetCount * 0.5)
  })

  it('keeps empty demand bounded and skips forbidden tone sampling', () => {
    const toneProducer = vi.fn(() => 1)
    const model = createStipplingModel(
      {
        toneField: createToneField(toneProducer),
        shadingMask: createShadingMask(() => 0),
      },
      FRAME,
    )

    expect(toneProducer).not.toHaveBeenCalled()
    expect(model.lattice.demandSum).toBe(0)
    expect(model.scales.targetCount).toBe(0)
    expect(model.distributionError([])).toBe(0)
    expect(model.distributionError([mark([500, 500])])).toBe(1)
  })

  it('deep-freezes target structures without reordering actual marks', () => {
    const model = createStipplingModel(source(), FRAME)
    const marks = Object.freeze([
      mark([750, 500], 1),
      mark([250, 500], 2),
    ])
    const before = [...marks]

    model.distributionError(marks)

    expect(marks).toEqual(before)
    expect(Object.isFrozen(model)).toBe(true)
    expect(Object.isFrozen(model.frame)).toBe(true)
    expect(Object.isFrozen(model.controls)).toBe(true)
    expect(Object.isFrozen(model.scales)).toBe(true)
    expect(Object.isFrozen(model.lattice)).toBe(true)
    expect(Object.isFrozen(model.lattice.samples)).toBe(true)
    expect(Object.isFrozen(model.lattice.samples[0])).toBe(true)
    expect(Object.isFrozen(model.lattice.samples[0]!.point)).toBe(true)
    expect(Object.isFrozen(marks[0])).toBe(true)
    expect(Object.isFrozen(marks[0]!.center)).toBe(true)
  })

  it('reports finite partial error invariant under proportional scaling', () => {
    const smallFrame = { width: 200, height: 100 }
    const largeFrame = { width: 600, height: 300 }
    const small = createStipplingModel(source(0.75), smallFrame)
    const large = createStipplingModel(source(0.75), largeFrame)
    const normalizedMarks = [
      [0.1, 0.2],
      [0.6, 0.7],
      [0.9, 0.4],
    ] as const
    const marksFor = (frame: CoordinateSpace) =>
      normalizedMarks.map(([x, y], index) =>
        mark([x * frame.width, y * frame.height], index * 0.4),
      )

    const partialError = small.distributionError(marksFor(smallFrame))

    expect(Number.isFinite(partialError)).toBe(true)
    expect(partialError).toBeGreaterThanOrEqual(0)
    expect(partialError).toBeLessThanOrEqual(2)
    expect(small.distributionError([])).toBe(1)
    expect(large.scales.targetCount).toBe(small.scales.targetCount)
    expect(large.scales.stippleLength).toBeCloseTo(
      small.scales.stippleLength * 3,
      12,
    )
    expect(large.scales.minimumSpacing).toBeCloseTo(
      small.scales.minimumSpacing * 3,
      12,
    )
    expect(large.distributionError(marksFor(largeFrame))).toBeCloseTo(
      partialError,
      12,
    )
  })
})
