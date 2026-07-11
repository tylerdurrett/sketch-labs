import { describe, expect, it } from 'vitest'

import * as barrel from '../index'
import { prepareCurlAngle4D } from '../curl'
import { createRandom } from '../random'
import { circles } from '../sketches/circles'
import { leafField } from '../sketches/leaf-field'
import { bbox as pointsBBox, HEIGHT, WIDTH } from '../sketches/sketch-util'
import type { Params } from '../sketch'
import type { Point } from '../types'
import type { Primitive } from '../scene'
import { DEFAULT_COMPOSITION_FRAME } from '../compositionFrame'

/**
 * The nineteen leaf-field knobs in Studio declaration order.
 */
const KNOBS = [
  'fieldPhase',
  'fieldScale',
  'turbulence',
  'octaves',
  'density',
  'leafScale',
  'leafSizeVariance',
  'leafSlenderness',
  'leafSlendernessVariance',
  'variation',
  'sphereCount',
  'sphereRadiusMin',
  'sphereRadiusMax',
  'sphereDepth',
  'backgroundColor',
  'discColor',
  'discStrokeColor',
  'leafColor',
  'leafStrokeColor',
] as const

/** The bold dark fill and paper-colored rim the audit pinned (see the sketch header). */
const LEAF_FILL = '#1a1a1a'
const PAPER_STROKE = '#f4f1ea'

/**
 * The occluder discs' DEFAULT fill — the `discColor` knob's default. NOT equal
 * to `backgroundColor`'s default (`#878787`, mid gray): at the defaults the
 * discs read as visible white orbs; disc == background (implied-sphere
 * figure-ground) is an opt-in param choice (see the sketch header's occluder
 * rationale).
 */
const DISC_FILL = '#ffffff'

/** A leaf Primitive (the dark-filled polygons) as opposed to the occluder disc. */
function isLeaf(primitive: Primitive): boolean {
  return primitive.fill?.color === LEAF_FILL
}

/** Just the leaf Primitives of a scene, with the single occluder disc filtered out. */
function leavesOf(scene: { primitives: Primitive[] }): Primitive[] {
  return scene.primitives.filter(isLeaf)
}

/** Axis-aligned bounding box of a single primitive's points. */
function primitiveBBox(primitive: Primitive) {
  return pointsBBox(primitive.points)
}

/** True if two axis-aligned bounding boxes overlap. */
function bboxesOverlap(
  a: ReturnType<typeof primitiveBBox>,
  b: ReturnType<typeof primitiveBBox>,
): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY
}

/**
 * Field params the orientation test drives the sketch with and mirrors here so
 * it can reconstruct the same curl field the sketch samples. A higher fieldScale
 * than the smooth default is used deliberately so mismatched (shuffled) leaf↔
 * field pairings decorrelate and the coherence assertion keeps its teeth.
 */
const ORIENT_FIELD_SCALE = 3
const ORIENT_OCTAVES = 2
// Pinned in the generate call below AND in fieldAxisAt's reconstruction so the
// two agree — the field must be sampled with the same gain the test rebuilds it
// with, independent of the sketch's shipped `turbulence` default.
const ORIENT_TURBULENCE = 0.5

/** Center of a primitive's bounding box — the point the sketch translated it onto. */
function primitiveCentroid(primitive: Primitive): Point {
  const { minX, minY, maxX, maxY } = primitiveBBox(primitive)
  return [(minX + maxX) / 2, (minY + maxY) / 2]
}

/**
 * The delta vector between a leaf's two farthest-apart vertices — its long axis
 * (base↔apex). This single scan backs both the leaf's undirected spine ANGLE
 * (`atan2`, with a 180° ambiguity callers resolve by angle-doubling) and its
 * rotation-invariant LENGTH (`hypot`).
 */
function farthestVertexDelta(primitive: Primitive): Point {
  const pts = primitive.points
  let best = -1
  let ax = 0
  let ay = 0
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j]![0] - pts[i]![0]
      const dy = pts[j]![1] - pts[i]![1]
      const d2 = dx * dx + dy * dy
      if (d2 > best) {
        best = d2
        ax = dx
        ay = dy
      }
    }
  }
  return [ax, ay]
}

/** Undirected spine axis angle (radians); the 180° ambiguity is caller-resolved. */
function spineAxisAngle(primitive: Primitive): number {
  const [dx, dy] = farthestVertexDelta(primitive)
  return Math.atan2(dy, dx)
}

/**
 * Mean resultant length of the DOUBLED angle differences between each leaf's
 * spine axis and the field axis at its centroid. Doubling collapses the 180°
 * spine ambiguity (an axis, not a direction); the resultant length is ~1 when
 * the differences cluster tightly (orientation tracks the field) and ~0 when
 * they scatter (random). `sampleAxis` lets callers pair each leaf with either
 * its own centroid (coherent) or a mismatched one (random baseline).
 */
function fieldAlignment(
  primitives: Primitive[],
  seed: string,
  sampleAxis: (i: number) => number,
): number {
  let sumCos = 0
  let sumSin = 0
  for (let i = 0; i < primitives.length; i++) {
    const spine = spineAxisAngle(primitives[i]!)
    const diff = 2 * (spine - sampleAxis(i))
    sumCos += Math.cos(diff)
    sumSin += Math.sin(diff)
  }
  return Math.hypot(sumCos, sumSin) / primitives.length
}

/**
 * Field axis angle at a leaf's centroid, reconstructed the same way the source
 * does: same prepared curl sampler, CANVAS-NORMALIZED coords, same
 * fieldScale/octaves/turbulence, same rng-from-seed, and phase 0's loop
 * coordinates.
 */
function fieldAxisAt(primitive: Primitive, seed: string): number {
  const rng = createRandom(seed)
  const [cx, cy] = primitiveCentroid(primitive)
  const angleAt = prepareCurlAngle4D(rng, {
    gain: ORIENT_TURBULENCE,
    octaves: ORIENT_OCTAVES,
  })
  return angleAt(
    (cx / WIDTH) * ORIENT_FIELD_SCALE,
    (cy / HEIGHT) * ORIENT_FIELD_SCALE,
    1,
    0,
  )
}

/**
 * Rotation-invariant leaf length: the distance between the two farthest-apart
 * vertices (base↔apex). Unlike an axis-aligned bbox diagonal, this is unaffected
 * by the leaf's flow rotation, so at variation 0 all leaves measure equal.
 */
