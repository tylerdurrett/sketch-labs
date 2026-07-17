import { describe, expect, it } from 'vitest'

import { resolveCompositionFrame } from '../compositionFrame'
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
  it('declares exactly the five bounded controls and derives their defaults', () => {
    expect(Object.keys(scribbleControlSchema)).toEqual([
      'pathDensity',
      'scribbleScale',
      'momentum',
      'chaos',
      'toneFidelity',
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
