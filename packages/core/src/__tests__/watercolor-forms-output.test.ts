import { describe, expect, it } from 'vitest'

import type { DecodedPixels } from '../imageAssets'
import { frameScene } from '../frameScene'
import { hiddenLinePass } from '../hiddenLine'
import type { PageFrame } from '../pageFrame'
import { derivePageFramePlotProfile } from '../pageFramePlotProfile'
import { computePlotMapping } from '../plotMapping'
import type { PlotProfile } from '../plotProfile'
import { renderPlotterSVG } from '../plotterSvg'
import { createRasterContainFit } from '../rasterSampling'
import { createRasterToneSource } from '../rasterToneSource'
import {
  drawSceneFitted,
  renderToSVG,
  type Canvas2DContext,
} from '../renderer'
import type { Primitive, Scene } from '../scene'
import {
  defaultWatercolorFormsControls,
  type WatercolorFormsControls,
} from '../sketches/watercolor-forms/controls'
import { generateWatercolorForms } from '../sketches/watercolor-forms/generator'
import type { Point } from '../types'

const FRAME = Object.freeze({ width: 100, height: 100 })
const TOOL_WIDTH_MILLIMETERS = 0.4
const PROFILE: PlotProfile = Object.freeze({
  width: 48,
  height: 48,
  insets: Object.freeze({ top: 4, right: 4, bottom: 4, left: 4 }),
  includeFrame: false,
  toolWidthMillimeters: TOOL_WIDTH_MILLIMETERS,
})

interface RecordedPath {
  readonly points: Point[]
  readonly closed: boolean
}

interface RecordingContext extends Canvas2DContext {
  readonly paths: RecordedPath[]
  readonly transforms: ReadonlyArray<readonly number[]>
}

function recordingContext(): RecordingContext {
  const paths: RecordedPath[] = []
  const transforms: number[][] = []
  let points: Point[] = []
  let closed = false
  let fillStyle = ''
  let strokeStyle = ''
  let lineCap: 'butt' | 'round' | 'square' = 'butt'
  let lineWidth = 0

  return {
    paths,
    transforms,
    save() {},
    restore() {},
    beginPath() {
      points = []
      closed = false
    },
    moveTo(x, y) {
      points.push([x, y])
    },
    lineTo(x, y) {
      points.push([x, y])
    },
    closePath() {
      closed = true
    },
    fill() {},
    stroke() {
      paths.push({
        points: points.map(([x, y]) => [x, y]),
        closed,
      })
    },
    setTransform(...transform) {
      transforms.push(transform)
    },
    fillRect() {},
    clearRect() {},
    get fillStyle() {
      return fillStyle
    },
    set fillStyle(value) {
      fillStyle = value
    },
    get strokeStyle() {
      return strokeStyle
    },
    set strokeStyle(value) {
      strokeStyle = value
    },
    get lineCap() {
      return lineCap
    },
    set lineCap(value) {
      lineCap = value
    },
    get lineWidth() {
      return lineWidth
    },
    set lineWidth(value) {
      lineWidth = value
    },
  }
}

function pixels(
  width: number,
  height: number,
  rgba: (
    x: number,
    y: number,
  ) => readonly [number, number, number, number],
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
  overrides: Partial<WatercolorFormsControls> = {},
): WatercolorFormsControls {
  return {
    ...defaultWatercolorFormsControls,
    formDetail: 1,
    colorSensitivity: 1,
    boundaryStrength: 0,
    boundarySmoothing: 0,
    ...overrides,
  }
}

function generate(
  source: Readonly<DecodedPixels>,
  frame = FRAME,
): Scene {
  return generateWatercolorForms({
    pixels: source,
    frame,
    controls: controls(),
  }).scene
}

function outlinedSource(): DecodedPixels {
  return pixels(10, 10, (x, y) => {
    const firstForm = x >= 1 && x < 4 && y >= 2 && y < 5
    const secondForm = x >= 6 && x < 9 && y >= 5 && y < 8
    if (!firstForm && !secondForm) return [255, 0, 255, 0]
    const value = firstForm ? 40 : 220
    return [value, value, value, 255]
  })
}

