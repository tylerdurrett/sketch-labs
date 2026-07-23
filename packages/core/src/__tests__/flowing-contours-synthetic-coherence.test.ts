import { describe, expect, it } from 'vitest'

import type { DecodedPixels } from '../imageAssets'
import type { Primitive } from '../scene'
import { createFlowingContoursAccounting } from '../sketches/flowing-contours/accounting'
import {
  defaultFlowingContoursControls,
  type FlowingContoursControls,
} from '../sketches/flowing-contours/controls'
import { buildFlowingContoursField } from '../sketches/flowing-contours/field'
import { generateFlowingContours } from '../sketches/flowing-contours/generator'
import { runFlowingContoursPipeline } from '../sketches/flowing-contours/pipeline'
import { prepareFlowingContoursRaster } from '../sketches/flowing-contours/raster'
import type { Point } from '../types'

const FRAME = Object.freeze({ width: 960, height: 720 })
const DETAILED_CONTROLS: Readonly<FlowingContoursControls> = Object.freeze({
  curveDetail: 0.72,
  continuity: 0.72,
  flowSmoothing: 0.82,
  minimumStrokeLength: 0.005,
})
const FIXED_SPACING = 12

function raster(
  width: number,
  height: number,
  sample: (x: number, y: number) => number,
): DecodedPixels {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = Math.round(Math.max(0, Math.min(255, sample(x, y))))
      const offset = (y * width + x) * 4
      data[offset] = value
      data[offset + 1] = value
      data[offset + 2] = value
      data[offset + 3] = 255
    }
  }
  return { width, height, data }
}

function softStep(distance: number): number {
  const interpolation = Math.max(0, Math.min(1, 0.5 + distance / 2))
  return 24 + interpolation * 207
}

function lineSignal(
  width: number,
  height: number,
  tangentAngle: number,
  offset = 0,
): DecodedPixels {
  const normalX = -Math.sin(tangentAngle)
  const normalY = Math.cos(tangentAngle)
  const centerX = (width - 1) / 2
  const centerY = (height - 1) / 2
  return raster(width, height, (x, y) =>
    softStep(
      (x - centerX) * normalX +
        (y - centerY) * normalY -
        offset,
    ),
  )
}

function graphSignal(
  width: number,
  height: number,
  graph: (x: number) => number,
): DecodedPixels {
  return raster(width, height, (x, y) => softStep(y - graph(x)))
}

function circleSignal(
  width: number,
  height: number,
  radius: number,
): DecodedPixels {
  const centerX = (width - 1) / 2
  const centerY = (height - 1) / 2
  return raster(width, height, (x, y) =>
    softStep(Math.hypot(x - centerX, y - centerY) - radius),
  )
}

function generate(
  pixels: DecodedPixels,
  controls: Readonly<FlowingContoursControls> =
    defaultFlowingContoursControls,
  frame = FRAME,
) {
  return generateFlowingContours({ pixels, controls, frame })
}

function pipeline(
  pixels: DecodedPixels,
  controls: Readonly<FlowingContoursControls>,
) {
  const accounting = createFlowingContoursAccounting()
  const prepared = prepareFlowingContoursRaster(pixels, accounting)
  const field = buildFlowingContoursField(prepared, accounting)
  return runFlowingContoursPipeline(field, controls)
}

function distance(first: Readonly<Point>, second: Readonly<Point>): number {
  return Math.hypot(second[0] - first[0], second[1] - first[1])
}

function primitiveLength(primitive: Readonly<Primitive>): number {
  let result = 0
  for (let index = 1; index < primitive.points.length; index += 1) {
    result += distance(primitive.points[index - 1]!, primitive.points[index]!)
  }
  if (
    primitive.closed &&
    primitive.points.length > 1 &&
    distance(primitive.points[0]!, primitive.points.at(-1)!) > 1e-9
  ) {
    result += distance(primitive.points.at(-1)!, primitive.points[0]!)
  }
  return result
}

function resample(
  primitive: Readonly<Primitive>,
  spacing = FIXED_SPACING,
): readonly Readonly<Point>[] {
  const source = [...primitive.points]
  if (
    primitive.closed &&
    source.length > 1 &&
    distance(source[0]!, source.at(-1)!) > 1e-9
  ) {
    source.push(source[0]!)
  }
  if (source.length < 2) return Object.freeze(source)

  const result: Readonly<Point>[] = [
    Object.freeze([source[0]![0], source[0]![1]] as Point),
  ]
  let remaining = spacing
  let segmentStart = source[0]!
  for (let index = 1; index < source.length; index += 1) {
    const segmentEnd = source[index]!
    let segmentLength = distance(segmentStart, segmentEnd)
    while (segmentLength + 1e-9 >= remaining) {
      const fraction = remaining / segmentLength
      const point = Object.freeze([
        segmentStart[0] + (segmentEnd[0] - segmentStart[0]) * fraction,
        segmentStart[1] + (segmentEnd[1] - segmentStart[1]) * fraction,
      ] as Point)
      result.push(point)
      segmentStart = point
      segmentLength = distance(segmentStart, segmentEnd)
      remaining = spacing
    }
    remaining -= segmentLength
    segmentStart = segmentEnd
  }
  const last = source.at(-1)!
  if (
    !primitive.closed &&
    distance(result.at(-1)!, last) > spacing * 0.25
  ) {
    result.push(Object.freeze([last[0], last[1]] as Point))
  }
  return Object.freeze(result)
}

