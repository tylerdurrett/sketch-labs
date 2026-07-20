import { describe, expect, it, vi } from 'vitest'

import { resolveCompositionFrame } from '../compositionFrame'
import {
  createScribbleScaleField,
  type ScribbleScaleField,
} from '../scribbleScaleField'
import {
  createShadingMask,
  createToneField,
  type ToneSource,
} from '../shadingFields'
import {
  createScribbleModel,
  normalizeScribbleControls,
  resolveScribbleLattice,
  resolveScribbleScales,
} from '../scribbleStrategy/model'
import {
  defaultScribbleControls,
  scribbleControlSchema,
} from '../scribbleStrategy/types'
import {
  constantTone,
  featheredBoundaryMask,
  horizontalGradientTone,
  whiteHoleTone,
} from './shadingFieldFixtures'

const SQUARE = resolveCompositionFrame(1)

function source(
  toneField = constantTone(0.8),
  shadingMask = createShadingMask(() => 1),
): ToneSource {
  return { toneField, shadingMask }
}

describe('Scribble authored controls', () => {
  it('declares exactly the six bounded controls and derives their defaults', () => {
    expect(Object.keys(scribbleControlSchema)).toEqual([
      'pathDensity',
      'scribbleScale',
      'momentum',
      'chaos',
      'toneFidelity',
      'stopPoint',
    ])

    for (const [name, spec] of Object.entries(scribbleControlSchema)) {
      expect(spec.kind, name).toBe('number')
      expect(spec.min, name).toBeLessThan(spec.max)
      expect(spec.default, name).toBeGreaterThanOrEqual(spec.min)
      expect(spec.default, name).toBeLessThanOrEqual(spec.max)
      expect(defaultScribbleControls[name as keyof typeof defaultScribbleControls]).toBe(
        spec.default,
      )
    }

    expect(scribbleControlSchema.pathDensity.max).toBe(20)
    expect(scribbleControlSchema.scribbleScale.min).toBe(0.1)
    expect(scribbleControlSchema.stopPoint).toMatchObject({
      min: 0,
      max: 100,
      default: 100,
      step: 1,
      integer: true,
    })
  })

  it('defaults, bounds, and rounds Stop point as an authored percentage', () => {
    expect(normalizeScribbleControls({}).stopPoint).toBe(100)
    expect(normalizeScribbleControls({ stopPoint: -1 }).stopPoint).toBe(0)
    expect(normalizeScribbleControls({ stopPoint: 50.6 }).stopPoint).toBe(51)
  })

  it('uses defaults for missing/non-finite values and authored bounds otherwise', () => {
    expect(
      normalizeScribbleControls({
        pathDensity: Number.NaN,
        scribbleScale: -10,
        momentum: 10,
      }),
    ).toEqual({
      ...defaultScribbleControls,
      scribbleScale: scribbleControlSchema.scribbleScale.min,
      momentum: scribbleControlSchema.momentum.max,
    })
  })
})

