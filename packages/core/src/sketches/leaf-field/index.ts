/**
 * The "leaf-field" Sketch — stage 4 of the Leaf Field build-up (parent #3):
 * a dense, tunable field of leaves scattered across the coordinate space at
 * blue-noise (Poisson-disk) points, ORIENTED along a seeded curl-noise flow
 * field, carrying seeded per-leaf shape variation, and composited in painter's
 * order.
 *
 * It samples the seeded variable-radius Poisson-disk sampler under a radius
 * field that is uniform (spacing driven by the `density` knob) EXCEPT inside the
 * static negative-space clearings, where the spacing blows up so the field thins
 * to leaf-free holes. Each clearing's rim is perturbed by SEEDED noise so it
 * reads as an organic, non-circular clearing rather than a hard disc (#132; see
 * ./negative-space); rolls a
 * seeded {@link LeafShape} at every sampled point (size/curl/wobble scaled by
 * the `variation` knob), rotates each so its spine aligns with the local flow
 * direction, and draws them into a painter's-order Scene — earlier points sit
 * under later ones, so the overlap reads as a real composited field, not a flat
 * stamp sheet.
 *
 * ALL KNOBS LIVE: this task completes the scatter + placement + flow-field
 * orientation + per-leaf variation + compositing, plus the clearing's boundary
 * treatment. `density` drives spacing;
 * `fieldScale` (curl base frequency, in features across the canvas),
 * `octaves` (how many noise layers stack) and `turbulence` (curl octave falloff
 * → fbm `gain`) shape the flow each leaf bends into; `leafSizeMin`/`leafSizeMax`
 * bound the seeded length, `leafWidth` sets width as a fraction of that length
 * (slenderness) and `pointiness` sets the tip sharpness; `variation` scales how
 * far each leaf's length/curl/wobble strays from the fixed base. At `variation`
 * 0 every leaf collapses back to the midpoint base shape (matching the
 * pre-variation field), so the knob is live. `edgeFalloff` grades the clearing
 * rim — 0 is a hard flat hole, wider feathers density into a spherical volume —
 * and `rimIntrusion` pulls the exclusion boundary inward so leaf tips break past
 * the rim into the clearing (0 = a clean stamped edge); see ./negative-space.
 *
 * FLOW COHERENCE (2026-07-02): `fieldScale` samples the curl field over
 * CANVAS-NORMALIZED coordinates (x/WIDTH, y/HEIGHT), so the knob reads directly
 * as "how many noise features span the canvas" — a value near 1–2 gives a
 * smooth, current-like sweep, not the near-random per-leaf scatter you get when
 * the base frequency runs into the tens. Fewer `octaves` keeps the field's broad
 * shape from dissolving into fine turbulence.
 *
 * SCALES OVERLAP (2026-07-02): the scatter is drawn TOP-OF-CANVAS FIRST (points
 * sorted by ascending y), so leaves lower on the canvas paint last and overlap
 * the ones above them — the field reads like overlapping scales / roof shingles
 * rather than an arbitrary stack.
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
import { lerp } from '../../math'
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
import { createNegativeSpaceField } from './negative-space'
import { leaf } from '../single-leaf/leaf'
import type { LeafShape } from '../single-leaf/leaf'

/**
 * The leaf-field Parameter Schema — eleven {@link NumberParamSpec} knobs, all
 * consumed NOW. Order is fixed and part of the contract (new knobs are APPENDED
 * so the existing keys keep their positions). `satisfies` keeps the literal key
 * set (so `numberParam` can index by `keyof typeof schema`) while enforcing the
 * spec type.
 */
