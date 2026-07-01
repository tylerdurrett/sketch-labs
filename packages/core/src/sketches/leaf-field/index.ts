/**
 * The "leaf-field" Sketch — stage 4 of the Leaf Field build-up (parent #3):
 * a dense, tunable field of a fixed-shape leaf scattered across the coordinate
 * space at blue-noise (Poisson-disk) points, ORIENTED along a seeded curl-noise
 * flow field, and composited in painter's order.
 *
 * It samples the seeded variable-radius Poisson-disk sampler under a CONSTANT
 * radius field (the field's spacing is driven by the `density` knob), bakes one
 * copy of a single fixed {@link LeafShape} at every sampled point, rotates each
 * so its spine aligns with the local flow direction, and draws them into a
 * painter's-order Scene — earlier points sit under later ones, so the overlap
 * reads as a real composited field, not a flat stamp sheet.
 *
 * BUILD-UP STAGE / DEFERRED KNOBS: this task lands the scatter + placement +
 * flow-field orientation + compositing. Orientation is now LIVE: `fieldScale`
 * (curl base frequency) and `turbulence` (curl octave falloff → fbm `gain`) are
 * CONSUMED here to bend each leaf into the flow. Per-leaf shape/size variation
 * is still DEFERRED — every leaf is still geometrically identical (only its
 * rotation differs) — so the `variation` knob is DECLARED but CONSUMED in
 * #TASK2. `density`, `leafSizeMin`, `leafSizeMax`, `fieldScale`, and
 * `turbulence` are read in this task.
 *
 * DRAW BOUNDARY (load-bearing): only generic {@link Primitive}s cross into the
 * Scene. The leaf domain type ({@link LeafShape}) is reached ONLY through the
 * relative `../single-leaf/leaf` import below and never re-exported, so it stays
 * private and never leaks across the public barrel / draw boundary.
 *
 * STATIC / DETERMINISTIC: there is no `time` metadata (the Harness hides the
 * scrubber), and `generate` is a pure function of `(params, seed, t)`. `t` is
 * threaded LIVE into the 3D curl overload as the field's z slice (ADR-0002) so
 * animating later is a metadata swap, not a rewrite; with no `time` metadata t
 * is 0 in practice, so the field is a static slice today. Everything random
 * flows from the explicit Seed via `createRandom` / the sampler's seed: NO
 * `Math.random`, no clock read, and no state carried across `generate` calls.
 * Re-seeding reshuffles the whole field while the params hold.
 *
 * PAPER-RIM RATIONALE (2026-07-01 audit): a matching dark stroke would make the
 * painter's-order overlap visually unobservable — adjacent dark leaves merge
 * into one shape and the layering is invisible. So each leaf keeps the bold dark
 * FILL (linocut idiom, initiative #3) but carries a paper-colored (light)
 * STROKE, giving every overlap a light separating rim so the draw order reads
 * live.
 */

import { curl } from '../../curl'
import { samplePoissonDisk } from '../../poisson'
import { createRandom } from '../../random'
import { createScene } from '../../scene'
import type { Scene } from '../../scene'
import type {
  NumberParamSpec,
  Params,
  Seed,
  StatelessSketch,
} from '../../sketch'
import type { Point, Polyline } from '../../types'
import { bbox, HEIGHT, numberParam, WIDTH } from '../sketch-util'
import { leaf } from '../single-leaf/leaf'
import type { LeafShape } from '../single-leaf/leaf'

/**
 * The leaf-field Parameter Schema — six {@link NumberParamSpec} knobs. Three are
 * consumed NOW (`density`, `leafSizeMin`, `leafSizeMax`); the other three are
 * declared now for a stable schema but consumed in #TASK2 (see each doc). Order
 * is fixed and part of the contract. `satisfies` keeps the literal key set (so
 * `numberParam` can index by `keyof typeof schema`) while enforcing the spec
 * type.
 */