describe('Scribble coherent scale model', () => {
  it('derives segment, coverage, residual, and mask-check lengths at fixed ratios', () => {
    const scales = resolveScribbleScales(SQUARE)

    expect(scales.segmentLength / scales.frameScale).toBeCloseTo(0.012, 12)
    expect(scales.coverageRadius / scales.segmentLength).toBeCloseTo(1.5, 12)
    expect(scales.residualSpacing / scales.segmentLength).toBeCloseTo(1.125, 12)
    expect(scales.maskCheckSpacing / scales.segmentLength).toBeCloseTo(0.25, 12)

    const doubled = resolveScribbleScales(SQUARE, { scribbleScale: 2 })
    expect(doubled.segmentLength).toBeCloseTo(scales.segmentLength * 2, 12)
    expect(doubled.coverageRadius).toBeCloseTo(scales.coverageRadius * 2, 12)
    expect(doubled.residualSpacing).toBeCloseTo(scales.residualSpacing * 2, 12)
    expect(doubled.maskCheckSpacing).toBeCloseTo(
      scales.maskCheckSpacing * 2,
      12,
    )

    const fineDense = resolveScribbleScales(SQUARE, {
      scribbleScale: 0.1,
      pathDensity: 20,
    })
    expect(fineDense.segmentLength).toBeCloseTo(scales.segmentLength * 0.1, 12)
    expect(fineDense.coveragePerPass).toBeCloseTo(
      scales.coveragePerPass / 20,
      12,
    )
  })

  it('is equal-area comparable for square, portrait, and landscape frames', () => {
    const square = resolveCompositionFrame(1)
    const portrait = resolveCompositionFrame(2 / 3)
    const landscape = resolveCompositionFrame(3 / 2)
    const scaleModels = [square, portrait, landscape].map((frame) =>
      resolveScribbleScales(frame),
    )

    expect(scaleModels.map(({ frameScale }) => frameScale)).toEqual([
      1000,
      1000,
      1000,
    ])
    expect(scaleModels.map(({ segmentLength }) => segmentLength)).toEqual([
      12,
      12,
      12,
    ])

    const portraitLattice = resolveScribbleLattice(
      portrait,
      scaleModels[1]!.residualSpacing,
    )
    const landscapeLattice = resolveScribbleLattice(
      landscape,
      scaleModels[2]!.residualSpacing,
    )
    expect(portraitLattice.columns).toBe(landscapeLattice.rows)
    expect(portraitLattice.rows).toBe(landscapeLattice.columns)
    expect(portraitLattice.sampleCount).toBe(landscapeLattice.sampleCount)
    expect(portraitLattice.cellArea).toBeCloseTo(
      landscapeLattice.cellArea,
      12,
    )

    const residuals = [square, portrait, landscape].map((frame) => ({
      constant: createScribbleModel(source(constantTone(0.6)), frame).residualError(),
      gradient: createScribbleModel(
        source(horizontalGradientTone(frame)),
        frame,
      ).residualError(),
    }))
    for (const residual of residuals) {
      expect(residual.constant).toBeCloseTo(0.6, 12)
      expect(residual.gradient).toBeCloseTo(0.5, 12)
    }
  })

  it('builds deterministic equal-area cells sampled at their centers', () => {
    const lattice = resolveScribbleLattice({ width: 120, height: 80 }, 20)
    const model = createScribbleModel(
      source(),
      { width: 120, height: 80 },
      { scribbleScale: 2 },
    )

    expect(lattice).toMatchObject({ columns: 6, rows: 4, sampleCount: 24 })
    expect(lattice.cellArea).toBe(400)
    const samples = model.samples()
    expect(samples[0]!.point).toEqual([
      model.lattice.cellWidth / 2,
      model.lattice.cellHeight / 2,
    ])
    expect(samples.at(-1)!.point[0]).toBeCloseTo(
      120 - model.lattice.cellWidth / 2,
      12,
    )
    expect(samples.at(-1)!.point[1]).toBeCloseTo(
      80 - model.lattice.cellHeight / 2,
      12,
    )
    expect(model.samples()).toEqual(samples)
  })

  it('resolves analytic fine, intermediate, and broad local scales at exact coupled ratios', () => {
    const scaleField = createScribbleScaleField(
      1,
      ([x]) => 1 + (2 * x) / SQUARE.width,
    )
    const model = createScribbleModel(source(), SQUARE, {}, scaleField)

    const fine = model.localScalesAt([0, 500])
    const intermediate = model.localScalesAt([500, 500])
    const broad = model.localScalesAt([1000, 500])

    expect(fine).toBe(model.scales)
    expect(
      [fine, intermediate, broad].map(({ segmentLength }) => segmentLength),
    ).toEqual([12, 24, 36])
    for (const local of [fine, intermediate, broad]) {
      expect(local.coverageRadius / local.segmentLength).toBeCloseTo(1.5, 12)
      expect(local.maskCheckSpacing / local.segmentLength).toBeCloseTo(0.25, 12)
    }
  })

  it('keeps authored scales, controls, lattice, and residual samples globally fixed with a field', () => {
    const toneSource = source(
      horizontalGradientTone(SQUARE),
      featheredBoundaryMask(SQUARE),
    )
    const controls = {
      pathDensity: 2.5,
      scribbleScale: 0.5,
      momentum: 0.6,
      chaos: 0.4,
      toneFidelity: 0.75,
      stopPoint: 80,
    }
    const uniform = createScribbleModel(toneSource, SQUARE, controls)
    const variable = createScribbleModel(
      toneSource,
      SQUARE,
      controls,
      createScribbleScaleField(0.5, ([x]) => 0.5 + x / 100),
    )

    expect(variable.controls).toEqual(uniform.controls)
    expect(variable.scales).toEqual(uniform.scales)
    expect(variable.scales.coveragePerPass).toBe(
      uniform.scales.coveragePerPass,
    )
    expect(variable.scales.completionThreshold).toBe(
      uniform.scales.completionThreshold,
    )
    expect(variable.lattice).toEqual(uniform.lattice)
    expect(variable.samples()).toEqual(uniform.samples())
    expect(variable.residualError()).toBe(uniform.residualError())
  })

  it('falls back atomically to authored fine scales for invalid samples and scene-unit overflow', () => {
    const invalidSamples = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      0,
    ]

    for (const sample of invalidSamples) {
      const model = createScribbleModel(
        source(),
        SQUARE,
        {},
        createScribbleScaleField(1, () => sample),
      )
      expect(model.localScalesAt([500, 500])).toBe(model.scales)
    }

    const overflowingField: ScribbleScaleField = {
      kind: 'scribble-scale-field',
      sample: () => Number.MAX_VALUE,
    }
    const overflowing = createScribbleModel(
      source(),
      SQUARE,
      {},
      overflowingField,
    )

    expect(overflowing.localScalesAt([500, 500])).toBe(overflowing.scales)
    expect(
      Object.values(overflowing.localScalesAt([500, 500])).every(
        Number.isFinite,
      ),
    ).toBe(true)
  })

  it('profiles exact segments deterministically at authored-fine-safe stations including endpoints', () => {
    const producer = vi.fn(([x]: Readonly<[number, number]>) => 1 + x / 12)
    const model = createScribbleModel(
      source(),
      SQUARE,
      {},
      createScribbleScaleField(1, producer),
    )
    const beforeSamples = model.samples()
    const beforeResidual = model.residualError()

    const first = model.profileSegment([0, 10], [12, 10])!
    const second = model.profileSegment([0, 10], [12, 10])!

    expect(first).toEqual(second)
    expect(first.samples.map(({ point }) => point)).toEqual([
      [0, 10],
      [3, 10],
      [6, 10],
      [9, 10],
      [12, 10],
    ])
    expect(first.samples.map(({ progress }) => progress)).toEqual([
      0,
      0.25,
      0.5,
      0.75,
      1,
    ])
    expect(first.minimumSegmentLength).toBe(12)
    expect(first.minimumMaskCheckSpacing).toBe(3)
    expect(first.maximumCoverageRadius).toBe(36)
    for (let index = 1; index < first.samples.length; index++) {
      const previous = first.samples[index - 1]!.point
      const current = first.samples[index]!.point
      expect(
        Math.hypot(current[0] - previous[0], current[1] - previous[1]),
      ).toBeLessThanOrEqual(model.scales.maskCheckSpacing)
    }
    expect(producer).toHaveBeenCalledTimes(first.samples.length * 2)
    expect(model.samples()).toEqual(beforeSamples)
    expect(model.residualError()).toBe(beforeResidual)
  })

  it('profiles a zero-length segment once and declines non-finite or unsafe geometry', () => {
    const producer = vi.fn(() => 2)
    const model = createScribbleModel(
      source(),
      SQUARE,
      {},
      createScribbleScaleField(1, producer),
    )

    const point = model.profileSegment([4, 5], [4, 5])!
    expect(point.length).toBe(0)
    expect(point.samples).toHaveLength(1)
    expect(point.samples[0]).toMatchObject({ point: [4, 5], progress: 0 })
    expect(producer).toHaveBeenCalledTimes(1)
    expect(model.profileSegment([Number.NaN, 0], [1, 0])).toBeUndefined()
    expect(model.profileSegment([0, 0], [Number.MAX_VALUE, 0])).toBeUndefined()
  })

  it('uses one conservative field-aware segment predicate for length, mask, and frame safety', () => {
    const fineBand = createScribbleScaleField(1, ([x]) =>
      x >= 5 && x <= 7 ? 1 : 2,
    )
    const model = createScribbleModel(source(), SQUARE, {}, fineBand)

    expect(model.isSegmentSafe([0, 10], [10, 10])).toBe(true)
    expect(model.isSegmentSafe([0, 10], [20, 10])).toBe(false)
    expect(model.isSegmentSafe([995, 10], [1005, 10])).toBe(false)

    const narrowMask = createShadingMask(([x]) => (x === 3 ? 0 : 1))
    const narrowFineStation = createScribbleScaleField(1, ([x]) =>
      x === 3 ? 1 : 2,
    )
    const masked = createScribbleModel(
      source(constantTone(1), narrowMask),
      SQUARE,
      {},
      narrowFineStation,
    )
    expect(masked.isSegmentSafe([0, 10], [12, 10])).toBe(false)
  })

  it('retains the original uniform mask path when no field is present', () => {
    const sample = vi.fn(() => 1)
    const model = createScribbleModel(
      source(constantTone(1), createShadingMask(sample)),
      SQUARE,
    )
    sample.mockClear()

    expect(model.scaleField).toBeUndefined()
    expect(model.isSegmentSafe([0, 10], [30, 10])).toBe(true)
    expect(sample.mock.calls.map(([point]) => point)).toEqual([
      [0, 10],
      [3, 10],
      [6, 10],
      [9, 10],
      [12, 10],
      [15, 10],
      [18, 10],
      [21, 10],
      [24, 10],
      [27, 10],
      [30, 10],
    ])
  })
})

