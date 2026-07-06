/**
 * The "leaf-field" Sketch — a dense, tunable field of leaves scattered across
 * the coordinate space at blue-noise (Poisson-disk) points, ORIENTED along a
 * seeded curl-noise flow field, carrying seeded per-leaf shape variation,
 * composited in painter's order, and — with a SEEDED SET of opaque occluder
 * discs spliced into that order — reading as IMPLIED SPHERES in the field's
 * negative space.
 *
 * It samples the seeded variable-radius Poisson-disk sampler under a CONSTANT
 * radius field (the field's spacing is driven by the `density` knob), rolls a
 * seeded {@link LeafShape} at every sampled point (size/curl/wobble scaled by
 * the `variation` knob), rotates each so its spine aligns with the local flow
 * direction, and draws them into a painter's-order Scene — earlier points sit
 * under later ones, so the overlap reads as a real composited field, not a flat
 * stamp sheet.
 *
 * ALL THIRTEEN KNOBS LIVE: the first nine complete the scatter + placement +
 * flow-field orientation + per-leaf variation + compositing, and the four
 * appended sphere knobs (`sphereCount`, `sphereRadiusMin`, `sphereRadiusMax`,
 * `sphereDepth`) drive the implied-sphere occluders (below). `density`
 * drives spacing;
 * `fieldScale` (curl base frequency, in features across the canvas),
 * `octaves` (how many noise layers stack) and `turbulence` (curl octave falloff
 * → fbm `gain`) shape the flow each leaf bends into; `leafSizeMin`/`leafSizeMax`
 * bound the seeded length, `leafWidth` sets width as a fraction of that length
 * (slenderness) and `pointiness` sets the tip sharpness; each leaf's length
 * draws uniformly across [leafSizeMin, leafSizeMax] (set them equal for a
 * uniform-size field), while `variation` scales how far each leaf's curl/wobble
 * strays from the fixed base — at `variation` 0 the curl/wobble collapse back to
 * that base, so the knob is live.
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
 * rather than an arbitrary stack. That ascending-y draw sequence IS the seam the
 * occluder exploits (below).
 *
 * IMPLIED-SPHERE OCCLUDERS (2026-07-03, slice #139 / tasks #140, #141, #142): the
 * field's negative space is made to read as round volumes NOT by thinning the
 * scatter but by OCCLUSION. Each opaque disc — filled with the render BACKGROUND
 * color ({@link DISC_FILL} = 'white'), so it is invisible AS AN OBJECT and reads
 * as pure figure-ground, never a drawn circle — is spliced into the painter's
 * order at a DEPTH index driven by the global `sphereDepth` knob. Leaves drawn
 * BEFORE it (top/back of the field) are painted over where they cross it, so the
 * disc's TRUE circular silhouette cuts a hard, genuinely round edge on the
 * sphere's FAR side; leaves drawn AFTER it (bottom/front) lap OVER its near side,
 * breaking that edge into organic leaf tips. Roundness comes from the real
 * circle; organic-ness comes from the front leaves; the eye fuses the two into an
 * implied sphere. Each disc is a closed polyline from the shared {@link circle}
 * helper (fill only, no stroke). #141 turns the single hardcoded disc into a
 * SEEDED SET of N discs driven by three knobs: `sphereCount` (how many — 0 by
 * default, so the field ships plain and the implied-sphere set is opt-in),
 * `sphereRadiusMin`/`sphereRadiusMax` (per-disc radius bounds, in coordinate
 * units — superseding the old radius-fraction constants). Each disc's center and
 * radius are seeded (per-sphere, off the leaf stream — see below). #142 makes the
 * front/behind split its own GLOBAL knob `sphereDepth` (0 ⇒ behind every leaf,
 * max front overlap / most embedded; 1 ⇒ in front of every leaf, clean round edge
 * / most spherical), applied uniformly to EVERY disc — replacing the per-sphere
 * seeded depth roll (per-sphere depth variation is out of scope for this slice).
 * All discs therefore share one splice index; if it lands past the last leaf they
 * paint on top after the loop. No shading, highlight, cast-shadow, or per-leaf
 * clipping against the discs (styling / clipping slices).
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
 * SPHERE STREAM OFF THE LEAF SEQUENCE (2026-07-03 audit): every sphere's
 * center/radius is drawn from a SEPARATE, dedicated rng stream
 * (`createRandom(`${seed}-sphere`)`), never interleaved before or inside the
 * per-leaf loop, and each sphere consumes that stream in a FIXED order (cx, cy,
 * r). Each leaf still consumes exactly its three `rng` draws, so raising
 * `sphereCount` consumes MORE draws from the sphere stream WITHOUT shifting a
 * single per-leaf roll and desyncing the field (#141). The sphere state is never
 * drawn up-front from the main `rng` (explicitly rejected by the audit). The
 * splice depth is NOT rolled — it is the global `sphereDepth` knob (#142), so it
 * touches only the insert index and never consumes an rng draw from either
 * stream: changing it leaves every disc's cx/cy/r AND every leaf byte-identical.
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
 * The leaf-field Parameter Schema — thirteen {@link NumberParamSpec} knobs, all
 * consumed NOW. Order is fixed and part of the contract; the sphere knobs are
 * APPENDED last (`sphereCount`/`sphereRadiusMin`/`sphereRadiusMax` #141, then
 * `sphereDepth` #142) so the existing nine keep their positions. `satisfies`
 * keeps the literal key set (so `numberParam` can index by `keyof typeof schema`)
 * while enforcing the spec type.
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
  density: { kind: 'number', min: 1, max: 80, default: 12.9 },
  /** Leaf length range low — each leaf's length draws uniformly in [min, max]. Set equal to max for a uniform-size field. Consumed NOW. */
  leafSizeMin: { kind: 'number', min: 10, max: 300, default: 50 },
  /** Leaf length range high — each leaf's length draws uniformly in [min, max]. Consumed NOW. */
  leafSizeMax: { kind: 'number', min: 10, max: 400, default: 155.5 },
  /** Leaf width as a fraction of its length — lower = long & slender, higher = short & fat. Consumed NOW. */
  leafWidth: { kind: 'number', min: 0.15, max: 1, default: 0.9, step: 0.05 },
  /** Tip pointiness (leaf `tipSharpness`) — 0 = round, blunt apex; 1 = sharp, pointed. Consumed NOW. */
  pointiness: { kind: 'number', min: 0, max: 1, default: 0, step: 0.05 },
  /** Per-leaf shape variation — scales how far each leaf's curl/wobble strays from the base shape (size is its own [leafSizeMin, leafSizeMax] range, independent of this). Consumed NOW. */
  variation: { kind: 'number', min: 0, max: 1, default: 0 },
  /**
   * How many implied-sphere occluder discs to scatter into the field. Each disc
   * is placed/sized/depth-sorted from the dedicated sphere rng stream (OFF the
   * per-leaf rolls), so raising this consumes more sphere draws without shifting
   * a single leaf. The set is OPT-IN: the min (and default) is 0 — a plain leaf
   * field with no implied spheres — and raising it splices in that many discs.
   * Consumed NOW (sphere-set count). Appended last (#141).
   */
  sphereCount: { kind: 'number', min: 0, max: 6, default: 0, step: 1, integer: true },
  /**
   * Sphere radius range low, in coordinate-space units (WIDTH=1000). Supersedes
   * the old SPHERE_RADIUS_MIN_FRAC constant (0.18·WIDTH ≈ 180). Consumed NOW.
   */
  sphereRadiusMin: { kind: 'number', min: 40, max: 400, default: 180 },
  /**
   * Sphere radius range high, in coordinate-space units (WIDTH=1000). Supersedes
   * the old SPHERE_RADIUS_MAX_FRAC constant (0.26·WIDTH ≈ 260). `generate` guards
   * min ≤ max internally (Sketch owns its inter-param coherence). Consumed NOW.
   */
  sphereRadiusMax: { kind: 'number', min: 40, max: 400, default: 260 },
  /**
   * Where every disc inserts into the (ascending-y) painter's-order stack — the
   * front/behind split, applied GLOBALLY to all discs. 0 ⇒ each disc sits behind
   * every leaf (max front overlap, most embedded); 1 ⇒ each disc sits in front of
   * every leaf (clean round edge, most spherical). Raising it draws MORE leaves
   * before the disc (occluded / behind), so the round far-side edge grows and the
   * front overlap shrinks. One global depth for the whole set this slice
   * (per-sphere depth variation is out of scope). Consumed NOW. Appended last
   * (#142).
   */
  sphereDepth: { kind: 'number', min: 0, max: 1, default: 0.5 },
} satisfies Record<string, NumberParamSpec>

