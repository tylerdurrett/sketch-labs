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
import type { Primitive, Scene } from '../scene'
import {
  createFlowingContours,
  defaultFlowingContoursControls,
} from '../sketches/flowing-contours'
import type { Point } from '../types'

const FRAME = Object.freeze({ width: 100, height: 100 })
const ASSET_ID = 'flowing-output-fixture'
const TOOL_WIDTH_MILLIMETERS = 0.8
const MILLIMETERS_PER_SCENE_UNIT = 0.4
// Noncommensurate fixed distances at the same relative scale as the reference
// suite's 7/11/17 samples in its 1000-unit Composition Frame.
const FIXED_ARC_SPACINGS = Object.freeze([0.7, 1.1, 1.7])
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

function distance(
  first: Readonly<Point>,
  second: Readonly<Point>,
): number {
  return Math.hypot(second[0] - first[0], second[1] - first[1])
}

function resampleByArcLength(
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
  if (source.length < 2) return source

  const result: Point[] = [[source[0]![0], source[0]![1]]]
  let remaining = spacing
  let segmentStart = source[0]!
  for (let index = 1; index < source.length; index += 1) {
    const segmentEnd = source[index]!
    let segmentLength = distance(segmentStart, segmentEnd)
    while (segmentLength + 1e-9 >= remaining) {
      const fraction = remaining / segmentLength
      const point: Point = [
        segmentStart[0] + (segmentEnd[0] - segmentStart[0]) * fraction,
        segmentStart[1] + (segmentEnd[1] - segmentStart[1]) * fraction,
      ]
      result.push(point)
      segmentStart = point
      segmentLength = distance(segmentStart, segmentEnd)
      remaining = spacing
    }
    remaining -= segmentLength
    segmentStart = segmentEnd
  }
  const last = source.at(-1)!
  if (!primitive.closed && distance(result.at(-1)!, last) > spacing * 0.25) {
    result.push([last[0], last[1]])
  }
  return result
}

interface TurnMetrics {
  readonly sampleCount: number
  readonly energyPerTurn: number
  readonly maximum: number
  readonly over25Share: number
  readonly over45Share: number
  readonly orthogonalAlternationShare: number
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
    const incomingX = current[0] - previous[0]
    const incomingY = current[1] - previous[1]
    const outgoingX = next[0] - current[0]
    const outgoingY = next[1] - current[1]
    if (
      Math.hypot(incomingX, incomingY) <= 1e-9 ||
      Math.hypot(outgoingX, outgoingY) <= 1e-9
    ) {
      continue
    }
    const signed = Math.atan2(
      incomingX * outgoingY - incomingY * outgoingX,
      incomingX * outgoingX + incomingY * outgoingY,
    )
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
  const turnCount = Math.max(1, turns.length)
  return {
    sampleCount: points.length,
    energyPerTurn:
      turns.reduce((sum, turn) => sum + turn * turn, 0) / turnCount,
    maximum: Math.max(0, ...turns),
    over25Share:
      turns.filter((turn) => turn > (25 * Math.PI) / 180).length / turnCount,
    over45Share:
      turns.filter((turn) => turn > Math.PI / 4).length / turnCount,
    orthogonalAlternationShare:
      orthogonalAlternations / Math.max(1, signedTurns.length - 1),
  }
}

function expectFlowyPath(primitive: Readonly<Primitive>): void {
  const raw = measureTurns(primitive.points, Boolean(primitive.closed))
  expect(raw.over45Share).toBeLessThan(0.15)
  expect(raw.orthogonalAlternationShare).toBeLessThan(0.05)

  // The three noncommensurate spacings prevent a regular staircase from
  // disappearing merely because one sample interval aliases its step period.
  for (const spacing of FIXED_ARC_SPACINGS) {
    const metrics = measureTurns(
      resampleByArcLength(primitive, spacing),
      Boolean(primitive.closed),
    )
    expect(metrics.sampleCount).toBeGreaterThanOrEqual(2)
    expect(metrics.maximum).toBeLessThan(Math.PI / 3)
    expect(metrics.over25Share).toBeLessThan(0.1)
    expect(metrics.over45Share).toBeLessThan(0.025)
    expect(metrics.orthogonalAlternationShare).toBe(0)
    expect(metrics.energyPerTurn).toBeLessThan(0.1)
  }
}