const schema = {
  /**
   * Curl-field base frequency, in noise features across the canvas (the sampled
   * coords are canvas-normalized). A tight range with a low default: the flow
   * stays coherent near 1–2 and the low end is where the fine control lives —
   * higher values start to look random. Consumed NOW (flow orientation).
   */
  fieldScale: { kind: 'number', min: 0.25, max: 4, default: 0.5, step: 0.05 },
  /** Curl-field roughness — mapped to fbm's per-octave amplitude falloff (`gain`). Consumed NOW. */
  turbulence: { kind: 'number', min: 0.1, max: 0.9, default: 0.5 },
  /** Number of noise layers stacked into the flow field (fbm `octaves`); fewer = broader, less turbulent. Consumed NOW. */
  octaves: { kind: 'number', min: 1, max: 6, default: 2, step: 1, integer: true },
  /** Drives the Poisson spacing radius (radius = REFERENCE_SPACING / density). Consumed NOW. */
  density: { kind: 'number', min: 1, max: 16, default: 12.9 },
  /** Leaf length range low (length = the min/max midpoint at variation 0). Consumed NOW. */
  leafSizeMin: { kind: 'number', min: 40, max: 300, default: 50 },
  /** Leaf length range high (length = the min/max midpoint at variation 0). Consumed NOW. */
  leafSizeMax: { kind: 'number', min: 40, max: 400, default: 155.5 },
  /** Leaf width as a fraction of its length — lower = long & slender, higher = short & fat. Consumed NOW. */
  leafWidth: { kind: 'number', min: 0.15, max: 1, default: 0.9, step: 0.05 },
  /** Tip pointiness (leaf `tipSharpness`) — 0 = round, blunt apex; 1 = sharp, pointed. Consumed NOW. */
  pointiness: { kind: 'number', min: 0, max: 1, default: 0, step: 0.05 },
  /** Per-leaf variation amount — scales how far each leaf strays from the base shape. Consumed NOW. */
  variation: { kind: 'number', min: 0, max: 1, default: 0 },
  /**
   * Edge falloff — how sharply density drops across a clearing's rim, as a
   * fraction of the clearing radius over which the void multiplier ramps 1 → VOID
   * just OUTSIDE the rim. 0 = a hard, flat-hole edge; wider = density thins
   * gradually so the clearing reads as a rounded, spherical volume. Consumed NOW.
   */
  edgeFalloff: { kind: 'number', min: 0, max: 1, default: 0, step: 0.05 },
  /**
   * Rim intrusion — how far leaf tips are allowed to cross a clearing's rim, as a
   * fraction of the clearing radius the exclusion boundary is pulled INWARD. 0 = a
   * clean stamped edge (centers stop at the rim); higher lets centers approach and
   * cross the perturbed rim so tips break organically into the clearing. Consumed NOW.
   */
  rimIntrusion: { kind: 'number', min: 0, max: 0.5, default: 0, step: 0.05 },
} satisfies Record<string, NumberParamSpec>

/** Poisson spacing radius at density 1; `radius = REFERENCE_SPACING / density`. */
const REFERENCE_SPACING = 400

// Base shape constants. Each leaf's shape is rolled from these: size lerps from
// the range midpoint toward a seeded in-range draw by `variation`; curl and
// wobble stray from their base by seeded amounts scaled by `variation`. At
// `variation` 0 every leaf collapses to the fixed base (midpoint size, base
// curl, zero wobble) — the pre-variation field. (Width ratio and tip pointiness
// are their own live knobs — `leafWidth` / `pointiness` — applied uniformly.)
const FIXED_CURL = 0.12

/** Std-dev of the seeded per-leaf curl jitter (radians of bend), scaled by `variation`. */
const CURL_JITTER_STD = 0.15

