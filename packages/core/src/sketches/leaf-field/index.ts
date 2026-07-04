/**
 * The "leaf-field" Sketch — stage 4 of the Leaf Field build-up (parent #3):
 * a dense, tunable field of leaves scattered across the coordinate space at
 * blue-noise (Poisson-disk) points, ORIENTED along a seeded curl-noise flow
 * field, carrying seeded per-leaf shape variation, and composited in painter's
 * order.
 *
 * It samples the seeded variable-radius Poisson-disk sampler under a CONSTANT
 * radius field (the field's spacing is driven by the `density` knob), rolls a
 * seeded {@link LeafShape} at every sampled point (size/curl/wobble scaled by
 * the `variation` knob), rotates each so its spine aligns with the local flow
 * direction, and draws them into a painter's-order Scene — earlier points sit
 * under later ones, so the overlap reads as a real composited field, not a flat
 * stamp sheet.
 *
 * ALL NINE KNOBS LIVE: this task completes the scatter + placement + flow-field
 * orientation + per-leaf variation + compositing. `density` drives spacing;
 * `fieldScale` (curl base frequency, in features across the canvas),
 * `octaves` (how many noise layers stack) and `turbulence` (curl octave falloff
 * → fbm `gain`) shape the flow each leaf bends into; `leafSizeMin`/`leafSizeMax`
 * bound the seeded length, `leafWidth` sets width as a fraction of that length
 * (slenderness) and `pointiness` sets the tip sharpness; `variation` scales how
 * far each leaf's length/curl/wobble strays from the fixed base. At `variation`
 * 0 every leaf collapses back to the midpoint base shape (matching the
 * pre-variation field), so the knob is live.
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
import { circle } from '../../geometry'
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
import { leaf } from '../single-leaf/leaf'
import type { LeafShape } from '../single-leaf/leaf'

/**
 * The leaf-field Parameter Schema — nine {@link NumberParamSpec} knobs, all
 * consumed NOW. Order is fixed and part of the contract. `satisfies` keeps the
 * literal key set (so `numberParam` can index by `keyof typeof schema`) while
 * enforcing the spec type.
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
 * The opaque occluder disc's fill — the render BACKGROUND color (see
 * `renderPreview`'s `background = 'white'` default), NOT {@link PAPER_STROKE}.
 * The disc must be invisible AS AN OBJECT (pure figure-ground) so that only the
 * OCCLUSION of the leaves it covers reads as an implied round volume; a tinted
 * fill (e.g. the leaf rim's `#f4f1ea`) would show up as a faint disc instead
 * (2026-07-03 audit). See the file header's occluder rationale.
 */
const DISC_FILL = 'white'

/**
 * Sphere placement, all derived from a SEPARATE seeded rng stream (see below).
 * The disc center is kept inside `[margin, 1 - margin]` of each axis so the full
 * circular silhouette lands on-canvas and reads as a complete round edge.
 */
const SPHERE_CENTER_MARGIN = 0.32

/** Sphere radius range, as a fraction of the canvas width. */
const SPHERE_RADIUS_MIN_FRAC = 0.18
const SPHERE_RADIUS_MAX_FRAC = 0.26

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

    // Sphere placement is drawn from a SEPARATE, dedicated rng stream (keyed off
    // the seed) so it stays OFF the per-leaf roll sequence (2026-07-03 audit,
    // finding 2): a future `sphereCount` knob can consume more draws here without
    // shifting a single per-leaf roll and desyncing the field. Each leaf still
    // consumes exactly its three `rng` draws below. Center/radius are fixed
    // constants of the Seed this task (NO schema knobs yet — later slice tasks).
    const sphereRng = createRandom(`${seed}-sphere`)
    const sphereCX = sphereRng.range(WIDTH * SPHERE_CENTER_MARGIN, WIDTH * (1 - SPHERE_CENTER_MARGIN))
    const sphereCY = sphereRng.range(HEIGHT * SPHERE_CENTER_MARGIN, HEIGHT * (1 - SPHERE_CENTER_MARGIN))
    const sphereR = sphereRng.range(WIDTH * SPHERE_RADIUS_MIN_FRAC, WIDTH * SPHERE_RADIUS_MAX_FRAC)

    // Constant radius field ⇒ uniform blue-noise spacing driven by `density`.
    // `minRadius` equals the constant so the accel grid is sized accurately
    // (mirror scatter). Variable/flow-driven radius is out of scope (#TASK2).
    const radius = REFERENCE_SPACING / density
    const sampled = samplePoissonDisk({
      width: WIDTH,
      height: HEIGHT,
      radius: () => radius,
      minRadius: radius,
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

    // The opaque, background-colored occluder disc. Appended LAST for now (top of
    // the draw order); the next step splices it in at the seeded painter's-order
    // depth so back leaves fall under it and front leaves lap over it. Fill only,
    // no stroke — pure figure-ground (see DISC_FILL / the file header).
    builder.addPath(circle(sphereCX, sphereCY, sphereR), {
      closed: true,
      fill: { color: DISC_FILL },
    })

    return builder.build()
  },
}