function spineLength(primitive: Primitive): number {
  const [dx, dy] = farthestVertexDelta(primitive)
  return Math.hypot(dx, dy)
}

/** Spread (max − min) of the leaf spine lengths in a scene, a proxy for size variation. */
function spineLengthSpread(primitives: Primitive[]): number {
  const lengths = primitives.map(spineLength)
  return Math.max(...lengths) - Math.min(...lengths)
}

/**
 * Shoelace area of a closed leaf outline — a ROTATION-INVARIANT measure of how
 * much a leaf covers, so it isolates the leaf width (slenderness) knobs from the
 * per-leaf flow rotation. The ring is closed (last === first), so the walk stops
 * one short of the end.
 */
function polygonArea(primitive: Primitive): number {
  const pts = primitive.points
  let acc = 0
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i]!
    const [x2, y2] = pts[i + 1]!
    acc += x1 * y2 - x2 * y1
  }
  return Math.abs(acc) / 2
}

/** Mean leaf area across a scene. */
function meanLeafArea(primitives: Primitive[]): number {
  return primitives.reduce((sum, p) => sum + polygonArea(p), 0) / primitives.length
}

describe('leaf-field Sketch contract', () => {
  it('declares exactly the nineteen knobs in Studio order and NO time metadata (static)', () => {
    expect(Object.keys(leafField.schema)).toEqual([...KNOBS])
    expect(leafField.schema.sphereCount.max).toBe(25)
    expect(leafField.schema.fieldScale.min).toBe(0.05)
    expect(leafField.schema.turbulence.max).toBe(3)
    expect(leafField.schema.fieldPhase).toEqual({
      kind: 'number',
      min: 0,
      max: 1,
      default: 0,
      step: 0.001,
    })
    // Static Sketch: absence of `time` is what makes the Harness hide the scrubber.
    expect(leafField.time).toBeUndefined()
  })

  it('bakes a FIELD of closed leaves, each dark-filled with a distinct paper rim', () => {
    const scene = leafField.generate({}, 'seed-a', 0, DEFAULT_COMPOSITION_FRAME)
    const leaves = leavesOf(scene)
    // A field, not one leaf.
    expect(leaves.length).toBeGreaterThan(1)
    for (const primitive of leaves) {
      expect(primitive.closed).toBe(true)
      // Audit's painter's-order-observability requirement: bold dark FILL AND a
      // light paper STROKE, and the two colors must be distinct so overlap reads.
      expect(primitive.fill?.color).toBe(LEAF_FILL)
      expect(primitive.stroke?.color).toBe(PAPER_STROKE)
      expect(primitive.fill?.color).not.toBe(primitive.stroke?.color)
      // A closed leaf outline is a non-degenerate ring of points.
      expect(primitive.points.length).toBeGreaterThan(3)
    }
  })
})

describe('leaf-field density is live-tunable', () => {
  it('a higher density yields strictly more leaves than a lower density at the same seed', () => {
    const seed = 'held'
    const sparse = leafField.generate({ density: 2 }, seed, 0, DEFAULT_COMPOSITION_FRAME)
    const dense = leafField.generate({ density: 10 }, seed, 0, DEFAULT_COMPOSITION_FRAME)
    expect(leavesOf(dense).length).toBeGreaterThan(leavesOf(sparse).length)
  })
})

describe("leaf-field painter's order / overlap", () => {
  it('bakes many overlapping leaves in draw order (index 0 = bottom)', () => {
    // A dense field of large leaves: total leaf area far exceeds the canvas, so
    // leaves must overlap. Assert externally-observable overlap of two bboxes.
    const scene = leafField.generate(
      { density: 12, leafScale: 350, leafSizeVariance: 50 },
      'overlap-seed',
      0, DEFAULT_COMPOSITION_FRAME,
    )
    expect(scene.primitives.length).toBeGreaterThan(1)

    // At least one pair of primitive bounding boxes intersects.
    let foundOverlap = false
    outer: for (let i = 0; i < scene.primitives.length; i++) {
      const a = primitiveBBox(scene.primitives[i]!)
      for (let j = i + 1; j < scene.primitives.length; j++) {
        if (bboxesOverlap(a, primitiveBBox(scene.primitives[j]!))) {
          foundOverlap = true
          break outer
        }
      }
    }
    expect(foundOverlap).toBe(true)
  })
})

describe('leaf-field determinism (ADR-0002)', () => {
  it('is deterministic at the Scene level for identical (params, seed, t)', () => {
    const params: Params = { density: 6, leafScale: 160, leafSizeVariance: 40 }
    const a = leafField.generate(params, 'fixed-seed', 0, DEFAULT_COMPOSITION_FRAME)
    const b = leafField.generate(params, 'fixed-seed', 0, DEFAULT_COMPOSITION_FRAME)
    expect(a).toEqual(b)
  })

  it('carries no cross-call state — an interleaved generate does not perturb the result', () => {
    const params: Params = { density: 7 }
    const first = leafField.generate(params, 's', 0, DEFAULT_COMPOSITION_FRAME)
    // Interleave unrelated generate calls to surface any accumulated state.
    leafField.generate({ density: 3 }, 'other', 3, DEFAULT_COMPOSITION_FRAME)
    circles.generate({ count: 5 }, 'yet-another', 1, DEFAULT_COMPOSITION_FRAME)
    const again = leafField.generate(params, 's', 0, DEFAULT_COMPOSITION_FRAME)
    expect(again).toEqual(first)
  })

  it('threads t LIVE around the 4D loop, staying static via no time metadata', () => {
    // A different t advances the normalized circular phase and reorients the
    // field. The Sketch still ships static: it declares NO `time` metadata, so
    // the Harness pins t=0 and this live plumbing is a metadata swap away from
    // animating rather than a rewrite. Determinism at a fixed t is covered above.
    const params: Params = { density: 5 }
    const atZero = leafField.generate(params, 's', 0, DEFAULT_COMPOSITION_FRAME)
    const atLater = leafField.generate(params, 's', 42, DEFAULT_COMPOSITION_FRAME)
    expect(atLater).not.toEqual(atZero)
    expect(leafField.time).toBeUndefined()
  })
})

