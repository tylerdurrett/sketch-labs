import { describe, expect, it } from 'vitest'

import type { DecodedPixels } from '../imageAssets'
import { createRasterContainFit } from '../rasterSampling'
import { resolveCompositionFrame } from '../compositionFrame'
import { createFlowingContoursAccounting } from '../sketches/flowing-contours/accounting'
import { buildFlowingContoursField } from '../sketches/flowing-contours/field'
import {
  flowingContoursPathIsClosedForTest,
  generateFlowingContours,
  type FlowingContoursGeneratorInput,
} from '../sketches/flowing-contours/generator'
import { runFlowingContoursPipeline } from '../sketches/flowing-contours/pipeline'
import { prepareFlowingContoursRaster } from '../sketches/flowing-contours/raster'
import type { FlowingContoursControls } from '../sketches/flowing-contours/controls'
import type { Point } from '../types'

const FRAME = Object.freeze({ width: 1000, height: 1000 })
const CONTROLS: Readonly<FlowingContoursControls> = Object.freeze({
  curveDetail: 1,
  continuity: 0.6,
  flowSmoothing: 0.8,
  minimumStrokeLength: 0.005,
})

function raster(
  width: number,
  height: number,
  at: (
    x: number,
    y: number,
  ) => readonly [number, number, number, number],
): DecodedPixels {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.set(at(x, y), (y * width + x) * 4)
    }
  }
  return { width, height, data }
}

function boundaryRaster(
  width: number,
  height: number,
  boundaryX: (y: number) => number,
): DecodedPixels {
  return raster(width, height, (x, y) =>
    x < boundaryX(y)
      ? [20, 20, 20, 255]
      : [235, 235, 235, 255],
  )
}

function generate(
  pixels: DecodedPixels,
  overrides: Partial<FlowingContoursGeneratorInput> = {},
) {
  return generateFlowingContours({
    pixels,
    frame: FRAME,
    controls: CONTROLS,
    ...overrides,
  })
}

function pathLength(
  points: readonly Readonly<Point>[],
  closed = false,
): number {
  let length = 0
  for (let index = 1; index < points.length; index += 1) {
    length += Math.hypot(
      points[index]![0] - points[index - 1]![0],
      points[index]![1] - points[index - 1]![1],
    )
  }
  if (
    closed &&
    (points[0]![0] !== points.at(-1)![0] ||
      points[0]![1] !== points.at(-1)![1])
  ) {
    length += Math.hypot(
      points[0]![0] - points.at(-1)![0],
      points[0]![1] - points.at(-1)![1],
    )
  }
  return length
}

function allPoints(result: ReturnType<typeof generateFlowingContours>) {
  return result.scene.primitives.flatMap((primitive) => primitive.points)
}