/** Max seeded per-leaf wobble amplitude at `variation` 1; the base (variation 0) is 0. */
const MAX_WOBBLE = 2

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
 * The leaf-field Sketch: a static, stateless field of seeded-variant leaves,
 * oriented along a seeded curl-noise flow field.
 *
 * `generate` reads the spacing/size/field/variation knobs, blue-noise-samples
 * the coordinate space, rolls a seeded {@link LeafShape} at every sampled point
 * (in sampler order — that IS painter's order), rotates each so its spine tracks
 * the local flow direction, and emits each as a dark-filled, paper-rimmed closed
 * polygon. No accumulated state — re-calling with the same `(params, seed, t)`
 * reproduces the same Scene exactly.
 */
export const leafField: StatelessSketch = {
  id: 'leaf-field',
  name: 'Leaf Field',
  schema,
  // NO `time` metadata ⇒ ships static (single frame, scrubber hidden).
  generate(params: Params, seed: Seed, t: number): Scene {
    // Shared seeded Random. It drives the per-leaf shape rolls (size, curl,
    // wobble) AND is threaded into `leaf()` for its per-vertex wobble jitter. It
    // ALSO seeds the curl field via its (separate, non-advancing) noise
    // instances — sampling curl does not consume value()/gaussian() draws, so
    // the placement/shape roll sequence stays untouched by orientation.
    const rng = createRandom(seed)

    const density = numberParam(params, schema, 'density')
    const leafSizeMin = numberParam(params, schema, 'leafSizeMin')
    const leafSizeMax = numberParam(params, schema, 'leafSizeMax')
    const leafWidth = numberParam(params, schema, 'leafWidth')
    const pointiness = numberParam(params, schema, 'pointiness')
    const fieldScale = numberParam(params, schema, 'fieldScale')
    const turbulence = numberParam(params, schema, 'turbulence')
    const octaves = numberParam(params, schema, 'octaves')
    const variation = numberParam(params, schema, 'variation')
    const edgeFalloff = numberParam(params, schema, 'edgeFalloff')
    const rimIntrusion = numberParam(params, schema, 'rimIntrusion')

    // Blue-noise spacing driven by `density`, thinned to zero inside the static
    // negative-space clearings. Each clearing carries a SEEDED ORGANIC RIM — its
    // boundary is perturbed per angle by rng.noise2D, so the holes read ragged /
    // hand-cut rather than perfect discs (#132). The rim noise rides the rng's
    // SEPARATE noise instance, so building the mask does NOT advance the main
    // prng — the per-leaf placement/shape roll sequence below stays untouched and
    // the field stays a pure function of the seed (ADR-0002).
    //
    // The radius field is the dense-outside base spacing scaled by the clearing
    // multiplier: ~1× outside, huge inside (so local spacing exceeds the canvas ⇒
    // no leaves survive there). `accept` excludes the clearing interiors outright,
    // so not even the initial seed can strand a lone leaf in a hole. Both come
    // from the SAME perturbed-boundary test — one mechanism, no second code path.
    //
    // minRadius is PINNED to the base (dense-outside) spacing — the field's true
    // MINIMUM, since the multiplier only ever RAISES radius. The sampler sizes
    // its acceleration grid from minRadius and throws if it was over-estimated,
    // so this must never be lowered below the base.
    const { insideAnyClearing, radiusMultiplier } = createNegativeSpaceField(
      rng.noise2D,
      edgeFalloff,
      rimIntrusion,
    )
    const baseSpacing = REFERENCE_SPACING / density
    const sampled = samplePoissonDisk({
      width: WIDTH,
      height: HEIGHT,
      radius: (x, y) => baseSpacing * radiusMultiplier(x, y),
      minRadius: baseSpacing,
      accept: (x, y) => !insideAnyClearing(x, y),
      seed,
    })

    // Painter's order = TOP-OF-CANVAS FIRST: sort by ascending y (ties broken by
    // x for a stable, deterministic order) so leaves lower on the canvas paint
    // last and overlap the ones above them — the field reads like overlapping
    // scales, not an arbitrary stack. Sorting only re-orders draw/roll sequence;
    // each leaf still consumes exactly its three rng draws, so the deterministic
    // seam holds (a copy is sorted — the sampler output is not mutated).
    const points = [...sampled].sort(([ax, ay], [bx, by]) => ay - by || ax - bx)

    // Size base: the range midpoint. At `variation` 0 each leaf's length is
    // exactly this midpoint (the pre-variation field); as variation → 1 it lerps
    // toward a seeded in-range draw.
    const sizeMidpoint = (leafSizeMin + leafSizeMax) / 2

    const builder = createScene({ width: WIDTH, height: HEIGHT })

    // Sampler order IS painter's order: index 0 is drawn first (bottom). Each
    // leaf is rotated by its own flow angle, so the bbox center is no longer a
    // loop invariant (the #126 hoist is superseded) — compute it per-leaf after
    // rotation.
    points.forEach(([x, y]) => {
      // Sample the divergence-free flow at this point via the 3D curl overload
      // (z = t) so animating later is a metadata swap, not a rewrite (ADR-0002).
      // Coords are CANVAS-NORMALIZED (x/WIDTH, y/HEIGHT) so `fieldScale` reads as
      // features across the canvas — a low value keeps the sweep coherent instead
      // of dissolving into per-leaf randomness. `octaves` sets how many noise
      // layers stack and `turbulence` maps to fbm's per-octave amplitude falloff
      // (`gain`). curl reads the rng's separate noise instances, so it does NOT
      // advance the leaf() sequence — placement and shape rolls stay independent.
      const flow = curl(rng, (x / WIDTH) * fieldScale, (y / HEIGHT) * fieldScale, t, {
        gain: turbulence,
        octaves,
      })
      const angle = Math.atan2(flow[1], flow[0])

      // Roll this leaf's shape from `rng`, scaled by `variation`. CRUCIAL: roll
      // all three (length, curl, wobble) UNCONDITIONALLY and in a fixed order,
      // even when variation is 0 — the rng-consumption COUNT per leaf must stay
      // constant regardless of knob values so the deterministic seam holds and
      // changing `variation` reshapes the field without desyncing the sequence.
      // At variation 0 the rolls collapse to the fixed base (midpoint / FIXED
      // curl / zero wobble) while still consuming their draws.
      const length = lerp(sizeMidpoint, rng.range(leafSizeMin, leafSizeMax), variation)
      const curlAmount = FIXED_CURL + rng.gaussian(0, CURL_JITTER_STD) * variation
      const wobble = MAX_WOBBLE * variation * rng.value()
      const shape: LeafShape = {
        length,
        width: length * leafWidth,
        curl: curlAmount,
        wobble,
        tipSharpness: pointiness,
      }

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
