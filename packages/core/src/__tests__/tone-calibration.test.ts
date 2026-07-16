import { afterEach, describe, expect, it, vi } from 'vitest'

const scribbleStrategyMock = vi.hoisted(() => vi.fn())

vi.mock('../scribbleStrategy/index', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../scribbleStrategy/index')
  >()
  scribbleStrategyMock.mockImplementation(actual.scribbleStrategy)
  return { ...actual, scribbleStrategy: scribbleStrategyMock }
})

import {
  defaultParams,
  generateToneCalibrationScribble as publicGenerateToneCalibrationScribble,
  renderToSVG,
  scribbleControlSchema,
  toneCalibration as publicToneCalibration,
  toneCalibrationSchema as publicToneCalibrationSchema,
} from '../index'
import type { ScribbleStrategyInput } from '../scribbleStrategy/index'
import { createScribbleModel } from '../scribbleStrategy/model'
import {
  generateToneCalibrationScribble,
  toneCalibration,
  toneCalibrationSchema,
} from '../sketches/tone-calibration'
import type { ToneCalibrationSource } from '../sketches/tone-calibration/source'

const FRAME = { width: 100, height: 100 }
const CONTROL_KEYS = [
  'pathDensity',
  'scribbleScale',
  'momentum',
  'chaos',
  'toneFidelity',
]

function params(overrides: Record<string, number> = {}) {
  return { ...defaultParams(toneCalibrationSchema), ...overrides }
}

function capturedInput(call: number): ScribbleStrategyInput {
  return scribbleStrategyMock.mock.calls[call]![0] as ScribbleStrategyInput
}

afterEach(() => {
  scribbleStrategyMock.mockClear()
})

