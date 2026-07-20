import { describe, expect, it } from 'vitest'

import { hiddenLinePass } from '../hiddenLine'
import type { CoordinateSpace, Primitive, Scene } from '../scene'
import { defaultParams, type Params } from '../sketch'
import { grassHills } from '../sketches/grass-hills'
import { GRASS_HILLS_TOOL_WIDTH_MILLIMETERS } from '../sketches/grass-hills/outline'
import { GRASS_HILLS_FIDELITY_FIXTURES } from './grassHillsFidelityFixtures'
import { compareVisibleContours } from './visibleContourOracle'

/**
 * Issue-315 slice acceptance sweep: the four features (terrain shaping, grass
 * exclusion, blade root sink, adaptive blade detail) at defaults are a
 * byte-identity no-op, and all of them active TOGETHER stay deterministic,
 * hidden-line faithful, and mutually non-interfering.
 */

const WIDE: CoordinateSpace = { width: 1600, height: 900 }
const SMALL: CoordinateSpace = { width: 480, height: 270 }

const BLADE_COLOR = '#ddeeaa'
const HILL_COLOR = '#88aa55'

/** Every issue-315 knob at its schema default, spelled explicitly. */
const NEW_KNOB_DEFAULTS = Object.freeze({
  terrainOctaves: 4,
  terrainRoughness: 0.5,
  terrainContrast: 1,
  terrainSharpness: 0,
  ridgeSamples: 128,
  treelineHeight: 1,
  treelineFalloff: 0.5,
  treelineStrength: 0,
  slopeBareness: 0,
  bladeRootSink: 0,
  bladeDetail: 4,
})

/**
 * All four features active at once. Root-sink blades are OPEN like hill
 * rings, so the blade and hill fills are deliberately distinct: primitives
 * are classified by fill color, never by the defaults-only `closed === true`
 * or seven-point heuristics.
 */
const ACTIVE_PARAMS = Object.freeze({
  bladeDensity: 0.004,
  terrainOctaves: 6,
  terrainSharpness: 0.7,
  terrainContrast: 2,
  ridgeSamples: 384,
  treelineStrength: 0.8,
  slopeBareness: 0.5,
  bladeRootSink: 0.2,
  bladeDetail: 10,
  foregroundZoom: 1.5,
  bladeColor: BLADE_COLOR,
  hillColor: HILL_COLOR,
})
const ACTIVE_SEED = 'issue-315-acceptance'

const OUTLINE_TARGET = Object.freeze({
  toolWidthMillimeters: GRASS_HILLS_TOOL_WIDTH_MILLIMETERS,
  millimetersPerSceneUnit: 0.18,
})

function withoutNewKnobs(params: Params): Params {
  const stripped: Params = { ...params }
  for (const key of Object.keys(NEW_KNOB_DEFAULTS)) delete stripped[key]
  return stripped
}

function bladesByFill(scene: Scene): Primitive[] {
  return scene.primitives.filter(({ fill }) => fill?.color === BLADE_COLOR)
}

function hillsByFill(scene: Scene): Primitive[] {
  return scene.primitives.filter(({ fill }) => fill?.color === HILL_COLOR)
}

/** The shared apex is each blade's strictly topmost (minimum-y) point. */
function tipOf(primitive: Primitive): readonly [number, number] {
  let tip = primitive.points[0]!
  for (const point of primitive.points) {
    if (point[1] < tip[1]) tip = point
  }
  return tip
}

/**
 * A sink/detail-invariant blade identity. `points[0][1]` is the projected
 * root y whether the first point is the closed root or the flat cut (both sit
 * at local y = 0), and the apex x is `rootX + tipOffset` bitwise regardless of
 * the cut fraction or station count, because t = 1 is a station in every list.
 */
function bladeAnchor(primitive: Primitive): string {
  return `${tipOf(primitive)[0]}|${primitive.points[0]![1]}`
}

describe('grass-hills issue-315 defaults gate', () => {
  it('matches absent knobs bit-for-bit on the bounded fidelity fixture', () => {
    const fixture = GRASS_HILLS_FIDELITY_FIXTURES.bounded
    const explicit = grassHills.generate(
      { ...fixture.params, ...NEW_KNOB_DEFAULTS },
      fixture.seed,
      fixture.time,
      fixture.frame,
    )
    const absent = grassHills.generate(
      withoutNewKnobs(fixture.params),
      fixture.seed,
      fixture.time,
      fixture.frame,
    )

    expect(explicit.primitives.length).toBeGreaterThan(
      fixture.expectedBladeCount,
    )
    expect(explicit).toEqual(absent)
  })

  it('matches absent knobs bit-for-bit on a non-square frame with grass', () => {
    const params = {
      ...defaultParams(grassHills.schema),
      ...NEW_KNOB_DEFAULTS,
      bladeDensity: 0.004,
    }
    const explicit = grassHills.generate(params, 'defaults-gate', 0, WIDE)
    const absent = grassHills.generate(
      withoutNewKnobs(params),
      'defaults-gate',
      0,
      WIDE,
    )

    expect(explicit.primitives.length).toBeGreaterThan(10)
    expect(explicit).toEqual(absent)
  })
})

