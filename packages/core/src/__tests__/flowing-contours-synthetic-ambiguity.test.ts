import { describe, expect, it } from 'vitest'

import type { DecodedPixels } from '../imageAssets'
import { createRasterContainFit } from '../rasterSampling'
import type { FlowingContoursControls } from '../sketches/flowing-contours/controls'
import { generateFlowingContours } from '../sketches/flowing-contours/generator'
import { FLOWING_CONTOURS_ENDPOINT_REASONS } from '../sketches/flowing-contours/types'
import type { Point } from '../types'

const FRAME = Object.freeze({ width: 960, height: 720 })
const CONTROLS: Readonly<FlowingContoursControls> = Object.freeze({
  curveDetail: 0.45,
  continuity: 0.7,
  flowSmoothing: 0.8,
  minimumStrokeLength: 0.04,
})

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

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

function modulatedBoundary(
  width: number,
  height: number,
  boundaryX: (y: number) => number,
  amplitudeAt: (y: number) => number = () => 1,
): DecodedPixels {
  return raster(width, height, (x, y) => {
    const amplitude = Math.max(0, Math.min(1, amplitudeAt(y)))
    const side = 1 / (1 + Math.exp(-(x - boundaryX(y)) / 0.55))
    const byte = clampByte(128 + (side - 0.5) * 210 * amplitude)
    return [byte, byte, byte, 255]
  })
}

function generate(
  pixels: DecodedPixels,
  controls: Partial<FlowingContoursControls> = {},
) {
  const resolvedControls = Object.freeze({ ...CONTROLS, ...controls })
  return {
    controls: resolvedControls,
    result: generateFlowingContours({
      pixels,
      frame: FRAME,
      controls: resolvedControls,
    }),
  }
}

function pathLength(points: readonly Readonly<Point>[]): number {
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(
      points[index]![0] - points[index - 1]![0],
      points[index]![1] - points[index - 1]![1],
    )
  }
  return total
}

function maximumSegmentLength(points: readonly Readonly<Point>[]): number {
  let maximum = 0
  for (let index = 1; index < points.length; index += 1) {
    maximum = Math.max(
      maximum,
      Math.hypot(
        points[index]![0] - points[index - 1]![0],
        points[index]![1] - points[index - 1]![1],
      ),
    )
  }
  return maximum
}

