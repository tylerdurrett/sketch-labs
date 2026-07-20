import { describe, expect, it } from 'vitest'

import type { CoordinateSpace, Primitive, Scene } from '../scene'
import { grassHills } from '../sketches/grass-hills'
import { FLANK_STATIONS } from '../sketches/grass-hills/blade'
import { resolveFlankStations } from '../sketches/grass-hills/blade-stations'
import { GRASS_HILLS_TOOL_WIDTH_MILLIMETERS } from '../sketches/grass-hills/outline'

const SCALES = [0.2, 0.35, 0.6, 0.875, 1] as const
const ZOOMS = [1, 1.45, 2] as const

describe('grass-hills blade stations', () => {
  it('returns the exact legacy array for detail 4 at every scale and zoom', () => {
    for (const scale of SCALES) {
      for (const zoom of ZOOMS) {
        expect(resolveFlankStations(4, scale, zoom)).toBe(FLANK_STATIONS)
      }
    }
    expect(FLANK_STATIONS).toEqual([0, 0.5, 0.82, 1])
  })

  it('clamps to the legacy four-station floor at the perspective scale floor', () => {
    const stations = resolveFlankStations(16, 0.2, 1)

    expect(stations).toHaveLength(4)
    expect(stations).toBe(FLANK_STATIONS)
  })

  it('spends the whole budget at full scale and never exceeds it under zoom', () => {
    expect(resolveFlankStations(12, 1, 1)).toHaveLength(12)
    expect(resolveFlankStations(16, 1, 1)).toHaveLength(16)
    // min(1, scale * zoom) caps the multiplier: zoom cannot overshoot detail.
    expect(resolveFlankStations(12, 1, 2)).toHaveLength(12)
    expect(resolveFlankStations(12, 0.9, 2)).toHaveLength(12)
  })

  it('lets active zoom restore detail that perspective scale alone shed', () => {
    expect(resolveFlankStations(12, 0.5, 1)).toHaveLength(6)
    expect(resolveFlankStations(12, 0.5, 1.5)).toHaveLength(9)
  })

  it('keeps the endpoints exactly 0 and 1 at every resolved count', () => {
    for (let detail = 5; detail <= 16; detail++) {
      const stations = resolveFlankStations(detail, 1, 1)
      expect(stations).toHaveLength(detail)
      expect(stations[0]).toBe(0)
      expect(stations.at(-1)).toBe(1)
    }
  })

  it('emits strictly ascending stations with gaps shrinking toward the tip', () => {
    for (let detail = 5; detail <= 16; detail++) {
      const stations = resolveFlankStations(detail, 1, 1)
      const gaps: number[] = []
      for (let index = 1; index < stations.length; index++) {
        expect(stations[index]!).toBeGreaterThan(stations[index - 1]!)
        gaps.push(stations[index]! - stations[index - 1]!)
      }
      for (let index = 1; index < gaps.length; index++) {
        expect(gaps[index]!).toBeLessThan(gaps[index - 1]!)
      }
    }
  })
})

const WIDE: CoordinateSpace = { width: 1600, height: 900 }

const BLADE_COLOR = '#ddeeaa'
const HILL_COLOR = '#88aa55'

/**
 * Low-density adaptive-detail fixture. Blade and hill fills are deliberately
 * distinct so primitives are classified by fill color instead of the
 * default-geometry heuristics (seven-point counting) that raised detail
 * invalidates.
 */
const DETAIL_PARAMS = Object.freeze({
  bladeDensity: 0.004,
  bladeDetail: 12,
  foregroundZoom: 1,
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

describe('grass-hills blade detail integration', () => {
  it('tessellates near blades densely while floor blades keep seven points', () => {
    const fill = grassHills.generate(DETAIL_PARAMS, 'blade-detail', 0, WIDE)
    const blades = bladesByFill(fill)

    expect(blades.length).toBeGreaterThan(0)
    const counts = blades.map(({ points }) => points.length)
    expect(counts.some((count) => count > 7)).toBe(true)
    expect(counts.some((count) => count === 7)).toBe(true)
    for (const count of counts) {
      // Uncut emission is always 2 * stations - 1 for station counts in
      // [4, bladeDetail].
      expect(count % 2).toBe(1)
      expect(count).toBeGreaterThanOrEqual(7)
      expect(count).toBeLessThanOrEqual(2 * DETAIL_PARAMS.bladeDetail - 1)
    }
  })

  it('renders floor blades identically to the bladeDetail-4 run of the same roots', () => {
    const raised = grassHills.generate(DETAIL_PARAMS, 'blade-detail', 0, WIDE)
    const legacy = grassHills.generate(
      { ...DETAIL_PARAMS, bladeDetail: 4 },
      'blade-detail',
      0,
      WIDE,
    )
    const raisedBlades = bladesByFill(raised)
    const legacyBlades = bladesByFill(legacy)

    // Detail never selects or reorders blades: populations pair by index.
    expect(raisedBlades.length).toBe(legacyBlades.length)
    let floorBlades = 0
    raisedBlades.forEach((primitive, index) => {
      const counterpart = legacyBlades[index]!
      expect(primitive.points[0]).toEqual(counterpart.points[0])
      if (primitive.points.length === 7) {
        expect(primitive.points).toEqual(counterpart.points)
        floorBlades++
      }
    })
    expect(floorBlades).toBeGreaterThan(0)
  })

  it('keeps the outline source geometry equal to fill at raised detail', () => {
    const fill = grassHills.generate(DETAIL_PARAMS, 'blade-detail', 0, WIDE)
    const source = grassHills.generateOutlineSource!(
      DETAIL_PARAMS,
      'blade-detail',
      0,
      WIDE,
      OUTLINE_TARGET,
    )

    expect(source.primitives).toHaveLength(fill.primitives.length)
    source.primitives.forEach((primitive, index) => {
      expect(primitive.points).toEqual(fill.primitives[index]!.points)
    })
  })

  it('deep-equals the no-param scene at explicit bladeDetail 4', () => {
    const params = { bladeDensity: 0.004 }
    const baseline = grassHills.generate(params, 'detail-identity', 0, WIDE)
    const explicit = grassHills.generate(
      { ...params, bladeDetail: 4, foregroundZoom: 1 },
      'detail-identity',
      0,
      WIDE,
    )

    expect(explicit).toEqual(baseline)
  })
})