function segmentsIntersect(
  firstStart: Readonly<Point>,
  firstEnd: Readonly<Point>,
  secondStart: Readonly<Point>,
  secondEnd: Readonly<Point>,
): boolean {
  const cross = (
    origin: Readonly<Point>,
    first: Readonly<Point>,
    second: Readonly<Point>,
  ) =>
    (first[0] - origin[0]) * (second[1] - origin[1]) -
    (first[1] - origin[1]) * (second[0] - origin[0])
  const firstSideStart = cross(firstStart, firstEnd, secondStart)
  const firstSideEnd = cross(firstStart, firstEnd, secondEnd)
  const secondSideStart = cross(secondStart, secondEnd, firstStart)
  const secondSideEnd = cross(secondStart, secondEnd, firstEnd)
  return (
    firstSideStart * firstSideEnd <= 0 &&
    secondSideStart * secondSideEnd <= 0
  )
}

/**
 * Share of paths that cross at least two members of a near-perpendicular
 * straight family. One straight contour and an isolated authentic crossing
 * both score zero; a repeated disconnected grid scores one.
 */
function repeatedPerpendicularLatticeShare(scene: Readonly<Scene>): number {
  const straightPaths = scene.primitives.flatMap((primitive, index) => {
    const start = primitive.points[0]
    const end = primitive.points.at(-1)
    if (start === undefined || end === undefined) return []
    const length = pathLength(primitive.points, primitive.closed)
    const chord = distance(start, end)
    if (length <= 0 || chord / length < 0.95) return []
    return [
      {
        index,
        start,
        end,
        direction: [(end[0] - start[0]) / chord, (end[1] - start[1]) / chord],
      },
    ]
  })
  const perpendicularCrossings = new Array<number>(
    scene.primitives.length,
  ).fill(0)
  for (let firstIndex = 0; firstIndex < straightPaths.length; firstIndex += 1) {
    const first = straightPaths[firstIndex]!
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < straightPaths.length;
      secondIndex += 1
    ) {
      const second = straightPaths[secondIndex]!
      const dot = Math.abs(
        first.direction[0]! * second.direction[0]! +
          first.direction[1]! * second.direction[1]!,
      )
      if (
        dot > Math.sin((15 * Math.PI) / 180) ||
        !segmentsIntersect(first.start, first.end, second.start, second.end)
      ) {
        continue
      }
      perpendicularCrossings[first.index] += 1
      perpendicularCrossings[second.index] += 1
    }
  }
  const repeatedFamilyMembers = perpendicularCrossings.filter(
    (count) => count >= 2,
  ).length
  return (
    repeatedFamilyMembers / Math.max(1, scene.primitives.length)
  )
}