describe('leaf-field caller-owned preparation', () => {
  it('samples byte-exact Scenes through cold generate and a retained warm sampler', () => {
    const fixtures: Array<{ params: Params; seed: string; times: number[] }> = [
      { params: {}, seed: 'prepared-default', times: [0, 1 / 60, 3.75] },
      {
        params: {
          density: 6,
          variation: 0.7,
          sphereCount: 3,
          sphereDepth: 0.2,
        },
        seed: 'prepared-varied',
        times: [0, 0.125, 42],
      },
    ]

    for (const { params, seed, times } of fixtures) {
      const prepared = leafField.prepare(params, seed, DEFAULT_COMPOSITION_FRAME)
      for (const t of times) {
        expect(prepared(t)).toEqual(leafField.generate(params, seed, t, DEFAULT_COMPOSITION_FRAME))
      }
    }
  })

  it('retains only immutable private layout — mutating one Scene cannot poison another', () => {
    const params: Params = { density: 5, variation: 0.4, sphereCount: 2 }
    const prepared = leafField.prepare(params, 'prepared-immutable', DEFAULT_COMPOSITION_FRAME)
    const first = prepared(0.5)
    const firstPoint = first.primitives[0]?.points[0]
    expect(firstPoint).toBeDefined()
    firstPoint![0] = Number.NaN

    expect(prepared(0.5)).toEqual(leafField.generate(params, 'prepared-immutable', 0.5, DEFAULT_COMPOSITION_FRAME))
  })

  it('carries no shared state across prepared callers or interleaved times', () => {
    const params: Params = { density: 5, variation: 0.6 }
    const a = leafField.prepare(params, 'prepared-interleave', DEFAULT_COMPOSITION_FRAME)
    const b = leafField.prepare(params, 'prepared-interleave', DEFAULT_COMPOSITION_FRAME)
    const expected = a(1.25)

    a(9)
    b(3)
    expect(a(1.25)).toEqual(expected)
    expect(b(1.25)).toEqual(expected)
  })
})

describe('leaf-field seed independence', () => {
  it('a different seed rearranges the field while params hold', () => {
    const params: Params = { density: 6 }
    const sceneA = leafField.generate(params, 'seed-a', 0, DEFAULT_COMPOSITION_FRAME)
    const sceneB = leafField.generate(params, 'seed-b', 0, DEFAULT_COMPOSITION_FRAME)
    // The Poisson scatter is seeded, so a re-seed reshuffles placement.
    expect(sceneB).not.toEqual(sceneA)
  })

  it('a re-seed shifts BOTH orientation and variation, not just placement', () => {
    // With variation live, a re-seed must reshuffle scatter, reroll every leaf's
    // shape, AND re-anchor the flow field (curl reads the same seed). Assert the
    // per-leaf spine-length multisets differ — that only holds if the seeded
    // shape rolls (and their flow-driven orientation) genuinely changed.
    const params: Params = { density: 6, variation: 0.6 }
    const a = leafField.generate(params, 'orient-a', 0, DEFAULT_COMPOSITION_FRAME)
    const b = leafField.generate(params, 'orient-b', 0, DEFAULT_COMPOSITION_FRAME)
    // Rotation-invariant spine lengths: differences here come from the seeded
    // SHAPE rolls (size variation), not merely from different rotations.
    const lengths = (scene: typeof a): number[] =>
      leavesOf(scene)
        .map((p) => Math.round(spineLength(p)))
        .sort((x, y) => x - y)
    expect(lengths(b)).not.toEqual(lengths(a))
  })
})

describe('leaf-field flow-field orientation (#127)', () => {
  it('orients leaves coherently with the flow field, not randomly', () => {
    const seed = 'orient'
    // Sparse enough that farthest-vertex spine recovery is unambiguous, variation
    // 0 so the spine axis reflects orientation alone (not per-leaf shape noise).
    // fieldScale/octaves are pinned to match the reconstruction in fieldAxisAt.
    const scene = leafField.generate(
      {
        density: 4,
        variation: 0,
        fieldScale: ORIENT_FIELD_SCALE,
        octaves: ORIENT_OCTAVES,
        turbulence: ORIENT_TURBULENCE,
      },
      seed,
      0, DEFAULT_COMPOSITION_FRAME,
    )
    const leaves = leavesOf(scene)
    expect(leaves.length).toBeGreaterThan(5)

    // Each leaf paired with the field at its OWN centroid ⇒ tight cluster.
    const coherent = fieldAlignment(leaves, seed, (i) => fieldAxisAt(leaves[i]!, seed))
    expect(coherent).toBeGreaterThan(0.8)

    // Baseline: pair each leaf with a MISMATCHED (rotated-index) centroid's field
    // axis ⇒ should NOT cluster, proving the test has teeth.
    const shuffled = fieldAlignment(leaves, seed, (i) =>
      fieldAxisAt(leaves[(i + 1) % leaves.length]!, seed),
    )
    expect(shuffled).toBeLessThan(coherent)
    expect(shuffled).toBeLessThan(0.6)
  })
})