interface TurnMetrics {
  readonly sampleCount: number
  readonly energy: number
  readonly maximum: number
  readonly over25Rate: number
  readonly over45Rate: number
  readonly orthogonalAlternationRate: number
}

function turnMetrics(primitive: Readonly<Primitive>): TurnMetrics {
  const points = resample(primitive)
  const turns: number[] = []
  const signedTurns: number[] = []
  const lastIndex = primitive.closed ? points.length : points.length - 1
  for (let index = primitive.closed ? 0 : 1; index < lastIndex; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length]!
    const current = points[index]!
    const next = points[(index + 1) % points.length]!
    const firstX = current[0] - previous[0]
    const firstY = current[1] - previous[1]
    const secondX = next[0] - current[0]
    const secondY = next[1] - current[1]
    const firstLength = Math.hypot(firstX, firstY)
    const secondLength = Math.hypot(secondX, secondY)
    if (firstLength <= 1e-9 || secondLength <= 1e-9) continue
    const cross = firstX * secondY - firstY * secondX
    const dot = firstX * secondX + firstY * secondY
    const signed = Math.atan2(cross, dot)
    signedTurns.push(signed)
    turns.push(Math.abs(signed))
  }

  let orthogonalAlternations = 0
  for (let index = 1; index < signedTurns.length; index += 1) {
    const previous = signedTurns[index - 1]!
    const current = signedTurns[index]!
    if (
      Math.abs(previous) > Math.PI / 4 &&
      Math.abs(current) > Math.PI / 4 &&
      Math.sign(previous) !== Math.sign(current)
    ) {
      orthogonalAlternations += 1
    }
  }
  const denominator = Math.max(1, turns.length)
  return Object.freeze({
    sampleCount: points.length,
    energy: turns.reduce((sum, turn) => sum + turn * turn, 0),
    maximum: Math.max(0, ...turns),
    over25Rate:
      turns.filter((turn) => turn > (25 * Math.PI) / 180).length /
      denominator,
    over45Rate:
      turns.filter((turn) => turn > Math.PI / 4).length / denominator,
    orthogonalAlternationRate:
      orthogonalAlternations / Math.max(1, signedTurns.length - 1),
  })
}

function assertFiniteWholeOutput(
  result: ReturnType<typeof generateFlowingContours>,
  minimumLongestLength: number,
): void {
  expect(result.diagnostics.termination).toBe('complete')
  expect(result.scene.primitives.length).toBeGreaterThan(0)
  expect(result.diagnostics.primitiveCount).toBe(
    result.scene.primitives.length,
  )

  const lengths = result.scene.primitives.map(primitiveLength)
  expect(Math.max(...lengths)).toBeGreaterThan(minimumLongestLength)
  expect(lengths.filter((length) => length < 80).length).toBe(0)
  expect(result.scene.primitives.length).toBeLessThanOrEqual(8)
  for (const primitive of result.scene.primitives) {
    // A perfectly straight whole curve legitimately simplifies to its two
    // endpoints; fragmentation is gated by mapped length and curve count.
    expect(primitive.points.length).toBeGreaterThanOrEqual(2)
    expect(
      primitive.points.every(
        (point) =>
          Number.isFinite(point[0]) &&
          Number.isFinite(point[1]) &&
          point[0] >= 0 &&
          point[0] <= result.scene.space.width &&
          point[1] >= 0 &&
          point[1] <= result.scene.space.height,
      ),
    ).toBe(true)
  }
}

function assertFlowy(
  primitive: Readonly<Primitive>,
  maximumTurn = Math.PI / 3,
): void {
  const metrics = turnMetrics(primitive)
  expect(metrics.sampleCount).toBeGreaterThan(12)
  expect(metrics.maximum).toBeLessThan(maximumTurn)
  expect(metrics.over25Rate).toBeLessThan(0.1)
  expect(metrics.over45Rate).toBeLessThan(0.025)
  expect(metrics.orthogonalAlternationRate).toBe(0)
  expect(metrics.energy / Math.max(1, metrics.sampleCount - 2)).toBeLessThan(
    0.04,
  )
}

