import { describe, expect, it } from 'vitest'

import { hiddenLinePass } from '../hiddenLine'
import type { CoordinateSpace, Primitive, Scene } from '../scene'
import { grassHills } from '../sketches/grass-hills'
import { GRASS_HILLS_TOOL_WIDTH_MILLIMETERS } from '../sketches/grass-hills/outline'
import type { Point } from '../types'
import { compareVisibleContours } from './visibleContourOracle'

const WIDE: CoordinateSpace = { width: 1600, height: 900 }

const BLADE_COLOR = '#ddeeaa'
const HILL_COLOR = '#88aa55'

/**
 * Low-density root-sink fixture. Blade and hill fills are deliberately
 * distinct so primitives can be classified by fill color: a sink-cut blade at
 * default detail is ALSO seven points but OPEN, so the default-geometry
 * heuristics used elsewhere (`closed === true`, seven-point counting) cannot
 * discriminate blades from hills here.
 */
const SINK_PARAMS = Object.freeze({
  bladeDensity: 0.004,
  bladeRootSink: 0.3,
  bladeColor: BLADE_COLOR,
  hillColor: HILL_COLOR,
})

const OUTLINE_TARGET = Object.freeze({
  toolWidthMillimeters: GRASS_HILLS_TOOL_WIDTH_MILLIMETERS,
  millimetersPerSceneUnit: 0.18,
})

function bladesByFill(scene: Scene): Primitive[] {
  return scene.primitives.filter(({ fill }) => fill?.color === BLADE_COLOR)
}

function samePoint(a: Point, b: Point): boolean {
  return a[0] === b[0] && a[1] === b[1]
}

/** True when any consecutive stroked point pair joins the two given points. */
function hasSegmentBetween(scene: Scene, a: Point, b: Point): boolean {
  return scene.primitives.some((primitive) => {
    for (let index = 1; index < primitive.points.length; index++) {
      const start = primitive.points[index - 1]!
      const end = primitive.points[index]!
      if (
        (samePoint(start, a) && samePoint(end, b)) ||
        (samePoint(start, b) && samePoint(end, a))
      ) {
        return true
      }
    }
    return false
  })
}

describe('grass-hills root sink integration', () => {
  it('emits every sunk blade open with distinct flat-cut endpoints', () => {
    const fill = grassHills.generate(SINK_PARAMS, 'root-sink', 0, WIDE)
    const blades = bladesByFill(fill)

    expect(blades.length).toBeGreaterThan(0)
    for (const primitive of blades) {
      expect(primitive.closed).toBe(false)
      expect(primitive.points).toHaveLength(7)
      const first = primitive.points[0]!
      const last = primitive.points.at(-1)!
      expect(samePoint(first, last)).toBe(false)
      // The cut is flat: both endpoints share the projected root's y.
      expect(first[1]).toBe(last[1])
      expect(first[0]).toBeGreaterThan(last[0])
      // Open paths never stroke a chord tick between the cut endpoints.
      expect(hasSegmentBetween(fill, first, last)).toBe(false)
    }
  })

  it('keeps the outline faithful to fill everywhere except the unstroked cuts', () => {
    const fill = grassHills.generate(SINK_PARAMS, 'root-sink', 0, WIDE)
    const source = grassHills.generateOutlineSource!(
      SINK_PARAMS,
      'root-sink',
      0,
      WIDE,
      OUTLINE_TARGET,
    )
    const outline = hiddenLinePass(source)
    const blades = bladesByFill(fill)

    // The hidden-line pass never synthesizes the cut chord either: outlineRing
    // appends a last-to-first closing edge only when `closed === true`.
    for (const primitive of blades) {
      expect(
        hasSegmentBetween(
          outline,
          primitive.points[0]!,
          primitive.points.at(-1)!,
        ),
      ).toBe(false)
    }

    // The oracle treats every filled path as an implicitly closed polygon, so
    // each VISIBLE flat cut registers as a fill contour that the outline — by
    // design, "no horizontal stroke tick at the cut" — must never stroke.
    // Fidelity therefore holds exactly everywhere EXCEPT the cut chords: the
    // outline invents nothing, and every missing interval lies inside the flat
    // cut of some sunk blade. (Chords occluded by nearer fills or clipped by
    // the frame drop out, so missing may count fewer intervals than blades.)
    const comparison = compareVisibleContours(fill, outline)
    const chords = blades.map((primitive) => {
      const first = primitive.points[0]!
      const last = primitive.points.at(-1)!
      return {
        y: first[1],
        minX: Math.min(first[0], last[0]),
        maxX: Math.max(first[0], last[0]),
      }
    })

    expect(comparison.extra).toEqual([])
    expect(comparison.missing.length).toBeGreaterThan(0)
    for (const [start, end] of comparison.missing) {
      expect(
        chords.some(
          (chord) =>
            Math.abs(start[1] - chord.y) <= 1e-6 &&
            Math.abs(end[1] - chord.y) <= 1e-6 &&
            start[0] >= chord.minX - 1e-6 &&
            end[0] <= chord.maxX + 1e-6,
        ),
      ).toBe(true)
    }
  })

  it('deep-equals the no-param scene at rootSink 0', () => {
    const params = { bladeDensity: 0.004 }
    const baseline = grassHills.generate(params, 'sink-identity', 0, WIDE)
    const explicit = grassHills.generate(
      { ...params, bladeRootSink: 0 },
      'sink-identity',
      0,
      WIDE,
    )

    expect(explicit).toEqual(baseline)
  })

  it('composes the cut with active foreground zoom', () => {
    const params = { ...SINK_PARAMS, foregroundZoom: 1.75 }
    const zoomed = grassHills.generate(params, 'root-sink-zoom', 0, WIDE)
    const unzoomed = grassHills.generate(SINK_PARAMS, 'root-sink-zoom', 0, WIDE)
    const blades = bladesByFill(zoomed)

    expect(blades.length).toBeGreaterThan(0)
    // Zoom transforms descriptors without culling: the cut applies to the
    // same blade population it applies to at identity zoom.
    expect(blades).toHaveLength(bladesByFill(unzoomed).length)
    for (const primitive of blades) {
      expect(primitive.closed).toBe(false)
      const first = primitive.points[0]!
      const last = primitive.points.at(-1)!
      expect(samePoint(first, last)).toBe(false)
      expect(first[1]).toBe(last[1])
    }
    expect(grassHills.generate(params, 'root-sink-zoom', 0, WIDE)).toEqual(
      zoomed,
    )
  })
})