const schema = {
  /** Curl-field base frequency (scales the sampled coordinates). Consumed NOW (flow orientation). */
  fieldScale: { kind: 'number', min: 0.5, max: 8, default: 1.25 },
  /** Curl-field roughness — mapped to fbm's octave falloff (`gain`). Consumed NOW (flow orientation). */
  turbulence: { kind: 'number', min: 0.1, max: 0.9, default: 0.5 },
  /** Drives the Poisson spacing radius (radius = REFERENCE_SPACING / density). Consumed NOW. */
  density: { kind: 'number', min: 1, max: 12, default: 5 },
  /** Leaf size range low. Consumed NOW (fixed size = the min/max midpoint). */
  leafSizeMin: { kind: 'number', min: 40, max: 300, default: 100 },
  /** Leaf size range high. Consumed NOW (fixed size = the min/max midpoint). */
  leafSizeMax: { kind: 'number', min: 40, max: 400, default: 180 },
  /** Per-leaf variation amount. Declared now; consumed in #TASK2. */
  variation: { kind: 'number', min: 0, max: 1, default: 0.4 },
} satisfies Record<string, NumberParamSpec>

/** Poisson spacing radius at density 1; `radius = REFERENCE_SPACING / density`. */
const REFERENCE_SPACING = 400

/** Fixed leaf width as a fraction of its length (size). */
const LEAF_WIDTH_RATIO = 0.6

// Fixed shape constants for this task — no per-leaf variation yet. With
// `wobble: 0` the private `leaf()` generator adds no per-vertex jitter, so it
// produces IDENTICAL geometry for every point regardless of how far the RNG has
// advanced (rng-independent). That is exactly what "fixed shape, no per-leaf
// variation yet" means: per-leaf variation — nonzero wobble plus seeded
// size/shape rolls — lands in #TASK2.
const FIXED_CURL = 0.12
const FIXED_TIP_SHARPNESS = 0.7
const FIXED_WOBBLE = 0

/** Bold dark leaf fill (linocut idiom, initiative #3). */
const LEAF_FILL = '#1a1a1a'

/** Paper-colored light rim (see the file header's paper-rim rationale). */
const PAPER_STROKE = '#f4f1ea'

/** Stroke width of each leaf's paper rim, in coordinate-space units. */
const LEAF_STROKE_WIDTH = 2

/**
 * Translate a leaf outline by a fixed `(dx, dy)` offset, returning a NEW Polyline
 * (the input is not mutated).
 *
 * The {@link leaf} generator grows from the origin (0, 0) along +y with signed
 * ±x spread, so a raw outline is anchored at the origin, not at the sampled
 * point. This mirrors single-leaf's `center()` — computing the bbox-center-to-
 * target offset — then translating the (already-rotated) outline so its center
 * lands on the sampled point.
 */
function translate(outline: Polyline, dx: number, dy: number): Polyline {
  return outline.map(([x, y]): Point => [x + dx, y + dy])
}

/**
 * Rotate a leaf outline by `angle` radians about the origin (0, 0), returning a
 * NEW Polyline (the input is not mutated).
 *
 * Applied to a raw, origin-anchored {@link leaf} outline BEFORE {@link translate}
 * so the leaf's spine (which grows along +y) can be turned to face the local
 * flow direction. Rotating about the origin — the leaf's own base anchor —
 * keeps the pivot at the shape's root; the subsequent bbox-center translation
 * then places the rotated silhouette onto the sampled point. Standard 2D
 * rotation: `x' = x·cosθ − y·sinθ`, `y' = x·sinθ + y·cosθ`.
 */
function rotate(outline: Polyline, angle: number): Polyline {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return outline.map(([x, y]): Point => [x * cos - y * sin, x * sin + y * cos])
}