describe('leaf-field 4D flow phase', () => {
  it('changes orientation and vortex-aware sphere placement while leaf layout/shape stay invariant', () => {
    const params: Params = {
      density: 5,
      variation: 0.7,
      sphereCount: 3,
      fieldPhase: 0,
    }
    const seed = 'phase-isolation'
    const start = leafField.generate(params, seed, 0, DEFAULT_COMPOSITION_FRAME)
    const evolved = leafField.generate({ ...params, fieldPhase: 0.25 }, seed, 0, DEFAULT_COMPOSITION_FRAME)
    const startLeaves = leavesOf(start)
    const evolvedLeaves = leavesOf(evolved)

    expect(evolvedLeaves).toHaveLength(startLeaves.length)
    let changedOrientations = 0
    for (let i = 0; i < startLeaves.length; i++) {
      const before = startLeaves[i]!
      const after = evolvedLeaves[i]!
      const [beforeCx, beforeCy] = primitiveCentroid(before)
      const [afterCx, afterCy] = primitiveCentroid(after)
      expect(afterCx).toBeCloseTo(beforeCx, 10)
      expect(afterCy).toBeCloseTo(beforeCy, 10)
      expect(after.points).toHaveLength(before.points.length)
      expect(spineLength(after)).toBeCloseTo(spineLength(before), 8)
      expect(polygonArea(after)).toBeCloseTo(polygonArea(before), 7)
      if (Math.abs(Math.sin(spineAxisAngle(after) - spineAxisAngle(before))) > 0.05) {
        changedOrientations++
      }
    }
    expect(changedOrientations).toBeGreaterThan(startLeaves.length / 2)

    const spheresOf = (scene: typeof start): Primitive[] =>
      scene.primitives.filter((primitive) => !isLeaf(primitive))
    expect(spheresOf(evolved)).not.toEqual(spheresOf(start))
  })

  it('anchors sphere geometry at fieldPhase inside one prepared time sampler', () => {
    const prepared = leafField.prepare(
      { density: 4, sphereCount: 3, fieldPhase: 0.17 },
      'phase-time-anchor', DEFAULT_COMPOSITION_FRAME,
    )
    const atStart = prepared(0)
    const atLaterTime = prepared(3)
    const spheresOf = (scene: typeof atStart): Primitive[] =>
      scene.primitives.filter((primitive) => !isLeaf(primitive))

    expect(spheresOf(atLaterTime)).toEqual(spheresOf(atStart))
    expect(leavesOf(atLaterTime)).not.toEqual(leavesOf(atStart))
  })

  it('is seamless at the normalized phase boundary and after one future loop duration', () => {
    const params: Params = { density: 4, variation: 0.5, sphereCount: 2 }
    const seed = 'phase-loop-boundary'
    expect(leafField.generate({ ...params, fieldPhase: 1 }, seed, 0, DEFAULT_COMPOSITION_FRAME)).toEqual(
      leafField.generate({ ...params, fieldPhase: 0 }, seed, 0, DEFAULT_COMPOSITION_FRAME),
    )

    // A nonzero offset keeps this assertion sensitive to floating-point seams
    // caused by composing the public phase with one wrapped time revolution.
    const prepared = leafField.prepare({ ...params, fieldPhase: 0.37 }, seed, DEFAULT_COMPOSITION_FRAME)
    expect(prepared(12)).toEqual(prepared(0))
    expect(prepared(-12)).toEqual(prepared(0))
  })
})

describe('leaf-field per-leaf variation (#127)', () => {
  it('at nonzero variation, no two leaves are geometrically identical', () => {
    const scene = leafField.generate({ density: 6, variation: 0.6 }, 'vary', 0, DEFAULT_COMPOSITION_FRAME)
    const hashes = leavesOf(scene).map((p) => JSON.stringify(p.points))
    expect(new Set(hashes).size).toBe(hashes.length)
  })

  it('more leafSizeVariance yields strictly more size spread at the same seed', () => {
    const seed = 'spread'
    const narrow = leafField.generate(
      { density: 6, leafScale: 110, leafSizeVariance: 10 },
      seed,
      0, DEFAULT_COMPOSITION_FRAME,
    )
    const wide = leafField.generate(
      { density: 6, leafScale: 110, leafSizeVariance: 90 },
      seed,
      0, DEFAULT_COMPOSITION_FRAME,
    )
    expect(spineLengthSpread(leavesOf(wide))).toBeGreaterThan(
      spineLengthSpread(leavesOf(narrow)),
    )
  })

  it('leaves vary in size at variation 0 — size is decoupled from the shape-variation knob', () => {
    // At variation 0 curl/wobble collapse to the base, but length still draws
    // across the range, so the field is NOT uniform in size.
    const scene = leafField.generate(
      { density: 6, variation: 0, leafScale: 115, leafSizeVariance: 85 },
      'flat',
      0, DEFAULT_COMPOSITION_FRAME,
    )
    expect(spineLengthSpread(leavesOf(scene))).toBeGreaterThan(1)
  })

  it('leafSizeVariance 0 yields a uniform-size field (spread ~0)', () => {
    const scene = leafField.generate(
      { density: 6, leafScale: 120, leafSizeVariance: 0 },
      'uniform',
      0, DEFAULT_COMPOSITION_FRAME,
    )
    // Every leaf draws the same length, so spine lengths — a rotation-invariant
    // diagonal measure — match to within float noise. (The occluder disc is
    // filtered out; its diameter is unrelated to leaf size.)
    expect(spineLengthSpread(leavesOf(scene))).toBeLessThan(1e-6)
  })
})

describe('leaf-field slenderness knobs', () => {
  it('higher slenderness yields skinnier leaves at the same seed', () => {
    const seed = 'slenderness'
    const slender = leafField.generate(
      { density: 5, variation: 0, leafSlenderness: 5, leafSlendernessVariance: 0 },
      seed,
      0, DEFAULT_COMPOSITION_FRAME,
    )
    const broad = leafField.generate(
      { density: 5, variation: 0, leafSlenderness: 1, leafSlendernessVariance: 0 },
      seed,
      0, DEFAULT_COMPOSITION_FRAME,
    )
    expect(leavesOf(broad).length).toBe(leavesOf(slender).length)
    expect(meanLeafArea(leavesOf(broad))).toBeGreaterThan(
      meanLeafArea(leavesOf(slender)),
    )
  })

  it('leafSlendernessVariance changes the baked proportions', () => {
    const seed = 'slenderness-range'
    const uniform = leafField.generate(
      { density: 6, variation: 0, leafSlenderness: 2, leafSlendernessVariance: 0 },
      seed,
      0, DEFAULT_COMPOSITION_FRAME,
    )
    const wide = leafField.generate(
      { density: 6, variation: 0, leafSlenderness: 2, leafSlendernessVariance: 1.5 },
      seed,
      0, DEFAULT_COMPOSITION_FRAME,
    )
    expect(wide).not.toEqual(uniform)
  })

  it('zero slenderness variance is deterministic and reproducible', () => {
    const params: Params = {
      density: 6,
      variation: 0,
      leafSlenderness: 2,
      leafSlendernessVariance: 0,
    }
    const a = leafField.generate(params, 'width-uniform', 0, DEFAULT_COMPOSITION_FRAME)
    const b = leafField.generate(params, 'width-uniform', 0, DEFAULT_COMPOSITION_FRAME)
    expect(a).toEqual(b)
  })

})

describe('leaf-field draw boundary', () => {
  it('emits only generic Primitive records — no leaf-typed field crosses the boundary', () => {
    const scene = leafField.generate({}, 'seed', 0, DEFAULT_COMPOSITION_FRAME)
    // The Scene container carries only the generic IR fields: `space`,
    // `primitives`, and the declared `background` (ADR-0009) — no domain field.
    expect(Object.keys(scene).sort()).toEqual(['background', 'primitives', 'space'])
    const allowed = new Set(['points', 'closed', 'fill', 'stroke'])
    for (const primitive of scene.primitives) {
      // Each Primitive is a plain record: only points/closed/fill/stroke keys.
      for (const key of Object.keys(primitive)) {
        expect(allowed.has(key)).toBe(true)
      }
      // Points are plain [x, y] number tuples — no domain object smuggled in.
      for (const point of primitive.points) {
        expect(point).toHaveLength(2)
        expect(typeof point[0]).toBe('number')
        expect(typeof point[1]).toBe('number')
      }
    }
  })

  it('the public barrel exposes leafField but no leaf domain type', () => {
    expect(barrel.leafField).toBe(leafField)
    // The private leaf generator/type must never leak across the public barrel.
    expect('leaf' in barrel).toBe(false)
    expect('LeafShape' in barrel).toBe(false)
  })
})

