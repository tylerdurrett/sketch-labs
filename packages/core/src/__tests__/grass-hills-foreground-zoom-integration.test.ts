import { describe, expect, it } from 'vitest'

import { clipSceneToBounds } from '../clipToBounds'
import { hiddenLinePass } from '../hiddenLine'
import type { CoordinateSpace, Primitive, Scene } from '../scene'
import { defaultParams } from '../sketch'
import { grassHills } from '../sketches/grass-hills'
import {
  GRASS_HILLS_TOOL_WIDTH_MILLIMETERS,
} from '../sketches/grass-hills/outline'

const WIDE: CoordinateSpace = { width: 480, height: 270 }
const TALL: CoordinateSpace = { width: 240, height: 400 }
const HORIZON_HEIGHT = 0.25
const ZOOM = 1.75
const PARAMS = {
  ...defaultParams(grassHills.schema),
  hillCount: 4,
  horizonHeight: HORIZON_HEIGHT,
  ridgeAmplitude: 0.8,
  bladeDensity: 0.004,
}
const TARGET = {
  toolWidthMillimeters: GRASS_HILLS_TOOL_WIDTH_MILLIMETERS,
  millimetersPerSceneUnit: 180 / 1_000,
}

function transformedCoordinate(
  value: number,
  anchor: number,
  zoom: number,
): number {
  return anchor + zoom * (value - anchor)
}

function expectSceneTransform(
  base: Scene,
  zoomed: Scene,
  frame: CoordinateSpace,
  horizonHeight: number,
  zoom: number,
): void {
  const anchorX = frame.width / 2
  const anchorY = frame.height * horizonHeight

  expect(zoomed.space).toEqual(base.space)
  expect(zoomed.background).toEqual(base.background)
  expect(zoomed.primitives).toHaveLength(base.primitives.length)
  for (
    let primitiveIndex = 0;
    primitiveIndex < base.primitives.length;
    primitiveIndex++
  ) {
    const before = base.primitives[primitiveIndex]!
    const after = zoomed.primitives[primitiveIndex]!
    expect(after.closed).toBe(before.closed === true ? false : before.closed)
    expect(after.fill).toEqual(before.fill)
    expect(after.stroke).toEqual(before.stroke)
    expect(after.points).toHaveLength(before.points.length)
    for (let pointIndex = 0; pointIndex < before.points.length; pointIndex++) {
      const [beforeX, beforeY] = before.points[pointIndex]!
      const [afterX, afterY] = after.points[pointIndex]!
      expect(afterX).toBeCloseTo(
        transformedCoordinate(beforeX, anchorX, zoom),
        10,
      )
      expect(afterY).toBeCloseTo(
        transformedCoordinate(beforeY, anchorY, zoom),
        10,
      )
    }
  }
}

function blades(scene: Scene): Primitive[] {
  return scene.primitives.filter(({ points }) => points.length === 7)
}

function isFrameEdgeSegment(
  start: readonly [number, number],
  end: readonly [number, number],
  frame: CoordinateSpace,
): boolean {
  if (start[0] === end[0] && start[1] === end[1]) return false
  return (
    (start[0] === 0 && end[0] === 0) ||
    (start[0] === frame.width && end[0] === frame.width) ||
    (start[1] === 0 && end[1] === 0) ||
    (start[1] === frame.height && end[1] === frame.height)
  )
}

function drawableSegments(
  primitive: Primitive,
): Array<readonly [readonly [number, number], readonly [number, number]]> {
  const segments = primitive.points.slice(1).map(
    (end, index) => [primitive.points[index]!, end] as const,
  )
  if (primitive.closed === true && primitive.points.length > 1) {
    segments.push([primitive.points.at(-1)!, primitive.points[0]!])
  }
  return segments
}

function expectClippedWithoutClosureOrFrameEdges(
  scene: Scene,
  frame: CoordinateSpace,
): void {
  expect(scene.primitives.length).toBeGreaterThan(0)
  for (const primitive of scene.primitives) {
    expect(
      primitive.points.every(
        ([x, y]) => x >= 0 && x <= frame.width && y >= 0 && y <= frame.height,
      ),
    ).toBe(true)
    if (primitive.closed === true) {
      expect(primitive.points.at(-1)).toEqual(primitive.points[0])
    }
    for (const [start, end] of drawableSegments(primitive)) {
      expect(isFrameEdgeSegment(start, end, frame)).toBe(false)
    }
  }
}

function crossesBoundary(
  primitive: Primitive,
  isOutside: (point: readonly [number, number]) => boolean,
): boolean {
  return (
    primitive.points.some(isOutside) &&
    primitive.points.some((point) => !isOutside(point))
  )
}