describe('grass-hills issue-315 all features active', () => {
  it('is deterministic across repeated generation', () => {
    const first = grassHills.generate(ACTIVE_PARAMS, ACTIVE_SEED, 0, WIDE)
    const second = grassHills.generate(ACTIVE_PARAMS, ACTIVE_SEED, 0, WIDE)

    expect(bladesByFill(first).length).toBeGreaterThan(0)
    expect(second).toEqual(first)
  })

  it('keeps the outline source geometry and closure identical to fill', () => {
    const fill = grassHills.generate(ACTIVE_PARAMS, ACTIVE_SEED, 0, WIDE)
    const source = grassHills.generateOutlineSource!(
      ACTIVE_PARAMS,
      ACTIVE_SEED,
      0,
      WIDE,
      OUTLINE_TARGET,
    )
    const shape = ({ points, closed }: Primitive) => ({ points, closed })

    expect(source.primitives.map(shape)).toEqual(fill.primitives.map(shape))
  })

  it('outline invents nothing and misses only inside flat cut chords', () => {
    const fill = grassHills.generate(ACTIVE_PARAMS, ACTIVE_SEED, 0, WIDE)
    const outline = hiddenLinePass(
      grassHills.generateOutlineSource!(
        ACTIVE_PARAMS,
        ACTIVE_SEED,
        0,
        WIDE,
        OUTLINE_TARGET,
      ),
    )

    // With bladeRootSink active a full contour match is geometrically
    // impossible: the oracle treats every filled path as implicitly closed,
    // so each visible flat cut registers a fill contour that the outline — by
    // design, "no horizontal stroke tick at the cut" — never strokes. The
    // sanctioned acceptance property is therefore: `extra` is empty (the
    // outline invents nothing) and every `missing` interval is a sub-interval
    // of some blade's flat cut chord.
    const comparison = compareVisibleContours(fill, outline)
    const chords = bladesByFill(fill).map((primitive) => {
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

  it('opens every sunk blade while hill rings keep explicit ring closure', () => {
    const scene = grassHills.generate(ACTIVE_PARAMS, ACTIVE_SEED, 0, WIDE)
    const blades = bladesByFill(scene)
    const hills = hillsByFill(scene)

    expect(blades.length).toBeGreaterThan(0)
    for (const primitive of blades) {
      const first = primitive.points[0]!
      const last = primitive.points.at(-1)!
      expect(primitive.closed).toBe(false)
      // The flat cut endpoints stay distinct and level even under zoom.
      expect(first).not.toEqual(last)
      expect(first[1]).toBe(last[1])
      expect(first[0]).toBeGreaterThan(last[0])
    }

    expect(hills).toHaveLength(10)
    for (const primitive of hills) {
      expect(primitive.closed).toBe(false)
      expect(primitive.points).toHaveLength(384 + 6)
      expect(primitive.points.at(-1)).toEqual(primitive.points[0])
    }
  })
})

describe('grass-hills issue-315 feature interactions', () => {
  it('keeps exclusion survivors immobile as sink and detail vary together', () => {
    const base = {
      hillCount: 4,
      bladeDensity: 0.05,
      ridgeAmplitude: 3,
      treelineHeight: 0.2,
      treelineFalloff: 0.4,
      treelineStrength: 0.7,
      slopeBareness: 1,
      bladeColor: BLADE_COLOR,
      hillColor: HILL_COLOR,
    }
    const scenes = [
      base,
      { ...base, bladeRootSink: 0.2, bladeDetail: 10 },
      { ...base, bladeRootSink: 0.35, bladeDetail: 7 },
    ].map((params) => grassHills.generate(params, 'sweep', 0, SMALL))
    const unculled = grassHills.generate(
      { ...base, treelineStrength: 0, slopeBareness: 0 },
      'sweep',
      0,
      SMALL,
    )
    const anchors = scenes.map((scene) =>
      bladesByFill(scene).map(bladeAnchor).sort(),
    )

    // The filter really bites on this fixture, so anchor equality proves the
    // surviving population itself — not a trivially full one — is invariant.
    expect(anchors[0]!.length).toBeGreaterThan(0)
    expect(anchors[0]!.length).toBeLessThan(bladesByFill(unculled).length)
    // Cut fraction and station count never reroll, cull, or move a survivor:
    // every scene keeps the same blades at bitwise-identical roots and tips.
    expect(anchors[1]).toEqual(anchors[0])
    expect(anchors[2]).toEqual(anchors[0])
    // Hill rings are untouched by both blade-local knobs.
    expect(hillsByFill(scenes[1]!)).toEqual(hillsByFill(scenes[0]!))
    expect(hillsByFill(scenes[2]!)).toEqual(hillsByFill(scenes[0]!))
  })

  it('resolves shaping extremes into finite rings of ridgeSamples + 6 points', () => {
    // The issue's "no visible aliasing at high ridgeSamples" acceptance
    // criterion is verified BY PROXY here: every ring grows to exactly the
    // requested resolution and every coordinate stays finite under both
    // shaping extremes. No automated test can assert the visual property
    // itself; the proxy pins the geometry that makes it hold.
    const extremes = [
      {
        ridgeSamples: 1024,
        terrainOctaves: 8,
        terrainSharpness: 1,
        terrainContrast: 4,
        terrainRoughness: 0.9,
      },
      {
        ridgeSamples: 64,
        terrainOctaves: 1,
        terrainSharpness: 1,
        terrainContrast: 0.25,
        terrainRoughness: 0.1,
      },
    ]

    for (const shaping of extremes) {
      const scene = grassHills.generate(
        { ...shaping, bladeDensity: 0, hillColor: HILL_COLOR },
        'shaping-extremes',
        0,
        WIDE,
      )
      const hills = hillsByFill(scene)

      expect(hills).toHaveLength(10)
      for (const primitive of hills) {
        expect(primitive.points).toHaveLength(shaping.ridgeSamples + 6)
        expect(primitive.points.at(-1)).toEqual(primitive.points[0])
        expect(
          primitive.points.every(
            ([x, y]) => Number.isFinite(x) && Number.isFinite(y),
          ),
        ).toBe(true)
      }
    }
  })
})
