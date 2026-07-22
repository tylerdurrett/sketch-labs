import { describe, expect, it } from 'vitest'

import { hiddenLinePass } from '../hiddenLine'
import type { DecodedPixels } from '../imageAssets'
import type { PlotProfile } from '../plotProfile'
import { renderPlotterSVG } from '../plotterSvg'
import { createRasterContainFit } from '../rasterSampling'
import { renderToSVG } from '../renderer'
import type { CoordinateSpace, Primitive, Scene } from '../scene'
import {
  defaultPencilContourControls,
  type PencilContourControls,
} from '../sketches/pencil-contour/controls'
import { generatePencilContour } from '../sketches/pencil-contour/generator'
import type { Point } from '../types'

const FRAME: CoordinateSpace = { width: 80, height: 60 }

function pixels(
  width: number,
  height: number,
  rgba: (x: number, y: number) => readonly [number, number, number, number],
): DecodedPixels {
  return {
    width,
    height,
    data: Uint8Array.from(
      Array.from({ length: width * height }, (_, index) =>
        rgba(index % width, Math.floor(index / width)),
      ).flat(),
    ),
  }
}

function controls(
  overrides: Partial<PencilContourControls> = {},
): PencilContourControls {
  return { ...defaultPencilContourControls, ...overrides }
}

function generate(
  source: Readonly<DecodedPixels>,
  controlOverrides: Partial<PencilContourControls> = {},
  frame: Readonly<CoordinateSpace> = FRAME,
): Scene {
  return generatePencilContour({
    pixels: source,
    frame,
    controls: controls(controlOverrides),
  }).scene
}

function transition(
  orientation: 'vertical' | 'horizontal',
): DecodedPixels {
  return pixels(8, 6, (x, y) => {
    const light = orientation === 'vertical' ? x >= 4 : y >= 3
    const byte = light ? 255 : 0
    return [byte, byte, byte, 255]
  })
}

function alphaDisk(size = 12): DecodedPixels {
  const center = (size - 1) / 2
  const radiusSquared = (size / 3) ** 2
  return pixels(size, size, (x, y) => {
    const opaque = (x - center) ** 2 + (y - center) ** 2 <= radiusSquared
    return [96, 96, 96, opaque ? 255 : 0]
  })
}

function opaqueTwoToneCircle(size = 32): DecodedPixels {
  const center = (size - 1) / 2
  const radiusSquared = (size * 0.3) ** 2
  return pixels(size, size, (x, y) => {
    const inside = (x - center) ** 2 + (y - center) ** 2 <= radiusSquared
    const byte = inside ? 32 : 224
    return [byte, byte, byte, 255]
  })
}

function junctionRichObliqueStructure(size = 64): DecodedPixels {
  const center = (size - 1) / 2
  return pixels(size, size, (x, y) => {
    const first = x * Math.cos(0.37) + y * Math.sin(0.37) - center * 1.3
    const second = x * Math.cos(1.19) + y * Math.sin(1.19) - center * 1.25
    const radial = Math.hypot(x - center * 1.08, y - center * 0.92) - size * 0.24
    const tone =
      0.12 +
      0.38 / (1 + Math.exp(-first / 1.5)) +
      0.27 * Math.exp(-(second * second) / 7) +
      0.2 / (1 + Math.exp(-radial / 1.2))
    const byte = Math.round(Math.min(1, Math.max(0, tone)) * 255)
    return [byte, byte, byte, 255]
  })
}

function hardAlphaLobes(size = 96): DecodedPixels {
  const center = (size - 1) / 2
  return pixels(size, size, (x, y) => {
    const dx = x - center
    const dy = y - center
    const angle = Math.atan2(dy, dx)
    const radius = 28 * (
      1 + 0.14 * Math.cos(3 * angle) + 0.05 * Math.cos(5 * angle + 0.4)
    )
    const opaque = Math.hypot(dx, dy) <= radius
    return [96, 96, 96, opaque ? 255 : 0]
  })
}

function allPoints(scene: Readonly<Scene>): readonly Readonly<Point>[] {
  return scene.primitives.flatMap((primitive) => primitive.points)
}