describe('grass-hills foreground zoom integration', () => {
  it.each([
    ['square', { width: 320, height: 320 }],
    ['wide', WIDE],
    ['tall', TALL],
  ] as const)(
    'keeps omitted and explicit default Fill/Outline bytes identical in a %s frame',
    (_label, frame) => {
      const { foregroundZoom: _omitted, ...legacyParams } = PARAMS
      const legacyFill = grassHills.generate(
        legacyParams,
        'default-zoom',
        7,
        frame,
      )
      const explicitFill = grassHills.generate(
        { ...legacyParams, foregroundZoom: 1 },
        'default-zoom',
        7,
        frame,
      )
      const legacyOutline = grassHills.generateOutlineSource!(
        legacyParams,
        'default-zoom',
        7,
        frame,
        TARGET,
      )
      const explicitOutline = grassHills.generateOutlineSource!(
        { ...legacyParams, foregroundZoom: 1 },
        'default-zoom',
        7,
        frame,
        TARGET,
      )

      expect(explicitFill).toEqual(legacyFill)
      expect(explicitOutline).toEqual(legacyOutline)
    },
  )

  it.each([
    ['wide', WIDE],
    ['tall', TALL],
  ] as const)(
    'is deterministic and warm/cold equivalent with active zoom in a %s frame',
    (_label, frame) => {
      const params = { ...PARAMS, foregroundZoom: ZOOM }
      const warm = grassHills.prepare!(params, 'active-zoom', frame)
      const cold = grassHills.generate(params, 'active-zoom', -4, frame)

      expect(warm(-4)).toEqual(cold)
      expect(warm(999)).toEqual(cold)
      expect(grassHills.generate(params, 'active-zoom', -4, frame)).toEqual(cold)
    },
  )

  it('uniformly transforms completed Fill geometry without rerolling or scaling authored strokes', () => {
    const base = grassHills.generate(
      { ...PARAMS, foregroundZoom: 1 },
      'inverse-transform',
      0,
      WIDE,
    )
    const zoomed = grassHills.generate(
      { ...PARAMS, foregroundZoom: ZOOM },
      'inverse-transform',
      0,
      WIDE,
    )

    expectSceneTransform(base, zoomed, WIDE, HORIZON_HEIGHT, ZOOM)
    expect(blades(base).every(({ closed }) => closed === true)).toBe(true)
    expect(blades(zoomed).every(({ closed }) => closed === false)).toBe(true)
    expect(zoomed.primitives.map(({ stroke }) => stroke?.width)).toEqual(
      base.primitives.map(({ stroke }) => stroke?.width),
    )
  })

  it('keeps the complete transformed Fill geometry in the Outline source', () => {
    const params = { ...PARAMS, foregroundZoom: ZOOM }
    const fill = grassHills.generate(params, 'shared-geometry', 0, WIDE)
    const outline = grassHills.generateOutlineSource!(
      params,
      'shared-geometry',
      0,
      WIDE,
      TARGET,
    )
    expect(outline.primitives).toHaveLength(fill.primitives.length)
    for (let index = 0; index < fill.primitives.length; index++) {
      const fillPrimitive = fill.primitives[index]!
      const outlinePrimitive = outline.primitives[index]!
      expect(outlinePrimitive.points).toEqual(fillPrimitive.points)
      expect(outlinePrimitive.closed).toBe(fillPrimitive.closed)
      expect(outlinePrimitive.hiddenLineRole).toBe('both')
      expect(outlinePrimitive.stroke?.width).toBe(
        TARGET.toolWidthMillimeters / TARGET.millimetersPerSceneUnit,
      )
    }
  })

  it('clips the magnified Fill and Outline inside the fixed frame without closure or frame-edge lines', () => {
    const params = {
      ...PARAMS,
      foregroundZoom: 2,
      hillCount: 4,
      bladeDensity: 0.04,
      bladeLength: 80,
      bladeWidth: 12,
      windLean: 1,
    }
    const fill = grassHills.generate(params, 'zoom-clipping', 0, WIDE)
    const outlineSource = grassHills.generateOutlineSource!(
      params,
      'zoom-clipping',
      0,
      WIDE,
      TARGET,
    )

    const fillBlades = blades(fill)
    expect(
      fillBlades.some((blade) => crossesBoundary(blade, ([x]) => x < 0)),
    ).toBe(true)
    expect(
      fillBlades.some((blade) =>
        crossesBoundary(blade, ([x]) => x > WIDE.width),
      ),
    ).toBe(true)
    expect(
      fillBlades.some((blade) =>
        crossesBoundary(blade, ([, y]) => y > WIDE.height),
      ),
    ).toBe(true)
    expect(
      outlineSource.primitives.some(({ points }) =>
        points.some(
          ([x, y]) => x < 0 || x > WIDE.width || y < 0 || y > WIDE.height,
        ),
      ),
    ).toBe(true)

    const clippedFill = clipSceneToBounds(fill)
    expect(clippedFill.primitives.every(({ closed }) => closed !== true)).toBe(
      true,
    )
    expectClippedWithoutClosureOrFrameEdges(clippedFill, WIDE)
    const outline = clipSceneToBounds(
      hiddenLinePass(outlineSource, { tolerance: 0 }),
    )
    expect(outline.primitives.every(({ fill }) => fill === undefined)).toBe(true)
    expect(outline.primitives.every(({ closed }) => closed !== true)).toBe(true)
    expectClippedWithoutClosureOrFrameEdges(outline, WIDE)
  })
})