/**
 * The single opaque occluder disc that makes the field's negative space read as
 * an implied sphere (#140). Its center/radius are recovered from the disc
 * Primitive itself; `orient` is a seed whose seeded depth lands leaves both
 * behind (occluded) and in front of (lapping) the disc.
 */
describe('leaf-field implied-sphere occluder (#140)', () => {
  /** The lone occluder disc — the only background-filled Primitive in a scene. */
  function discOf(scene: { primitives: Primitive[] }): Primitive {
    const discs = scene.primitives.filter((p) => p.fill?.color === DISC_FILL)
    expect(discs).toHaveLength(1)
    return discs[0]!
  }

  /** Disc center (bbox center of a circle == its true center). */
  function discCenter(disc: Primitive): Point {
    return primitiveCentroid(disc)
  }

  /** Disc radius, read off the bbox width of the circular silhouette. */
  function discRadius(disc: Primitive): number {
    const { minX, maxX } = primitiveBBox(disc)
    return (maxX - minX) / 2
  }

  it('bakes exactly one opaque discColor-filled, discStrokeColor-outlined disc', () => {
    const scene = leafField.generate({ sphereCount: 1 }, 'orient', 0, DEFAULT_COMPOSITION_FRAME)
    const disc = discOf(scene)
    expect(disc.closed).toBe(true)
    // Fill and stroke match at the defaults, preserving a single white silhouette
    // on the mid-gray background. Matching both to the background recovers the
    // implied-sphere figure-ground as an opt-in choice.
    expect(disc.stroke).toEqual({ color: '#ffffff', width: 2 })
    expect(disc.fill?.color).toBe(DISC_FILL)
    expect(disc.fill?.color).not.toBe(scene.background?.color)
    expect(disc.fill?.color).not.toBe(PAPER_STROKE)
  })

  it('the occluder is a genuinely round silhouette — every rim point equidistant from center', () => {
    const scene = leafField.generate({ sphereCount: 1 }, 'orient', 0, DEFAULT_COMPOSITION_FRAME)
    const disc = discOf(scene)
    // Drop the closing duplicate vertex, then measure each rim point's radius.
    const ring = disc.points.slice(0, -1)
    const cx = ring.reduce((s, p) => s + p[0]!, 0) / ring.length
    const cy = ring.reduce((s, p) => s + p[1]!, 0) / ring.length
    const radii = ring.map(([x, y]) => Math.hypot(x! - cx, y! - cy))
    const mean = radii.reduce((a, b) => a + b, 0) / radii.length
    expect(mean).toBeGreaterThan(0)
    // A true circle: the far-side occluded arc is genuinely round, not lumpy.
    for (const r of radii) {
      expect(Math.abs(r - mean) / mean).toBeLessThan(1e-3)
    }
  })

  it('occludes far-side (back) leaves while front leaves lap over the near side', () => {
    // Seed picked so the default-radius disc lands mid-canvas, straddling the
    // depth-0.5 splice — placement is now inset by the disc's OWN radius (#146),
    // so a disc can sit near an edge with no back leaves reaching it; this fixture
    // seed keeps both sides of the occlusion observable (assertions unchanged).
    const scene = leafField.generate({ sphereCount: 1 }, 'disc', 0, DEFAULT_COMPOSITION_FRAME)
    const prims = scene.primitives
    const discIdx = prims.findIndex((p) => p.fill?.color === DISC_FILL)
    const disc = prims[discIdx]!
    const [cx, cy] = discCenter(disc)
    const r = discRadius(disc)

    // Back leaves: drawn BEFORE the disc with a centroid inside it ⇒ painted
    // over ⇒ they contribute the hard round far-side edge (occlusion happened).
    const occludedBack = prims.slice(0, discIdx).filter((p) => {
      if (!isLeaf(p)) return false
      const [x, y] = primitiveCentroid(p)
      return Math.hypot(x - cx, y - cy) <= r
    })
    expect(occludedBack.length).toBeGreaterThan(0)

    // Front leaves: drawn AFTER the disc and overlapping it ⇒ they lap over the
    // near side for organic tip breakup.
    const discBBox = primitiveBBox(disc)
    const front = prims
      .slice(discIdx + 1)
      .filter((p) => isLeaf(p) && bboxesOverlap(primitiveBBox(p), discBBox))
    expect(front.length).toBeGreaterThan(0)
  })

  it('OCCLUDES rather than THINS — leaf density under the disc matches the surrounding field', () => {
    const scene = leafField.generate({ sphereCount: 1 }, 'orient', 0, DEFAULT_COMPOSITION_FRAME)
    const disc = discOf(scene)
    const [cx, cy] = discCenter(disc)
    const r = discRadius(disc)
    const leaves = leavesOf(scene)

    const inside = leaves.filter((p) => {
      const [x, y] = primitiveCentroid(p)
      return Math.hypot(x - cx, y - cy) <= r
    }).length

    const areaInside = Math.PI * r * r
    const densityInside = inside / areaInside
    const densityOutside = (leaves.length - inside) / (WIDTH * HEIGHT - areaInside)

    // The mechanism is occlusion, not density-thinning: the leaves under the
    // sphere are all still present (just painted over), so per-area leaf density
    // inside the disc matches the field outside it.
    const ratio = densityInside / densityOutside
    expect(ratio).toBeGreaterThan(0.75)
    expect(ratio).toBeLessThan(1.35)
  })

  it('is deterministic including the occluder — identical Scene for identical (params, seed, t) (ADR-0002)', () => {
    const params: Params = { density: 8, sphereCount: 1 }
    const a = leafField.generate(params, 'disc-det', 0, DEFAULT_COMPOSITION_FRAME)
    const b = leafField.generate(params, 'disc-det', 0, DEFAULT_COMPOSITION_FRAME)
    expect(a).toEqual(b)
    // The disc placement (off the per-leaf rng stream) reproduces exactly too.
    expect(a.primitives.filter((p) => p.fill?.color === DISC_FILL)).toEqual(
      b.primitives.filter((p) => p.fill?.color === DISC_FILL),
    )
  })
})

