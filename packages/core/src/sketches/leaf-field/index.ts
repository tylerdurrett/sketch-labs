/**
 * The "leaf-field" Sketch — a dense, tunable field of leaves scattered across
 * the coordinate space at blue-noise (Poisson-disk) points, ORIENTED along a
 * seeded curl-noise flow field, carrying seeded per-leaf shape variation,
 * composited in painter's order over a param-colored background, and — with a
 * SEEDED SET of opaque occluder discs spliced into that order — carrying round
 * volumes in the field: colored orbs the leaves lap over (white on mid gray at
 * the defaults), which when disc color == background color read as IMPLIED
 * SPHERES in the field's negative space.
 *
 * It samples the seeded variable-radius Poisson-disk sampler under a CONSTANT
 * radius field (the field's spacing is driven by the `density` knob), rolls a
 * seeded {@link LeafShape} at every sampled point (size/curl/wobble scaled by
 * the `variation` knob), rotates each so its spine aligns with the local flow
 * direction, and draws them into a painter's-order Scene — earlier points sit
 * under later ones, so the overlap reads as a real composited field, not a flat
 * stamp sheet.
 *
 * ALL SEVENTEEN KNOBS LIVE: the first eleven complete the scatter + placement +
 * flow-field orientation + per-leaf variation + compositing, the four appended
 * sphere knobs (`sphereCount`, `sphereRadiusMin`, `sphereRadiusMax`,
 * `sphereDepth`) drive the occluder discs (below), and the two appended color
 * knobs (`backgroundColor`, `discColor` — the first `kind: 'color'` params,
 * ADR-0010) own the scene background and the disc fill. `density`
 * drives spacing;
 * `fieldScale` (curl base frequency, in features across the canvas),
 * `octaves` (how many noise layers stack) and `turbulence` (curl octave falloff
 * → fbm `gain`) shape the flow each leaf bends into; `leafSizeMin`/`leafSizeMax`
 * bound the seeded length, `leafWidthMin`/`leafWidthMax` bound the seeded width
 * (as a fraction of that length — slenderness) and `pointinessMin`/`pointinessMax`
 * bound the seeded tip
 * sharpness; each leaf's length draws uniformly across [leafSizeMin, leafSizeMax],
 * its width fraction across [leafWidthMin, leafWidthMax], and its tip sharpness
 * across [pointinessMin, pointinessMax]
 * (set each pair equal for a uniform field), while `variation` scales how far
 * each leaf's curl/wobble
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
 * OCCLUDER DISCS (2026-07-03, slice #139 / tasks #140, #141, #142; recolorable
 * 2026-07-07): the field's round volumes come NOT from thinning the scatter but
 * from OCCLUSION. Each opaque disc is filled with the `discColor` knob. The disc
 * was ORIGINALLY hardwired white-on-white — the render background's color —
 * specifically to be INVISIBLE AS AN OBJECT: only the occlusion of the leaves it
 * covers read, a pure figure-ground implied sphere (a tinted fill would have
 * shown up as a faint drawn circle, 2026-07-03 audit). `discColor` DECOUPLES
 * that: the disc is now a VISIBLE colored occluder in its own right — a colored
 * orb the leaves lap over — and that is the SHIPPED DEFAULT (2026-07-07): white
 * discs (`discColor` `'#ffffff'`) on a mid-gray ground (`backgroundColor`
 * `'#878787'`), so a bare generate reads as white orbs in the field. The
 * original implied-sphere figure-ground survives as the SPECIAL CASE
 * `discColor === backgroundColor` (what the "Nice One" preset pins, both
 * white). Each disc is spliced into the painter's
 * order at a DEPTH index driven by the global `sphereDepth` knob. Leaves drawn
 * BEFORE it (top/back of the field) are painted over where they cross it, so the
 * disc's TRUE circular silhouette cuts a hard, genuinely round edge on the
 * sphere's FAR side; leaves drawn AFTER it (bottom/front) lap OVER its near side,
 * breaking that edge into organic leaf tips. Roundness comes from the real
 * circle; organic-ness comes from the front leaves; the eye fuses the two into an
 * implied sphere. Each disc is a closed polyline from the shared {@link circle}
 * helper (fill only, no stroke). #141 turns the single hardcoded disc into a
 * SEEDED SET of N discs driven by three knobs: `sphereCount` (how many — default
 * 6, from the "Nice One" preset, so the field ships with the full implied-sphere
 * set; drop to 0 for a plain field),
 * `sphereRadiusMin`/`sphereRadiusMax` (per-disc radius bounds, in coordinate
 * units — superseding the old radius-fraction constants). Each disc's center and
 * radius are seeded (per-sphere, off the leaf stream — see below). #142 makes the
 * front/behind split its own knob `sphereDepth` (0 ⇒ behind every overlapping
 * leaf, max front overlap / most embedded; 1 ⇒ in front of every overlapping leaf,
 * clean round edge / most spherical). Because the field draws top-of-canvas first
 * (ascending y), applying that knob as ONE global splice index made it a single y
 * threshold across the whole canvas — so at any fixed value the low discs came out
 * buried while the high discs floated with no overlap (or vice-versa), with no
 * value reading the same top and bottom. So `sphereDepth` is POSITION-RELATIVE
 * (2026-07-06): each disc derives its OWN splice index from a threshold anchored to
 * its own center and radius (the disc's overlap band, [cy − r − margin,
 * cy + r + margin], with margin = half the max leaf length), so the knob reads as a
 * CONSISTENT depth wherever the disc sits. A disc whose threshold clears the last
 * leaf paints on top after the loop. No shading, highlight, cast-shadow, or
 * per-leaf clipping against the discs (styling / clipping slices).
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
 * Re-seeding reshuffles the whole field while the params hold. The two color
 * knobs consume NO rng draws from either stream — they touch only fill colors
 * and the Scene's `background` — so every leaf outline and disc silhouette stays
 * byte-identical to the pre-color field at any color value. The pre-color image
 * itself is preserved by the "Nice One" preset, which pins BOTH colors to white
 * explicitly (its stored params predate the knobs, and the gray-background
 * default would otherwise silently repaint it on reconciliation).
 *
 * SPHERE STREAM OFF THE LEAF SEQUENCE (2026-07-03 audit): every sphere's
 * center/radius is drawn from a SEPARATE, dedicated rng stream
 * (`createRandom(`${seed}-sphere`)`), never interleaved before or inside the
 * per-leaf loop, and each sphere consumes that stream in a FIXED order (cx, cy,
 * r). Each leaf still consumes exactly its three `rng` draws, so raising
 * `sphereCount` consumes MORE draws from the sphere stream WITHOUT shifting a
 * single per-leaf roll and desyncing the field (#141). The sphere state is never
 * drawn up-front from the main `rng` (explicitly rejected by the audit). The
 * splice depth is NOT rolled — it derives from the `sphereDepth` knob and each
 * disc's own (already-seeded) cy/r (#142, position-relative 2026-07-06), so it
 * touches only the per-disc insert indices and never consumes an rng draw from
 * either stream: changing it leaves every disc's cx/cy/r AND every leaf
 * byte-identical.
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
  Params,
  ParamSpec,
  Seed,
  StatelessSketch,
} from '../../sketch'
import type { Point, Polyline } from '../../types'
import { bbox, colorParam, HEIGHT, numberParam, WIDTH } from '../sketch-util'
import { leaf } from '../single-leaf/leaf'
import type { LeafShape } from '../single-leaf/leaf'

/**
 * The leaf-field Parameter Schema — seventeen knobs (fifteen numeric, two
 * color), all consumed NOW. Order is fixed and part of the contract; each
 * widening APPENDS so earlier knobs keep their positions: the sphere knobs
 * (`sphereCount`/`sphereRadiusMin`/`sphereRadiusMax` #141, then `sphereDepth`
 * #142) after the original eleven, then the color knobs (`backgroundColor`,
 * `discColor` — the first `kind: 'color'` specs, ADR-0010) last. `satisfies`
 * keeps the literal key set (so `numberParam`/`colorParam` can filter
 * `keyof typeof schema` by each spec's literal `kind`) while enforcing the spec
 * type — the target is the full `ParamSpec` union now that the kinds mix.
 */
