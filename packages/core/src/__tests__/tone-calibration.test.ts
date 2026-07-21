import { afterEach, describe, expect, it, vi } from 'vitest'

const scribbleStrategyMock = vi.hoisted(() => vi.fn())
const stipplingStrategyMock = vi.hoisted(() => vi.fn())

vi.mock('../scribbleStrategy/index', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../scribbleStrategy/index')
  >()
  scribbleStrategyMock.mockImplementation(actual.scribbleStrategy)
  return { ...actual, scribbleStrategy: scribbleStrategyMock }
})

vi.mock('../stipplingStrategy/index', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../stipplingStrategy/index')
  >()
  stipplingStrategyMock.mockImplementation(actual.stipplingStrategy)
  return { ...actual, stipplingStrategy: stipplingStrategyMock }
})

import {
  applyPreset,
  defaultParams,
  deserialize,
  generateToneCalibrationScribble as publicGenerateToneCalibrationScribble,
  hiddenLinePass,
  renderPlotterSVG,
  renderToSVG,
  scribbleControlSchema,
  stipplingControlSchema,
  toneCalibration as publicToneCalibration,
  toneCalibrationSchema as publicToneCalibrationSchema,
  validateParamSchema,
} from '../index'
import type { ShadingProgress } from '../shadingStrategy'
import type { ScribbleStrategyInput } from '../scribbleStrategy/index'
import { createScribbleModel } from '../scribbleStrategy/model'
import type { StipplingStrategyInput } from '../stipplingStrategy/index'
import {
  generateToneCalibrationScribble,
  toneCalibration,
  toneCalibrationSchema,
} from '../sketches/tone-calibration'
import neatPreset from '../sketches/tone-calibration/presets/neat.json'
import type { ToneCalibrationSource } from '../sketches/tone-calibration/source'
import type { Point, Polyline } from '../types'

const FRAME = { width: 100, height: 100 }
const SCRIBBLE_CONTROL_KEYS = [
  'pathDensity',
  'scribbleScale',
  'momentum',
  'chaos',
  'toneFidelity',
  'stopPoint',
] as const
const STIPPLING_CONTROL_KEYS = [
  'stippleDensity',
  'distributionFidelity',
  'voronoiRelaxation',
] as const
const CONTROL_KEYS = [
  'strategy',
  ...SCRIBBLE_CONTROL_KEYS,
  ...STIPPLING_CONTROL_KEYS,
] as const

function params(overrides: Record<string, unknown> = {}) {
  return { ...defaultParams(toneCalibrationSchema), ...overrides }
}

function scribbleControlValues(values: Record<string, unknown>) {
  return Object.fromEntries(
    SCRIBBLE_CONTROL_KEYS.map((key) => [key, values[key]]),
  )
}

function capturedScribbleInput(call: number): ScribbleStrategyInput {
  return scribbleStrategyMock.mock.calls[call]![0] as ScribbleStrategyInput
}

function capturedStipplingInput(call: number): StipplingStrategyInput {
  return stipplingStrategyMock.mock.calls[call]![0] as StipplingStrategyInput
}

function squaredDistanceToSegment(
  point: Readonly<Point>,
  start: Readonly<Point>,
  end: Readonly<Point>,
): number {
  const segmentX = end[0] - start[0]
  const segmentY = end[1] - start[1]
  const lengthSquared = segmentX * segmentX + segmentY * segmentY
  const projection =
    lengthSquared === 0
      ? 0
      : Math.min(
          1,
          Math.max(
            0,
            ((point[0] - start[0]) * segmentX +
              (point[1] - start[1]) * segmentY) /
              lengthSquared,
          ),
        )
  const nearestX = start[0] + projection * segmentX
  const nearestY = start[1] + projection * segmentY
  return (point[0] - nearestX) ** 2 + (point[1] - nearestY) ** 2
}

/**
 * Raster-like center sampling of the geometry's actual one-unit black stroke.
 * This deliberately knows nothing about the strategy's virtual coverage model.
 */