function twoBlocks(): DecodedPixels {
  return pixels(4, 2, (x) => {
    const value = x < 2 ? 32 : 224
    return [value, value, value, 255]
  })
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function roundedPoints(points: readonly Readonly<Point>[]): Point[] {
  return points.map(([x, y]) => [round(x), round(y)])
}

function expectedPaths(scene: Readonly<Scene>): RecordedPath[] {
  return scene.primitives.map((primitive) => ({
    points: primitive.points.map(([x, y]) => [x, y]),
    closed: primitive.closed === true,
  }))
}

function svgPathElements(svg: string): string[] {
  return svg.match(/<path\b[^>]*\/>/g) ?? []
}

function svgPathInventory(svg: string): RecordedPath[] {
  return svgPathElements(svg).map((path) => {
    const d = path.match(/\bd="([^"]*)"/)?.[1]
    expect(d, path).toBeDefined()
    const points = Array.from(
      d!.matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g),
      (match): Point => [Number(match[1]), Number(match[2])],
    )
    return { points, closed: /\sZ$/.test(d!) }
  })
}

function mappedPlotterInventory(
  scene: Readonly<Scene>,
  profile: Readonly<PlotProfile>,
): RecordedPath[] {
  const { scale, offsetX, offsetY } = computePlotMapping(scene.space, profile)
  return scene.primitives.map((primitive) => ({
    points: roundedPoints(
      primitive.points.map(([x, y]): Point => [
        offsetX + x * scale,
        offsetY + y * scale,
      ]),
    ),
    closed: false,
  }))
}

function expectGenericSources(primitives: readonly Readonly<Primitive>[]) {
  expect(primitives.length).toBeGreaterThan(0)
  for (const primitive of primitives) {
    expect(primitive).toEqual({
      points: primitive.points,
      closed: primitive.closed,
      stroke: { color: 'black', width: 1 },
      hiddenLineRole: 'source',
    })
  }
}