describe('Tone Calibration Scribble integration', () => {
  it('publishes exactly the five shared strategy controls and no source controls', () => {
    expect(toneCalibration.id).toBe('tone-calibration')
    expect(toneCalibration.name).toBe('Tone Calibration')
    expect(toneCalibration.schema).toBe(toneCalibrationSchema)
    expect(toneCalibrationSchema).toBe(scribbleControlSchema)
    expect(Object.keys(toneCalibration.schema)).toEqual(CONTROL_KEYS)
    expect(defaultParams(toneCalibration.schema)).toEqual({
      pathDensity: 1,
      scribbleScale: 1,
      momentum: 0.75,
      chaos: 0.25,
      toneFidelity: 0.9,
    })
    expect(toneCalibration.schema).not.toHaveProperty('limits')
  })

  it('exports the Sketch, schema, and headless helper from the core entry point', () => {
    expect(publicToneCalibration).toBe(toneCalibration)
    expect(publicToneCalibrationSchema).toBe(toneCalibrationSchema)
    expect(publicGenerateToneCalibrationScribble).toBe(
      generateToneCalibrationScribble,
    )
  })

  it('changes routes by Seed alone while every consumed source stays invariant', () => {
    const sharedControls = params({
      momentum: 0,
      chaos: 0,
      toneFidelity: 0,
    })
    const changedControls = params({
      momentum: 1,
      chaos: 1,
      toneFidelity: 0,
    })
    const firstResult = generateToneCalibrationScribble(
      sharedControls,
      'a',
      FRAME,
    )
    const differentSeedResult = generateToneCalibrationScribble(
      sharedControls,
      'b',
      FRAME,
    )
    generateToneCalibrationScribble(changedControls, 'a', FRAME)
    const firstInput = capturedInput(0)
    const differentSeedInput = capturedInput(1)
    const changedControlsInput = capturedInput(2)
    const firstSource = firstInput.source as ToneCalibrationSource
    const differentSeedSource =
      differentSeedInput.source as ToneCalibrationSource
    const changedControlsSource =
      changedControlsInput.source as ToneCalibrationSource
    const latticeSnapshot = (input: ScribbleStrategyInput) =>
      createScribbleModel(input.source, input.frame, input.controls)
        .samples()
        .map(({ point, tone, permission }) => ({ point, tone, permission }))

    expect(firstInput.seed).toBe('a')
    expect(differentSeedInput.seed).toBe('b')
    expect(changedControlsInput.seed).toBe('a')
    expect(firstInput.controls).toEqual(sharedControls)
    expect(differentSeedInput.controls).toEqual(sharedControls)
    expect(changedControlsInput.controls).toEqual(changedControls)
    expect(firstSource).not.toBe(differentSeedSource)
    expect(firstSource).not.toBe(changedControlsSource)
    expect(firstSource.layout).toEqual({
      frame: FRAME,
      circle: { center: [50, 50], radius: 40, diameter: 80 },
    })
    expect(differentSeedSource.layout).toEqual(firstSource.layout)
    expect(changedControlsSource.layout).toEqual(firstSource.layout)
    expect([
      firstSource.toneField.sample([0, 0]),
      firstSource.toneField.sample([0, 25]),
      firstSource.toneField.sample([50, 10]),
      firstSource.toneField.sample([50, 30]),
      firstSource.toneField.sample([50, 50]),
      firstSource.toneField.sample([50, 70]),
      firstSource.toneField.sample([50, 90]),
      firstSource.toneField.sample([0, 100]),
    ]).toEqual([0, 0.25, 1, 0.75, 0.5, 0.25, 0, 1])
    const firstLattice = latticeSnapshot(firstInput)
    const differentSeedLattice = latticeSnapshot(differentSeedInput)
    const changedControlsLattice = latticeSnapshot(changedControlsInput)
    expect(firstLattice.every(({ permission }) => permission === 1)).toBe(true)
    expect(differentSeedLattice).toEqual(firstLattice)
    expect(changedControlsLattice).toEqual(firstLattice)
    expect(firstResult.polylines).not.toEqual(differentSeedResult.polylines)
  })

  it('returns an exactly repeatable headless result and Scene for the same Seed', () => {
    const controls = params({ toneFidelity: 0 })
    const first = generateToneCalibrationScribble(controls, 'a', FRAME)
    const second = generateToneCalibrationScribble(controls, 'a', FRAME)
    expect(second).toEqual(first)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))

    const scene = toneCalibration.generate(controls, 'a', -123, FRAME)
    const repeated = toneCalibration.generate(controls, 'a', 999, FRAME)
    expect(repeated).toEqual(scene)
    expect(scene.space).toEqual(FRAME)
    expect(scene.space).not.toBe(FRAME)
    expect(scene.primitives.map(({ points }) => points)).toEqual(first.polylines)
  })

  it('produces nonempty Scribble-only default artwork with a readable inversion', () => {
    const scene = toneCalibration.generate(params(), 'default', 0, FRAME)
    const strategyInput = capturedInput(0)
    const source = strategyInput.source as ToneCalibrationSource
    const coverageModel = createScribbleModel(
      source,
      strategyInput.frame,
      strategyInput.controls,
    )
    for (const { points } of scene.primitives) {
      for (let index = 1; index < points.length; index += 1) {
        coverageModel.depositSegment(points[index - 1]!, points[index]!)
      }
    }
    const samples = coverageModel.samples()
    const meanCoverage = (
      predicate: (x: number, y: number) => boolean,
    ): number => {
      const bin = samples.filter(({ point: [x, y] }) => predicate(x, y))
      expect(bin.length).toBeGreaterThan(0)
      return bin.reduce((sum, sample) => sum + sample.coverage, 0) / bin.length
    }
    const insideCircle = (x: number, y: number) =>
      (x - 50) ** 2 + (y - 50) ** 2 <= 40 ** 2

    expect(scene.primitives.length).toBeGreaterThan(0)
    expect(scene.background).toBeUndefined()

    for (const primitive of scene.primitives) {
      expect(primitive.closed).toBe(false)
      expect(primitive.fill).toBeUndefined()
      expect(primitive.stroke).toEqual({ color: 'black', width: 1 })
      expect(primitive.hiddenLineRole).toBeUndefined()
      expect(primitive.points.length).toBeGreaterThan(1)
    }

    // Equal-area lattice bins make the assertion insensitive to vertex spacing:
    // deposited virtual coverage follows the rising exterior ramp and the
    // opposing falling circle ramp from top through middle to bottom.
    const exteriorCoverage = [
      meanCoverage((x, y) => !insideCircle(x, y) && y < 20),
      meanCoverage((x, y) => !insideCircle(x, y) && y >= 40 && y < 60),
      meanCoverage((x, y) => !insideCircle(x, y) && y > 80),
    ]
    const circleCoverage = [
      meanCoverage((x, y) => insideCircle(x, y) && y < 30),
      meanCoverage((x, y) => insideCircle(x, y) && y >= 45 && y < 55),
      meanCoverage((x, y) => insideCircle(x, y) && y > 70),
    ]
    expect(exteriorCoverage[0]).toBeLessThan(exteriorCoverage[1]!)
    expect(exteriorCoverage[1]).toBeLessThan(exteriorCoverage[2]!)
    expect(circleCoverage[0]).toBeGreaterThan(circleCoverage[1]!)
    expect(circleCoverage[1]).toBeGreaterThan(circleCoverage[2]!)

    // One-and-a-half lattice cells on either side is the nearest robust
    // working-resolution comparison. The top pair reverses from dark circle to
    // light exterior; the bottom pair reverses from light circle to dark exterior.
    const boundaryOffset = coverageModel.lattice.cellWidth * 1.5
    const boundaryPair = (y: number) => {
      const boundaryX = 50 + Math.sqrt(40 ** 2 - (y - 50) ** 2)
      const inside: [number, number] = [boundaryX - boundaryOffset, y]
      const outside: [number, number] = [boundaryX + boundaryOffset, y]
      return {
        tone: [
          source.toneField.sample(inside),
          source.toneField.sample(outside),
        ],
        coverage: [
          coverageModel.coverageAt(inside),
          coverageModel.coverageAt(outside),
        ],
      }
    }
    const upperBoundary = boundaryPair(15)
    const lowerBoundary = boundaryPair(85)
    const upperCoverageContrast =
      upperBoundary.coverage[0]! - upperBoundary.coverage[1]!
    const lowerCoverageContrast =
      lowerBoundary.coverage[1]! - lowerBoundary.coverage[0]!
    expect(upperBoundary.tone).toEqual([0.9375, 0.15])
    expect(lowerBoundary.tone).toEqual([0.0625, 0.85])
    expect(upperCoverageContrast).toBeGreaterThan(0.4)
    expect(lowerCoverageContrast).toBeGreaterThan(0.8)

    // No closed circle, boundary guide, background, or grayscale primitive is
    // present: the hard edge is readable only through opposing mark coverage.
    expect(JSON.stringify(scene)).not.toMatch(
      /background|fill|gray|toneField|shadingMask|circle|guide/i,
    )
  })

  it('keeps forced budget-exhausted geometry visible through ordinary SVG export', () => {
    scribbleStrategyMock.mockReturnValueOnce({
      polylines: [
        [
          [10, 20],
          [30, 40],
          [50, 45],
        ],
      ],
      termination: 'budget-exhausted',
      residualError: 0.4,
    })

    const scene = toneCalibration.generate(params(), 'forced-budget', 0, FRAME)
    expect(scene.primitives).toEqual([
      {
        points: [
          [10, 20],
          [30, 40],
          [50, 45],
        ],
        closed: false,
        stroke: { color: 'black', width: 1 },
      },
    ])

    const svg = renderToSVG(scene, undefined, 'transparent')
    expect(svg).toContain('d="M10 20 L30 40 L50 45"')
    expect(svg).toContain('fill="none" stroke="black" stroke-width="1"')
    expect(svg).not.toMatch(/<circle|<rect/)
  })

  it('keeps Tone reference data separate from generated Scene geometry', () => {
    const source = toneCalibration.generateToneSource!(
      params({ chaos: 1, momentum: 0 }),
      FRAME,
    )
    const scene = toneCalibration.generate(
      params({ chaos: 1, momentum: 0, toneFidelity: 0 }),
      'reference-separation',
      0,
      FRAME,
    )

    expect(source.toneField.sample([0, 75])).toBe(0.75)
    expect(source.toneField.sample([50, 30])).toBe(0.75)
    expect(source.shadingMask.sample([50, 50])).toBe(1)
    expect(source).not.toHaveProperty('polylines')
    expect(JSON.stringify(scene)).not.toMatch(/toneField|shadingMask|layout/)
  })
})