function extents(points: readonly Readonly<Point>[]) {
  const xs = points.map((point) => point[0])
  const ys = points.map((point) => point[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return {
    minX,
    maxX,
    minY,
    maxY,
    xSpan: maxX - minX,
    ySpan: maxY - minY,
  }
}

function expectExactAccounting(
  pixels: DecodedPixels,
  generated: ReturnType<typeof generate>,
): void {
  const { controls, result } = generated
  const { diagnostics } = result
  const primitiveCount = result.scene.primitives.length
  const endpointCount = Object.values(
    diagnostics.endpointReasonCounts,
  ).reduce((sum, count) => sum + count, 0)

  expect(diagnostics).toMatchObject({
    termination: 'complete',
    limitedBy: null,
    analysisWidth: pixels.width,
    analysisHeight: pixels.height,
    analysisSampleCount: pixels.width * pixels.height,
    acceptedCandidateCount: primitiveCount,
    rawTrajectoryCount: primitiveCount,
    fittedCurveCount: primitiveCount,
    primitiveCount,
  })
  expect(diagnostics.rejectedCandidateCount).toBe(
    diagnostics.candidateCount - primitiveCount,
  )
  expect(diagnostics.rawTrajectoryPointCount).toBeGreaterThanOrEqual(
    primitiveCount * 2,
  )
  expect(diagnostics.fittedCurvePointCount).toBeGreaterThanOrEqual(
    primitiveCount * 2,
  )
  expect(endpointCount).toBe(primitiveCount * 2)
  expect(Object.keys(diagnostics.endpointReasonCounts)).toEqual(
    FLOWING_CONTOURS_ENDPOINT_REASONS,
  )
  expect(diagnostics.acceptedMaximumUnsupportedSpanLength).toBeGreaterThanOrEqual(
    0,
  )
  expect(diagnostics.acceptedTotalUnsupportedSpanLength).toBeGreaterThanOrEqual(
    diagnostics.acceptedMaximumUnsupportedSpanLength,
  )
  expect(diagnostics.processedAnchorCount).toBeLessThanOrEqual(
    diagnostics.eligibleAnchorCount,
  )
  expect(diagnostics.suppressedAnchorCount).toBeLessThanOrEqual(
    diagnostics.processedAnchorCount,
  )

  const fit = createRasterContainFit(pixels, FRAME)!
  const mappedMinimum =
    controls.minimumStrokeLength *
    Math.hypot(fit.fittedWidth, fit.fittedHeight)
  for (const primitive of result.scene.primitives) {
    expect(pathLength(primitive.points)).toBeGreaterThanOrEqual(
      mappedMinimum - 1e-8,
    )
  }
}

function expectDeterministic(
  pixels: DecodedPixels,
  controls: Partial<FlowingContoursControls> = {},
) {
  const first = generate(pixels, controls)
  const second = generate(pixels, controls)
  expect(second).toEqual(first)
  expectExactAccounting(pixels, first)
  return first.result
}

function expectNoSegmentBridgesHorizontalBand(
  points: readonly Readonly<Point>[],
  lowerY: number,
  upperY: number,
): void {
  for (let index = 1; index < points.length; index += 1) {
    const first = points[index - 1]!
    const second = points[index]!
    expect(
      (first[1] < lowerY && second[1] > upperY) ||
        (second[1] < lowerY && first[1] > upperY),
    ).toBe(false)
  }
}

function expectNoFragmentFlood(
  result: ReturnType<typeof generateFlowingContours>,
  maximumCount: number,
): void {
  expect(result.scene.primitives.length).toBeLessThanOrEqual(maximumCount)
  for (const primitive of result.scene.primitives) {
    expect(pathLength(primitive.points)).toBeGreaterThan(FRAME.height * 0.2)
  }
}

describe('Flowing Contours synthetic ambiguity and gap integration', () => {
  it('crosses one short compatible weak span as one long flow with exact provenance totals', () => {
    const pixels = modulatedBoundary(
      80,
      64,
      (y) => 35 + 5 * Math.sin(y / 13),
      (y) => 1 - 0.45 * Math.exp(-((y - 31) ** 2) / (2 * 1.15 ** 2)),
    )
    const result = expectDeterministic(pixels)
    const primitive = result.scene.primitives[0]!

    expect(result.scene.primitives).toHaveLength(1)
    expect(extents(primitive.points).ySpan).toBeGreaterThan(
      FRAME.height * 0.94,
    )
    expect(pathLength(primitive.points)).toBeGreaterThan(FRAME.height * 0.95)
    expect(result.diagnostics.acceptedMaximumUnsupportedSpanLength).toBeGreaterThan(
      0,
    )
    expect(result.diagnostics.acceptedMaximumUnsupportedSpanLength).toBeLessThan(
      2,
    )
    expect(result.diagnostics.acceptedTotalUnsupportedSpanLength).toBe(
      result.diagnostics.acceptedMaximumUnsupportedSpanLength,
    )
    expect(result.diagnostics.endpointReasonCounts['source-boundary']).toBe(2)
    expect(result.diagnostics.suppressedAnchorCount).toBeGreaterThan(0)
  })

  it('refuses a long incompatible gap without joining its nearest endpoints', () => {
    const pixels = modulatedBoundary(
      80,
      64,
      (y) => (y < 22 ? 34 : y > 42 ? 52 : 43),
      (y) => (y >= 22 && y <= 42 ? 0 : 1),
    )
    const generated = generate(pixels)
    const { result } = generated
    expectExactAccounting(pixels, generated)

    for (const primitive of result.scene.primitives) {
      expectNoSegmentBridgesHorizontalBand(
        primitive.points,
        (24 / pixels.height) * FRAME.height,
        (40 / pixels.height) * FRAME.height,
      )
    }
    expect(
      result.scene.primitives.some((primitive) => {
        const bounds = extents(primitive.points)
        return (
          bounds.minY < FRAME.height * 0.3 &&
          bounds.maxY > FRAME.height * 0.7
        )
      }),
    ).toBe(false)
    expect(result.diagnostics.acceptedMaximumUnsupportedSpanLength).toBe(0)
    expectNoFragmentFlood(result, 4)
  })

  it('rolls back a transparent-gap rejection and never bridges zero-alpha support', () => {
    const pixels = raster(80, 64, (x, y) => {
      if (y >= 29 && y <= 34) return [255, 0, 255, 0]
      const byte = x < 38 + 3 * Math.sin(y / 14) ? 25 : 230
      return [byte, byte, byte, 255]
    })
    const generated = generate(pixels, {
      curveDetail: 0.6,
      continuity: 1,
    })
    const { result } = generated
    expectExactAccounting(pixels, generated)

    expect(result.diagnostics.rejectedCandidateCount).toBeGreaterThan(0)
    for (const primitive of result.scene.primitives) {
      expectNoSegmentBridgesHorizontalBand(
        primitive.points,
        (27 / pixels.height) * FRAME.height,
        (37 / pixels.height) * FRAME.height,
      )
    }
    expectNoFragmentFlood(result, 6)
  })

  it('keeps a dominant crossing whole while retaining a long secondary half', () => {
    const pixels = raster(80, 64, (x, y) => {
      const vertical = 1 / (1 + Math.exp(-(x - 39.25) / 0.65))
      const horizontal = 1 / (1 + Math.exp(-(y - 31.4) / 0.65))
      const byte = clampByte(25 + 185 * vertical + 45 * horizontal)
      return [byte, byte, byte, 255]
    })
    const result = expectDeterministic(pixels, {
      curveDetail: 1,
      continuity: 0.9,
    })
    const bounds = result.scene.primitives.map((primitive) =>
      extents(primitive.points),
    )
    const dominant = bounds.find(
      (item) =>
        item.ySpan > FRAME.height * 0.9 &&
        item.xSpan < FRAME.width * 0.04,
    )
    const secondary = bounds.find(
      (item) =>
        item.xSpan > FRAME.width * 0.2 &&
        item.ySpan < FRAME.height * 0.04,
    )

    expect(result.scene.primitives).toHaveLength(2)
    expect(dominant).toBeDefined()
    expect(secondary).toBeDefined()
    expect(
      result.diagnostics.endpointReasonCounts['evidence-exhausted'] +
        result.diagnostics.endpointReasonCounts.ambiguity +
        result.diagnostics.endpointReasonCounts.curvature,
    ).toBeGreaterThan(0)
    for (const item of bounds) {
      expect(Math.max(item.xSpan, item.ySpan)).toBeGreaterThan(
        Math.min(item.xSpan, item.ySpan) * 8,
      )
    }
    expectNoFragmentFlood(result, 2)
  })

  it('stops at a Y-junction ambiguity instead of choosing an arbitrary branch', () => {
    const pixels = raster(80, 64, (x, y) => {
      const spread = Math.max(0, y - 31) * 0.42
      const left = 1 / (1 + Math.exp(-(x - (39.5 - spread)) / 0.6))
      const right = 1 / (1 + Math.exp(-(x - (39.5 + spread)) / 0.6))
      const byte = clampByte(25 + 110 * left + 100 * right)
      return [byte, byte, byte, 255]
    })
    const generated = generate(pixels, { curveDetail: 0.6 })
    const { result } = generated
    expectExactAccounting(pixels, generated)

    expect(result.scene.primitives).toHaveLength(1)
    expect(extents(result.scene.primitives[0]!.points).ySpan).toBeGreaterThan(
      FRAME.height * 0.7,
    )
    expect(result.diagnostics.endpointReasonCounts.ambiguity).toBe(1)
    expect(result.diagnostics.endpointReasonCounts['source-boundary']).toBe(1)
    expect(result.diagnostics.acceptedMaximumUnsupportedSpanLength).toBe(0)
  })

  it.each([
    ['subpixel', 34.25, 43.75],
    ['integer', 34, 44],
  ])(
    'retains both close %s parallel ridges while suppressing same-ridge duplicates',
    (_name, firstX, secondX) => {
      const pixels = raster(80, 64, (x) => {
        const first = 1 / (1 + Math.exp(-(x - firstX) / 0.55))
        const second = 1 / (1 + Math.exp(-(x - secondX) / 0.55))
        const byte = clampByte(35 + 190 * first - 190 * second)
        return [byte, byte, byte, 255]
      })
      const result = expectDeterministic(pixels, { curveDetail: 0.7 })
      const bounds = result.scene.primitives.map((primitive) =>
        extents(primitive.points),
      )
      const centers = bounds
        .map((item) => (item.minX + item.maxX) / 2)
        .sort((first, second) => first - second)

      expect(result.scene.primitives).toHaveLength(2)
      expect(bounds.every((item) => item.ySpan > FRAME.height * 0.9)).toBe(
        true,
      )
      expect(bounds.every((item) => item.xSpan < FRAME.width * 0.03)).toBe(
        true,
      )
      expect(centers[1]! - centers[0]!).toBeGreaterThan(FRAME.width * 0.08)
      expect(result.diagnostics.candidateCount).toBe(2)
      expect(result.diagnostics.suppressedAnchorCount).toBeGreaterThan(10)
      expectNoFragmentFlood(result, 2)
    },
  )

  it('leaves an interrupted near-loop open without an endpoint chord', () => {
    const pixels = raster(72, 72, (x, y) => {
      const dx = x - 35.5
      const dy = y - 35.5
      const angle = Math.atan2(dy, dx)
      const angleFromTop = Math.atan2(
        Math.sin(angle + Math.PI / 2),
        Math.cos(angle + Math.PI / 2),
      )
      const distanceFromGap = Math.abs(angleFromTop)
      const amplitude =
        distanceFromGap < 0.24
          ? 0
          : Math.min(1, (distanceFromGap - 0.24) / 0.12)
      const side =
        1 / (1 + Math.exp(-(Math.hypot(dx, dy) - 22) / 0.6))
      const byte = clampByte(128 + (side - 0.5) * 210 * amplitude)
      return [byte, byte, byte, 255]
    })
    const generated = generate(pixels, { curveDetail: 0.6 })
    const { result } = generated
    expectExactAccounting(pixels, generated)
    const primitive = result.scene.primitives[0]!
    const first = primitive.points[0]!
    const last = primitive.points.at(-1)!
    const endpointDistance = Math.hypot(
      last[0] - first[0],
      last[1] - first[1],
    )

    expect(result.scene.primitives).toHaveLength(1)
    expect(primitive.closed).toBe(false)
    expect(pathLength(primitive.points)).toBeGreaterThan(endpointDistance * 5)
    expect(maximumSegmentLength(primitive.points)).toBeLessThan(
      FRAME.width * 0.12,
    )
    expect(result.diagnostics.endpointReasonCounts['evidence-exhausted']).toBe(
      2,
    )
    expectNoFragmentFlood(result, 1)
  })

  it('does not hop from a broadening weak ridge onto its stronger neighbor', () => {
    const pixels = raster(80, 64, (x, y) => {
      const broadening = 1 / (1 + Math.exp(-(y - 37) / 3))
      const weakSigma = 0.55 + 5 * broadening
      const weak = 1 / (1 + Math.exp(-(x - 31.5) / weakSigma))
      const strong = 1 / (1 + Math.exp(-(x - 43.5) / 0.55))
      const byte = clampByte(15 + 170 * weak + 65 * strong)
      return [byte, byte, byte, 255]
    })
    const generated = generate(pixels, {
      curveDetail: 1,
      continuity: 0.7,
    })
    const { result } = generated
    expectExactAccounting(pixels, generated)
    const bounds = extents(result.scene.primitives[0]!.points)

    expect(result.scene.primitives).toHaveLength(1)
    expect(bounds.ySpan).toBeGreaterThan(FRAME.height * 0.95)
    expect(bounds.xSpan).toBeLessThan(FRAME.width * 0.06)
    expect(bounds.ySpan).toBeGreaterThan(bounds.xSpan * 12)
    expect(result.diagnostics.acceptedMaximumUnsupportedSpanLength).toBe(0)
    expectNoFragmentFlood(result, 1)
  })
})