function rasterizeInk(
  polylines: readonly Polyline[],
  frame: Readonly<{ width: number; height: number }>,
  strokeWidth: number,
): Uint8Array {
  const width = Math.round(frame.width)
  const height = Math.round(frame.height)
  const ink = new Uint8Array(width * height)
  const radius = strokeWidth / 2
  const radiusSquared = radius * radius

  for (const polyline of polylines) {
    for (let index = 1; index < polyline.length; index += 1) {
      const start = polyline[index - 1]!
      const end = polyline[index]!
      const minColumn = Math.max(
        0,
        Math.ceil(Math.min(start[0], end[0]) - radius - 0.5),
      )
      const maxColumn = Math.min(
        width - 1,
        Math.floor(Math.max(start[0], end[0]) + radius - 0.5),
      )
      const minRow = Math.max(
        0,
        Math.ceil(Math.min(start[1], end[1]) - radius - 0.5),
      )
      const maxRow = Math.min(
        height - 1,
        Math.floor(Math.max(start[1], end[1]) + radius - 0.5),
      )

      for (let row = minRow; row <= maxRow; row += 1) {
        for (let column = minColumn; column <= maxColumn; column += 1) {
          if (
            squaredDistanceToSegment(
              [column + 0.5, row + 0.5],
              start,
              end,
            ) <= radiusSquared
          ) {
            ink[row * width + column] = 1
          }
        }
      }
    }
  }

  return ink
}

function inkRatio(
  ink: Uint8Array,
  frame: Readonly<{ width: number; height: number }>,
  predicate: (x: number, y: number) => boolean = () => true,
): number {
  const width = Math.round(frame.width)
  const height = Math.round(frame.height)
  let marked = 0
  let sampled = 0

  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const x = column + 0.5
      const y = row + 0.5
      if (!predicate(x, y)) continue
      sampled += 1
      marked += ink[row * width + column]!
    }
  }

  expect(sampled).toBeGreaterThan(0)
  return marked / sampled
}

afterEach(() => {
  scribbleStrategyMock.mockClear()
  stipplingStrategyMock.mockClear()
})