/**
 * The leaf-field Sketch: a static, stateless field of a fixed-shape leaf,
 * oriented along a seeded curl-noise flow field.
 *
 * `generate` reads the spacing/size/field knobs, blue-noise-samples the
 * coordinate space, bakes ONE fixed {@link LeafShape} at every sampled point (in
 * sampler order — that IS painter's order), rotates each so its spine tracks the
 * local flow direction, and emits each as a dark-filled, paper-rimmed closed
 * polygon. No accumulated state — re-calling with the same `(params, seed, t)`
 * reproduces the same Scene exactly.
 */
export const leafField: StatelessSketch = {
  id: 'leaf-field',
  name: 'Leaf Field',
  schema,
  // NO `time` metadata ⇒ ships static (single frame, scrubber hidden).
  generate(params: Params, seed: Seed, t: number): Scene {
    // Shared seeded Random threaded into `leaf()`. It drives per-leaf variation
    // in #TASK2; here the shape is fixed (wobble 0), so it only advances the
    // sequence and does not change geometry. It ALSO seeds the curl field via
    // its (separate, non-advancing) noise instances — sampling curl does not
    // consume value()/gaussian() draws, so the leaf() sequence stays untouched.
    const rng = createRandom(seed)

    const density = numberParam(params, schema, 'density')
    const leafSizeMin = numberParam(params, schema, 'leafSizeMin')
    const leafSizeMax = numberParam(params, schema, 'leafSizeMax')
    const fieldScale = numberParam(params, schema, 'fieldScale')
    const turbulence = numberParam(params, schema, 'turbulence')

    // Constant radius field ⇒ uniform blue-noise spacing driven by `density`.
    // `minRadius` equals the constant so the accel grid is sized accurately
    // (mirror scatter). Variable/flow-driven radius is out of scope (#TASK2).
    const radius = REFERENCE_SPACING / density
    const points = samplePoissonDisk({
      width: WIDTH,
      height: HEIGHT,
      radius: () => radius,
      minRadius: radius,
      seed,
    })

    // Fixed shape for the whole field (no per-leaf variation yet). Size is the
    // midpoint of the declared range; width follows the fixed length ratio.
    const length = (leafSizeMin + leafSizeMax) / 2
    const shape: LeafShape = {
      length,
      width: length * LEAF_WIDTH_RATIO,
      curl: FIXED_CURL,
      wobble: FIXED_WOBBLE,
      tipSharpness: FIXED_TIP_SHARPNESS,
    }

    const builder = createScene({ width: WIDTH, height: HEIGHT })

    // Sampler order IS painter's order: index 0 is drawn first (bottom). Each
    // leaf is rotated by its own flow angle, so the bbox center is no longer a
    // loop invariant (the #126 hoist is superseded) — compute it per-leaf after
    // rotation.
    points.forEach(([x, y]) => {
      // Sample the divergence-free flow at this point via the 3D curl overload
      // (z = t) so animating later is a metadata swap, not a rewrite (ADR-0002).
      // `turbulence` maps to fbm's per-octave falloff (`gain`). curl reads the
      // rng's separate noise instances, so it does NOT advance the leaf()
      // sequence — placement and shape rolls stay independent.
      const flow = curl(rng, x * fieldScale, y * fieldScale, t, { gain: turbulence })
      const angle = Math.atan2(flow[1], flow[0])

      // The leaf spine grows along +y; rotate by `angle - π/2` so that +y axis
      // aligns with the flow direction, then translate the rotated bbox-center
      // onto the sampled point.
      const rotated = rotate(leaf(shape, rng), angle - Math.PI / 2)
      const { minX, minY, maxX, maxY } = bbox(rotated)
      const centerX = (minX + maxX) / 2
      const centerY = (minY + maxY) / 2

      builder.addPath(translate(rotated, x - centerX, y - centerY), {
        closed: true,
        fill: { color: LEAF_FILL },
        stroke: { color: PAPER_STROKE, width: LEAF_STROKE_WIDTH },
      })
    })

    return builder.build()
  },
}