describe('Scribble residual model', () => {
  it('samples a continuous Tone Field without jumps at lattice-cell boundaries', () => {
    const model = createScribbleModel(
      source(horizontalGradientTone(SQUARE)),
      SQUARE,
    )
    const boundaryX = model.lattice.cellWidth
    const epsilon = model.lattice.cellWidth * 1e-6
    const y = model.lattice.cellHeight / 2
    const left = [boundaryX - epsilon, y] as const
    const right = [boundaryX + epsilon, y] as const

    expect(model.residualAt(left)).toBeCloseTo(left[0] / SQUARE.width, 12)
    expect(model.residualAt(right)).toBeCloseTo(right[0] / SQUARE.width, 12)
    expect(Math.abs(model.residualAt(right) - model.residualAt(left))).toBeLessThan(
      (epsilon * 3) / SQUARE.width,
    )
  })

  it('measures constant tone and horizontal gradient by cell-center average', () => {
    const constant = createScribbleModel(source(constantTone(0.6)), SQUARE)
    const gradient = createScribbleModel(
      source(horizontalGradientTone(SQUARE)),
      SQUARE,
    )

    expect(constant.residualError()).toBeCloseTo(0.6, 12)
    expect(gradient.residualError()).toBeCloseTo(0.5, 12)
  })

  it('retains the exact-white hole as zero demand rather than mask prohibition', () => {
    const model = createScribbleModel(source(whiteHoleTone(SQUARE)), SQUARE)
    const center = model.samples().find(
      ({ point }) =>
        Math.abs(point[0] - SQUARE.width / 2) < model.lattice.cellWidth &&
        Math.abs(point[1] - SQUARE.height / 2) < model.lattice.cellHeight,
    )!
    const dark = model.samples().find(
      ({ point }) => point[0] < 100 && point[1] < 100,
    )!

    expect(center.tone).toBe(0)
    expect(center.permission).toBe(1)
    expect(center.residual).toBe(0)
    expect(dark.tone).toBe(0.8)
    expect(dark.residual).toBe(0.8)
  })

  it('keeps target tone and feathered permission separate in the residual sum', () => {
    const model = createScribbleModel(
      source(constantTone(0.8), featheredBoundaryMask(SQUARE)),
      SQUARE,
    )
    const samples = model.samples()
    const expected =
      samples.reduce(
        (sum, sample) =>
          sum + sample.permission * Math.max(0, sample.tone - sample.coverage),
        0,
      ) / samples.length
    const soft = samples.find(
      ({ permission }) => permission > 0 && permission < 1,
    )!
    const forbidden = samples.find(({ permission }) => permission === 0)!

    expect(soft.tone).toBe(0.8)
    expect(soft.residual).toBeCloseTo(soft.permission * 0.8, 12)
    expect(forbidden.tone).toBe(0.8)
    expect(forbidden.residual).toBe(0)
    expect(model.residualError()).toBeCloseTo(expected, 12)
  })

  it('returns finite zero for zero permission and zero demand', () => {
    const forbidden = createScribbleModel(
      source(constantTone(1), createShadingMask(() => 0)),
      SQUARE,
    )
    const paper = createScribbleModel(
      source(createToneField(() => 0)),
      SQUARE,
    )

    for (const model of [forbidden, paper]) {
      expect(model.residualError()).toBe(0)
      expect(Number.isFinite(model.residualError())).toBe(true)
      expect(model.samples().every(({ residual }) => residual === 0)).toBe(true)
    }
  })

  it('keeps normalized residuals finite and within [0, 1]', () => {
    const model = createScribbleModel(
      source(createToneField(() => Number.POSITIVE_INFINITY)),
      SQUARE,
    )
    expect(model.residualError()).toBeGreaterThanOrEqual(0)
    expect(model.residualError()).toBeLessThanOrEqual(1)
    expect(Number.isFinite(model.residualError())).toBe(true)
  })
})

