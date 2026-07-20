import { describe, expect, it } from 'vitest'

import type { CoordinateSpace, Primitive, Scene } from '../scene'
import { defaultParams } from '../sketch'
import { grassHills } from '../sketches/grass-hills'
import {
  createGrassSurvival,
  type GrassExclusionKnobs,
} from '../sketches/grass-hills/grass-exclusion'
import type { TerrainField } from '../sketches/grass-hills/terrain'

const BAND = { baselineY: 100, localBandHeight: 50, depth: 0.5 }
const FLAT: TerrainField = () => 0

const INACTIVE_KNOBS: GrassExclusionKnobs = {
  treelineHeight: 1,
  treelineFalloff: 0.5,
  treelineStrength: 0,
  slopeBareness: 0,
}

const FRAME: CoordinateSpace = { width: 480, height: 270 }
const SEED = 'exclusion'
const BASE = {
  ...defaultParams(grassHills.schema),
  hillCount: 4,
  bladeDensity: 0.05,
  ridgeAmplitude: 3,
}

// These fixtures keep foregroundZoom at 1 and every blade-geometry knob at its
// default, so blades are exactly the `closed: true` primitives and hill rings
// the `closed: false` ones. Do not reuse these helpers under other params.
function blades(scene: Scene): Primitive[] {
  return scene.primitives.filter(({ closed }) => closed === true)
}

function hills(scene: Scene): Primitive[] {
  return scene.primitives.filter(({ closed }) => closed === false)
}

/** Blade paths start at their translated `[0, 0]` root — a stable identity. */
function rootKey({ points }: Primitive): string {
  return `${points[0]![0]},${points[0]![1]}`
}

describe('grass survival field', () => {
  it('returns one everywhere and never samples terrain when both knobs are zero', () => {
    let terrainSamples = 0
    const terrainAt: TerrainField = () => {
      terrainSamples += 1
      return 1
    }
    const survivalAt = createGrassSurvival({
      band: BAND,
      terrainAt,
      ridgeAmplitude: 25,
      knobs: { ...INACTIVE_KNOBS, treelineHeight: 0, treelineFalloff: 0 },
    })

    for (const u of [0, 0.25, 0.5, 1]) {
      for (const projectedY of [-100, 0, 50, 100, 150]) {
        expect(survivalAt(u, projectedY)).toBe(1)
      }
    }
    expect(terrainSamples).toBe(0)
  })

  it('applies a hard elevation cut when treeline falloff is zero', () => {
    const survivalAt = createGrassSurvival({
      band: BAND,
      terrainAt: FLAT,
      ridgeAmplitude: 0.8,
      knobs: {
        treelineHeight: 0.5,
        treelineFalloff: 0,
        treelineStrength: 1,
        slopeBareness: 0,
      },
    })

    // elevation = (100 - projectedY) / 50, so the step sits at projectedY 75.
    expect(survivalAt(0.5, 76)).toBe(1)
    expect(survivalAt(0.5, 75)).toBe(0)
    expect(survivalAt(0.5, 0)).toBe(0)
    expect(survivalAt(0.5, 150)).toBe(1)
  })

  it('interpolates the treeline ramp linearly across the falloff span', () => {
    const survivalAt = createGrassSurvival({
      band: BAND,
      terrainAt: FLAT,
      ridgeAmplitude: 0.8,
      knobs: {
        treelineHeight: 0.5,
        treelineFalloff: 1,
        treelineStrength: 0.8,
        slopeBareness: 0,
      },
    })

    // The ramp spans elevations 0.5..1.5, i.e. projectedY 75 down to 25.
    expect(survivalAt(0, 75)).toBe(1)
    expect(survivalAt(0, 50)).toBeCloseTo(1 - 0.8 * 0.5, 12)
    expect(survivalAt(0, 25)).toBeCloseTo(1 - 0.8, 12)
    expect(survivalAt(0, 0)).toBeCloseTo(1 - 0.8, 12)
  })

  it('ramps slope bareness between band-relative slopes one and three', () => {
    // A linear profile has an exact central difference of 1, so the measured
    // slope equals ridgeAmplitude and the ramp can be probed directly.
    const linear: TerrainField = (x) => x
    const knobs: GrassExclusionKnobs = {
      ...INACTIVE_KNOBS,
      slopeBareness: 1,
    }
    const survivalFor = (ridgeAmplitude: number) =>
      createGrassSurvival({
        band: BAND,
        terrainAt: linear,
        ridgeAmplitude,
        knobs,
      })(0.5, BAND.baselineY)

    expect(survivalFor(0.5)).toBe(1)
    expect(survivalFor(1)).toBe(1)
    expect(survivalFor(2)).toBeCloseTo(0.5, 12)
    expect(survivalFor(2.5)).toBeCloseTo(0.25, 12)
    expect(survivalFor(3)).toBeCloseTo(0, 12)
    expect(survivalFor(100)).toBe(0)
  })

  it('keeps the slope term identical across bands with different screen heights', () => {
    const terrainAt: TerrainField = (x, depth) => Math.sin(7 * x + depth)
    const knobs: GrassExclusionKnobs = {
      ...INACTIVE_KNOBS,
      slopeBareness: 0.9,
    }
    const far = createGrassSurvival({
      band: { baselineY: 30, localBandHeight: 6, depth: 0.75 },
      terrainAt,
      ridgeAmplitude: 2,
      knobs,
    })
    const near = createGrassSurvival({
      band: { baselineY: 90, localBandHeight: 40, depth: 0.75 },
      terrainAt,
      ridgeAmplitude: 2,
      knobs,
    })

    for (const u of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      expect(near(u, 95)).toBe(far(u, 12))
    }
  })
})