function lengthWeightedOctilinearFraction(
  scene: Readonly<Scene>,
  toleranceDegrees: number,
): number {
  let matchingLength = 0
  let totalLength = 0
  const tolerance = (toleranceDegrees * Math.PI) / 180
  for (const primitive of scene.primitives) {
    const segmentCount = primitive.closed
      ? primitive.points.length
      : primitive.points.length - 1
    for (let index = 0; index < segmentCount; index += 1) {
      const start = primitive.points[index]!
      const end = primitive.points[(index + 1) % primitive.points.length]!
      const dx = end[0] - start[0]
      const dy = end[1] - start[1]
      const length = Math.hypot(dx, dy)
      const angle = Math.atan2(dy, dx)
      const nearest = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4)
      totalLength += length
      if (Math.abs(angle - nearest) <= tolerance) matchingLength += length
    }
  }
  return totalLength === 0 ? 0 : matchingLength / totalLength
}

interface WeightedTurn {
  readonly degrees: number
  readonly weight: number
}

function pathTurns(
  points: readonly Readonly<Point>[],
  closed: boolean,
): readonly WeightedTurn[] {
  const turns: WeightedTurn[] = []
  if (points.length < 3) return turns
  const first = closed ? 0 : 1
  const end = closed ? points.length : points.length - 1
  for (let index = first; index < end; index += 1) {
      const previous = points[(index - 1 + points.length) % points.length]!
      const current = points[index]!
      const next = points[(index + 1) % points.length]!
      const incoming: Point = [
        current[0] - previous[0],
        current[1] - previous[1],
      ]
      const outgoing: Point = [next[0] - current[0], next[1] - current[1]]
      const incomingLength = Math.hypot(...incoming)
      const outgoingLength = Math.hypot(...outgoing)
      if (incomingLength === 0 || outgoingLength === 0) continue
      const cosine = Math.max(-1, Math.min(1,
        (incoming[0] * outgoing[0] + incoming[1] * outgoing[1]) /
          (incomingLength * outgoingLength),
      ))
      turns.push({
        degrees: Math.acos(cosine) * 180 / Math.PI,
        weight: (incomingLength + outgoingLength) / 2,
      })
  }
  return turns
}

function resampleAtFixedSpacing(
  primitive: Readonly<Primitive>,
  spacing: number,
): readonly Readonly<Point>[] {
  const segmentCount = primitive.closed
    ? primitive.points.length
    : primitive.points.length - 1
  const cumulative = [0]
  for (let index = 0; index < segmentCount; index += 1) {
    const start = primitive.points[index]!
    const end = primitive.points[(index + 1) % primitive.points.length]!
    cumulative.push(cumulative.at(-1)! + Math.hypot(
      end[0] - start[0],
      end[1] - start[1],
    ))
  }
  const total = cumulative.at(-1)!
  const distances: number[] = []
  for (let distance = 0; distance < total; distance += spacing) {
    distances.push(distance)
  }
  if (!primitive.closed) distances.push(total)

  let segment = 0
  return distances.map((distance): Point => {
    while (
      segment + 1 < cumulative.length - 1 &&
      cumulative[segment + 1]! < distance
    ) {
      segment += 1
    }
    const start = primitive.points[segment]!
    const end = primitive.points[(segment + 1) % primitive.points.length]!
    const length = cumulative[segment + 1]! - cumulative[segment]!
    const amount = length === 0 ? 0 : (distance - cumulative[segment]!) / length
    return [
      start[0] + (end[0] - start[0]) * amount,
      start[1] + (end[1] - start[1]) * amount,
    ]
  })
}

function fixedSpacingSceneTurns(
  scene: Readonly<Scene>,
  spacing: number,
): readonly WeightedTurn[] {
  return scene.primitives.flatMap((primitive) =>
    pathTurns(resampleAtFixedSpacing(primitive, spacing), primitive.closed),
  )
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((first, second) => first - second)
  return sorted[Math.floor(fraction * (sorted.length - 1))]!
}

function weightedTurnFraction(
  turns: readonly WeightedTurn[],
  threshold: number,
): number {
  const total = turns.reduce((sum, turn) => sum + turn.weight, 0)
  const matching = turns.reduce(
    (sum, turn) => sum + (turn.degrees > threshold + 1e-7 ? turn.weight : 0),
    0,
  )
  return total === 0 ? 0 : matching / total
}

