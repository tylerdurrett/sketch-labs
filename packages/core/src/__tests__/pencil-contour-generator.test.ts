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

function allPoints(scene: Readonly<Scene>): readonly Readonly<Point>[] {
  return scene.primitives.flatMap((primitive) => primitive.points)
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

  it('lets detail add secondary structure and smoothing simplify paths', () => {
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
    const unsmoothed = generate(transition('vertical'), {
      contourSmoothing: 0,
    })
    const smoothed = generate(transition('vertical'), {
      contourSmoothing: 1,
    })

    expect(highDetail.primitives.length).toBeGreaterThan(lowDetail.primitives.length)
    expect(
      highDetail.primitives.reduce((sum, primitive) => sum + primitive.points.length, 0),
    ).toBeGreaterThan(
      lowDetail.primitives.reduce((sum, primitive) => sum + primitive.points.length, 0),
    )
    expect(smoothed.primitives).toHaveLength(unsmoothed.primitives.length)
    expect(smoothed.primitives[0]!.points.length).toBeLessThan(
      unsmoothed.primitives[0]!.points.length,
    )
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
