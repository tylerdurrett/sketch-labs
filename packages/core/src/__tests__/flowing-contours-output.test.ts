import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { finalizeOutlineScene } from '../../../../apps/studio/src/outlineScene'
import { clipSceneToBounds } from '../clipToBounds'
import type { DecodedPixels } from '../imageAssets'
import { hiddenLinePass } from '../hiddenLine'
import type { PageFrame } from '../pageFrame'
import { derivePageFramePlotProfile } from '../pageFramePlotProfile'
import { computePlotMapping } from '../plotMapping'
import type { PlotProfile } from '../plotProfile'
import { renderPlotterSVG } from '../plotterSvg'
import {
  drawSceneFitted,
  renderToSVG,
  type Canvas2DContext,
} from '../renderer'
import type { Scene } from '../scene'
import {
  createFlowingContours,
  defaultFlowingContoursControls,
} from '../sketches/flowing-contours'
import type { Point } from '../types'

const FRAME = Object.freeze({ width: 100, height: 100 })
const ASSET_ID = 'flowing-output-fixture'
const TOOL_WIDTH_MILLIMETERS = 0.8
const MILLIMETERS_PER_SCENE_UNIT = 0.4
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
  readonly width: number
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
        width: lineWidth,
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

function flowingBoundary(): DecodedPixels {
  return raster(96, 72, (x, y) => {
    const boundary = 42 + 8 * Math.sin(y / 10)
    const value = x < boundary ? 24 : 232
    return [value, value, value, 255]
  })
}

function completedScene(): Scene {
  const sketch = createFlowingContours(ASSET_ID)
  return sketch.generate(
    {
      imageAsset: ASSET_ID,
      ...defaultFlowingContoursControls,
      curveDetail: 1,
      continuity: 0.6,
      flowSmoothing: 0.9,
      minimumStrokeLength: 0.05,
    },
    'ignored-seed',
    999,
    FRAME,
    { imageAssets: (id) => (id === ASSET_ID ? flowingBoundary() : undefined) },
  )
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

function abruptOrthogonalTurnShare(scene: Readonly<Scene>): number {
  let turns = 0
  let abruptOrthogonalTurns = 0
  for (const primitive of scene.primitives) {
    for (let index = 1; index < primitive.points.length - 1; index += 1) {
      const previous = primitive.points[index - 1]!
      const current = primitive.points[index]!
      const next = primitive.points[index + 1]!
      const incoming = [current[0] - previous[0], current[1] - previous[1]]
      const outgoing = [next[0] - current[0], next[1] - current[1]]
      const denominator =
        Math.hypot(incoming[0]!, incoming[1]!) *
        Math.hypot(outgoing[0]!, outgoing[1]!)
      if (denominator === 0) continue
      turns += 1
      const cosine =
        (incoming[0]! * outgoing[0]! + incoming[1]! * outgoing[1]!) /
        denominator
      if (Math.abs(cosine) < 0.2) abruptOrthogonalTurns += 1
    }
  }
  return turns === 0 ? 0 : abruptOrthogonalTurns / turns
}

function expectFlowingGeometry(
  scene: Readonly<Scene>,
  minimumLongestPath = 60,
): void {
  const lengths = scene.primitives.map((primitive) =>
    pathLength(primitive.points, primitive.closed),
  )
  const total = lengths.reduce((sum, length) => sum + length, 0)
  const shortTotal = lengths
    .filter((length) => length < 20)
    .reduce((sum, length) => sum + length, 0)

  expect(lengths.length).toBeGreaterThan(0)
  expect(Math.max(...lengths)).toBeGreaterThan(minimumLongestPath)
  expect(shortTotal / total).toBeLessThan(0.1)
  expect(
    scene.primitives.every((primitive) => primitive.points.length >= 4),
  ).toBe(true)
  expect(abruptOrthogonalTurnShare(scene)).toBeLessThan(0.05)
}

function expectedCanvasPaths(scene: Readonly<Scene>): RecordedPath[] {
  return scene.primitives.map((primitive) => ({
    points: primitive.points.map(([x, y]) => [x, y]),
    closed: primitive.closed === true,
    width: primitive.stroke?.width ?? 0,
  }))
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function roundedPoints(points: readonly Readonly<Point>[]): Point[] {
  return points.map(([x, y]) => [round(x), round(y)])
}

function svgPathElements(svg: string): string[] {
  return svg.match(/<path\b[^>]*\/>/g) ?? []
}

function svgPathInventory(svg: string): Point[][] {
  return svgPathElements(svg).map((path) => {
    const d = path.match(/\bd="([^"]*)"/)?.[1]
    expect(d, path).toBeDefined()
    return Array.from(
      d!.matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g),
      (match): Point => [Number(match[1]), Number(match[2])],
    )
  })
}