/**
 * The seeded SET of implied-sphere occluder discs, driven by the three appended
 * knobs (#141): `sphereCount` (how many), `sphereRadiusMin`/`sphereRadiusMax`
 * (per-disc radius bounds, in coordinate units). This block carries the slice's
 * regression guard (audit finding 2): the sphere-set's count/radius bounds, its
 * seeded rearrangement, the per-leaf rng seam, and Scene-level determinism
 * including all discs.
 */
describe('leaf-field sphere-set knobs (#141)', () => {
  /** All occluder discs in a scene (background-filled Primitives). */
  function discsOf(scene: { primitives: Primitive[] }): Primitive[] {
    return scene.primitives.filter((p) => p.fill?.color === DISC_FILL)
  }

  /** A disc's radius, read off the bbox half-width of the circular silhouette. */
  function discRadius(disc: Primitive): number {
    const { minX, maxX } = primitiveBBox(disc)
    return (maxX - minX) / 2
  }

  /** Mean signed tangency around a circle, folded so either circulation wins. */
  function rimTangency(
    seed: string,
    cx: number,
    cy: number,
    radius: number,
    fieldScale: number,
    turbulence: number,
    octaves: number,
  ): number {
    const angleAt = prepareCurlAngle4D(createRandom(seed), { gain: turbulence, octaves })
    const samples = 24
    let tangentProjection = 0
    for (let i = 0; i < samples; i++) {
      const rimAngle = (i / samples) * Math.PI * 2
      const x = cx + Math.cos(rimAngle) * radius
      const y = cy + Math.sin(rimAngle) * radius
      const flowAngle = angleAt(
        (x / WIDTH) * fieldScale,
        (y / HEIGHT) * fieldScale,
        1,
        0,
      )
      tangentProjection += Math.cos(flowAngle - (rimAngle + Math.PI / 2))
    }
    return Math.abs(tangentProjection / samples)
  }

  it('emits exactly `sphereCount` discs, so raising it yields strictly more', () => {
    const seed = 'set-count'
    const few = leafField.generate({ sphereCount: 1 }, seed, 0, DEFAULT_COMPOSITION_FRAME)
    const many = leafField.generate({ sphereCount: 5 }, seed, 0, DEFAULT_COMPOSITION_FRAME)
    expect(discsOf(few)).toHaveLength(1)
    expect(discsOf(many)).toHaveLength(5)
    expect(discsOf(many).length).toBeGreaterThan(discsOf(few).length)
  })

  it('sphereCount 0 opts out to a disc-free field; the default (6) ships the full set', () => {
    // Count 0 opts out: no occluder disc is spliced in, so the field ships as a
    // plain leaf scatter. The default is now 6 (the "Nice One" preset), so a bare
    // generate carries the full implied-sphere set. Either way a field of leaves
    // still bakes, and the disc count never perturbs the leaves (separate stream).
    const explicit = leafField.generate({ sphereCount: 0 }, 'set-none', 0, DEFAULT_COMPOSITION_FRAME)
    const byDefault = leafField.generate({}, 'set-none', 0, DEFAULT_COMPOSITION_FRAME)
    expect(discsOf(explicit)).toHaveLength(0)
    expect(discsOf(byDefault)).toHaveLength(6)
    // A disc-free field is still a field — leaves are unaffected by disc count.
    expect(leavesOf(explicit).length).toBeGreaterThan(1)
    expect(leavesOf(byDefault)).toEqual(leavesOf(explicit))
  })

  it("every disc's radius falls within [sphereRadiusMin, sphereRadiusMax]", () => {
    const sphereRadiusMin = 90
    const sphereRadiusMax = 240
    const scene = leafField.generate(
      { sphereCount: 6, sphereRadiusMin, sphereRadiusMax },
      'set-radius',
      0, DEFAULT_COMPOSITION_FRAME,
    )
    const discs = discsOf(scene)
    expect(discs).toHaveLength(6)
    for (const disc of discs) {
      const r = discRadius(disc)
      // Tiny epsilon absorbs the circle-tessellation / float noise on the bbox.
      expect(r).toBeGreaterThanOrEqual(sphereRadiusMin - 1e-6)
      expect(r).toBeLessThanOrEqual(sphereRadiusMax + 1e-6)
    }
  })

  it('guards sphereRadiusMin > sphereRadiusMax by swapping — the radius draw stays valid', () => {
    // Inverted bounds must not throw or produce out-of-range discs; the Sketch
    // owns its inter-param coherence (swap so [min,max] is well-formed).
    const lo = 100
    const hi = 200
    const scene = leafField.generate(
      { sphereCount: 5, sphereRadiusMin: hi, sphereRadiusMax: lo },
      'set-swap',
      0, DEFAULT_COMPOSITION_FRAME,
    )
    for (const disc of discsOf(scene)) {
      const r = discRadius(disc)
      expect(r).toBeGreaterThanOrEqual(lo - 1e-6)
      expect(r).toBeLessThanOrEqual(hi + 1e-6)
    }
  })

  it('a re-seed rearranges the sphere set while the params hold', () => {
    const params: Params = { sphereCount: 4 }
    const a = leafField.generate(params, 'spheres-a', 0, DEFAULT_COMPOSITION_FRAME)
    const b = leafField.generate(params, 'spheres-b', 0, DEFAULT_COMPOSITION_FRAME)
    // Same count, but the seeded centers/radii/depths differ ⇒ the disc set moves.
    expect(discsOf(a)).toHaveLength(4)
    expect(discsOf(b)).toHaveLength(4)
    expect(discsOf(b)).not.toEqual(discsOf(a))
  })

  it('places sphere rims more tangent to the curl field than the former seeded-random centers', () => {
    const fieldScale = 2
    const turbulence = 0.2
    const octaves = 2
    const radius = 80
    const seeds = [
      'vortex-quality-a',
      'vortex-quality-b',
      'vortex-quality-c',
      'vortex-quality-d',
    ]
    let selectedTotal = 0
    let randomTotal = 0

    for (const seed of seeds) {
      const scene = leafField.generate(
        {
          fieldScale,
          turbulence,
          octaves,
          sphereCount: 1,
          sphereRadiusMin: radius,
          sphereRadiusMax: radius,
        },
        seed,
        0, DEFAULT_COMPOSITION_FRAME,
      )
      const [selectedX, selectedY] = primitiveCentroid(discsOf(scene)[0]!)
      selectedTotal += rimTangency(
        seed,
        selectedX,
        selectedY,
        radius,
        fieldScale,
        turbulence,
        octaves,
      )

      // Reconstruct the former placement policy: the same first two dedicated
      // sphere-stream draws mapped uniformly into the radius-inset canvas.
      const sphereRng = createRandom(`${seed}-sphere`)
      const randomX = radius + sphereRng.value() * (WIDTH - radius * 2)
      const randomY = radius + sphereRng.value() * (HEIGHT - radius * 2)
      randomTotal += rimTangency(
        seed,
        randomX,
        randomY,
        radius,
        fieldScale,
        turbulence,
        octaves,
      )
    }

    const selectedMean = selectedTotal / seeds.length
    const randomMean = randomTotal / seeds.length
    expect(selectedMean).toBeGreaterThan(randomMean)
    expect(selectedMean - randomMean).toBeGreaterThan(0.1)
  })

  it('changing a sphere knob leaves the leaf primitives untouched (per-leaf rng seam intact)', () => {
    // The sphere set draws from a SEPARATE rng stream, so raising sphereCount
    // must consume more sphere draws WITHOUT shifting a single per-leaf roll.
    const seed = 'seam'
    const base: Params = { density: 6, variation: 0.6 }
    const one = leafField.generate({ ...base, sphereCount: 1 }, seed, 0, DEFAULT_COMPOSITION_FRAME)
    const many = leafField.generate({ ...base, sphereCount: 5 }, seed, 0, DEFAULT_COMPOSITION_FRAME)
    // The leaf primitives (filtered from the disc splices) are byte-identical.
    expect(leavesOf(many)).toEqual(leavesOf(one))
  })

  it('is deterministic including every disc for identical (params, seed, t) (ADR-0002)', () => {
    const params: Params = { density: 6, sphereCount: 4, sphereRadiusMin: 120, sphereRadiusMax: 260 }
    const a = leafField.generate(params, 'set-det', 0, DEFAULT_COMPOSITION_FRAME)
    const b = leafField.generate(params, 'set-det', 0, DEFAULT_COMPOSITION_FRAME)
    expect(a).toEqual(b)
    expect(discsOf(a)).toEqual(discsOf(b))
  })

  it('keeps every disc fully on-canvas even at the max radius (silhouette bounded by drawn radius)', () => {
    // Center placement is inset by each disc's OWN drawn radius, so even at the
    // largest possible radius (400) a full sphere-set lands entirely within the
    // canvas. The tiny epsilon absorbs circle-tessellation float noise.
    const eps = 1e-6
    const scene = leafField.generate(
      { sphereCount: 6, sphereRadiusMin: 400, sphereRadiusMax: 400 },
      'on-canvas',
      0, DEFAULT_COMPOSITION_FRAME,
    )
    const discs = discsOf(scene)
    expect(discs).toHaveLength(6)
    const centers = new Set<string>()
    for (const disc of discs) {
      const { minX, minY, maxX, maxY } = primitiveBBox(disc)
      expect(minX).toBeGreaterThanOrEqual(-eps)
      expect(minY).toBeGreaterThanOrEqual(-eps)
      expect(maxX).toBeLessThanOrEqual(WIDTH + eps)
      expect(maxY).toBeLessThanOrEqual(HEIGHT + eps)
      centers.add(primitiveCentroid(disc).join(','))
    }
    expect(centers.size).toBe(discs.length)
  })

  it('re-seeding still moves discs at a smaller radius (placement stays seeded)', () => {
    const params: Params = { sphereCount: 4, sphereRadiusMin: 80, sphereRadiusMax: 80 }
    const a = leafField.generate(params, 'move-a', 0, DEFAULT_COMPOSITION_FRAME)
    const b = leafField.generate(params, 'move-b', 0, DEFAULT_COMPOSITION_FRAME)
    expect(discsOf(a)).toHaveLength(4)
    expect(discsOf(b)).toHaveLength(4)
    expect(discsOf(b)).not.toEqual(discsOf(a))
  })
})

