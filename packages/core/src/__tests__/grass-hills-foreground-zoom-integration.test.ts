import { describe, expect, it } from 'vitest'

import { clipSceneToBounds } from '../clipToBounds'
import { hiddenLinePass } from '../hiddenLine'
import type { CoordinateSpace, Primitive, Scene } from '../scene'
import { defaultParams } from '../sketch'
import { grassHills } from '../sketches/grass-hills'
import { applyForegroundZoom } from '../sketches/grass-hills/foreground-zoom'
import type { GrassBladeDescriptor } from '../sketches/grass-hills/grass'
import {
  GRASS_HILLS_TOOL_WIDTH_MILLIMETERS,
  selectToolReadableBlades,
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
  for (let primitiveIndex = 0; primitiveIndex < base.primitives.length; primitiveIndex++) {
    const before = base.primitives[primitiveIndex]!
    const after = zoomed.primitives[primitiveIndex]!
    expect(after.closed).toBe(before.closed)
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
  return scene.primitives.filter(({ closed }) => closed === true)
}

function role(scene: Scene, value: Primitive['hiddenLineRole']): Primitive[] {
  return scene.primitives.filter(({ hiddenLineRole }) => hiddenLineRole === value)
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

function expectClippedWithoutFrameEdges(
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
    for (let index = 1; index < primitive.points.length; index++) {
      expect(
        isFrameEdgeSegment(
          primitive.points[index - 1]!,
          primitive.points[index]!,
          frame,
        ),
      ).toBe(false)
    }
  }
}

function lodDescriptor(
  x: number,
  ordinal: number,
): GrassBladeDescriptor {
  return {
    identity: { hillKey: '1/1', rootKey: `root-${ordinal}`, ordinal },
    canonical: { u: x, v: 0 },
    projected: [x, 0],
    rolls: { length: 0, width: ordinal, stiffness: 0, lean: 0 },
    shape: { length: 1, width: 0.2, stiffness: 2.5, lean: 0 },
  }
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
      const legacyFill = grassHills.generate(legacyParams, 'default-zoom', 7, frame)
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
    expect(zoomed.primitives.map(({ stroke }) => stroke?.width)).toEqual(
      base.primitives.map(({ stroke }) => stroke?.width),
    )
  })

  it('keeps Fill blade roots and tips identical to specialized Outline geometry', () => {
    const params = { ...PARAMS, foregroundZoom: ZOOM }
    const fill = grassHills.generate(params, 'shared-geometry', 0, WIDE)
    const outline = grassHills.generateOutlineSource!(
      params,
      'shared-geometry',
      0,
      WIDE,
      TARGET,
    )
    const fillByRoot = new Map(
      blades(fill).map((primitive) => [primitive.points[0]!.join(':'), primitive]),
    )
    const spines = role(outline, 'source').filter(
      ({ points }) => points.length === 6,
    )

    expect(spines.length).toBeGreaterThan(0)
    for (const spine of spines) {
      const fillBlade = fillByRoot.get(spine.points[0]!.join(':'))
      expect(fillBlade).toBeDefined()
      expect(spine.points.at(-1)).toEqual(fillBlade!.points[3])
      expect(spine.stroke?.width).toBe(
        TARGET.toolWidthMillimeters / TARGET.millimetersPerSceneUnit,
      )
    }
  })

  it('runs fixed-tool-width LOD against transformed root distances', () => {
    const hills = [
      {
        ridge: [],
        blades: [lodDescriptor(0, 0), lodDescriptor(0.75, 1)],
      },
    ]
    const transformed = applyForegroundZoom(hills, {
      frame: { width: 0, height: 0 },
      horizonHeight: 0,
      zoom: 2,
    })

    expect(selectToolReadableBlades(hills, 1).size).toBe(1)
    expect(selectToolReadableBlades(transformed, 1).size).toBe(2)
  })

  it('clips the magnified Fill and Outline inside the fixed frame without closure or frame-edge lines', () => {
    const params = {
      ...PARAMS,
      foregroundZoom: 2,
      bladeDensity: 0.002,
    }
    const fill = grassHills.generate(params, 'zoom-clipping', 0, WIDE)
    const outlineSource = grassHills.generateOutlineSource!(
      params,
      'zoom-clipping',
      0,
      WIDE,
      TARGET,
    )

    expect(
      fill.primitives.some(({ points }) =>
        points.some(
          ([x, y]) => x < 0 || x > WIDE.width || y < 0 || y > WIDE.height,
        ),
      ),
    ).toBe(true)
    expect(
      outlineSource.primitives.some(({ points }) =>
        points.some(
          ([x, y]) => x < 0 || x > WIDE.width || y < 0 || y > WIDE.height,
        ),
      ),
    ).toBe(true)

    expectClippedWithoutFrameEdges(clipSceneToBounds(fill), WIDE)
    const outline = clipSceneToBounds(
      hiddenLinePass(outlineSource, { tolerance: 0 }),
    )
    expect(outline.primitives.every(({ fill }) => fill === undefined)).toBe(true)
    expect(outline.primitives.every(({ closed }) => closed !== true)).toBe(true)
    expectClippedWithoutFrameEdges(outline, WIDE)
  })
})
