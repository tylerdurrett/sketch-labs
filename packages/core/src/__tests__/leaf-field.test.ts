import { describe, expect, it } from 'vitest'

import * as barrel from '../index'
import { curl } from '../curl'
import { samplePoissonDisk } from '../poisson'
import { createRandom } from '../random'
import { circles } from '../sketches/circles'
import { leafField } from '../sketches/leaf-field'
import {
  createNegativeSpaceField,
  NEGATIVE_SPACES,
} from '../sketches/leaf-field/negative-space'
import { bbox as pointsBBox, HEIGHT, WIDTH } from '../sketches/sketch-util'
import type { Params } from '../sketch'
import type { Point } from '../types'
import type { Primitive } from '../scene'

/** The nine leaf-field knobs, in declaration order. */
const KNOBS = [
  'fieldScale',
  'turbulence',
  'octaves',
  'density',
  'leafSizeMin',
  'leafSizeMax',
  'leafWidth',
  'pointiness',
  'variation',
] as const

/** The bold dark fill and paper-colored rim the audit pinned (see the sketch header). */
const LEAF_FILL = '#1a1a1a'
const PAPER_STROKE = '#f4f1ea'

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
const DEFAULT_TURBULENCE = 0.5

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
 * does: same curl overload, CANVAS-NORMALIZED coords, same fieldScale/octaves/
 * turbulence, same rng-from-seed, t=0.
 */
function fieldAxisAt(primitive: Primitive, seed: string): number {
  const rng = createRandom(seed)
  const [cx, cy] = primitiveCentroid(primitive)
  const flow = curl(
    rng,
    (cx / WIDTH) * ORIENT_FIELD_SCALE,
    (cy / HEIGHT) * ORIENT_FIELD_SCALE,
    0,
    { gain: DEFAULT_TURBULENCE, octaves: ORIENT_OCTAVES },
  )
  return Math.atan2(flow[1], flow[0])
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
 * much a leaf covers, so it isolates the `leafWidth` (slenderness) knob from the
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
  it('declares exactly the nine knobs in order and NO time metadata (static)', () => {
    expect(Object.keys(leafField.schema)).toEqual([...KNOBS])
    // Static Sketch: absence of `time` is what makes the Harness hide the scrubber.
    expect(leafField.time).toBeUndefined()
  })

  it('bakes a FIELD of closed leaves, each dark-filled with a distinct paper rim', () => {
    const scene = leafField.generate({}, 'seed-a', 0)
    // A field, not one leaf.
    expect(scene.primitives.length).toBeGreaterThan(1)
    for (const primitive of scene.primitives) {
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
    const sparse = leafField.generate({ density: 2 }, seed, 0)
    const dense = leafField.generate({ density: 10 }, seed, 0)
    expect(dense.primitives.length).toBeGreaterThan(sparse.primitives.length)
  })
})