/**
 * The global `sphereDepth` knob (#142): where every disc inserts into the
 * (ascending-y) painter's-order stack — the front/behind split. Higher depth ⇒
 * MORE leaves drawn before the disc (occluded / behind ⇒ cleaner round edge);
 * lower depth ⇒ fewer leaves before it (more front overlap / more embedded). One
 * global depth for the whole set this slice.
 */
describe('leaf-field sphereDepth — front/behind split (#142)', () => {
  /** Count of leaf Primitives drawn BEFORE the single disc (its splice position). */
  function leavesBeforeDisc(scene: { primitives: Primitive[] }): number {
    const discIdx = scene.primitives.findIndex((p) => p.fill?.color === DISC_FILL)
    expect(discIdx).toBeGreaterThanOrEqual(0)
    return scene.primitives.slice(0, discIdx).filter(isLeaf).length
  }

  it('raising sphereDepth draws strictly more leaves before the disc (splits front/behind)', () => {
    // One disc so the split reads off a single splice position; same seed/density
    // ⇒ identical leaf set, only the disc's insert index moves with the knob.
    const base: Params = { sphereCount: 1, density: 8 }
    const seed = 'depth-split'
    const shallow = leafField.generate({ ...base, sphereDepth: 0.1 }, seed, 0, DEFAULT_COMPOSITION_FRAME)
    const deep = leafField.generate({ ...base, sphereDepth: 0.9 }, seed, 0, DEFAULT_COMPOSITION_FRAME)
    // Higher depth ⇒ more leaves painted before (behind) the disc ⇒ cleaner edge.
    expect(leavesBeforeDisc(deep)).toBeGreaterThan(leavesBeforeDisc(shallow))
  })

  it('is a pure splice reorder — the leaf primitives are untouched by sphereDepth', () => {
    // sphereDepth touches only the insert index, never an rng draw, so the leaf
    // set stays byte-identical while only the disc's stack position shifts.
    const base: Params = { sphereCount: 1, density: 8 }
    const seed = 'depth-seam'
    const shallow = leafField.generate({ ...base, sphereDepth: 0.1 }, seed, 0, DEFAULT_COMPOSITION_FRAME)
    const deep = leafField.generate({ ...base, sphereDepth: 0.9 }, seed, 0, DEFAULT_COMPOSITION_FRAME)
    expect(leavesOf(deep)).toEqual(leavesOf(shallow))
  })

  it('is deterministic for identical (params, seed, t) (ADR-0002)', () => {
    const params: Params = { sphereCount: 3, sphereDepth: 0.7, density: 6 }
    const a = leafField.generate(params, 'depth-det', 0, DEFAULT_COMPOSITION_FRAME)
    const b = leafField.generate(params, 'depth-det', 0, DEFAULT_COMPOSITION_FRAME)
    expect(a).toEqual(b)
  })
})