describe('Flowing Contours generator', () => {
  it('contain-fits from original source dimensions and preserves a long straight gesture', () => {
    const source = boundaryRaster(80, 40, (y) => 35 + y * 0.2)
    const result = generate(source)
    const fit = createRasterContainFit(source, FRAME)!

    expect(result.scene.space).toEqual(FRAME)
    expect(result.scene.primitives.length).toBeGreaterThan(0)
    expect(result.diagnostics.primitiveCount).toBe(
      result.scene.primitives.length,
    )
    for (const point of allPoints(result)) {
      expect(point[0]).toBeGreaterThanOrEqual(fit.left)
      expect(point[0]).toBeLessThanOrEqual(fit.right)
      expect(point[1]).toBeGreaterThanOrEqual(fit.top)
      expect(point[1]).toBeLessThanOrEqual(fit.bottom)
    }
    expect(
      Math.max(
        ...result.scene.primitives.map((primitive) =>
          pathLength(primitive.points, primitive.closed),
        ),
      ),
    ).toBeGreaterThan(fit.fittedHeight * 0.7)
  })

  it('uses source aspect rather than a rounded analysis aspect', () => {
    const source = boundaryRaster(1024, 513, (y) => 480 + y * 0.1)
    const frame = resolveCompositionFrame(0.8)
    const result = generate(source, { frame })
    const fit = createRasterContainFit(source, frame)!

    expect(result.scene.primitives.length).toBeGreaterThan(0)
    for (const point of allPoints(result)) {
      expect(point[0]).toBeGreaterThanOrEqual(fit.left)
      expect(point[0]).toBeLessThanOrEqual(fit.right)
      expect(point[1]).toBeGreaterThanOrEqual(fit.top)
      expect(point[1]).toBeLessThanOrEqual(fit.bottom)
    }
  })

  it.each([
    ['diagonal', (y: number) => 12 + y * 0.8],
    ['curved', (y: number) => 34 + 10 * Math.sin(y / 10)],
  ])('maps a coherent %s boundary without inventing stumps', (_name, edge) => {
    const result = generate(boundaryRaster(80, 64, edge))
    const lengths = result.scene.primitives.map((primitive) =>
      pathLength(primitive.points, primitive.closed),
    )

    expect(lengths.length).toBeGreaterThan(0)
    expect(Math.max(...lengths)).toBeGreaterThan(500)
    expect(lengths.every((length) => length >= 5)).toBe(true)
    expect(
      result.scene.primitives.every(
        (primitive) => primitive.points.length >= 3,
      ),
    ).toBe(true)
  })

  it('recognizes only complete repeated-endpoint trajectories as closed loops', () => {
    expect(
      flowingContoursPathIsClosedForTest([
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
        [1, 0],
      ]),
    ).toBe(true)
    expect(
      flowingContoursPathIsClosedForTest([
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ]),
    ).toBe(false)
    expect(
      flowingContoursPathIsClosedForTest([
        [0, 0],
        [1, 0],
        [0, 0],
      ]),
    ).toBe(false)
  })

  it('reapplies the authored mapped minimum to every final primitive', () => {
    const source = boundaryRaster(96, 55, (y) => 44 + 8 * Math.sin(y / 8))
    const minimumStrokeLength = 0.2
    const result = generate(source, {
      controls: { ...CONTROLS, minimumStrokeLength },
    })
    const fit = createRasterContainFit(source, FRAME)!
    const minimum =
      minimumStrokeLength * Math.hypot(fit.fittedWidth, fit.fittedHeight)

    expect(result.scene.primitives.length).toBeGreaterThan(0)
    for (const primitive of result.scene.primitives) {
      expect(pathLength(primitive.points, primitive.closed)).toBeGreaterThanOrEqual(
        minimum - 1e-8,
      )
    }
    expect(result.diagnostics.acceptedCandidateCount).toBe(
      result.scene.primitives.length,
    )
    expect(result.diagnostics.rawTrajectoryCount).toBe(
      result.scene.primitives.length,
    )
    expect(result.diagnostics.fittedCurveCount).toBe(
      result.scene.primitives.length,
    )
  })

  it('emits finite black stroke-only generic Hidden-line sources in stable order', () => {
    const source = raster(90, 70, (x, y) => {
      const first = x < 28 + 4 * Math.sin(y / 9)
      const second = x < 62 + 5 * Math.sin((y + 3) / 11)
      const value = first ? 20 : second ? 125 : 235
      return [value, value, value, 255]
    })
    const first = generate(source)
    const second = generate(source)

    expect(first).toEqual(second)
    expect(first.scene.primitives.length).toBeGreaterThanOrEqual(2)
    for (const primitive of first.scene.primitives) {
      expect(primitive.stroke).toEqual({ color: 'black', width: 1 })
      expect(primitive.fill).toBeUndefined()
      expect(primitive.hiddenLineRole).toBe('source')
      expect(primitive.points.every((point) => point.every(Number.isFinite))).toBe(
        true,
      )
    }
  })

  it('does not clip contain-fitted geometry to any downstream Page Frame', () => {
    const source = boundaryRaster(64, 64, () => 5)
    const result = generate(source)
    const minimumX = Math.min(...allPoints(result).map((point) => point[0]))

    expect(result.scene.primitives.length).toBeGreaterThan(0)
    // A hypothetical 10% Page Frame inset would begin at x=100. Generation
    // composes only to the supplied Composition Frame, so source geometry may
    // remain outside that downstream inset.
    expect(minimumX).toBeLessThan(100)
  })

  it('stops at transparent support and ignores RGB hidden behind zero alpha', () => {
    const first = raster(80, 50, (x) => {
      if (x >= 36 && x <= 43) return [255, 0, 255, 0]
      return x < 40 ? [20, 20, 20, 255] : [235, 235, 235, 255]
    })
    const second = raster(80, 50, (x) => {
      if (x >= 36 && x <= 43) return [0, 255, 0, 0]
      return x < 40 ? [20, 20, 20, 255] : [235, 235, 235, 255]
    })

    expect(generate(first)).toEqual(generate(second))
  })

  it('keeps alpha-boundary geometry on the positive-support side', () => {
    const source = raster(80, 50, (x) =>
      x < 40 ? [80, 80, 80, 255] : [255, 0, 255, 0],
    )
    const result = generate(source)
    const fit = createRasterContainFit(source, FRAME)!
    const supportBoundary = fit.left + fit.fittedWidth / 2

    expect(result.scene.primitives.length).toBeGreaterThan(0)
    expect(
      allPoints(result).every(
        (point) => point[0] <= supportBoundary + fit.fittedWidth / 80,
      ),
    ).toBe(true)
  })

  it('returns complete empty Scenes for flat, transparent, and tiny valid inputs', () => {
    for (const source of [
      raster(24, 16, () => [120, 120, 120, 255]),
      raster(24, 16, () => [255, 0, 255, 0]),
      raster(1, 1, () => [0, 0, 0, 255]),
      raster(1, 31, () => [0, 0, 0, 255]),
    ]) {
      const result = generate(source)
      expect(result.scene.primitives).toEqual([])
      expect(result.diagnostics.termination).toBe('complete')
      expect(result.diagnostics.primitiveCount).toBe(0)
    }
  })

  it.each([
    null,
    {},
    { width: 0, height: 1, data: new Uint8Array() },
    { width: 1, height: 1, data: new Uint8Array(3) },
    { width: 1, height: 1, data: [0, 0, 0, 255] },
    {
      width: Number.MAX_SAFE_INTEGER,
      height: Number.MAX_SAFE_INTEGER,
      data: new Uint8Array(),
    },
  ])('fails malformed decoded input closed (%o)', (pixels) => {
    const result = generateFlowingContours({
      pixels: pixels as unknown as DecodedPixels,
      frame: FRAME,
      controls: CONTROLS,
    })

    expect(result.scene.primitives).toEqual([])
    expect(result.diagnostics.termination).toBe('invalid-input')
    expect(result.diagnostics.primitiveCount).toBe(0)
  })

  it('fails hostile top-level and frame inputs closed', () => {
    const hostile = Object.defineProperty({}, 'pixels', {
      get() {
        throw new Error('hostile input')
      },
    })
    const hostileFrame = Object.defineProperty({}, 'width', {
      get() {
        throw new Error('hostile frame')
      },
    })

    for (const input of [
      hostile,
      {
        pixels: raster(8, 8, () => [0, 0, 0, 255]),
        frame: hostileFrame,
        controls: CONTROLS,
      },
    ]) {
      const result = generateFlowingContours(
        input as unknown as FlowingContoursGeneratorInput,
      )
      expect(result.scene.primitives).toEqual([])
      expect(result.diagnostics.termination).toBe('invalid-input')
    }
  })

  it('normalizes malformed and hostile controls through declared defaults', () => {
    const source = boundaryRaster(64, 48, () => 31)
    const hostile = Object.defineProperty({}, 'flowSmoothing', {
      get() {
        throw new Error('hostile control')
      },
    })

    const expected = generate(source, { controls: null })
    expect(
      generate(source, {
        controls: {
          curveDetail: Number.NaN,
          continuity: Number.POSITIVE_INFINITY,
          flowSmoothing: 'smooth',
          minimumStrokeLength: undefined,
        } as unknown as FlowingContoursControls,
      }),
    ).toEqual(expected)
    expect(
      generate(source, {
        controls: hostile as unknown as FlowingContoursControls,
      }),
    ).toEqual(expected)
  })

  it('reports the first lowered analysis and field limits exactly', () => {
    const source = boundaryRaster(32, 32, () => 16)
    const analysis = generate(source, {
      limits: { 'analysis-sample-count': 100 },
    })
    const scale = generate(source, {
      limits: { 'scale-plane-count': 3 },
    })

    expect(analysis.scene.primitives).toEqual([])
    expect(analysis.diagnostics).toMatchObject({
      termination: 'limit-reached',
      limitedBy: 'analysis-sample-count',
      primitiveCount: 0,
    })
    expect(scale.scene.primitives).toEqual([])
    expect(scale.diagnostics).toMatchObject({
      termination: 'limit-reached',
      limitedBy: 'scale-plane-count',
      analysisWidth: 32,
      analysisHeight: 32,
      primitiveCount: 0,
    })
  })

  it('enforces primitive and fitted-point limits without partial mismatch', () => {
    const source = boundaryRaster(72, 52, (y) => 34 + 6 * Math.sin(y / 8))
    const primitiveLimited = generate(source, {
      limits: { 'primitive-count': 0 },
    })
    expect(primitiveLimited.scene.primitives).toEqual([])
    expect(primitiveLimited.diagnostics).toMatchObject({
      termination: 'limit-reached',
      limitedBy: 'primitive-count',
      primitiveCount: 0,
      rawTrajectoryCount: 0,
      fittedCurveCount: 0,
    })

    const fittedLimited = generate(source, {
      limits: { 'fitted-curve-point-count': 1 },
    })
    expect(fittedLimited.scene.primitives).toEqual([])
    expect(fittedLimited.diagnostics).toMatchObject({
      termination: 'limit-reached',
      limitedBy: 'fitted-curve-point-count',
      analysisWidth: 72,
      analysisHeight: 52,
      analysisSampleCount: 72 * 52,
      primitiveCount: 0,
      rawTrajectoryCount: 0,
      fittedCurveCount: 0,
      fittedCurvePointCount: 0,
    })
    expect(fittedLimited.diagnostics.eligibleAnchorCount).toBeGreaterThan(0)
    expect(fittedLimited.diagnostics.processedAnchorCount).toBeGreaterThan(0)
    expect(fittedLimited.diagnostics.directionalTraceCount).toBeGreaterThan(0)
    expect(fittedLimited.diagnostics.searchStepCount).toBeGreaterThan(0)
    expect(fittedLimited.diagnostics.candidateCount).toBeGreaterThan(0)
  })

  it('rejects malformed or raised limit policies instead of falling back', () => {
    const source = boundaryRaster(32, 24, () => 16)
    for (const limits of [
      { 'analysis-dimension': 257 },
      { 'primitive-count': -1 },
      { unknown: 1 },
    ]) {
      const result = generate(source, {
        limits: limits as FlowingContoursGeneratorInput['limits'],
      })
      expect(result.scene.primitives).toEqual([])
      expect(result.diagnostics.termination).toBe('invalid-input')
    }
  })

  it('preserves pipeline work diagnostics while reconciling exact output counts', () => {
    const source = boundaryRaster(70, 50, (y) => 34 + 6 * Math.sin(y / 8))
    const accounting = createFlowingContoursAccounting()
    const prepared = prepareFlowingContoursRaster(source, accounting)
    const field = buildFlowingContoursField(prepared, accounting)
    const pipeline = runFlowingContoursPipeline(field, CONTROLS)
    const generated = generate(source)

    for (const name of [
      'analysisWidth',
      'analysisHeight',
      'analysisSampleCount',
      'contourEvidenceSampleCount',
      'eligibleAnchorCount',
      'processedAnchorCount',
      'directionalTraceCount',
      'searchStepCount',
      'candidateCount',
      'suppressedAnchorCount',
      'suppressedEvidenceSampleCount',
    ] as const) {
      expect(generated.diagnostics[name]).toBe(pipeline.diagnostics[name])
    }
    expect(generated.diagnostics.primitiveCount).toBe(
      generated.scene.primitives.length,
    )
    expect(generated.diagnostics.acceptedCandidateCount).toBe(
      generated.diagnostics.rawTrajectoryCount,
    )
    expect(generated.diagnostics.rawTrajectoryCount).toBe(
      generated.diagnostics.fittedCurveCount,
    )
    expect(generated.diagnostics.fittedCurveCount).toBe(
      generated.diagnostics.primitiveCount,
    )
  })

  it('returns a deeply frozen detached result without mutating decoded bytes', () => {
    const source = boundaryRaster(64, 48, () => 32)
    const before = source.data.slice()
    const result = generate(source)

    expect(source.data).toEqual(before)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.scene)).toBe(true)
    expect(Object.isFrozen(result.scene.space)).toBe(true)
    expect(Object.isFrozen(result.scene.primitives)).toBe(true)
    expect(Object.isFrozen(result.diagnostics)).toBe(true)
    expect(Object.isFrozen(result.diagnostics.endpointReasonCounts)).toBe(true)
    for (const primitive of result.scene.primitives) {
      expect(Object.isFrozen(primitive)).toBe(true)
      expect(Object.isFrozen(primitive.points)).toBe(true)
      expect(Object.isFrozen(primitive.stroke)).toBe(true)
      expect(primitive.points.every(Object.isFrozen)).toBe(true)
    }
  })
})