describe('grass-hills exclusion integration', () => {
  it('drops blade count at full treeline or slope strength', () => {
    const baseline = grassHills.generate(BASE, SEED, 0, FRAME)
    const treeline = grassHills.generate(
      { ...BASE, treelineHeight: 0.2, treelineFalloff: 0.4, treelineStrength: 1 },
      SEED,
      0,
      FRAME,
    )
    const slope = grassHills.generate(
      { ...BASE, slopeBareness: 1 },
      SEED,
      0,
      FRAME,
    )

    expect(blades(baseline).length).toBeGreaterThan(0)
    expect(blades(treeline).length).toBeLessThan(blades(baseline).length)
    expect(blades(slope).length).toBeLessThan(blades(baseline).length)
    expect(hills(treeline)).toEqual(hills(baseline))
    expect(hills(slope)).toEqual(hills(baseline))
  })

  it('keeps every surviving blade byte-identical to its baseline counterpart', () => {
    const baseline = grassHills.generate(BASE, SEED, 0, FRAME)
    const culled = grassHills.generate(
      {
        ...BASE,
        treelineHeight: 0.2,
        treelineFalloff: 0.4,
        treelineStrength: 0.7,
        slopeBareness: 1,
      },
      SEED,
      0,
      FRAME,
    )
    const baselineByRoot = new Map(
      blades(baseline).map((primitive) => [rootKey(primitive), primitive]),
    )
    const survivors = blades(culled)

    expect(survivors.length).toBeGreaterThan(0)
    expect(survivors.length).toBeLessThan(baselineByRoot.size)
    for (const survivor of survivors) {
      expect(survivor).toEqual(baselineByRoot.get(rootKey(survivor)))
    }
  })

  it('deep-equals the baseline at zero strengths despite extreme relief and knob values', () => {
    const extreme = { ...BASE, ridgeAmplitude: 10 }
    const baseline = grassHills.generate(extreme, SEED, 0, FRAME)
    const explicit = grassHills.generate(
      {
        ...extreme,
        treelineHeight: 2,
        treelineFalloff: 0,
        treelineStrength: 0,
        slopeBareness: 0,
      },
      SEED,
      0,
      FRAME,
    )

    expect(explicit).toEqual(baseline)
  })

  it('keeps survivors at full strength a subset of survivors at half strength', () => {
    const shared = { ...BASE, treelineHeight: 0.2, treelineFalloff: 0.6 }
    const half = grassHills.generate(
      { ...shared, treelineStrength: 0.5 },
      SEED,
      0,
      FRAME,
    )
    const full = grassHills.generate(
      { ...shared, treelineStrength: 1 },
      SEED,
      0,
      FRAME,
    )
    const halfRoots = new Set(blades(half).map(rootKey))
    const fullRoots = new Set(blades(full).map(rootKey))

    expect(fullRoots.size).toBeGreaterThan(0)
    expect(fullRoots.size).toBeLessThan(halfRoots.size)
    for (const root of fullRoots) {
      expect(halfRoots.has(root)).toBe(true)
    }
  })

  it('is deterministic across repeated generation with active exclusion', () => {
    const params = {
      ...BASE,
      treelineHeight: 0.2,
      treelineFalloff: 0.4,
      treelineStrength: 0.8,
      slopeBareness: 0.6,
    }

    expect(grassHills.generate(params, SEED, 0, FRAME)).toEqual(
      grassHills.generate(params, SEED, 0, FRAME),
    )
  })
})