describe('Scribble virtual coverage', () => {
  it('reconstructs deposited coverage without jumps at lattice-cell boundaries', () => {
    const model = createScribbleModel(source(constantTone(1)), SQUARE)
    const firstCenter = model.samples()[0]!.point
    const boundaryX = model.lattice.cellWidth
    const epsilon = model.lattice.cellWidth * 1e-6
    const left = [boundaryX - epsilon, firstCenter[1]] as const
    const right = [boundaryX + epsilon, firstCenter[1]] as const

    model.depositPoint(firstCenter)

    expect(Math.abs(model.coverageAt(right) - model.coverageAt(left))).toBeLessThan(
      1e-5,
    )
    expect(Math.abs(model.residualAt(right) - model.residualAt(left))).toBeLessThan(
      1e-5,
    )
  })

  it('keeps the cached residual equal to the residual sample sum', () => {
    const model = createScribbleModel(
      source(horizontalGradientTone(SQUARE), featheredBoundaryMask(SQUARE)),
      SQUARE,
      { pathDensity: 3.5, scribbleScale: 0.5 },
    )
    const segments = [
      [[100, 100], [350, 225]],
      [[350, 225], [700, 500]],
      [[700, 500], [900, 850]],
      [[200, 800], [800, 200]],
    ] as const

    for (const [start, end] of segments) {
      model.depositSegment(start, end)
      const samples = model.samples()
      const independentlySummed =
        samples.reduce((sum, sample) => sum + sample.residual, 0) /
        samples.length
      expect(model.residualError()).toBeCloseTo(independentlySummed, 12)
    }
  })

  it('deposits compact smooth coverage additively and reduces residual monotonically', () => {
    const model = createScribbleModel(source(constantTone(1)), SQUARE)
    const centerSample = model.samples()[Math.floor(model.lattice.sampleCount / 2)]!
    const center = centerSample.point
    const far = model.samples()[0]!.point
    const initialError = model.residualError()

    model.depositPoint(center)
    const firstCoverage = model.coverageAt(center)
    const firstError = model.residualError()
    model.depositPoint(center)
    const secondCoverage = model.coverageAt(center)
    const secondError = model.residualError()

    expect(firstCoverage).toBeCloseTo(model.scales.coveragePerPass, 12)
    expect(secondCoverage).toBeCloseTo(firstCoverage * 2, 12)
    expect(model.coverageAt(far)).toBe(0)
    expect(firstError).toBeLessThan(initialError)
    expect(secondError).toBeLessThan(firstError)

    const covered = model
      .samples()
      .filter(({ coverage }) => coverage > 0)
      .sort((a, b) => a.coverage - b.coverage)
    expect(covered.length).toBeGreaterThan(1)
    expect(covered[0]!.coverage).toBeLessThan(
      covered.at(-1)!.coverage,
    )
  })

  it('applies a continuous footprint along a complete segment', () => {
    const model = createScribbleModel(source(constantTone(1)), SQUARE)
    const y = SQUARE.height / 2
    model.depositSegment([SQUARE.width * 0.25, y], [SQUARE.width * 0.75, y])

    expect(model.coverageAt([SQUARE.width * 0.5, y])).toBeGreaterThan(0)
    expect(model.coverageAt([SQUARE.width * 0.1, y])).toBe(0)
  })

  it('makes path density inversely control per-pass coverage', () => {
    const sparse = createScribbleModel(source(constantTone(1)), SQUARE, {
      pathDensity: 1,
    })
    const dense = createScribbleModel(source(constantTone(1)), SQUARE, {
      pathDensity: 2,
    })
    const point = sparse.samples()[Math.floor(sparse.lattice.sampleCount / 2)]!.point

    sparse.depositPoint(point)
    dense.depositPoint(point)

    expect(dense.scales.coveragePerPass).toBeCloseTo(
      sparse.scales.coveragePerPass / 2,
      12,
    )
    expect(dense.coverageAt(point)).toBeCloseTo(sparse.coverageAt(point) / 2, 12)
    expect(dense.residualError()).toBeGreaterThan(sparse.residualError())
  })
})