/** Poisson spacing radius at density 1; `radius = REFERENCE_SPACING / density`. */
const REFERENCE_SPACING = 400

// Base shape constants. Each leaf's length draws uniformly in its own
// [leafSizeMin, leafSizeMax] range (independent of `variation` — that knob owns
// curl/wobble only). Curl and wobble stray from these bases by seeded amounts
// scaled by `variation`; at `variation` 0 they collapse to the fixed base (base
// curl, zero wobble). (Width ratio and tip pointiness are their own live knobs —
// `leafWidth` / `pointiness` — applied uniformly.)
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
 * oriented along a seeded curl-noise flow field, with a seeded set of opaque
 * occluder discs implying spheres in the negative space.
 *
 * `generate` reads the spacing/size/field/variation knobs, blue-noise-samples
 * the coordinate space, rolls a seeded {@link LeafShape} at every sampled point
 * (in sorted ascending-y order — that IS painter's order), rotates each so its
 * spine tracks the local flow direction, emits each as a dark-filled,
 * paper-rimmed closed polygon, and splices a seeded set of background-colored
 * occluder discs into the draw order at their own seeded depths (see the file
 * header's occluder rationale). No accumulated state — re-calling with the same `(params, seed, t)`
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
    const sphereCount = numberParam(params, schema, 'sphereCount')

    // Sphere-set radius bounds. The Sketch owns its own inter-param coherence
    // (CONTEXT.md), so guarantee a valid draw range by swapping if a user sets
    // min > max — the radius draw below must always be well-formed.
    let sphereRadiusMin = numberParam(params, schema, 'sphereRadiusMin')
    let sphereRadiusMax = numberParam(params, schema, 'sphereRadiusMax')
    if (sphereRadiusMin > sphereRadiusMax) {
      ;[sphereRadiusMin, sphereRadiusMax] = [sphereRadiusMax, sphereRadiusMin]
    }

    // The front/behind split: one GLOBAL depth (0 ⇒ behind every leaf, 1 ⇒ in
    // front of every leaf) applied to EVERY disc (#142). It is a knob, not an rng
    // roll, so it touches only the splice index — it never consumes a draw from
    // either stream, leaving cx/cy/r and every leaf byte-identical.
    const sphereDepth = numberParam(params, schema, 'sphereDepth')

    // The sphere set is drawn from a SEPARATE, dedicated rng stream (keyed off
    // the seed) so it stays OFF the per-leaf roll sequence (2026-07-03 audit,
    // finding 2): raising `sphereCount` consumes MORE draws here without shifting
    // a single per-leaf roll and desyncing the field. Each leaf still consumes
    // exactly its three `rng` draws below. Every sphere draws center/radius from
    // this stream in a FIXED per-sphere order (cx, cy, r) so the set is fully
    // reproducible from (params, seed). Depth is the global `sphereDepth` knob
    // above, NOT a per-sphere roll — dropping that draw leaves cx/cy/r identical.
    const sphereRng = createRandom(`${seed}-sphere`)
    const spheres = Array.from({ length: sphereCount }, () => {
      // Draw center fractions first, radius last — this PRESERVES the documented
      // per-sphere draw order (center-x, center-y, radius = three draws) and the
      // separate-stream seam, so no per-leaf roll shifts. Each center is then inset
      // by the disc's OWN radius (not a fixed fraction) so the full circular
      // silhouette always lands on-canvas for ANY radius: radius ≤ 400 < WIDTH/2,
      // so [r, WIDTH − r] is always a valid range and reads as a complete round
      // edge. (Radius bounds are the live `sphereRadiusMin`/`sphereRadiusMax`
      // knobs, #141.)
      const cxFrac = sphereRng.value()
      const cyFrac = sphereRng.value()
      const r = sphereRng.range(sphereRadiusMin, sphereRadiusMax)
      const cx = lerp(r, WIDTH - r, cxFrac)
      const cy = lerp(r, HEIGHT - r, cyFrac)
      return { cx, cy, r }
    })

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

    const builder = createScene({ width: WIDTH, height: HEIGHT })

    // Splice the opaque occluder discs into the painter's order at the GLOBAL
    // depth index: the top/back leaves (drawn first) fall UNDER them and are
    // occluded where they cross a disc — the disc's true circular silhouette reads
    // as a hard, genuinely round edge on the sphere's far side — while the
    // bottom/front leaves (drawn after) lap OVER the near side for organic tip
    // breakup. `Math.round(sphereDepth · N)` maps depth 0 → behind all leaves
    // (max front overlap) and depth 1 → in front of all (clean round edge); every
    // disc shares this one index. Fill only, no stroke: pure figure-ground.
    const drawDisc = (sphere: { cx: number; cy: number; r: number }): void => {
      builder.addPath(circle(sphere.cx, sphere.cy, sphere.r), {
        closed: true,
        fill: { color: DISC_FILL },
      })
    }

    // One global splice index for the whole set (#142). All discs draw (in sphere
    // order) just before the leaf at this index; if it lands past the last leaf
    // (index ≥ N, i.e. depth ~1) the in-loop `i === spliceIdx` never fires and the
    // discs are deferred to the on-top pass after the loop instead.
    const spliceIdx = Math.round(sphereDepth * points.length)

    // Sampler order IS painter's order: index 0 is drawn first (bottom). Each
    // leaf is rotated by its own flow angle, so the bbox center is no longer a
    // loop invariant (the #126 hoist is superseded) — compute it per-leaf after
    // rotation.
    points.forEach(([x, y], i) => {
      if (i === spliceIdx) for (const sphere of spheres) drawDisc(sphere)
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

      // Roll this leaf's shape from `rng`. CRUCIAL: roll all three (length, curl,
      // wobble) UNCONDITIONALLY and in a fixed order — the rng-consumption COUNT
      // per leaf must stay constant regardless of knob values so the deterministic
      // seam holds and changing a knob reshapes the field without desyncing the
      // sequence. Length draws uniformly across the full [leafSizeMin, leafSizeMax]
      // range so leaves genuinely differ in size (set the two equal for a uniform
      // field); `variation` governs only the curl/wobble shape strays, which
      // collapse to the fixed base (FIXED curl / zero wobble) at variation 0 while
      // still consuming their draws.
      const length = rng.range(leafSizeMin, leafSizeMax)
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

    // sphereDepth ~1 lands the splice index past the last leaf ⇒ draw on top of all.
    if (spliceIdx >= points.length) for (const sphere of spheres) drawDisc(sphere)

    return builder.build()
  },
}