describe('Watercolor Forms output contract', () => {
  it('carries one generated Scene through ordinary and exact outlined output seams', () => {
    const scene = generate(outlinedSource())
    expectGenericSources(scene.primitives)
    expect(scene.primitives.length).toBeGreaterThan(1)
    expect(scene.primitives.some((primitive) => primitive.closed === true)).toBe(
      true,
    )
    const originalJson = JSON.stringify(scene)

    const ordinaryPreview = recordingContext()
    drawSceneFitted(ordinaryPreview, scene, 300, 200, 'transparent')
    const ordinarySVG = renderToSVG(scene, undefined, 'transparent')

    const outlined = hiddenLinePass(scene)
    const outlinedJson = JSON.stringify(outlined)
    const outlinePreview = recordingContext()
    drawSceneFitted(outlinePreview, outlined, 300, 200, 'transparent')
    const plotterSVG = renderPlotterSVG(outlined, PROFILE)

    expect(ordinaryPreview.paths).toEqual(expectedPaths(scene))
    expect(svgPathInventory(ordinarySVG)).toEqual(
      scene.primitives.map((primitive) => ({
        points: roundedPoints(primitive.points),
        closed: primitive.closed === true,
      })),
    )
    expect(ordinaryPreview.transforms).toEqual([
      [1, 0, 0, 1, 0, 0],
      [2, 0, 0, 2, 50, 0],
    ])

    expect(outlined.space).toBe(scene.space)
    expect(outlined.primitives.every((primitive) => primitive.closed !== true)).toBe(
      true,
    )
    expect(
      outlined.primitives.every(
        (primitive) =>
          primitive.fill === undefined &&
          primitive.hiddenLineRole === undefined &&
          primitive.stroke?.color === 'black' &&
          primitive.stroke.width === 1,
      ),
    ).toBe(true)
    expect(outlinePreview.paths).toEqual(expectedPaths(outlined))
    expect(outlinePreview.transforms).toEqual(ordinaryPreview.transforms)
    expect(svgPathInventory(plotterSVG)).toEqual(
      mappedPlotterInventory(outlined, PROFILE),
    )
    expect(svgPathElements(plotterSVG)).toHaveLength(
      outlined.primitives.length,
    )
    expect(
      svgPathElements(plotterSVG).every((path) =>
        path.includes(`stroke-width="${TOOL_WIDTH_MILLIMETERS}"`),
      ),
    ).toBe(true)
    expect(plotterSVG).not.toMatch(
      /<(?:rect|g|polyline|circle|clipPath)\b|\b(?:transform|clip-path)=|\sZ(?="|\s)/,
    )

    expect(JSON.stringify(scene)).toBe(originalJson)
    expect(JSON.stringify(outlined)).toBe(outlinedJson)
  })

  it('uses existing Page Frame clipping, rebasing, and physical mapping unchanged', () => {
    const scene = generate(twoBlocks())
    const outlined = hiddenLinePass(scene)
    const page: PageFrame = {
      x: 40,
      y: 35,
      width: 20,
      height: 30,
    }
    const framed = frameScene(outlined, page)

    expect(outlined.primitives).toHaveLength(1)
    expect(outlined.primitives[0]!.points).toEqual([
      [50, 25],
      [50, 50],
      [50, 75],
    ])
    expect(framed).toEqual({
      space: { width: 20, height: 30 },
      primitives: [
        {
          points: [
            [10, -0.5],
            [10, 15],
            [10, 30.5],
          ],
          stroke: { color: 'black', width: 1 },
        },
      ],
    })

    const pageProfile = derivePageFramePlotProfile(
      PROFILE,
      { x: 0, y: 0, ...FRAME },
      page,
    )
    expect(pageProfile).toEqual({
      ...PROFILE,
      width: 16,
      height: 20,
      insets: { top: 4, right: 4, bottom: 4, left: 4 },
    })
    expect(pageProfile.toolWidthMillimeters).toBe(TOOL_WIDTH_MILLIMETERS)

    const plotterSVG = renderPlotterSVG(framed, pageProfile)
    expect(svgPathElements(plotterSVG)).toEqual([
      '<path d="M8 3.8 L8 10 L8 16.2" fill="none" stroke="black" stroke-width="0.4" stroke-linecap="round" />',
    ])
    expect(plotterSVG).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="16mm" height="20mm" viewBox="0 0 16 20" data-paper-extent="paper">/,
    )
  })

  it('shares the photo-backed raster contain fit without a perimeter mark or private transform', () => {
    const source = twoBlocks()
    const fit = createRasterContainFit(source, FRAME)!
    const scene = generate(source)
    const establishedPhotoSource = createRasterToneSource(source, FRAME)

    expect(fit).toEqual({
      sourceWidth: 4,
      sourceHeight: 2,
      left: 0,
      top: 25,
      right: 100,
      bottom: 75,
      fittedWidth: 100,
      fittedHeight: 50,
    })
    expect(scene.space).toEqual(FRAME)
    expect(scene.primitives).toEqual([
      {
        points: [
          [fit.left + fit.fittedWidth / 2, fit.top],
          [fit.left + fit.fittedWidth / 2, fit.top + fit.fittedHeight / 2],
          [fit.left + fit.fittedWidth / 2, fit.bottom],
        ],
        closed: false,
        stroke: { color: 'black', width: 1 },
        hiddenLineRole: 'source',
      },
    ])

    expect(establishedPhotoSource.shadingMask.sample([50, fit.top])).toBe(1)
    expect(establishedPhotoSource.shadingMask.sample([50, fit.bottom])).toBe(1)
    expect(establishedPhotoSource.shadingMask.sample([50, fit.top - 0.01])).toBe(
      0,
    )
    expect(
      establishedPhotoSource.shadingMask.sample([50, fit.bottom + 0.01]),
    ).toBe(0)

    const perimeter: Point[] = [
      [fit.left, fit.top],
      [fit.right, fit.top],
      [fit.right, fit.bottom],
      [fit.left, fit.bottom],
    ]
    expect(
      scene.primitives.some(
        (primitive) =>
          primitive.closed === true &&
          JSON.stringify(primitive.points) === JSON.stringify(perimeter),
      ),
    ).toBe(false)
  })
})
