/**
 * The "leaf-field" Sketch — stage 4 of the Leaf Field build-up (parent #3):
 * a dense, tunable field of a fixed-shape leaf scattered across the coordinate
 * space at blue-noise (Poisson-disk) points and composited in painter's order.
 *
 * It samples the seeded variable-radius Poisson-disk sampler under a CONSTANT
 * radius field (the field's spacing is driven by the `density` knob), bakes one
 * copy of a single fixed {@link LeafShape} at every sampled point, and draws
 * them into a painter's-order Scene — earlier points sit under later ones, so
 * the overlap reads as a real composited field, not a flat stamp sheet.
 *
 * BUILD-UP STAGE / DEFERRED KNOBS: this task lands the scatter + placement +
 * compositing only. There is NO flow-field orientation and NO per-leaf
 * variation yet — every leaf is geometrically identical. The `fieldScale`,
 * `turbulence`, and `variation` knobs are DECLARED now (so the schema is stable
 * and the control panel is complete) but are CONSUMED in #TASK2, where flow
 * orientation and seeded per-leaf shape/size rolls land. Only `density`,
 * `leafSizeMin`, and `leafSizeMax` are read in this task.
 *
 * DRAW BOUNDARY (load-bearing): only generic {@link Primitive}s cross into the
 * Scene. The leaf domain type ({@link LeafShape}) is reached ONLY through the
 * relative `../single-leaf/leaf` import below and never re-exported, so it stays
 * private and never leaks across the public barrel / draw boundary.
 *
 * STATIC / DETERMINISTIC: there is no `time` metadata (the Harness hides the
 * scrubber), and `generate` is a pure function of `(params, seed, t)` — `t` is
 * threaded for the stateless contract but not read. Everything random flows from
 * the explicit Seed via `createRandom` / the sampler's seed: NO `Math.random`,
 * no clock read, and no state carried across `generate` calls. Re-seeding
 * reshuffles the whole field while the params hold.
 *
 * PAPER-RIM RATIONALE (2026-07-01 audit): a matching dark stroke would make the
 * painter's-order overlap visually unobservable — adjacent dark leaves merge
 * into one shape and the layering is invisible. So each leaf keeps the bold dark
 * FILL (linocut idiom, initiative #3) but carries a paper-colored (light)
 * STROKE, giving every overlap a light separating rim so the draw order reads
 * live.
 */

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
  /** Field base frequency. Declared now; consumed in #TASK2 (flow orientation). */
  fieldScale: { kind: 'number', min: 0.5, max: 8, default: 1.25 },
  /** Field roughness. Declared now; consumed in #TASK2 (flow orientation). */
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
 * target offset — but with the offset precomputed by the caller: because the
 * fixed-shape leaf's geometry (and thus its bbox center) is identical for every
 * point, the caller hoists the one bbox scan out of the placement loop and only
 * varies the translation.
 */
function translate(outline: Polyline, dx: number, dy: number): Polyline {
  return outline.map(([x, y]): Point => [x + dx, y + dy])
}

/**
 * The leaf-field Sketch: a static, stateless field of a fixed-shape leaf.
 *
 * `generate` reads the spacing/size knobs, blue-noise-samples the coordinate
 * space, bakes ONE fixed {@link LeafShape} at every sampled point (in sampler
 * order — that IS painter's order), and emits each as a dark-filled,
 * paper-rimmed closed polygon. No accumulated state — re-calling with the same
 * `(params, seed, t)` reproduces the same Scene exactly.
 */
export const leafField: StatelessSketch = {
  id: 'leaf-field',
  name: 'Leaf Field',
  schema,
  // NO `time` metadata ⇒ ships static (single frame, scrubber hidden).
  generate(params: Params, seed: Seed, _t: number): Scene {
    // Shared seeded Random threaded into `leaf()`. It drives per-leaf variation
    // in #TASK2; here the shape is fixed (wobble 0), so it only advances the
    // sequence and does not change geometry.
    const rng = createRandom(seed)

    const density = numberParam(params, schema, 'density')
    const leafSizeMin = numberParam(params, schema, 'leafSizeMin')
    const leafSizeMax = numberParam(params, schema, 'leafSizeMax')

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

    // The fixed-shape leaf's raw geometry is identical for every point (wobble
    // 0), so its bbox center is a loop invariant. Compute it ONCE, lazily, from
    // the first rolled outline instead of re-scanning inside the placement loop.
    // Roll from the SAME `rng` (no extra pre-loop `leaf()` call, so the shared
    // rng sequence is untouched — the seam #TASK2 relies on) and reuse that
    // outline as the first placement. Every later point translates by its own
    // offset from this fixed center.
    let centerX = 0
    let centerY = 0

    // Sampler order IS painter's order: index 0 is drawn first (bottom).
    points.forEach(([x, y], i) => {
      const raw = leaf(shape, rng)
      if (i === 0) {
        const { minX, minY, maxX, maxY } = bbox(raw)
        centerX = (minX + maxX) / 2
        centerY = (minY + maxY) / 2
      }
      builder.addPath(translate(raw, x - centerX, y - centerY), {
        closed: true,
        fill: { color: LEAF_FILL },
        stroke: { color: PAPER_STROKE, width: LEAF_STROKE_WIDTH },
      })
    })

    return builder.build()
  },
}