describe("leaf-field painter's order / overlap", () => {
  it('bakes many overlapping leaves in draw order (index 0 = bottom)', () => {
    // A dense field of large leaves: total leaf area far exceeds the canvas, so
    // leaves must overlap. Assert externally-observable overlap of two bboxes.
    const scene = leafField.generate(
      { density: 12, leafSizeMin: 300, leafSizeMax: 400 },
      'overlap-seed',
      0,
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
    const params: Params = { density: 6, leafSizeMin: 120, leafSizeMax: 200 }
    const a = leafField.generate(params, 'fixed-seed', 0)
    const b = leafField.generate(params, 'fixed-seed', 0)
    expect(a).toEqual(b)
  })

  it('carries no cross-call state — an interleaved generate does not perturb the result', () => {
    const params: Params = { density: 7 }
    const first = leafField.generate(params, 's', 0)
    // Interleave unrelated generate calls to surface any accumulated state.
    leafField.generate({ density: 3 }, 'other', 3)
    circles.generate({ count: 5 }, 'yet-another', 1)
    const again = leafField.generate(params, 's', 0)
    expect(again).toEqual(first)
  })

  it('threads t LIVE into the flow field (ADR-0002 plumbing), staying static via no time metadata', () => {
    // #127 makes t the curl field's z slice, so a different t reorients the
    // field. The Sketch still ships static: it declares NO `time` metadata, so
    // the Harness pins t=0 and this live plumbing is a metadata swap away from
    // animating rather than a rewrite. (Determinism at a fixed t is covered
    // above; here we assert the z-slice is genuinely wired through.)
    const params: Params = { density: 5 }
    const atZero = leafField.generate(params, 's', 0)
    const atLater = leafField.generate(params, 's', 42)
    expect(atLater).not.toEqual(atZero)
    expect(leafField.time).toBeUndefined()
  })
})

describe('leaf-field seed independence', () => {
  it('a different seed rearranges the field while params hold', () => {
    const params: Params = { density: 6 }
    const sceneA = leafField.generate(params, 'seed-a', 0)
    const sceneB = leafField.generate(params, 'seed-b', 0)
    // The Poisson scatter is seeded, so a re-seed reshuffles placement.
    expect(sceneB).not.toEqual(sceneA)
  })

  it('a re-seed shifts BOTH orientation and variation, not just placement', () => {
    // With variation live, a re-seed must reshuffle scatter, reroll every leaf's
    // shape, AND re-anchor the flow field (curl reads the same seed). Assert the
    // per-leaf spine-length multisets differ — that only holds if the seeded
    // shape rolls (and their flow-driven orientation) genuinely changed.
    const params: Params = { density: 6, variation: 0.6 }
    const a = leafField.generate(params, 'orient-a', 0)
    const b = leafField.generate(params, 'orient-b', 0)
    // Rotation-invariant spine lengths: differences here come from the seeded
    // SHAPE rolls (size variation), not merely from different rotations.
    const lengths = (scene: typeof a): number[] =>
      scene.primitives.map((p) => Math.round(spineLength(p))).sort((x, y) => x - y)
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
      },
      seed,
      0,
    )
    const leaves = scene.primitives
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

describe('leaf-field per-leaf variation (#127)', () => {
  it('at nonzero variation, no two leaves are geometrically identical', () => {
    const scene = leafField.generate({ density: 6, variation: 0.6 }, 'vary', 0)
    const hashes = scene.primitives.map((p) => JSON.stringify(p.points))
    expect(new Set(hashes).size).toBe(hashes.length)
  })

  it('a higher variation yields strictly more size spread than a lower one at the same seed', () => {
    const seed = 'spread'
    const low = leafField.generate({ density: 6, variation: 0.2 }, seed, 0)
    const high = leafField.generate({ density: 6, variation: 0.8 }, seed, 0)
    expect(spineLengthSpread(high.primitives)).toBeGreaterThan(
      spineLengthSpread(low.primitives),
    )
  })

  it('at variation 0 every leaf shares the same base size (spread ~0), confirming the knob is live', () => {
    const scene = leafField.generate({ density: 6, variation: 0 }, 'flat', 0)
    // Leaves are all the fixed base shape (only rotated), so spine lengths — a
    // rotation-invariant diagonal measure — match to within float noise.
    expect(spineLengthSpread(scene.primitives)).toBeLessThan(1e-6)
  })
})

describe('leaf-field shape knobs — width & pointiness (#127)', () => {
  it('a wider leafWidth yields larger leaves (rotation-invariant area) at the same seed', () => {
    const seed = 'width'
    // variation 0 so every leaf is the same base shape (only rotated) — the area
    // difference then comes from `leafWidth` alone, not per-leaf size rolls.
    const slender = leafField.generate({ density: 5, variation: 0, leafWidth: 0.2 }, seed, 0)
    const fat = leafField.generate({ density: 5, variation: 0, leafWidth: 0.9 }, seed, 0)
    // Same seed/density ⇒ same placement/count; only the per-leaf width differs.
    expect(fat.primitives.length).toBe(slender.primitives.length)
    expect(meanLeafArea(fat.primitives)).toBeGreaterThan(meanLeafArea(slender.primitives))
  })

  it('pointiness is live — changing the tip sharpness rebakes the field', () => {
    const params: Params = { density: 5, variation: 0 }
    const round = leafField.generate({ ...params, pointiness: 0.05 }, 'point', 0)
    const sharp = leafField.generate({ ...params, pointiness: 0.95 }, 'point', 0)
    expect(sharp).not.toEqual(round)
  })
})

describe('leaf-field negative-space clearings — seeded organic rim (#131 + #132)', () => {
  /** Mirror of the sketch's REFERENCE_SPACING (radius = REFERENCE_SPACING / density). */
  const REFERENCE_SPACING = 400
  /** A density dense enough that the field carries a robust statistical sample. */
  const CLEARING_DENSITY = 8
  const BASE_SPACING = REFERENCE_SPACING / CLEARING_DENSITY

  /**
   * A factor safely beyond the module's rim perturbation amplitude (the effective
   * radius stays within `radius · (1 ± amplitude)`, amplitude 0.2). A ray of this
   * length from a clearing center is guaranteed OUTSIDE that clearing's bulged
   * rim, and short enough not to reach the other, non-overlapping clearing.
   */
  const RIM_OUTER_FACTOR = 1.3

  /**
   * Reconstruct the SEED-DEPENDENT mask the sketch builds inside `generate`: the
   * organic rim rides `createRandom(seed).noise2D`, so the field is a pure
   * function of the seed. Every clearing assertion rebuilds it per seed rather
   * than reading a single global mask.
   */
  function maskFor(seed: string) {
    return createNegativeSpaceField(createRandom(seed).noise2D)
  }

  /**
   * Find a seed whose UNGUARDED initial Poisson seed (the sampler's first two rng
   * draws, reconstructed from `createRandom(seed)`) would land inside THAT seed's
   * own clearing rim. Such a seed is the one that, without the domain gate, would
   * strand a lone leaf in a hole — exactly the case the reseed loop must handle.
   */
  function seedWithInitialPointInClearing(): string {
    for (let i = 0; i < 4000; i++) {
      const seed = `clearing-seed-${i}`
      const rng = createRandom(seed)
      const x = rng.range(0, WIDTH)
      const y = rng.range(0, HEIGHT)
      if (maskFor(seed).insideAnyClearing(x, y)) return seed
    }
    throw new Error('no seed found whose initial point lands in a clearing')
  }

  /** All leaf centroids (== the sampled points the leaves are centered on). */
  function centroids(scene: ReturnType<typeof leafField.generate>): Point[] {
    return scene.primitives.map(primitiveCentroid)
  }

  /**
   * The clearing's boundary radius along the ray at `theta`, recovered THROUGH
   * the public mask by bisecting for the inside→outside transition. `hi` is
   * capped just past the max bulge so the ray never reaches the sibling clearing.
   */
  function boundaryRadiusAt(
    mask: ReturnType<typeof maskFor>,
    space: (typeof NEGATIVE_SPACES)[number],
    theta: number,
  ): number {
    let lo = 0 // the center is always inside
    let hi = space.radius * RIM_OUTER_FACTOR // guaranteed outside
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2
      const x = space.cx + Math.cos(theta) * mid
      const y = space.cy + Math.sin(theta) * mid
      if (mask.insideAnyClearing(x, y)) lo = mid
      else hi = mid
    }
    return (lo + hi) / 2
  }

  /** Boundary radii sampled uniformly around a clearing's rim. */
  function rimProfile(
    mask: ReturnType<typeof maskFor>,
    space: (typeof NEGATIVE_SPACES)[number],
    samples = 64,
  ): number[] {
    return Array.from({ length: samples }, (_, i) =>
      boundaryRadiusAt(mask, space, (i / samples) * 2 * Math.PI),
    )
  }

  it('the rim is measurably NON-CIRCULAR — boundary radius varies with angle (#132)', () => {
    const seed = 'organic-rim'
    const mask = maskFor(seed)
    for (const space of NEGATIVE_SPACES) {
      const radii = rimProfile(mask, space)
      const spread = Math.max(...radii) - Math.min(...radii)
      // A hard circle would give spread ~0; the seeded rim must vary well beyond
      // float noise (amplitude 0.2 permits up to 0.4·radius swing).
      expect(spread).toBeGreaterThan(space.radius * 0.05)
    }
  })

  it('the rim is SEEDED — same seed reproduces the rim, a different seed reshapes it (#132)', () => {
    const space = NEGATIVE_SPACES[0]!
    const same = rimProfile(maskFor('rim-seed'), space)
    const sameAgain = rimProfile(maskFor('rim-seed'), space)
    const other = rimProfile(maskFor('rim-other'), space)
    // Identical seed ⇒ identical rim (deterministic, seeded — never Math.random).
    expect(sameAgain).toEqual(same)
    // Different seed ⇒ a different rim shape.
    expect(other).not.toEqual(same)
  })

  it('leaves exactly ZERO leaves inside the clearings, across multiple seeds (perturbed rim)', () => {
    const seeds = ['seed-a', 'seed-b', 'clearing', seedWithInitialPointInClearing()]
    for (const seed of seeds) {
      const scene = leafField.generate({ density: CLEARING_DENSITY }, seed, 0)
      const mask = maskFor(seed)
      // The field must still fill (it reseeded past the hole rather than bailing).
      expect(scene.primitives.length).toBeGreaterThan(50)
      const inside = centroids(scene).filter(([x, y]) => mask.insideAnyClearing(x, y))
      expect(inside).toHaveLength(0)
    }
  })

  it('multiple perturbed clearings compose — neither strands a leaf inside (#132 AC2)', () => {
    // Two adjacent, independently-perturbed clearings must BOTH read as holes: no
    // leaf inside either, checked against each clearing's own perturbed boundary.
    for (const seed of ['compose-a', 'compose-b', seedWithInitialPointInClearing()]) {
      const scene = leafField.generate({ density: CLEARING_DENSITY }, seed, 0)
      const mask = maskFor(seed)
      const cents = centroids(scene)
      for (const space of NEGATIVE_SPACES) {
        const insideThis = cents.filter(([x, y]) => {
          const dx = x - space.cx
          const dy = y - space.cy
          const theta = Math.atan2(dy, dx)
          const r = boundaryRadiusAt(mask, space, theta)
          return Math.hypot(dx, dy) <= r
        })
        expect(insideThis).toHaveLength(0)
      }
    }
  })

  it('the seeded reseed keeps the strand-in-a-hole seed from placing a leaf inside', () => {
    // Focused assertion on the audited leak: the very seed whose unguarded first
    // point lands in a clearing produces a full field with no leaf in the hole.
    const seed = seedWithInitialPointInClearing()
    const scene = leafField.generate({ density: CLEARING_DENSITY }, seed, 0)
    const mask = maskFor(seed)
    for (const [x, y] of centroids(scene)) expect(mask.insideAnyClearing(x, y)).toBe(false)
  })

  it('density holds STATISTICALLY outside the clearings (no thinning of the field proper)', () => {
    const seed = 'clearing-density'
    const scene = leafField.generate({ density: CLEARING_DENSITY, variation: 0 }, seed, 0)
    const mask = maskFor(seed)
    // Every leaf is outside a clearing (asserted above), so the masked count is
    // the count of sampled points OUTSIDE the holes.
    const maskedOutside = scene.primitives.length
    // Baseline: an unmasked uniform field at the SAME spacing/seed, counting only
    // the points that fall outside the clearings. Outside the holes both fields
    // see the identical local radius, so the areal density there must match —
    // NOT the exact coordinates (the mask reshuffles the whole blue-noise set).
    const unmasked = samplePoissonDisk({
      width: WIDTH,
      height: HEIGHT,
      radius: () => BASE_SPACING,
      minRadius: BASE_SPACING,
      seed,
    })
    const unmaskedOutside = unmasked.filter(([x, y]) => !mask.insideAnyClearing(x, y)).length
    expect(maskedOutside).toBeGreaterThan(50)
    const ratio = maskedOutside / unmaskedOutside
    expect(ratio).toBeGreaterThan(0.85)
    expect(ratio).toBeLessThan(1.15)
  })

  it('preserves blue-noise spacing outside — no two leaves closer than the base spacing', () => {
    const scene = leafField.generate({ density: CLEARING_DENSITY, variation: 0 }, 'spacing', 0)
    const pts = centroids(scene)
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i]![0] - pts[j]![0], pts[i]![1] - pts[j]![1])
        expect(d).toBeGreaterThanOrEqual(BASE_SPACING - 1e-9)
      }
    }
  })

  it('never trips the sampler minRadius lower-bound assertion (constant radius field)', () => {
    // The radius field is the constant `baseSpacing`, and minRadius is pinned to
    // that same base — so the accel-grid guard (which throws if minRadius was
    // over-estimated) can never fire for any seed.
    for (const seed of ['a', 'b', 'c', seedWithInitialPointInClearing()]) {
      expect(() => leafField.generate({ density: CLEARING_DENSITY }, seed, 0)).not.toThrow()
    }
  })

  it('is deterministic with the mask engaged (same params, seed, t)', () => {
    const params: Params = { density: CLEARING_DENSITY, variation: 0.4 }
    const a = leafField.generate(params, 'masked-det', 0)
    const b = leafField.generate(params, 'masked-det', 0)
    expect(a).toEqual(b)
  })

  it('actually carves holes — the field spans the canvas but the clearings stay empty', () => {
    // Sanity that the clearings are real negative space, not a degenerate no-op:
    // there ARE leaves elsewhere near each clearing, yet none inside its rim.
    const seed = 'carve'
    const scene = leafField.generate({ density: CLEARING_DENSITY }, seed, 0)
    const mask = maskFor(seed)
    const cents = centroids(scene)
    for (const space of NEGATIVE_SPACES) {
      // A band SAFELY beyond the max bulge, so these are guaranteed real neighbours
      // of a hole that sits inside the populated field.
      const outer = space.radius * RIM_OUTER_FACTOR
      const nearby = cents.filter(([x, y]) => {
        const d = Math.hypot(x - space.cx, y - space.cy)
        return d > outer && d < outer + 2 * BASE_SPACING
      })
      expect(nearby.length).toBeGreaterThan(0)
      // …while the interior (under the perturbed rim) is empty.
      const inside = cents.filter(([x, y]) => mask.insideAnyClearing(x, y))
      expect(inside).toHaveLength(0)
    }
  })
})

describe('leaf-field draw boundary', () => {
  it('emits only generic Primitive records — no leaf-typed field crosses the boundary', () => {
    const scene = leafField.generate({}, 'seed', 0)
    // The Scene container carries only `space` and `primitives`.
    expect(Object.keys(scene).sort()).toEqual(['primitives', 'space'])
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
