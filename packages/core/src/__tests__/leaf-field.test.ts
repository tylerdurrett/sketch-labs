import { describe, expect, it } from 'vitest'

import * as barrel from '../index'
import { curl } from '../curl'
import { createRandom } from '../random'
import { circles } from '../sketches/circles'
import { leafField } from '../sketches/leaf-field'
import { bbox as pointsBBox, HEIGHT, WIDTH } from '../sketches/sketch-util'
import type { Params } from '../sketch'
import type { Point } from '../types'
import type { Primitive } from '../scene'

/**
 * The thirteen leaf-field knobs, in declaration order. The sphere knobs are
 * APPENDED last (`sphereCount`/`sphereRadiusMin`/`sphereRadiusMax` #141, then
 * `sphereDepth` #142) — the first nine keep their positions (order is part of
 * the contract).
 */
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
  'sphereCount',
  'sphereRadiusMin',
  'sphereRadiusMax',
  'sphereDepth',
] as const

/** The bold dark fill and paper-colored rim the audit pinned (see the sketch header). */
const LEAF_FILL = '#1a1a1a'
const PAPER_STROKE = '#f4f1ea'

/** The occluder disc's fill — the render BACKGROUND color (see the sketch header). */
const DISC_FILL = 'white'

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
  it('declares exactly the thirteen knobs in order and NO time metadata (static)', () => {
    expect(Object.keys(leafField.schema)).toEqual([...KNOBS])
    // Static Sketch: absence of `time` is what makes the Harness hide the scrubber.
    expect(leafField.time).toBeUndefined()
  })

  it('bakes a FIELD of closed leaves, each dark-filled with a distinct paper rim', () => {
    const scene = leafField.generate({}, 'seed-a', 0)
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
    const sparse = leafField.generate({ density: 2 }, seed, 0)
    const dense = leafField.generate({ density: 10 }, seed, 0)
    expect(leavesOf(dense).length).toBeGreaterThan(leavesOf(sparse).length)
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
      },
      seed,
      0,
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

describe('leaf-field per-leaf variation (#127)', () => {
  it('at nonzero variation, no two leaves are geometrically identical', () => {
    const scene = leafField.generate({ density: 6, variation: 0.6 }, 'vary', 0)
    const hashes = leavesOf(scene).map((p) => JSON.stringify(p.points))
    expect(new Set(hashes).size).toBe(hashes.length)
  })

  it('a higher variation yields strictly more size spread than a lower one at the same seed', () => {
    const seed = 'spread'
    const low = leafField.generate({ density: 6, variation: 0.2 }, seed, 0)
    const high = leafField.generate({ density: 6, variation: 0.8 }, seed, 0)
    expect(spineLengthSpread(leavesOf(high))).toBeGreaterThan(
      spineLengthSpread(leavesOf(low)),
    )
  })

  it('at variation 0 every leaf shares the same base size (spread ~0), confirming the knob is live', () => {
    const scene = leafField.generate({ density: 6, variation: 0 }, 'flat', 0)
    // Leaves are all the fixed base shape (only rotated), so spine lengths — a
    // rotation-invariant diagonal measure — match to within float noise. (The
    // occluder disc is filtered out; its diameter is unrelated to leaf size.)
    expect(spineLengthSpread(leavesOf(scene))).toBeLessThan(1e-6)
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
    expect(leavesOf(fat).length).toBe(leavesOf(slender).length)
    expect(meanLeafArea(leavesOf(fat))).toBeGreaterThan(meanLeafArea(leavesOf(slender)))
  })

  it('pointiness is live — changing the tip sharpness rebakes the field', () => {
    const params: Params = { density: 5, variation: 0 }
    const round = leafField.generate({ ...params, pointiness: 0.05 }, 'point', 0)
    const sharp = leafField.generate({ ...params, pointiness: 0.95 }, 'point', 0)
    expect(sharp).not.toEqual(round)
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

  it('bakes exactly one opaque background-colored disc — fill only, closed, no stroke (figure-ground)', () => {
    const scene = leafField.generate({}, 'orient', 0)
    const disc = discOf(scene)
    expect(disc.closed).toBe(true)
    // Invisible AS AN OBJECT: filled with the render background, never stroked,
    // and NOT the paper rim color (which would read as a faint tinted circle).
    expect(disc.stroke).toBeUndefined()
    expect(disc.fill?.color).toBe('white')
    expect(disc.fill?.color).not.toBe(PAPER_STROKE)
  })

  it('the occluder is a genuinely round silhouette — every rim point equidistant from center', () => {
    const scene = leafField.generate({}, 'orient', 0)
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
    const scene = leafField.generate({}, 'orient', 0)
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
    const scene = leafField.generate({}, 'orient', 0)
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
    const params: Params = { density: 8 }
    const a = leafField.generate(params, 'disc-det', 0)
    const b = leafField.generate(params, 'disc-det', 0)
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

  it('emits exactly `sphereCount` discs, so raising it yields strictly more', () => {
    const seed = 'set-count'
    const few = leafField.generate({ sphereCount: 1 }, seed, 0)
    const many = leafField.generate({ sphereCount: 5 }, seed, 0)
    expect(discsOf(few)).toHaveLength(1)
    expect(discsOf(many)).toHaveLength(5)
    expect(discsOf(many).length).toBeGreaterThan(discsOf(few).length)
  })

  it("every disc's radius falls within [sphereRadiusMin, sphereRadiusMax]", () => {
    const sphereRadiusMin = 90
    const sphereRadiusMax = 240
    const scene = leafField.generate(
      { sphereCount: 6, sphereRadiusMin, sphereRadiusMax },
      'set-radius',
      0,
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
      0,
    )
    for (const disc of discsOf(scene)) {
      const r = discRadius(disc)
      expect(r).toBeGreaterThanOrEqual(lo - 1e-6)
      expect(r).toBeLessThanOrEqual(hi + 1e-6)
    }
  })

  it('a re-seed rearranges the sphere set while the params hold', () => {
    const params: Params = { sphereCount: 4 }
    const a = leafField.generate(params, 'spheres-a', 0)
    const b = leafField.generate(params, 'spheres-b', 0)
    // Same count, but the seeded centers/radii/depths differ ⇒ the disc set moves.
    expect(discsOf(a)).toHaveLength(4)
    expect(discsOf(b)).toHaveLength(4)
    expect(discsOf(b)).not.toEqual(discsOf(a))
  })

  it('changing a sphere knob leaves the leaf primitives untouched (per-leaf rng seam intact)', () => {
    // The sphere set draws from a SEPARATE rng stream, so raising sphereCount
    // must consume more sphere draws WITHOUT shifting a single per-leaf roll.
    const seed = 'seam'
    const base: Params = { density: 6, variation: 0.6 }
    const one = leafField.generate({ ...base, sphereCount: 1 }, seed, 0)
    const many = leafField.generate({ ...base, sphereCount: 5 }, seed, 0)
    // The leaf primitives (filtered from the disc splices) are byte-identical.
    expect(leavesOf(many)).toEqual(leavesOf(one))
  })

  it('is deterministic including every disc for identical (params, seed, t) (ADR-0002)', () => {
    const params: Params = { density: 6, sphereCount: 4, sphereRadiusMin: 120, sphereRadiusMax: 260 }
    const a = leafField.generate(params, 'set-det', 0)
    const b = leafField.generate(params, 'set-det', 0)
    expect(a).toEqual(b)
    expect(discsOf(a)).toEqual(discsOf(b))
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
    const shallow = leafField.generate({ ...base, sphereDepth: 0.1 }, seed, 0)
    const deep = leafField.generate({ ...base, sphereDepth: 0.9 }, seed, 0)
    // Higher depth ⇒ more leaves painted before (behind) the disc ⇒ cleaner edge.
    expect(leavesBeforeDisc(deep)).toBeGreaterThan(leavesBeforeDisc(shallow))
  })

  it('is a pure splice reorder — the leaf primitives are untouched by sphereDepth', () => {
    // sphereDepth touches only the insert index, never an rng draw, so the leaf
    // set stays byte-identical while only the disc's stack position shifts.
    const base: Params = { sphereCount: 1, density: 8 }
    const seed = 'depth-seam'
    const shallow = leafField.generate({ ...base, sphereDepth: 0.1 }, seed, 0)
    const deep = leafField.generate({ ...base, sphereDepth: 0.9 }, seed, 0)
    expect(leavesOf(deep)).toEqual(leavesOf(shallow))
  })

  it('is deterministic for identical (params, seed, t) (ADR-0002)', () => {
    const params: Params = { sphereCount: 3, sphereDepth: 0.7, density: 6 }
    const a = leafField.generate(params, 'depth-det', 0)
    const b = leafField.generate(params, 'depth-det', 0)
    expect(a).toEqual(b)
  })
})