function mappedPlotterInventory(
  scene: Readonly<Scene>,
  profile: Readonly<PlotProfile>,
  includePaperMargins = true,
): Point[][] {
  const { scale, offsetX, offsetY } = computePlotMapping(scene.space, profile)
  const originX = includePaperMargins ? 0 : profile.insets.left
  const originY = includePaperMargins ? 0 : profile.insets.top
  return scene.primitives.map((primitive) =>
    roundedPoints(
      primitive.points.map(([x, y]): Point => [
        offsetX + x * scale - originX,
        offsetY + y * scale - originY,
      ]),
    ),
  )
}

function withoutStrokeWidths(scene: Readonly<Scene>) {
  return {
    ...scene,
    primitives: scene.primitives.map(({ stroke, ...primitive }) => ({
      ...primitive,
      ...(stroke === undefined ? {} : { stroke: { color: stroke.color } }),
    })),
  }
}

describe('Flowing Contours output contract', () => {
  it('carries one long, non-grid-like Scene through Canvas, SVG, Outline, and plotter SVG', () => {
    const scene = completedScene()
    const originalJson = JSON.stringify(scene)
    expectFlowingGeometry(scene)

    const canvas = recordingContext()
    drawSceneFitted(canvas, scene, 300, 200, 'transparent')
    expect(canvas.paths).toEqual(expectedCanvasPaths(scene))
    expect(canvas.transforms).toEqual([
      [1, 0, 0, 1, 0, 0],
      [2, 0, 0, 2, 50, 0],
    ])

    const ordinarySVG = renderToSVG(scene, undefined, 'transparent')
    expect(svgPathInventory(ordinarySVG)).toEqual(
      scene.primitives.map((primitive) => roundedPoints(primitive.points)),
    )

    const sketch = createFlowingContours(ASSET_ID)
    expect(sketch.generateOutlineSource).toBeUndefined()
    expect(sketch.deriveOutlineSource).toBeTypeOf('function')
    const target = {
      toolWidthMillimeters: TOOL_WIDTH_MILLIMETERS,
      millimetersPerSceneUnit: MILLIMETERS_PER_SCENE_UNIT,
    }
    const outlineSource = sketch.deriveOutlineSource!(scene, target)
    const outlined = hiddenLinePass(outlineSource)
    expectFlowingGeometry(outlined)
    expect(outlineSource.primitives.map(({ points }) => points)).toEqual(
      scene.primitives.map(({ points }) => points),
    )
    expect(
      outlineSource.primitives.every(
        (primitive) =>
          primitive.stroke?.width ===
          TOOL_WIDTH_MILLIMETERS / MILLIMETERS_PER_SCENE_UNIT,
      ),
    ).toBe(true)

    const outlineCanvas = recordingContext()
    drawSceneFitted(outlineCanvas, outlined, 300, 200, 'transparent')
    expect(outlineCanvas.paths).toEqual(expectedCanvasPaths(outlined))
    const plotterSVG = renderPlotterSVG(outlined, PROFILE)
    expect(svgPathInventory(plotterSVG)).toEqual(
      mappedPlotterInventory(outlined, PROFILE),
    )
    expect(svgPathElements(plotterSVG)).toHaveLength(
      outlined.primitives.length,
    )
    expect(plotterSVG).not.toMatch(
      /<(?:rect|g|polyline|circle|clipPath)\b|\b(?:transform|clip-path)=/,
    )
    expect(JSON.stringify(scene)).toBe(originalJson)
  })

  it('retargets only tool width, then uses generic Page clipping, rebasing, margins, and physical mapping', () => {
    const scene = completedScene()
    const originalJson = JSON.stringify(scene)
    const sketch = createFlowingContours(ASSET_ID)
    const fineTarget = {
      toolWidthMillimeters: TOOL_WIDTH_MILLIMETERS,
      millimetersPerSceneUnit: MILLIMETERS_PER_SCENE_UNIT,
    }
    const broadTarget = {
      toolWidthMillimeters: 1.2,
      millimetersPerSceneUnit: 0.2,
    }
    const fine = sketch.deriveOutlineSource!(scene, fineTarget)
    const broad = sketch.deriveOutlineSource!(scene, broadTarget)

    expect(withoutStrokeWidths(broad)).toEqual(withoutStrokeWidths(fine))
    expect(
      fine.primitives.every(
        (primitive) => primitive.stroke?.width === 2,
      ),
    ).toBe(true)
    for (const primitive of broad.primitives) {
      expect(primitive.stroke?.width).toBeCloseTo(6)
    }

    const page: PageFrame = { x: 25, y: 30, width: 40, height: 40 }
    const pageProfile = derivePageFramePlotProfile(
      PROFILE,
      { x: 0, y: 0, ...FRAME },
      page,
    )
    expect(pageProfile).toEqual({
      ...PROFILE,
      width: 24,
      height: 24,
      insets: { top: 4, right: 4, bottom: 4, left: 4 },
    })
    expect(computePlotMapping(page, pageProfile)).toEqual({
      scale: MILLIMETERS_PER_SCENE_UNIT,
      offsetX: 4,
      offsetY: 4,
    })

    const outlined = hiddenLinePass(fine)
    const finalized = finalizeOutlineScene(outlined, page, false, {
      kind: 'physical-tool',
      target: fineTarget,
    })
    const clipped = clipSceneToBounds(finalized)
    expect(finalized.space).toEqual({ width: 40, height: 40 })
    expect(clipped.space).toEqual(finalized.space)
    expect(clipped.primitives.length).toBeGreaterThan(0)
    // Downstream Page clipping is allowed to shorten the already-accepted
    // gesture; it must still remain a substantial, smooth Page-spanning path.
    expectFlowingGeometry(clipped, 35)
    expect(
      clipped.primitives
        .flatMap((primitive) => primitive.points)
        .every(
          ([x, y]) =>
            x >= 0 && x <= page.width && y >= 0 && y <= page.height,
        ),
    ).toBe(true)
    expect(
      clipped.primitives
        .flatMap((primitive) => primitive.points)
        .some(
          ([x, y]) =>
            x === 0 || x === page.width || y === 0 || y === page.height,
        ),
    ).toBe(true)

    const paperSVG = renderPlotterSVG(clipped, pageProfile)
    const drawableSVG = renderPlotterSVG(
      clipped,
      pageProfile,
      undefined,
      { includePaperMargins: false },
    )
    expect(paperSVG).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="24mm" height="24mm" viewBox="0 0 24 24" data-paper-extent="paper">/,
    )
    expect(drawableSVG).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="16mm" height="16mm" viewBox="0 0 16 16" data-paper-extent="drawable">/,
    )
    expect(svgPathInventory(paperSVG)).toEqual(
      mappedPlotterInventory(clipped, pageProfile),
    )
    expect(svgPathInventory(drawableSVG)).toEqual(
      mappedPlotterInventory(clipped, pageProfile, false),
    )
    for (const path of svgPathElements(paperSVG)) {
      expect(path).toContain('stroke-width="0.8"')
    }
    expect(JSON.stringify(scene)).toBe(originalJson)
  })

  it('keeps Flowing Contours out of generic rendering and export modules', () => {
    const genericModules = [
      '../renderer.ts',
      '../plotterSvg.ts',
      '../plotMapping.ts',
      '../frameScene.ts',
      '../clipToBounds.ts',
      '../hiddenLine.ts',
      '../../../../apps/studio/src/outlineScene.ts',
    ]

    for (const modulePath of genericModules) {
      const source = readFileSync(new URL(modulePath, import.meta.url), 'utf8')
      expect(source, modulePath).not.toMatch(/flowing[-_ ]?contours/i)
    }
  })
})
