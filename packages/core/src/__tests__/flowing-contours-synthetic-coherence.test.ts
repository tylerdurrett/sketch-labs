import { describe, expect, it } from 'vitest'

import type { DecodedPixels } from '../imageAssets'
import { createRasterContainFit } from '../rasterSampling'
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
const FIXED_SPACINGS = Object.freeze([7, 11, 17])

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
  spacing: number,
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

function measureTurns(
  points: readonly Readonly<Point>[],
  closed: boolean,
): TurnMetrics {
  const turns: number[] = []
  const signedTurns: number[] = []
  const lastIndex = closed ? points.length : points.length - 1
  for (let index = closed ? 0 : 1; index < lastIndex; index += 1) {
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

function assertCoherentCollection(
  primitives: readonly Readonly<Primitive>[],
  minimumLongestLength: number,
): void {
  expect(primitives.length).toBeGreaterThan(0)
  expect(primitives.length).toBeLessThanOrEqual(8)
  const lengths = primitives.map(primitiveLength)
  const totalLength = lengths.reduce((sum, length) => sum + length, 0)
  const shortThreshold = Math.max(100, minimumLongestLength * 0.25)
  const shortIndices = lengths.flatMap((length, index) =>
    length < shortThreshold ? [index] : [],
  )
  const shortLength = shortIndices.reduce(
    (sum, index) => sum + lengths[index]!,
    0,
  )
  const openEndpointCount =
    primitives.filter((primitive) => !primitive.closed).length * 2

  expect(Math.max(...lengths)).toBeGreaterThan(minimumLongestLength)
  expect(shortLength / totalLength).toBeLessThan(0.15)
  expect(shortIndices.length / primitives.length).toBeLessThan(0.25)
  expect((openEndpointCount * 80) / totalLength).toBeLessThan(0.6)
}

function assertFiniteWholeOutput(
  result: ReturnType<typeof generateFlowingContours>,
  minimumLongestLength: number,
): void {
  expect(result.diagnostics.termination).toBe('complete')
  expect(result.diagnostics.primitiveCount).toBe(
    result.scene.primitives.length,
  )
  expect(result.diagnostics.acceptedCandidateCount).toBe(
    result.scene.primitives.length,
  )
  expect(result.diagnostics.rawTrajectoryCount).toBe(
    result.scene.primitives.length,
  )
  expect(result.diagnostics.fittedCurveCount).toBe(
    result.scene.primitives.length,
  )
  assertCoherentCollection(result.scene.primitives, minimumLongestLength)

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
  const raw = measureTurns(primitive.points, Boolean(primitive.closed))
  expect(raw.orthogonalAlternationRate).toBeLessThan(0.05)
  expect(raw.over45Rate).toBeLessThan(0.15)
  for (const spacing of FIXED_SPACINGS) {
    const metrics = measureTurns(
      resample(primitive, spacing),
      Boolean(primitive.closed),
    )
    expect(metrics.sampleCount).toBeGreaterThan(8)
    expect(metrics.maximum).toBeLessThan(maximumTurn)
    expect(metrics.over25Rate).toBeLessThan(0.1)
    expect(metrics.over45Rate).toBeLessThan(0.025)
    expect(metrics.orthogonalAlternationRate).toBe(0)
    expect(metrics.energy / Math.max(1, metrics.sampleCount - 2)).toBeLessThan(
      0.04,
    )
  }
}

function assertAllFlowy(
  primitives: readonly Readonly<Primitive>[],
  maximumTurn = Math.PI / 3,
): void {
  for (const primitive of primitives) assertFlowy(primitive, maximumTurn)
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

function sourcePoint(
  point: Readonly<Point>,
  source: Readonly<DecodedPixels>,
  frame = FRAME,
): Readonly<Point> {
  const fit = createRasterContainFit(source, frame)!
  return Object.freeze([
    ((point[0] - fit.left) / fit.fittedWidth) * source.width - 0.5,
    ((point[1] - fit.top) / fit.fittedHeight) * source.height - 0.5,
  ] as Point)
}

function framePoint(
  point: Readonly<Point>,
  source: Readonly<DecodedPixels>,
  frame = FRAME,
): Readonly<Point> {
  const fit = createRasterContainFit(source, frame)!
  return Object.freeze([
    fit.left + ((point[0] + 0.5) / source.width) * fit.fittedWidth,
    fit.top + ((point[1] + 0.5) / source.height) * fit.fittedHeight,
  ] as Point)
}

function intendedLineExtent(
  source: Readonly<DecodedPixels>,
  tangentAngle: number,
  offset: number,
): readonly [number, number] {
  const tangentX = Math.cos(tangentAngle)
  const tangentY = Math.sin(tangentAngle)
  const normalX = -tangentY
  const normalY = tangentX
  const originX = (source.width - 1) / 2 + normalX * offset
  const originY = (source.height - 1) / 2 + normalY * offset
  let minimum = Number.NEGATIVE_INFINITY
  let maximum = Number.POSITIVE_INFINITY
  for (const [origin, tangent, upper] of [
    [originX, tangentX, source.width - 1],
    [originY, tangentY, source.height - 1],
  ] as const) {
    if (Math.abs(tangent) <= 1e-12) continue
    const first = (0 - origin) / tangent
    const second = (upper - origin) / tangent
    minimum = Math.max(minimum, Math.min(first, second))
    maximum = Math.min(maximum, Math.max(first, second))
  }
  return Object.freeze([minimum, maximum])
}

function assertLineLocus(
  primitives: readonly Readonly<Primitive>[],
  source: Readonly<DecodedPixels>,
  tangentAngle: number,
  offset: number,
  frame = FRAME,
): void {
  const tangentX = Math.cos(tangentAngle)
  const tangentY = Math.sin(tangentAngle)
  const normalX = -tangentY
  const normalY = tangentX
  const centerX = (source.width - 1) / 2
  const centerY = (source.height - 1) / 2
  let maximumNormalDistance = 0
  for (const primitive of primitives) {
    for (const point of resample(primitive, 7)) {
      const sourceMapped = sourcePoint(point, source, frame)
      const normalDistance =
        (sourceMapped[0] - centerX) * normalX +
        (sourceMapped[1] - centerY) * normalY -
        offset
      maximumNormalDistance = Math.max(
        maximumNormalDistance,
        Math.abs(normalDistance),
      )
    }
  }
  // Guide proposals remain locally certified; keep the collection within
  // 2.7 source pixels of this authored two-pixel soft edge at every aspect.
  expect(maximumNormalDistance).toBeLessThan(2.7)

  const longest = longestPrimitive(primitives)
  const projected = longest.points.map((point) => {
    const mapped = sourcePoint(point, source, frame)
    return (
      (mapped[0] - centerX) * tangentX +
      (mapped[1] - centerY) * tangentY
    )
  })
  const [intendedMinimum, intendedMaximum] = intendedLineExtent(
    source,
    tangentAngle,
    offset,
  )
  const intendedSpan = intendedMaximum - intendedMinimum
  const actualMinimum = Math.min(...projected)
  const actualMaximum = Math.max(...projected)
  expect(actualMaximum - actualMinimum).toBeGreaterThan(intendedSpan * 0.72)
  expect(Math.abs(projected.at(-1)! - projected[0]!)).toBeGreaterThan(
    intendedSpan * 0.68,
  )
  expect(actualMinimum).toBeLessThan(intendedMinimum + intendedSpan * 0.18)
  expect(actualMaximum).toBeGreaterThan(intendedMaximum - intendedSpan * 0.18)
}

function assertGraphLocus(
  primitives: readonly Readonly<Primitive>[],
  source: Readonly<DecodedPixels>,
  graph: (x: number) => number,
  frame = FRAME,
): void {
  for (const primitive of primitives) {
    for (const point of resample(primitive, 7)) {
      const mapped = sourcePoint(point, source, frame)
      expect(Math.abs(mapped[1] - graph(mapped[0]))).toBeLessThan(3)
    }
  }
  const longest = longestPrimitive(primitives)
  const mapped = longest.points.map((point) => sourcePoint(point, source, frame))
  const xValues = mapped.map((point) => point[0])
  const intendedSpan = source.width - 1
  expect(Math.max(...xValues) - Math.min(...xValues)).toBeGreaterThan(
    intendedSpan * 0.72,
  )
  expect(Math.abs(mapped.at(-1)![0] - mapped[0]![0])).toBeGreaterThan(
    intendedSpan * 0.68,
  )
}

function assertCircleLocus(
  primitive: Readonly<Primitive>,
  source: Readonly<DecodedPixels>,
  radius: number,
  frame: Readonly<{ width: number; height: number }>,
): void {
  const centerX = (source.width - 1) / 2
  const centerY = (source.height - 1) / 2
  for (const point of resample(primitive, 7)) {
    const mapped = sourcePoint(point, source, frame)
    expect(
      Math.abs(Math.hypot(mapped[0] - centerX, mapped[1] - centerY) - radius),
    ).toBeLessThan(3)
  }
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
      const source = lineSignal(72, 56, angle, offset)
      const result = generate(source)

      assertFiniteWholeOutput(result, 430)
      assertAllFlowy(result.scene.primitives, Math.PI / 6)
      assertLineLocus(result.scene.primitives, source, angle, offset)
    },
  )

  it.each([
    [
      'sinusoid',
      (width: number, height: number) => (x: number) =>
        (height - 1) / 2 +
        height * 0.15 * Math.sin((x / (width - 1)) * Math.PI * 1.6),
    ],
    [
      'circular arc',
      (width: number, height: number) => {
        const centerX = (width - 1) / 2
        const centerY = height * 0.93
        const radius = height * 0.66
        return (x: number) =>
          centerY -
          Math.sqrt(Math.max(0, radius * radius - (x - centerX) ** 2))
      },
    ],
  ])('keeps a smooth %s whole, supported, and flowy', (_name, graphFor) => {
    const width = 76
    const height = 58
    const graph = graphFor(width, height)
    const source = graphSignal(width, height, graph)
    const result = generate(source, DETAILED_CONTROLS)

    assertFiniteWholeOutput(result, 500)
    assertAllFlowy(result.scene.primitives)
    assertGraphLocus(result.scene.primitives, source, graph)
  })

  it('retains an opaque supported circle as a complete closed loop', () => {
    const radius = 21.4
    const source = circleSignal(70, 70, radius)
    const frame = Object.freeze({ width: 800, height: 800 })
    const result = generate(source, DETAILED_CONTROLS, frame)

    assertFiniteWholeOutput(result, 1_000)
    expect(result.scene.primitives).toHaveLength(1)
    expect(result.scene.primitives[0]!.closed).toBe(true)
    const loop = result.scene.primitives[0]!
    expect(distance(loop.points[0]!, loop.points.at(-1)!)).toBeLessThan(1e-9)
    expect(primitiveLength(loop)).toBeGreaterThan(1_200)
    assertFlowy(loop)
    assertCircleLocus(loop, source, radius, frame)
  })

  it('is exactly repeatable through raw accepted trajectories, fitting, diagnostics, and Scene order', () => {
    const source = graphSignal(
      70,
      52,
      (x) => 25.3 + 7 * Math.sin(x / 11),
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
    [Object.freeze({ width: 1_200, height: 360 }), 78, 42],
    [Object.freeze({ width: 360, height: 1_200 }), 42, 78],
    [Object.freeze({ width: 777, height: 777 }), 62, 62],
  ])(
    'preserves coherent coverage across frame and decoded aspects %#',
    (frame, width, height) => {
      const angle = Math.PI / 5
      const offset = 0.33
      const source = lineSignal(width, height, angle, offset)
      const result = generate(source, defaultFlowingContoursControls, frame)

      assertFiniteWholeOutput(result, Math.min(frame.width, frame.height) * 0.55)
      assertAllFlowy(result.scene.primitives, Math.PI / 5)
      assertLineLocus(result.scene.primitives, source, angle, offset, frame)
    },
  )

  it('rejects the representative #402 six-pixel orthogonal staircase even when one sampling scale aliases it', () => {
    const points: Readonly<Point>[] = []
    for (let index = 0; index <= 18; index += 1) {
      const step = Math.floor(index / 2) * 6
      points.push(
        Object.freeze(
          index % 2 === 0 ? ([step, step] as Point) : ([step + 6, step] as Point),
        ),
      )
    }
    const staircase: Readonly<Primitive> = Object.freeze({
      points: Object.freeze(points),
      closed: false,
    })

    expect(
      measureTurns(resample(staircase, 12), false).maximum,
    ).toBeLessThan(1e-9)
    expect(
      measureTurns(staircase.points, false).orthogonalAlternationRate,
    ).toBeGreaterThan(0.8)
    expect(() => assertFlowy(staircase)).toThrow()
  })

  it('rejects the representative #396 one-long-curve plus seven-stump collection', () => {
    const primitives: Readonly<Primitive>[] = [
      Object.freeze({
        points: Object.freeze([
          Object.freeze([0, 0] as Point),
          Object.freeze([1_000, 0] as Point),
        ]),
      }),
    ]
    for (let index = 0; index < 7; index += 1) {
      primitives.push(
        Object.freeze({
          points: Object.freeze([
            Object.freeze([index * 90, 30] as Point),
            Object.freeze([index * 90 + 80, 30] as Point),
          ]),
        }),
      )
    }

    expect(() => assertCoherentCollection(primitives, 430)).toThrow()
  })

  it('rejects a smooth straight substitute that abandons a sinusoidal source locus', () => {
    const width = 70
    const height = 52
    const graph = (x: number) =>
      (height - 1) / 2 +
      height * 0.2 * Math.sin((x / (width - 1)) * Math.PI * 2)
    const source = graphSignal(width, height, graph)
    const substitute: Readonly<Primitive> = Object.freeze({
      points: Object.freeze([
        framePoint([0, (height - 1) / 2], source),
        framePoint([width - 1, (height - 1) / 2], source),
      ]),
    })

    expect(() => assertFlowy(substitute)).not.toThrow()
    expect(() => assertGraphLocus([substitute], source, graph)).toThrow()
  })
})