const schema = {
  /**
   * Curl-field base frequency, in noise features across the canvas (the sampled
   * coords are canvas-normalized). A tight range with a low default: the flow
   * stays coherent near 1–2 and the low end is where the fine control lives —
   * higher values start to look random. Consumed NOW (flow orientation).
   */
  fieldScale: { kind: 'number', min: 0.25, max: 4, default: 0.75, step: 0.05 },
  /** Curl-field roughness — mapped to fbm's per-octave amplitude falloff (`gain`). Consumed NOW. */
  turbulence: { kind: 'number', min: 0.1, max: 0.9, default: 0.1536 },
  /** Number of noise layers stacked into the flow field (fbm `octaves`); fewer = broader, less turbulent. Consumed NOW. */
  octaves: { kind: 'number', min: 1, max: 6, default: 2, step: 1, integer: true },
  /** Drives the Poisson spacing radius (radius = REFERENCE_SPACING / density). Consumed NOW. */
  density: { kind: 'number', min: 1, max: 80, default: 18.696 },
  /** Leaf length range low — each leaf's length draws uniformly in [min, max]. Set equal to max for a uniform-size field. Consumed NOW. */
  leafSizeMin: { kind: 'number', min: 10, max: 300, default: 50 },
  /** Leaf length range high — each leaf's length draws uniformly in [min, max]. Consumed NOW. */
  leafSizeMax: { kind: 'number', min: 10, max: 400, default: 64.6 },
  /** Leaf width range low — width as a fraction of the leaf's own length; each leaf draws uniformly in [min, max]. Lower = long & slender, higher = short & fat. Set equal to max for a uniform-width field. Consumed NOW. */
  leafWidthMin: { kind: 'number', min: 0.15, max: 2, default: 0.5, step: 0.05 },
  /** Leaf width range high — width as a fraction of the leaf's own length; each leaf draws uniformly in [min, max]. Above 1 the leaf is wider than it is long. Consumed NOW. */
  leafWidthMax: { kind: 'number', min: 0.15, max: 2, default: 1.15, step: 0.05 },
  /** Leaf tip sharpness range low — each leaf's `tipSharpness` draws uniformly in [min, max]; 0 = round/blunt apex, 1 = sharp/pointed. Set equal to max for a uniform field. Consumed NOW. */
  pointinessMin: { kind: 'number', min: 0, max: 1, default: 0, step: 0.05 },
  /** Leaf tip sharpness range high — each leaf's `tipSharpness` draws uniformly in [min, max]; 0 = round/blunt apex, 1 = sharp/pointed. Consumed NOW. */
  pointinessMax: { kind: 'number', min: 0, max: 1, default: 0, step: 0.05 },
  /** Per-leaf shape variation — scales how far each leaf's curl/wobble strays from the base shape (size is its own [leafSizeMin, leafSizeMax] range, independent of this). Consumed NOW. */
  variation: { kind: 'number', min: 0, max: 1, default: 0 },
  /**
   * How many implied-sphere occluder discs to scatter into the field. Each disc
   * is placed/sized/depth-sorted from the dedicated sphere rng stream (OFF the
   * per-leaf rolls), so raising this consumes more sphere draws without shifting
   * a single leaf. The min is 0 (a plain leaf field with no implied spheres); the
   * default is 6 (the "Nice One" preset), so the field ships with the full
   * implied-sphere set. Consumed NOW (sphere-set count). Appended last (#141).
   */
  sphereCount: { kind: 'number', min: 0, max: 6, default: 6, step: 1, integer: true },
  /**
   * Sphere radius range low, in coordinate-space units (WIDTH=1000). Default from
   * the "Nice One" preset (40). Consumed NOW.
   */
  sphereRadiusMin: { kind: 'number', min: 40, max: 400, default: 40 },
  /**
   * Sphere radius range high, in coordinate-space units (WIDTH=1000). Default from
   * the "Nice One" preset (190.12). `generate` guards min ≤ max internally (Sketch
   * owns its inter-param coherence). Consumed NOW.
   */
  sphereRadiusMax: { kind: 'number', min: 40, max: 400, default: 190.12 },
  /**
   * How embedded each disc reads in the field — the front/behind split, applied
   * as a POSITION-RELATIVE depth (2026-07-06). Because the field draws
   * top-of-canvas first (ascending y), a single global splice index meant one y
   * threshold for the whole canvas and so a different apparent depth at every
   * height; instead each disc's threshold is anchored to its OWN center/radius, so
   * one knob value reads consistently wherever a disc sits. 0 ⇒ the disc sits
   * behind every leaf that overlaps it (max front overlap, most embedded); 1 ⇒ in
   * front of every overlapping leaf (clean round edge, most spherical); 0.5 splits
   * at the disc's center. Consumed NOW. Appended last (#142).
   */
  sphereDepth: { kind: 'number', min: 0, max: 1, default: 0.5 },
  /**
   * The Scene's background color (hex) — the whole output surface, letterbox
   * included, carried as `Scene.background` so it rides the determinism spine
   * and round-trips through Presets (ADR-0009). Defaults to a mid gray
   * (2026-07-07), deliberately DIFFERENT from `discColor`'s white so the discs
   * read as visible orbs out of the box; the pre-color white-on-white image is
   * pinned by the "Nice One" preset, not by these defaults. Consumed NOW.
   * Appended last with `discColor` (ADR-0010).
   */
  backgroundColor: { kind: 'color', default: '#878787' },
  /**
   * The occluder discs' fill color (hex). DIFFERENT from `backgroundColor` at
   * the defaults (white orbs on mid gray), so each disc reads as a visible
   * colored orb the leaves lap over; set it EQUAL to `backgroundColor` to make
   * the disc invisible as an object and recover the original implied-sphere
   * figure-ground (see the header's occluder rationale). Consumed NOW. Appended
   * last (ADR-0010).
   */
  discColor: { kind: 'color', default: '#ffffff' },
} satisfies Record<string, ParamSpec>