function expectFlowingGeometry(
  scene: Readonly<Scene>,
  minimumLongestPath = 60,
): void {
  const lengths = scene.primitives.map((primitive) =>
    pathLength(primitive.points, primitive.closed),
  )
  const total = lengths.reduce((sum, length) => sum + length, 0)
  const shortIndices = lengths.flatMap((length, index) =>
    length < 20 ? [index] : [],
  )
  const longGeometryLength = lengths
    .filter((length) => length >= 20)
    .reduce((sum, length) => sum + length, 0)

  expect(lengths.length).toBeGreaterThan(0)
  expect(lengths.length).toBeLessThanOrEqual(8)
  expect(Math.max(...lengths)).toBeGreaterThan(minimumLongestPath)
  expect(shortIndices.length / lengths.length).toBeLessThan(0.25)
  expect(longGeometryLength / total).toBeGreaterThan(0.85)
  expect(
    scene.primitives.every((primitive) => primitive.points.length >= 4),
  ).toBe(true)
  expect(repeatedPerpendicularLatticeShare(scene)).toBeLessThan(0.25)
  for (const primitive of scene.primitives) expectFlowyPath(primitive)
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
    expect(outlineSource.space).toEqual(scene.space)
    expect(outlined.space).toEqual(scene.space)
    expect(outlineSource.primitives).toHaveLength(scene.primitives.length)
    expect(outlined.primitives).toHaveLength(scene.primitives.length)
    scene.primitives.forEach((completedPrimitive, index) => {
      const sourcePrimitive = outlineSource.primitives[index]!
      const outlinedPrimitive = outlined.primitives[index]!
      expect(sourcePrimitive.points).toEqual(completedPrimitive.points)
      expect(outlinedPrimitive.points).toEqual(completedPrimitive.points)
      expect(Boolean(sourcePrimitive.closed)).toBe(
        Boolean(completedPrimitive.closed),
      )
      expect(Boolean(outlinedPrimitive.closed)).toBe(
        Boolean(completedPrimitive.closed),
      )
      expect(completedPrimitive.stroke).toEqual({
        color: 'black',
        width: 1,
      })
      expect(sourcePrimitive.stroke).toEqual({
        color: 'black',
        width:
          TOOL_WIDTH_MILLIMETERS / MILLIMETERS_PER_SCENE_UNIT,
      })
      expect(outlinedPrimitive.stroke).toEqual(sourcePrimitive.stroke)
      expect(sourcePrimitive.fill).toBeUndefined()
      expect(outlinedPrimitive.fill).toBeUndefined()
      expect(sourcePrimitive.hiddenLineRole).toBe('source')
      expect(outlinedPrimitive.hiddenLineRole).toBeUndefined()
    })

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

  it('rejects representative lattice and one-long-plus-many-stumps output', () => {
    const staircaseVertices: Point[] = []
    for (let index = 0; index <= 18; index += 1) {
      const step = Math.floor(index / 2) * 6
      staircaseVertices.push(
        index % 2 === 0 ? [step, step] : [step + 6, step],
      )
    }
    const staircasePoints: Point[] = [staircaseVertices[0]!]
    for (let index = 1; index < staircaseVertices.length; index += 1) {
      const start = staircaseVertices[index - 1]!
      const end = staircaseVertices[index]!
      for (let subdivision = 1; subdivision <= 20; subdivision += 1) {
        staircasePoints.push([
          start[0] + ((end[0] - start[0]) * subdivision) / 20,
          start[1] + ((end[1] - start[1]) * subdivision) / 20,
        ])
      }
    }
    const staircase: Scene = {
      space: { width: 120, height: 120 },
      primitives: [
        {
          points: staircasePoints,
          stroke: { color: 'black', width: 1 },
        },
      ],
    }
    // A commensurate 12-unit sample aliases this six-unit staircase into a
    // straight diagonal. Its dense collinear vertices also dilute a raw
    // per-vertex turn share. Fixed noncommensurate arc samples still reject it.
    const rawStaircase = measureTurns(staircasePoints, false)
    expect(rawStaircase.over45Share).toBeLessThan(0.15)
    expect(rawStaircase.orthogonalAlternationShare).toBe(0)
    expect(
      measureTurns(
        resampleByArcLength(staircase.primitives[0]!, 12),
        false,
      ).maximum,
    ).toBeLessThan(1e-9)
    expect(
      FIXED_ARC_SPACINGS.some(
        (spacing) =>
          measureTurns(
            resampleByArcLength(staircase.primitives[0]!, spacing),
            false,
          ).over45Share >= 0.025,
      ),
    ).toBe(true)
    expect(() => expectFlowingGeometry(staircase, 60)).toThrow()

    const longWithStumps: Scene = {
      space: { width: 1_100, height: 100 },
      primitives: [
        {
          points: [
            [0, 10],
            [330, 10],
            [660, 10],
            [1_000, 10],
          ],
          stroke: { color: 'black', width: 1 },
        },
        ...Array.from({ length: 7 }, (_, index) => ({
          points: [
            [index * 120, 40] as Point,
            [index * 120 + 8, 40] as Point,
            [index * 120 + 16, 40] as Point,
            [index * 120 + 17, 40] as Point,
          ],
          stroke: { color: 'black', width: 1 },
        })),
      ],
    }
    const lengths = longWithStumps.primitives.map((primitive) =>
      pathLength(primitive.points),
    )
    expect(Math.max(...lengths)).toBeGreaterThan(900)
    expect(
      Math.max(...lengths) /
        lengths.reduce((sum, length) => sum + length, 0),
    ).toBeGreaterThan(0.89)
    expect(() => expectFlowingGeometry(longWithStumps, 60)).toThrow()

    const disconnectedGrid: Scene = {
      space: { width: 100, height: 100 },
      primitives: [
        ...[20, 40, 60, 80].map(
          (y): Primitive => ({
            points: [
              [5, y],
              [35, y],
              [65, y],
              [95, y],
            ],
            stroke: { color: 'black', width: 1 },
          }),
        ),
        ...[20, 40, 60, 80].map(
          (x): Primitive => ({
            points: [
              [x, 5],
              [x, 35],
              [x, 65],
              [x, 95],
            ],
            stroke: { color: 'black', width: 1 },
          }),
        ),
      ],
    }
    expect(
      disconnectedGrid.primitives.every(
        (primitive) =>
          measureTurns(primitive.points, false).maximum === 0,
      ),
    ).toBe(true)
    expect(repeatedPerpendicularLatticeShare(disconnectedGrid)).toBe(1)
    expect(() => expectFlowingGeometry(disconnectedGrid, 60)).toThrow()

    const legitimateSingleStraight: Scene = {
      space: { width: 100, height: 100 },
      primitives: [disconnectedGrid.primitives[0]!],
    }
    expect(repeatedPerpendicularLatticeShare(legitimateSingleStraight)).toBe(0)
    expect(() =>
      expectFlowingGeometry(legitimateSingleStraight, 60),
    ).not.toThrow()
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