/**
 * The two appended color knobs (ADR-0010): `backgroundColor` feeds the Scene's
 * declared background (ADR-0009) and `discColor` the occluder discs' fill. The
 * defaults DIFFER deliberately — white discs (`#ffffff`) on a mid-gray ground
 * (`#878787`) — so the discs read as visible orbs out of the box (the look the
 * "Nice One" preset also pins); the original white-on-white implied-sphere
 * image is an opt-in param choice (set both knobs white). Neither knob consumes
 * an rng draw, so geometry is byte-identical across any color value.
 */
describe('leaf-field color knobs — backgroundColor & discColor (ADR-0010)', () => {
  /** All occluder discs of a scene, keyed by the given disc fill color. */
  function discsFilled(scene: { primitives: Primitive[] }, color: string): Primitive[] {
    return scene.primitives.filter((p) => p.fill?.color === color)
  }

  it('carries the backgroundColor param as the Scene-declared background', () => {
    const scene = leafField.generate({ backgroundColor: '#112233' }, 'color', 0, DEFAULT_COMPOSITION_FRAME)
    expect(scene.background).toEqual({ color: '#112233' })
  })

  it('defaults the background to mid gray (#878787)', () => {
    const scene = leafField.generate({}, 'color', 0, DEFAULT_COMPOSITION_FRAME)
    expect(scene.background).toEqual({ color: '#878787' })
  })

  it('fills every occluder disc with the discColor param', () => {
    const scene = leafField.generate(
      { sphereCount: 4, discColor: '#aa3366' },
      'color',
      0, DEFAULT_COMPOSITION_FRAME,
    )
    const discs = discsFilled(scene, '#aa3366')
    expect(discs).toHaveLength(4)
    for (const disc of discs) {
      expect(disc.stroke).toEqual({ color: '#ffffff', width: 2 })
      expect(disc.closed).toBe(true)
    }
  })

  it('defaults discColor to white — visible orbs on the gray ground, NOT figure-ground', () => {
    const scene = leafField.generate({ sphereCount: 3 }, 'color', 0, DEFAULT_COMPOSITION_FRAME)
    const discs = discsFilled(scene, '#ffffff')
    expect(discs).toHaveLength(3)
    // The defaults deliberately differ: disc fill + stroke == background (the
    // implied-sphere special case) is opt-in via params.
    expect(scene.background?.color).toBe('#878787')
  })

  it('consumes NO rng draws — geometry is byte-identical across color values', () => {
    // Changing both colors must touch ONLY fill colors and the background:
    // every leaf primitive stays byte-identical (fill/stroke included — leaf
    // colors are not param-driven), and every disc keeps its exact outline.
    const seed = 'color-seam'
    const base: Params = { density: 6, variation: 0.6, sphereCount: 3 }
    const plain = leafField.generate(base, seed, 0, DEFAULT_COMPOSITION_FRAME)
    const tinted = leafField.generate(
      { ...base, backgroundColor: '#0a141e', discColor: '#c2b280' },
      seed,
      0, DEFAULT_COMPOSITION_FRAME,
    )
    expect(leavesOf(tinted)).toEqual(leavesOf(plain))
    const outlines = (scene: typeof plain, color: string): unknown[] =>
      discsFilled(scene, color).map((p) => p.points)
    expect(outlines(tinted, '#c2b280')).toEqual(outlines(plain, '#ffffff'))
  })

  it('is deterministic including the colors for identical (params, seed, t) (ADR-0002)', () => {
    const params: Params = {
      density: 6,
      sphereCount: 2,
      backgroundColor: '#123123',
      discColor: '#456456',
    }
    const a = leafField.generate(params, 'color-det', 0, DEFAULT_COMPOSITION_FRAME)
    const b = leafField.generate(params, 'color-det', 0, DEFAULT_COMPOSITION_FRAME)
    expect(a).toEqual(b)
  })
})

describe('leaf-field disc stroke color knob', () => {
  it('applies discStrokeColor to every disc without changing its fill', () => {
    const scene = leafField.generate(
      {
        sphereCount: 3,
        discColor: '#ccddee',
        discStrokeColor: '#663399',
      },
      'disc-stroke-color',
      0, DEFAULT_COMPOSITION_FRAME,
    )
    const discs = scene.primitives.filter(
      (primitive) => primitive.fill?.color === '#ccddee',
    )

    expect(discs).toHaveLength(3)
    for (const disc of discs) {
      expect(disc.stroke).toEqual({ color: '#663399', width: 2 })
    }
  })
})

describe('leaf-field leaf color knobs', () => {
  it('applies leafColor and leafStrokeColor to every leaf', () => {
    const scene = leafField.generate(
      {
        sphereCount: 0,
        leafColor: '#2f7d32',
        leafStrokeColor: '#f6c453',
      },
      'leaf-colors',
      0, DEFAULT_COMPOSITION_FRAME,
    )

    expect(scene.primitives.length).toBeGreaterThan(1)
    for (const primitive of scene.primitives) {
      expect(primitive.fill?.color).toBe('#2f7d32')
      expect(primitive.stroke?.color).toBe('#f6c453')
      expect(primitive.stroke?.width).toBe(2)
    }
  })

  it('changes only leaf styling, not geometry or draw order', () => {
    const params: Params = { density: 6, sphereCount: 0 }
    const plain = leafField.generate(params, 'leaf-color-seam', 0, DEFAULT_COMPOSITION_FRAME)
    const tinted = leafField.generate(
      { ...params, leafColor: '#335577', leafStrokeColor: '#ddeeff' },
      'leaf-color-seam',
      0, DEFAULT_COMPOSITION_FRAME,
    )

    expect(
      tinted.primitives.map(({ points, closed }) => ({ points, closed })),
    ).toEqual(plain.primitives.map(({ points, closed }) => ({ points, closed })))
  })
})