function primitiveLength(primitive: Readonly<Primitive>): number {
  let length = 0
  const segmentCount = primitive.closed
    ? primitive.points.length
    : primitive.points.length - 1
  for (let index = 0; index < segmentCount; index += 1) {
    const start = primitive.points[index]!
    const end = primitive.points[(index + 1) % primitive.points.length]!
    length += Math.hypot(end[0] - start[0], end[1] - start[1])
  }
  return length
}

function distanceToPrimitive(
  point: Readonly<Point>,
  primitive: Readonly<Primitive>,
): number {
  let minimum = Number.POSITIVE_INFINITY
  const segmentCount = primitive.closed
    ? primitive.points.length
    : primitive.points.length - 1
  for (let index = 0; index < segmentCount; index += 1) {
    const start = primitive.points[index]!
    const end = primitive.points[(index + 1) % primitive.points.length]!
    const dx = end[0] - start[0]
    const dy = end[1] - start[1]
    const lengthSquared = dx * dx + dy * dy
    const amount = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
      ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) /
        lengthSquared,
    ))
    minimum = Math.min(minimum, Math.hypot(
      point[0] - (start[0] + dx * amount),
      point[1] - (start[1] + dy * amount),
    ))
  }
  return minimum
}

function segmentSamples(primitive: Readonly<Primitive>): readonly Point[] {
  const samples: Point[] = []
  const segmentCount = primitive.closed
    ? primitive.points.length
    : primitive.points.length - 1
  for (let index = 0; index < segmentCount; index += 1) {
    const start = primitive.points[index]!
    const end = primitive.points[(index + 1) % primitive.points.length]!
    for (let step = 0; step <= 16; step += 1) {
      const amount = step / 16
      samples.push([
        start[0] + (end[0] - start[0]) * amount,
        start[1] + (end[1] - start[1]) * amount,
      ])
    }
  }
  return samples
}

function segmentInventory(scene: Readonly<Scene>): ReadonlySet<string> {
  const inventory = new Set<string>()
  const pointKey = ([x, y]: Readonly<Point>) =>
    `${x.toFixed(12)},${y.toFixed(12)}`
  for (const primitive of scene.primitives) {
    const segmentCount = primitive.closed
      ? primitive.points.length
      : primitive.points.length - 1
    for (let index = 0; index < segmentCount; index += 1) {
      const start = pointKey(primitive.points[index]!)
      const end = pointKey(
        primitive.points[(index + 1) % primitive.points.length]!,
      )
      inventory.add(start < end ? `${start}:${end}` : `${end}:${start}`)
    }
  }
  return inventory
}

function alphaAtFramePoint(
  source: Readonly<DecodedPixels>,
  frame: Readonly<CoordinateSpace>,
  point: Readonly<Point>,
): number {
  const fit = createRasterContainFit(source, frame)!
  const latticeX = ((point[0] - fit.left) / fit.fittedWidth) * source.width - 0.5
  const latticeY = ((point[1] - fit.top) / fit.fittedHeight) * source.height - 0.5
  const left = Math.min(Math.max(0, Math.floor(latticeX)), source.width - 1)
  const top = Math.min(Math.max(0, Math.floor(latticeY)), source.height - 1)
  const right = Math.min(left + 1, source.width - 1)
  const bottom = Math.min(top + 1, source.height - 1)
  const horizontal = latticeX - left
  const vertical = latticeY - top
  const alpha = (x: number, y: number) =>
    source.data[(y * source.width + x) * 4 + 3]! / 255
  const topValue =
    alpha(left, top) * (1 - horizontal) + alpha(right, top) * horizontal
  const bottomValue =
    alpha(left, bottom) * (1 - horizontal) +
    alpha(right, bottom) * horizontal
  return topValue * (1 - vertical) + bottomValue * vertical
}