describe('Tone Calibration Shading integration', () => {
  it('publishes Strategy first and exact strategy controls with conditional applicability', () => {
    expect(toneCalibration.id).toBe('tone-calibration')
    expect(toneCalibration.name).toBe('Tone Calibration')
    expect(toneCalibration.schema).toBe(toneCalibrationSchema)
    expect(Object.keys(toneCalibration.schema)).toEqual(CONTROL_KEYS)
    expect(toneCalibrationSchema.strategy).toEqual({
      kind: 'choice',
      options: [
        { value: 'scribble', label: 'Scribble' },
        { value: 'stippling', label: 'Stippling' },
      ],
      default: 'scribble',
    })
    for (const key of SCRIBBLE_CONTROL_KEYS) {
      expect(toneCalibrationSchema[key]).toEqual({
        ...scribbleControlSchema[key],
        activeWhen: { key: 'strategy', equals: 'scribble' },
      })
      expect(toneCalibrationSchema[key]).not.toBe(scribbleControlSchema[key])
    }
    for (const key of STIPPLING_CONTROL_KEYS) {
      expect(toneCalibrationSchema[key]).toEqual({
        ...stipplingControlSchema[key],
        activeWhen: { key: 'strategy', equals: 'stippling' },
      })
      expect(toneCalibrationSchema[key]).not.toBe(
        stipplingControlSchema[key],
      )
    }
    expect(defaultParams(toneCalibration.schema)).toEqual({
      strategy: 'scribble',
      pathDensity: 1,
      scribbleScale: 1,
      momentum: 0.75,
      chaos: 0.25,
      toneFidelity: 0.9,
      stopPoint: 100,
      stippleDensity: 1,
      distributionFidelity: 0.5,
      voronoiRelaxation: 0,
    })
    expect(() => validateParamSchema(toneCalibrationSchema)).not.toThrow()
    expect(toneCalibration.schema).not.toHaveProperty('limits')
  })

  it('exports the Sketch, schema, and headless helper from the core entry point', () => {
    expect(publicToneCalibration).toBe(toneCalibration)
    expect(publicToneCalibrationSchema).toBe(toneCalibrationSchema)
    expect(publicGenerateToneCalibrationScribble).toBe(
      generateToneCalibrationScribble,
    )
  })

  it('reconciles the existing neat Preset to Scribble defaults without changing its prior geometry', () => {
    const preset = deserialize(neatPreset)
    const reconciled = applyPreset(toneCalibrationSchema, preset)
    const legacy = generateToneCalibrationScribble(
      preset.params,
      preset.seed,
      FRAME,
    )
    const current = toneCalibration.generate(
      reconciled.params,
      reconciled.seed,
      0,
      FRAME,
    )

    expect(reconciled.params).toEqual({
      strategy: 'scribble',
      ...preset.params,
      stippleDensity: 1,
      distributionFidelity: 0.5,
      voronoiRelaxation: 0,
    })
    expect(current.primitives.map(({ points }) => points)).toEqual(
      legacy.polylines,
    )
    expect(stipplingStrategyMock).not.toHaveBeenCalled()
  })

  it('dispatches Stippling explicitly with the unchanged source and exact cold/prepared parity', () => {
    const controls = params({
      strategy: 'stippling',
      stippleDensity: 0.25,
      distributionFidelity: 0,
      voronoiRelaxation: 0.5,
      // Inactive Scribble state must not leak into Stippling controls or source.
      pathDensity: 19.7,
      chaos: 1,
    })
    const progress: ShadingProgress[] = []
    const artwork = toneCalibration.generateShadingArtwork!(
      controls,
      'stipple-dispatch',
      FRAME,
      (snapshot) => progress.push(snapshot),
    )
    const input = capturedStipplingInput(0)
    const scribbleSource = toneCalibration.generateToneSource!(
      params({ strategy: 'scribble' }),
      FRAME,
    ) as ToneCalibrationSource
    const stipplingSource = input.source as ToneCalibrationSource

    expect(scribbleStrategyMock).not.toHaveBeenCalled()
    expect(input.frame).toBe(FRAME)
    expect(input.seed).toBe('stipple-dispatch')
    expect(input.controls).toEqual({
      stippleDensity: 0.25,
      distributionFidelity: 0,
      voronoiRelaxation: 0.5,
    })
    expect(input.source).not.toBe(scribbleSource)
    expect(stipplingSource.layout).toEqual(scribbleSource.layout)
    for (const point of [
      [0, 0],
      [0, 25],
      [50, 10],
      [50, 30],
      [50, 50],
      [50, 70],
      [50, 90],
      [0, 100],
    ] as const) {
      expect(stipplingSource.toneField.sample(point)).toBe(
        scribbleSource.toneField.sample(point),
      )
      expect(stipplingSource.shadingMask.sample(point)).toBe(
        scribbleSource.shadingMask.sample(point),
      )
    }
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.at(-1)?.terminal).toBe(true)
    expect(artwork.diagnostics).toEqual({
      termination: expect.stringMatching(/^(completed|budget-exhausted)$/),
      pathLength: expect.any(Number),
      polylineCount: artwork.scene.primitives.length,
      penLiftCount: Math.max(0, artwork.scene.primitives.length - 1),
      fidelity: {
        kind: 'stippling',
        distributionError: expect.any(Number),
      },
    })
    expect(
      artwork.diagnostics.fidelity.kind === 'stippling' &&
        Number.isFinite(artwork.diagnostics.fidelity.distributionError),
    ).toBe(true)
    expect(
      toneCalibration.generate(controls, 'stipple-dispatch', 999, FRAME),
    ).toEqual(artwork.scene)
  })

  it('completes all 160k retained marks at maximum Stipple density', () => {
    const artwork = toneCalibration.generateShadingArtwork!(
      params({
        strategy: 'stippling',
        stippleDensity: stipplingControlSchema.stippleDensity.max,
        distributionFidelity: 0,
      }),
      'maximum-stipple-density',
      FRAME,
    )

    expect(artwork.diagnostics.termination).toBe('completed')
    expect(artwork.scene.primitives).toHaveLength(160_000)
    expect(artwork.diagnostics.polylineCount).toBe(160_000)
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
    const firstInput = capturedScribbleInput(0)
    const differentSeedInput = capturedScribbleInput(1)
    const changedControlsInput = capturedScribbleInput(2)
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
    expect(firstInput.controls).toEqual(scribbleControlValues(sharedControls))
    expect(differentSeedInput.controls).toEqual(
      scribbleControlValues(sharedControls),
    )
    expect(changedControlsInput.controls).toEqual(
      scribbleControlValues(changedControls),
    )
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

  it('prepares exactly the cold Scene with public progress and scalar-only diagnostics', () => {
    const controls = params({ toneFidelity: 0 })
    const progress: ShadingProgress[] = []
    const artwork = toneCalibration.generateShadingArtwork!(
      controls,
      'capability',
      FRAME,
      (snapshot) => progress.push(snapshot),
    )

    expect(artwork.scene).toEqual(
      toneCalibration.generate(controls, 'capability', 123, FRAME),
    )
    expect(artwork.diagnostics).toEqual({
      termination: 'completed',
      pathLength: expect.any(Number),
      polylineCount: artwork.scene.primitives.length,
      penLiftCount: Math.max(0, artwork.scene.primitives.length - 1),
      fidelity: { kind: 'scribble', residualError: expect.any(Number) },
    })
    expect(artwork.diagnostics.pathLength).toBeGreaterThan(0)
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.at(-1)?.terminal).toBe(true)
    expect(artwork).not.toHaveProperty('polylines')
    expect(artwork.diagnostics).not.toHaveProperty('polylines')
  })

  it('preserves generated Scribble paths through hidden-line plotter export', () => {
    const scene = toneCalibration.generate(
      params({ toneFidelity: 0 }),
      'hidden-line-export',
      0,
      FRAME,
    )
    const outline = hiddenLinePass(scene)
    const svg = renderPlotterSVG(outline, {
      width: 120,
      height: 120,
      insets: { top: 10, right: 10, bottom: 10, left: 10 },
      includeFrame: false,
      toolWidthMillimeters: 0.3,
    })
    const paths = svg.match(/<path\b[^>]*>/g) ?? []

    expect(scene.primitives.length).toBeGreaterThan(0)
    expect(outline.primitives.map(({ points }) => points)).toEqual(
      scene.primitives.map(({ points }) => points),
    )
    expect(paths).toHaveLength(scene.primitives.length)
  })

  it('produces nonempty Scribble-only default artwork with a readable inversion', () => {
    const scene = toneCalibration.generate(params(), 'default', 0, FRAME)
    const strategyInput = capturedScribbleInput(0)
    const source = strategyInput.source as ToneCalibrationSource
    const insideCircle = (x: number, y: number) =>
      (x - 50) ** 2 + (y - 50) ** 2 <= 40 ** 2
    const ink = rasterizeInk(
      scene.primitives.map(({ points }) => points),
      FRAME,
      1,
    )

    expect(scene.primitives.length).toBeGreaterThan(0)
    expect(scene.background).toBeUndefined()

    for (const primitive of scene.primitives) {
      expect(primitive.closed).toBe(false)
      expect(primitive.fill).toBeUndefined()
      expect(primitive.stroke).toEqual({ color: 'black', width: 1 })
      expect(primitive.hiddenLineRole).toBe('source')
      expect(primitive.points.length).toBeGreaterThan(1)
    }

    // Raster-like center sampling measures the returned geometry rather than
    // replaying its curve-refinement points as extra virtual solver passes.
    const exteriorInk = [
      inkRatio(ink, FRAME, (x, y) => !insideCircle(x, y) && y < 20),
      inkRatio(
        ink,
        FRAME,
        (x, y) => !insideCircle(x, y) && y >= 40 && y < 60,
      ),
      inkRatio(ink, FRAME, (x, y) => !insideCircle(x, y) && y > 80),
    ]
    const circleInk = [
      inkRatio(ink, FRAME, (x, y) => insideCircle(x, y) && y < 30),
      inkRatio(
        ink,
        FRAME,
        (x, y) => insideCircle(x, y) && y >= 45 && y < 55,
      ),
      inkRatio(ink, FRAME, (x, y) => insideCircle(x, y) && y > 70),
    ]
    expect(exteriorInk[0]).toBeLessThan(exteriorInk[1]!)
    expect(exteriorInk[1]).toBeLessThan(exteriorInk[2]!)
    expect(circleInk[0]).toBeGreaterThan(circleInk[1]!)
    expect(circleInk[1]).toBeGreaterThan(circleInk[2]!)

    const radius = (x: number, y: number) => Math.hypot(x - 50, y - 50)
    const upperInside = inkRatio(
      ink,
      FRAME,
      (x, y) => insideCircle(x, y) && y < 20 && radius(x, y) > 34,
    )
    const upperOutside = inkRatio(
      ink,
      FRAME,
      (x, y) => !insideCircle(x, y) && y < 20 && radius(x, y) < 46,
    )
    const lowerInside = inkRatio(
      ink,
      FRAME,
      (x, y) => insideCircle(x, y) && y > 80 && radius(x, y) > 34,
    )
    const lowerOutside = inkRatio(
      ink,
      FRAME,
      (x, y) => !insideCircle(x, y) && y > 80 && radius(x, y) < 46,
    )
    expect(source.toneField.sample([50, 15])).toBe(0.9375)
    expect(source.toneField.sample([0, 15])).toBe(0.15)
    expect(source.toneField.sample([50, 85])).toBe(0.0625)
    expect(source.toneField.sample([0, 85])).toBe(0.85)
    expect(upperInside - upperOutside).toBeGreaterThan(0.25)
    expect(lowerOutside - lowerInside).toBeGreaterThan(0.25)

    // No closed circle, boundary guide, background, or grayscale primitive is
    // present: the hard edge is readable only through opposing mark coverage.
    expect(JSON.stringify(scene)).not.toMatch(
      /background|fill|gray|toneField|shadingMask|circle|guide/i,
    )
  })

  it('produces deterministic, legible Stippling using only finite open two-point micro-strokes', () => {
    const controls = params({
      strategy: 'stippling',
      distributionFidelity: 0.2,
    })
    const first = toneCalibration.generateShadingArtwork!(
      controls,
      'stipple-legibility',
      FRAME,
    )
    const second = toneCalibration.generateShadingArtwork!(
      controls,
      'stipple-legibility',
      FRAME,
    )
    const { scene } = first
    const insideCircle = (x: number, y: number) =>
      (x - 50) ** 2 + (y - 50) ** 2 <= 40 ** 2

    expect(second).toEqual(first)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(scene.primitives.length).toBeGreaterThan(0)
    expect(scene.background).toBeUndefined()
    for (const primitive of scene.primitives) {
      expect(primitive).toMatchObject({
        closed: false,
        stroke: { color: 'black', width: 0.2, lineCap: 'round' },
        hiddenLineRole: 'source',
      })
      expect(primitive.fill).toBeUndefined()
      expect(primitive.points).toHaveLength(2)
      expect(
        primitive.points.every(([x, y]) =>
          Number.isFinite(x) && Number.isFinite(y),
        ),
      ).toBe(true)
    }

    const ink = rasterizeInk(
      scene.primitives.map(({ points }) => points),
      FRAME,
      1,
    )
    const exteriorInk = [
      inkRatio(ink, FRAME, (x, y) => !insideCircle(x, y) && y < 25),
      inkRatio(
        ink,
        FRAME,
        (x, y) => !insideCircle(x, y) && y >= 37.5 && y < 62.5,
      ),
      inkRatio(ink, FRAME, (x, y) => !insideCircle(x, y) && y >= 75),
    ]
    const circleInk = [
      inkRatio(ink, FRAME, (x, y) => insideCircle(x, y) && y < 25),
      inkRatio(
        ink,
        FRAME,
        (x, y) => insideCircle(x, y) && y >= 37.5 && y < 62.5,
      ),
      inkRatio(ink, FRAME, (x, y) => insideCircle(x, y) && y >= 75),
    ]

    expect(exteriorInk[0]).toBeLessThan(exteriorInk[1]!)
    expect(exteriorInk[1]).toBeLessThan(exteriorInk[2]!)
    expect(circleInk[0]).toBeGreaterThan(circleInk[1]!)
    expect(circleInk[1]).toBeGreaterThan(circleInk[2]!)

    const radius = (x: number, y: number) => Math.hypot(x - 50, y - 50)
    const upperInside = inkRatio(
      ink,
      FRAME,
      (x, y) => insideCircle(x, y) && y < 25 && radius(x, y) > 32,
    )
    const upperOutside = inkRatio(
      ink,
      FRAME,
      (x, y) => !insideCircle(x, y) && y < 25 && radius(x, y) < 48,
    )
    const lowerInside = inkRatio(
      ink,
      FRAME,
      (x, y) => insideCircle(x, y) && y >= 75 && radius(x, y) > 32,
    )
    const lowerOutside = inkRatio(
      ink,
      FRAME,
      (x, y) => !insideCircle(x, y) && y >= 75 && radius(x, y) < 48,
    )
    expect(upperInside).toBeGreaterThan(upperOutside)
    expect(lowerOutside).toBeGreaterThan(lowerInside)
    expect(JSON.stringify(scene)).not.toMatch(
      /background|fill|gray|toneField|shadingMask|circle|guide/i,
    )
  })

  it('renders materially dense, opposing tones at the calibrated dense fine scale', () => {
    const renderFrame = { width: 1000, height: 1000 }
    const fineDense = generateToneCalibrationScribble(
      params({
        pathDensity: 10,
        scribbleScale: 0.5,
      }),
      'density-range',
      renderFrame,
    )
    const ink = rasterizeInk(fineDense.polylines, renderFrame, 1)
    const insideCircle = (x: number, y: number) =>
      (x - 500) ** 2 + (y - 500) ** 2 <= 400 ** 2
    const exteriorInk = [
      inkRatio(ink, renderFrame, (x, y) => !insideCircle(x, y) && y < 200),
      inkRatio(
        ink,
        renderFrame,
        (x, y) => !insideCircle(x, y) && y >= 400 && y < 600,
      ),
      inkRatio(ink, renderFrame, (x, y) => !insideCircle(x, y) && y > 800),
    ]
    const circleInk = [
      inkRatio(ink, renderFrame, (x, y) => insideCircle(x, y) && y < 300),
      inkRatio(
        ink,
        renderFrame,
        (x, y) => insideCircle(x, y) && y >= 450 && y < 550,
      ),
      inkRatio(ink, renderFrame, (x, y) => insideCircle(x, y) && y > 700),
    ]
    const overallInk = inkRatio(ink, renderFrame)

    expect(fineDense.termination).toBe('completed')
    expect(overallInk).toBeGreaterThan(0.4)
    expect(exteriorInk[2]).toBeGreaterThan(0.6)
    expect(circleInk[0]).toBeGreaterThan(0.6)
    expect(exteriorInk[0]).toBeLessThan(exteriorInk[1]!)
    expect(exteriorInk[1]).toBeLessThan(exteriorInk[2]!)
    expect(circleInk[0]).toBeGreaterThan(circleInk[1]!)
    expect(circleInk[1]).toBeGreaterThan(circleInk[2]!)
    expect(exteriorInk[2]! - exteriorInk[0]!).toBeGreaterThan(0.45)
    expect(circleInk[0]! - circleInk[2]!).toBeGreaterThan(0.4)
  })

  it('keeps forced budget-exhausted artwork valid and visible through ordinary SVG export', () => {
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

    const artwork = toneCalibration.generateShadingArtwork!(
      params(),
      'forced-budget',
      FRAME,
    )
    const { scene } = artwork
    expect(artwork.diagnostics).toEqual({
      termination: 'budget-exhausted',
      pathLength: Math.hypot(20, 20) + Math.hypot(20, 5),
      polylineCount: 1,
      penLiftCount: 0,
      fidelity: { kind: 'scribble', residualError: 0.4 },
    })
    expect(scene.primitives).toEqual([
      {
        points: [
          [10, 20],
          [30, 40],
          [50, 45],
        ],
        closed: false,
        stroke: { color: 'black', width: 1 },
        hiddenLineRole: 'source',
      },
    ])

    const svg = renderToSVG(scene, undefined, 'transparent')
    expect(svg).toContain('d="M10 20 L30 40 L50 45"')
    expect(svg).toContain('fill="none" stroke="black" stroke-width="1"')
    expect(svg).not.toMatch(/<circle|<rect/)
  })

  it('keeps bounded partial Stippling as valid visible artwork with typed diagnostics', () => {
    stipplingStrategyMock.mockReturnValueOnce({
      polylines: [
        [
          [10, 20],
          [10.25, 20],
        ],
        [
          [30, 40],
          [30, 40.25],
        ],
      ],
      termination: 'budget-exhausted',
      distributionError: 0.4,
    })

    const artwork = toneCalibration.generateShadingArtwork!(
      params({ strategy: 'stippling' }),
      'forced-stipple-budget',
      FRAME,
    )

    expect(artwork.diagnostics).toEqual({
      termination: 'budget-exhausted',
      pathLength: 0.5,
      polylineCount: 2,
      penLiftCount: 1,
      fidelity: { kind: 'stippling', distributionError: 0.4 },
    })
    expect(artwork.scene.primitives).toEqual([
      {
        points: [
          [10, 20],
          [10.25, 20],
        ],
        closed: false,
        stroke: { color: 'black', width: 0.2, lineCap: 'round' },
        hiddenLineRole: 'source',
      },
      {
        points: [
          [30, 40],
          [30, 40.25],
        ],
        closed: false,
        stroke: { color: 'black', width: 0.2, lineCap: 'round' },
        hiddenLineRole: 'source',
      },
    ])
  })

  it('derives both physical widths by restyling the exact completed Scribble paths only', () => {
    scribbleStrategyMock.mockReturnValueOnce({
      polylines: [
        [
          [7, 11],
          [13, 17],
          [19, 23],
        ],
        [
          [29, 31],
          [37, 41],
        ],
      ],
      termination: 'completed',
      residualError: 0.01,
    })
    const completed = toneCalibration.generateShadingArtwork!(
      params(),
      'exact-prepared-result',
      FRAME,
    ).scene

    const fine = toneCalibration.deriveOutlineSource!(completed, {
      toolWidthMillimeters: 0.5,
      millimetersPerSceneUnit: 0.25,
    })
    const broad = toneCalibration.deriveOutlineSource!(completed, {
      toolWidthMillimeters: 1,
      millimetersPerSceneUnit: 0.25,
    })

    expect(fine).toEqual({
      space: FRAME,
      primitives: [
        {
          points: [
            [7, 11],
            [13, 17],
            [19, 23],
          ],
          closed: false,
          stroke: { color: 'black', width: 2 },
          hiddenLineRole: 'source',
        },
        {
          points: [
            [29, 31],
            [37, 41],
          ],
          closed: false,
          stroke: { color: 'black', width: 2 },
          hiddenLineRole: 'source',
        },
      ],
    })
    expect(
      broad.primitives.map(({ stroke: _stroke, ...primitive }) => primitive),
    ).toEqual(
      fine.primitives.map(({ stroke: _stroke, ...primitive }) => primitive),
    )
    expect(broad.primitives.map(({ stroke }) => stroke?.width)).toEqual([4, 4])
    expect(fine.primitives[0]?.points).not.toBe(
      completed.primitives[0]?.points,
    )
    expect(completed.primitives.map(({ stroke }) => stroke?.width)).toEqual([
      1, 1,
    ])
    expect(fine).not.toHaveProperty('background')
    expect(
      fine.primitives.every((primitive) => primitive.fill === undefined),
    ).toBe(true)
    expect(JSON.stringify(fine)).not.toMatch(
      /toneField|shadingMask|layout|circle|grayscale|background|fill/,
    )
  })

  it('uses the shared Hidden-line simplification path without changing physical width', () => {
    const completed = {
      space: FRAME,
      primitives: [
        {
          points: [
            [0, 10],
            [10, 10.05],
            [20, 9.95],
            [30, 10],
          ],
          closed: false,
          stroke: { color: 'navy', width: 9 },
          hiddenLineRole: 'source' as const,
        },
      ],
    }
    const source = toneCalibration.deriveOutlineSource!(completed, {
      toolWidthMillimeters: 0.3,
      millimetersPerSceneUnit: 0.15,
    })

    expect(hiddenLinePass(source, { tolerance: 0.1 })).toEqual({
      space: FRAME,
      primitives: [
        {
          points: [
            [0, 10],
            [30, 10],
          ],
          stroke: { color: 'black', width: 2 },
        },
      ],
    })
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