/** Poisson spacing radius at density 1; `radius = REFERENCE_SPACING / density`. */
const REFERENCE_SPACING = 400

// Base shape constants. Each leaf's length draws uniformly in its own
// [leafSizeMin, leafSizeMax] range, its tip sharpness in its own
// [pointinessMin, pointinessMax] range, and its width fraction in its own
// [leafWidthMin, leafWidthMax] range (all three independent of `variation` —
// that knob owns curl/wobble only). Curl and wobble stray from these bases by
// seeded amounts scaled by `variation`; at `variation` 0 they collapse to the
// fixed base (base curl, zero wobble).
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

// The disc fill is the `discColor` knob (read in `generate`), which superseded
// the old hardwired DISC_FILL = 'white' constant. See the file header's occluder
// rationale: at the defaults (white on mid gray) the disc is a visible colored
// orb; setting discColor === backgroundColor makes it invisible as an object —
// the original implied-sphere figure-ground.

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
 * oriented along a seeded curl-noise flow field, over a param-colored
 * background, with a seeded set of opaque `discColor`-filled occluder discs —
 * visible colored orbs at the defaults (white on mid gray), implied spheres
 * when disc and background colors match.
 *
 * `generate` reads the spacing/size/field/variation knobs plus the two color
 * knobs, blue-noise-samples the coordinate space, rolls a seeded
 * {@link LeafShape} at every sampled point (in sorted ascending-y order — that
 * IS painter's order), rotates each so its spine tracks the local flow
 * direction, emits each as a dark-filled, paper-rimmed closed polygon, and
 * splices a seeded set of `discColor`-filled occluder discs into the draw order
 * at their own seeded depths (see the file header's occluder rationale); the
 * built Scene carries `backgroundColor` as its declared background (ADR-0009).
 * No accumulated state — re-calling with the same `(params, seed, t)`
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
    const leafWidthMin = numberParam(params, schema, 'leafWidthMin')
    const leafWidthMax = numberParam(params, schema, 'leafWidthMax')
    const pointinessMin = numberParam(params, schema, 'pointinessMin')
    const pointinessMax = numberParam(params, schema, 'pointinessMax')
    const fieldScale = numberParam(params, schema, 'fieldScale')
    const turbulence = numberParam(params, schema, 'turbulence')
    const octaves = numberParam(params, schema, 'octaves')
    const variation = numberParam(params, schema, 'variation')
    const sphereCount = numberParam(params, schema, 'sphereCount')

    // The two color knobs (ADR-0010). They consume NO rng draws — backgroundColor
    // feeds only the Scene's `background` (ADR-0009) and discColor only the disc
    // fills — so every leaf and disc outline stays byte-identical across any
    // color value (the determinism seam holds untouched).
    const backgroundColor = colorParam(params, schema, 'backgroundColor')
    const discColor = colorParam(params, schema, 'discColor')

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

    // The Sketch-declared background (ADR-0009): the whole output surface,
    // letterbox included, painted from the `backgroundColor` knob — part of the
    // image, so it rides the (params, seed) determinism spine rather than being
    // a caller-side Render Setting.
    const builder = createScene(
      { width: WIDTH, height: HEIGHT },
      { color: backgroundColor },
    )

    // Splice the opaque occluder discs into the painter's order at the GLOBAL
    // depth index: the top/back leaves (drawn first) fall UNDER them and are
    // occluded where they cross a disc — the disc's true circular silhouette reads
    // as a hard, genuinely round edge on the sphere's far side — while the
    // bottom/front leaves (drawn after) lap OVER the near side for organic tip
    // breakup. `Math.round(sphereDepth · N)` maps depth 0 → behind all leaves
    // (max front overlap) and depth 1 → in front of all (clean round edge); every
    // disc shares this one index. Fill only (the `discColor` knob), no stroke: a
    // visible colored orb at the defaults (white on mid gray), pure figure-ground
    // when discColor == backgroundColor.
    const drawDisc = (sphere: { cx: number; cy: number; r: number }): void => {
      builder.addPath(circle(sphere.cx, sphere.cy, sphere.r), {
        closed: true,
        fill: { color: discColor },
      })
    }

    // PER-DISC, POSITION-RELATIVE DEPTH (2026-07-06): a single global splice index
    // made `sphereDepth` mean DIFFERENT things at different canvas heights. The
    // field draws top-of-canvas first (ascending y), so one index is one y
    // threshold across the WHOLE canvas — at any fixed value the low discs came out
    // buried (their overlapping leaves paint late/in-front) while the high discs
    // floated with a clean edge, or vice-versa. There was no value that read the
    // same top and bottom. So each disc now gets its OWN splice index from a
    // threshold anchored to ITS center and radius, and the knob reads as a
    // CONSISTENT depth wherever the disc sits.
    //
    // The band is the disc's own overlap zone padded by half the max leaf length
    // (the farthest a leaf CENTER can sit from the disc edge and still cross it):
    // [cy − r − margin, cy + r + margin]. sphereDepth 0 drops the threshold BELOW
    // that band ⇒ every overlapping leaf draws AFTER ⇒ disc sits behind all of them
    // (max front overlap, embedded); sphereDepth 1 lifts it ABOVE ⇒ every
    // overlapping leaf draws BEFORE ⇒ disc sits in front (clean round edge); 0.5
    // splits the band at the disc's center. Points are y-sorted, so the count of
    // points below the threshold IS that disc's splice index. Still a knob, not an
    // rng roll — it touches only these indices, leaving every cx/cy/r and every
    // leaf byte-identical.
    const depthMargin = leafSizeMax / 2
    const placedSpheres = spheres.map((sphere) => {
      const thresholdY = lerp(
        sphere.cy - sphere.r - depthMargin,
        sphere.cy + sphere.r + depthMargin,
        sphereDepth,
      )
      let spliceIdx = 0
      while (spliceIdx < points.length && (points[spliceIdx]?.[1] ?? Infinity) < thresholdY) {
        spliceIdx++
      }
      return { ...sphere, spliceIdx }
    })

    // Sampler order IS painter's order: index 0 is drawn first (bottom). Each
    // leaf is rotated by its own flow angle, so the bbox center is no longer a
    // loop invariant (the #126 hoist is superseded) — compute it per-leaf after
    // rotation.
    points.forEach(([x, y], i) => {
      for (const sphere of placedSpheres) if (sphere.spliceIdx === i) drawDisc(sphere)
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

      // Roll this leaf's shape from `rng`. CRUCIAL: roll all five (length, curl,
      // wobble, tipSharpness, widthRatio) UNCONDITIONALLY and in a fixed order —
      // the rng-consumption COUNT per leaf must stay constant regardless of knob
      // values so the deterministic seam holds and changing a knob reshapes the
      // field without desyncing the sequence. Length draws uniformly across the
      // full [leafSizeMin, leafSizeMax] range so leaves genuinely differ in size,
      // tipSharpness draws uniformly across [pointinessMin, pointinessMax] so tip
      // pointiness varies per leaf, and widthRatio draws uniformly across
      // [leafWidthMin, leafWidthMax] so width (as a fraction of length) varies per
      // leaf — size, pointiness, and width variation are each owned by their own
      // range (set any pair equal for a uniform field). `variation` governs only
      // the curl/wobble shape strays, which collapse to the fixed base (FIXED curl
      // / zero wobble) at variation 0 while still consuming their draws. The
      // tipSharpness and widthRatio draws are APPENDED LAST (in that order) so the
      // pre-existing length/curl/wobble order is untouched; widthRatio is the last
      // per-leaf roll.
      const length = rng.range(leafSizeMin, leafSizeMax)
      const curlAmount = FIXED_CURL + rng.gaussian(0, CURL_JITTER_STD) * variation
      const wobble = MAX_WOBBLE * variation * rng.value()
      const tipSharpness = rng.range(pointinessMin, pointinessMax)
      const widthRatio = rng.range(leafWidthMin, leafWidthMax)
      const shape: LeafShape = {
        length,
        width: length * widthRatio,
        curl: curlAmount,
        wobble,
        tipSharpness,
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

    // A disc whose threshold cleared the last leaf (spliceIdx === N — its whole
    // padded band sits at/above the bottom of the field) never fired in the loop,
    // so draw it on top of all leaves here.
    for (const sphere of placedSpheres) {
      if (sphere.spliceIdx >= points.length) drawDisc(sphere)
    }

    return builder.build()
  },
}