function longestPrimitive(
  primitives: readonly Readonly<Primitive>[],
): Readonly<Primitive> {
  return primitives.reduce((longest, primitive) =>
    primitiveLength(primitive) > primitiveLength(longest)
      ? primitive
      : longest,
  )
}

describe('Flowing Contours synthetic coherence acceptance', () => {
  it.each([
    ['horizontal', 0, 0],
    ['horizontal subpixel', 0, 0.37],
    ['vertical', Math.PI / 2, -0.31],
    ['shallow diagonal', Math.PI / 7, 0.23],
    ['diagonal', Math.PI / 4, -0.19],
    ['steep diagonal', (5 * Math.PI) / 14, 0.41],
  ])(
    'traces one long continuous %s signal without lattice steps or stumps',
    (_name, angle, offset) => {
      const source = lineSignal(84, 68, angle, offset)
      const first = generate(source)
      const second = generate(source)

      expect(first).toEqual(second)
      assertFiniteWholeOutput(first, 430)
      assertFlowy(longestPrimitive(first.scene.primitives), Math.PI / 6)
    },
  )

  it.each([
    [
      'sinusoid',
      (width: number, height: number) =>
        graphSignal(
          width,
          height,
          (x) =>
            (height - 1) / 2 +
            height * 0.15 * Math.sin((x / (width - 1)) * Math.PI * 1.6),
        ),
    ],
    [
      'circular arc',
      (width: number, height: number) => {
        const centerX = (width - 1) / 2
        const centerY = height * 0.93
        const radius = height * 0.66
        return graphSignal(
          width,
          height,
          (x) =>
            centerY -
            Math.sqrt(
              Math.max(0, radius * radius - (x - centerX) ** 2),
            ),
        )
      },
    ],
  ])('keeps a smooth %s whole and flowy', (_name, signal) => {
    const source = signal(88, 68)
    const result = generate(source, DETAILED_CONTROLS)

    assertFiniteWholeOutput(result, 500)
    assertFlowy(longestPrimitive(result.scene.primitives))
  })

  it('retains an opaque supported circle as a complete closed loop', () => {
    const source = circleSignal(80, 80, 24.4)
    const first = generate(source, DETAILED_CONTROLS, {
      width: 800,
      height: 800,
    })
    const second = generate(source, DETAILED_CONTROLS, {
      width: 800,
      height: 800,
    })

    expect(first).toEqual(second)
    assertFiniteWholeOutput(first, 1_000)
    expect(first.scene.primitives.filter((primitive) => primitive.closed)).toHaveLength(
      1,
    )
    const loop = first.scene.primitives.find((primitive) => primitive.closed)!
    expect(distance(loop.points[0]!, loop.points.at(-1)!)).toBeLessThan(1e-9)
    expect(primitiveLength(loop)).toBeGreaterThan(1_200)
    assertFlowy(loop)
  })

  it('is exactly repeatable through raw accepted trajectories, fitting, diagnostics, and Scene order', () => {
    const source = graphSignal(
      86,
      64,
      (x) => 31.3 + 8.5 * Math.sin(x / 12),
    )
    const firstPipeline = pipeline(source, DETAILED_CONTROLS)
    const secondPipeline = pipeline(source, DETAILED_CONTROLS)
    const first = generate(source, DETAILED_CONTROLS)
    const second = generate(source, DETAILED_CONTROLS)

    expect(firstPipeline).toEqual(secondPipeline)
    expect(firstPipeline.acceptedTrajectories.length).toBeGreaterThan(0)
    expect(firstPipeline.acceptedTrajectories).toEqual(
      secondPipeline.acceptedTrajectories,
    )
    expect(firstPipeline.fittedCurves).toEqual(secondPipeline.fittedCurves)
    expect(firstPipeline.diagnostics).toEqual(secondPipeline.diagnostics)
    expect(first.scene.primitives).toEqual(second.scene.primitives)
    expect(first.diagnostics).toEqual(second.diagnostics)
  })

  it.each([
    [Object.freeze({ width: 1_200, height: 360 }), 92, 48],
    [Object.freeze({ width: 360, height: 1_200 }), 48, 92],
    [Object.freeze({ width: 777, height: 777 }), 73, 73],
  ])(
    'preserves coherent coverage across frame and decoded aspects %#',
    (frame, width, height) => {
      const source = lineSignal(width, height, Math.PI / 5, 0.33)
      const result = generate(source, defaultFlowingContoursControls, frame)

      assertFiniteWholeOutput(result, Math.min(frame.width, frame.height) * 0.55)
      assertFlowy(longestPrimitive(result.scene.primitives), Math.PI / 5)
    },
  )
})