describe('generatePencilContour', () => {
  it('repeats exact vertical geometry and draw order', () => {
    const input = transition('vertical')
    const first = generate(input, { contourSmoothing: 1 })
    const second = generate(input, { contourSmoothing: 1 })

    expect(second).toEqual(first)
    expect(first).toEqual({
      space: FRAME,
      primitives: [
        {
          points: [
            [40, 5],
            [40, 30],
            [40, 40],
            [40, 50],
            [40, 55],
          ],
          closed: false,
          stroke: { color: 'black', width: 1 },
          hiddenLineRole: 'source',
        },
      ],
    })
  })

  it('extracts horizontal, diagonal, and curved structure deterministically', () => {
    const horizontal = generate(transition('horizontal'), {
      contourSmoothing: 1,
    })
    const diagonal = generate(
      pixels(12, 12, (x, y) => [64, 64, 64, x >= y ? 255 : 0]),
      { contourSmoothing: 0 },
      { width: 60, height: 60 },
    )
    const curved = generate(alphaDisk(), { contourSmoothing: 0 }, {
      width: 60,
      height: 60,
    })

    expect(horizontal.primitives).toEqual([
      {
        points: [
          [5, 30],
          [40, 30],
          [50, 30],
          [60, 30],
          [70, 30],
          [75, 30],
        ],
        closed: false,
        stroke: { color: 'black', width: 1 },
        hiddenLineRole: 'source',
      },
    ])
    expect(
      diagonal.primitives.some((primitive) =>
        primitive.points.some(
          (point, index) =>
            index > 0 &&
            point[0] !== primitive.points[index - 1]![0] &&
            point[1] !== primitive.points[index - 1]![1],
        ),
      ),
    ).toBe(true)
    expect(curved.primitives.some((primitive) => primitive.closed)).toBe(true)
    expect(new Set(allPoints(curved).map((point) => point[0])).size).toBeGreaterThan(2)
    expect(new Set(allPoints(curved).map((point) => point[1])).size).toBeGreaterThan(2)
  })

  it('keeps alpha boundaries on half coverage and every segment out of exact-zero support', () => {
    const source = pixels(10, 8, (x) => [120, 120, 120, x >= 4 ? 255 : 0])
    const scene = generate(source, { contourSmoothing: 1 }, {
      width: 100,
      height: 100,
    })

    expect(scene.primitives.length).toBeGreaterThan(0)
    for (const primitive of scene.primitives) {
      for (const point of primitive.points) {
        expect(alphaAtFramePoint(source, scene.space, point)).toBeCloseTo(0.5, 7)
      }
      for (const point of segmentSamples(primitive)) {
        expect(alphaAtFramePoint(source, scene.space, point)).toBeGreaterThan(0)
      }
    }
  })

  it('makes RGB hidden by exact-zero alpha irrelevant to geometry', () => {
    const source = (hidden: readonly [number, number, number]) =>
      pixels(12, 8, (x, y) =>
        x >= 4 && x <= 8 && y >= 2 && y <= 5
          ? [80, 80, 80, 255]
          : [hidden[0], hidden[1], hidden[2], 0],
      )

    expect(generate(source([255, 0, 0]))).toEqual(
      generate(source([0, 255, 255])),
    )
  })

  it('uses contain fitting without stretching and never emits a fitted rectangle', () => {
    const frame = { width: 100, height: 100 }
    const source = transition('vertical')
    const scene = generate(source, { contourSmoothing: 1 }, frame)
    const fit = createRasterContainFit(source, frame)!

    expect(fit).toMatchObject({ left: 0, top: 12.5, right: 100, bottom: 87.5 })
    expect(scene.space).toEqual(frame)
    for (const [x, y] of allPoints(scene)) {
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true)
      expect(x).toBeGreaterThanOrEqual(fit.left)
      expect(x).toBeLessThanOrEqual(fit.right)
      expect(y).toBeGreaterThanOrEqual(fit.top)
      expect(y).toBeLessThanOrEqual(fit.bottom)
    }
    expect(
      generate(pixels(8, 6, () => [127, 127, 127, 255]), {}, frame)
        .primitives,
    ).toEqual([])
  })

  it('lets detail add secondary structure', () => {
    const detailed = pixels(8, 6, (x) => {
      const byte = x < 2 ? 0 : x < 4 ? 255 : 240
      return [byte, byte, byte, 255]
    })
    const lowDetail = generate(detailed, {
      contourDetail: 0,
      contourSmoothing: 1,
    })
    const highDetail = generate(detailed, {
      contourDetail: 1,
      contourSmoothing: 1,
    })
    expect(highDetail.primitives.length).toBeGreaterThan(lowDetail.primitives.length)
    expect(
      highDetail.primitives.reduce((sum, primitive) => sum + primitive.points.length, 0),
    ).toBeGreaterThan(
      lowDetail.primitives.reduce((sum, primitive) => sum + primitive.points.length, 0),
    )
  })

  it('preserves a curved luminance contour deterministically at maximum smoothing', () => {
    const source = opaqueTwoToneCircle()
    const frame = { width: source.width, height: source.height }
    const unsmoothed = generate(source, {
      contourDetail: 0.5,
      contourSmoothing: 0,
    }, frame)
    const smoothed = generate(source, {
      contourDetail: 0.5,
      contourSmoothing: 1,
    }, frame)
    const repeated = generate(source, {
      contourDetail: 0.5,
      contourSmoothing: 1,
    }, frame)
    expect(repeated).toEqual(smoothed)
    const unsmoothedP95 = percentile(
      fixedSpacingSceneTurns(unsmoothed, 1).map(({ degrees }) => degrees), 0.95,
    )
    const smoothedP95 = percentile(
      fixedSpacingSceneTurns(smoothed, 1).map(({ degrees }) => degrees), 0.95,
    )
    expect(smoothedP95).toBeLessThan(unsmoothedP95)
    expect(smoothedP95).toBeLessThanOrEqual(25)
    expect(smoothed.primitives.some((primitive) => primitive.closed)).toBe(true)
    expect(allPoints(smoothed).every(([x, y]) =>
      Number.isFinite(x) && Number.isFinite(y) &&
      x >= 0 && x <= frame.width && y >= 0 && y <= frame.height,
    )).toBe(true)
  })

  it('turns a hard-alpha lobe silhouette into a genuinely smooth curve', () => {
    const source = hardAlphaLobes()
    const frame = { width: source.width, height: source.height }
    const unsmoothed = generate(source, {
      contourDetail: 0.5,
      contourSmoothing: 0,
    }, frame)
    const smoothed = generate(source, {
      contourDetail: 0.5,
      contourSmoothing: 1,
    }, frame)
    const repeated = generate(source, {
      contourDetail: 0.5,
      contourSmoothing: 1,
    }, frame)
    const turns = fixedSpacingSceneTurns(smoothed, 1)

    expect(smoothed).toEqual(repeated)
    expect(smoothed.primitives).toHaveLength(unsmoothed.primitives.length)
    expect(smoothed.primitives).toHaveLength(1)
    expect(smoothed.primitives[0]!.closed).toBe(true)
    expect(smoothed.primitives[0]!.points.at(-1)).not.toEqual(
      smoothed.primitives[0]!.points[0],
    )
    const unsmoothedLength = primitiveLength(unsmoothed.primitives[0]!)
    const smoothedLength = primitiveLength(smoothed.primitives[0]!)
    expect(smoothedLength).toBeGreaterThan(unsmoothedLength * 0.9)
    expect(smoothedLength).toBeLessThanOrEqual(unsmoothedLength * 1.01)
    const maximumDisplacement = Math.max(
      ...smoothed.primitives[0]!.points.map((point) =>
      distanceToPrimitive(point, unsmoothed.primitives[0]!),
      ),
    )
    expect(maximumDisplacement).toBeGreaterThan(0.1)
    expect(maximumDisplacement).toBeLessThanOrEqual(1 + 1e-12)
    expect(percentile(turns.map(({ degrees }) => degrees), 0.95))
      .toBeLessThanOrEqual(15)
    expect(weightedTurnFraction(turns, 25)).toBeLessThanOrEqual(0.05)
    expect(weightedTurnFraction(turns, 45)).toBeLessThanOrEqual(0.01)
  })

  it('keeps junction-rich oblique structure from collapsing to grid directions', () => {
    const source = junctionRichObliqueStructure()
    const frame = { width: source.width, height: source.height }
    const atDefaultDetail = generate(source, {
      contourDetail: 0.5,
      contourSmoothing: 1,
    }, frame)
    const atMaximumDetail = generate(source, {
      contourDetail: 1,
      contourSmoothing: 1,
    }, frame)

    expect(lengthWeightedOctilinearFraction(atDefaultDetail, 3)).toBeLessThanOrEqual(0.35)
    expect(lengthWeightedOctilinearFraction(atMaximumDetail, 3)).toBeLessThanOrEqual(0.45)
  })

  it('keeps lower-detail segment inventory when new edges create junctions', () => {
    const source: DecodedPixels = {
      width: 3,
      height: 3,
      data: Uint8Array.from([
        134, 45, 168, 231, 26, 177, 92, 11, 238, 117, 80, 111, 2, 121,
        132, 19, 86, 189, 248, 247, 234, 65, 172, 27, 190, 5, 160, 127,
        210, 9, 212, 35, 38, 77, 72, 7,
      ]),
    }
    let previous = new Set<string>()
    const counts: number[] = []

    for (const contourDetail of [0, 0.25, 0.5, 0.75, 1]) {
      const inventory = segmentInventory(
        generate(source, { contourDetail, contourSmoothing: 0 }),
      )
      for (const segment of previous) expect(inventory.has(segment)).toBe(true)
      counts.push(inventory.size)
      previous = new Set(inventory)
    }

    expect(counts).toEqual([...counts].sort((first, second) => first - second))
    expect(counts[2]).toBe(8)
    expect(counts[3]).toBeGreaterThanOrEqual(counts[2]!)
  })

  it.each([
    ['flat', pixels(6, 6, () => [128, 128, 128, 255])],
    ['transparent', pixels(6, 6, () => [255, 0, 255, 0])],
    ['tiny', pixels(1, 1, () => [0, 0, 0, 255])],
    ['empty', { width: 0, height: 0, data: new Uint8Array() }],
    ['short data', { width: 2, height: 2, data: new Uint8Array(3) }],
  ] as const)('fails closed in the exact frame for %s input', (_name, source) => {
    expect(
      generatePencilContour({
        pixels: source,
        frame: FRAME,
        controls: defaultPencilContourControls,
      }).scene,
    ).toEqual({ space: FRAME, primitives: [] })
  })

  it('bounds deterministic noisy and malformed-control outcomes', () => {
    const noisy = pixels(16, 12, (x, y) => {
      const byte = (x * 73 + y * 151 + 41) % 256
      return [byte, 255 - byte, (byte * 29) % 256, 255]
    })
    const first = generate(noisy, { contourDetail: 1, contourSmoothing: 0 })
    const second = generate(noisy, { contourDetail: 1, contourSmoothing: 0 })
    const malformedControls = generatePencilContour({
      pixels: transition('vertical'),
      frame: FRAME,
      controls: {
        gamma: Number.NaN,
        contrast: Number.POSITIVE_INFINITY,
        pivot: -10,
        contourDetail: 10,
        contourSmoothing: Number.NaN,
      },
    }).scene

    expect(second).toEqual(first)
    expect(first.primitives.length).toBeLessThanOrEqual(16 * 12 * 0.5)
    expect(allPoints(first).every(([x, y]) =>
      Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 80 && y >= 0 && y <= 60,
    )).toBe(true)
    expect(malformedControls.space).toEqual(FRAME)
    expect(allPoints(malformedControls).every(([x, y]) =>
      Number.isFinite(x) && Number.isFinite(y),
    )).toBe(true)
  })

  it('emits ordinary source primitives usable by Hidden-line and both SVG renderers', () => {
    const scene = generate(alphaDisk(), { contourSmoothing: 1 }, {
      width: 60,
      height: 60,
    })
    const closed = scene.primitives.find((primitive) => primitive.closed)!
    const outlined = hiddenLinePass(scene)
    const ordinarySvg = renderToSVG(scene, undefined, 'transparent')
    const profile: PlotProfile = {
      width: 60,
      height: 60,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      includeFrame: false,
      toolWidthMillimeters: 0.3,
    }
    const plotterSvg = renderPlotterSVG(scene, profile)

    expect(closed.points.length).toBeGreaterThanOrEqual(3)
    expect(scene).not.toHaveProperty('background')
    expect(scene.primitives.every((primitive) =>
      primitive.stroke?.color === 'black' &&
      primitive.stroke.width === 1 &&
      primitive.hiddenLineRole === 'source' &&
      primitive.fill === undefined,
    )).toBe(true)
    expect(outlined.primitives.length).toBeGreaterThan(0)
    expect(outlined.primitives.some((primitive) =>
      primitive.points.length > 2 &&
      primitive.points[0]![0] === primitive.points.at(-1)![0] &&
      primitive.points[0]![1] === primitive.points.at(-1)![1],
    )).toBe(true)
    expect(ordinarySvg).toContain('<path')
    expect(ordinarySvg).toContain('fill="none" stroke="black"')
    expect(plotterSvg).toContain('<path')
    expect(plotterSvg).toContain('fill="none" stroke="black"')
  })
})
