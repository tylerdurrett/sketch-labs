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
 * seeded {@link LeafShape} at every sampled point, rotates each so its spine
 * aligns with the local flow direction, and draws them into a painter's-order
 * Scene — earlier points sit
 * under later ones, so the overlap reads as a real composited field, not a flat
 * stamp sheet.
 *
 * ALL NINETEEN KNOBS LIVE: the field and shape controls complete scatter,
 * placement, flow-field orientation, per-leaf variation, and compositing. Four
 * sphere knobs (`sphereCount`, `sphereRadiusMin`, `sphereRadiusMax`,
 * `sphereDepth`) drive the occluder discs (below). Five color knobs own the scene
 * and primitive styling (ADR-0010), and `fieldPhase` scrubs around the seamless
 * 4D flow loop. `density` drives spacing;
 * `fieldScale` (curl base frequency, in features across the canvas),
 * `octaves` (how many noise layers stack) and `turbulence` (curl octave falloff
 * → fbm `gain`) shape the flow each leaf bends into. `leafScale` and its
 * variance define a centered length range; `leafSlenderness` and its variance
 * define a centered length-to-width ratio (higher is skinnier). Tip pointiness
 * is fixed at the former blunt default, while `variation` scales how far each
 * leaf's curl and broad contour wobble stray from the fixed base — at
 * `variation` 0 the curl/wobble collapse back to
 * that base, so the knob is live.
 *
 * FLOW COHERENCE (2026-07-02): `fieldScale` samples the curl field over
 * CANVAS-NORMALIZED coordinates (x/WIDTH, y/HEIGHT), so the knob reads directly
 * as "how many noise features span the canvas" — a value near 1–2 gives a
 * smooth, current-like sweep, not the near-random per-leaf scatter you get when
 * the base frequency runs into the tens. Fewer `octaves` keeps the field's broad
 * shape from dissolving into fine turbulence.
 *
 * LOOP-READY FLOW (2026-07-10): rather than moving linearly through a 3D noise
 * z-axis, the flow samples a circle in the final two coordinates of 4D simplex
 * noise. `fieldPhase` selects the normalized position around that circle;
 * prepared-frame time advances it over a named loop duration. Returning to
 * phase 0 returns to identical 4D coordinates, so future time metadata can
 * animate a seamless loop without changing the field contract. The Sketch
 * remains static today: it still declares no `time` metadata.
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
 * original implied-sphere figure-ground survives as the OPT-IN SPECIAL CASE
 * `discColor === discStrokeColor === backgroundColor` (set all three knobs to
 * the same color; no shipped preset pins it). Each disc is spliced into the
 * painter's order at a DEPTH index driven by the global `sphereDepth` knob. Leaves drawn
 * BEFORE it (top/back of the field) are painted over where they cross it, so the
 * disc's TRUE circular silhouette cuts a hard, genuinely round edge on the
 * sphere's FAR side; leaves drawn AFTER it (bottom/front) lap OVER its near side,
 * breaking that edge into organic leaf tips. Roundness comes from the real
 * circle; organic-ness comes from the front leaves; the eye fuses the two into an
 * implied sphere. Each disc is a closed polyline from the shared {@link circle}
 * helper with a `discStrokeColor` outline. #141 turns the single hardcoded disc
 * into a SEEDED SET of N discs driven by three knobs: `sphereCount` (how many — default
 * 6, from the "Nice One" preset, so the field ships with the full implied-sphere
 * set; drop to 0 for a plain field),
 * `sphereRadiusMin`/`sphereRadiusMax` (per-disc radius bounds, in coordinate
 * units — superseding the old radius-fraction constants). Each disc's radius is
 * seeded per sphere; its center is derived from the seeded curl field
 * (with the sphere stream breaking equal scores — see below). #142 makes the
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
 * VORTEX-AWARE PLACEMENT (2026-07-10): sphere centers are landmarks of the flow,
 * not an independent uniform scatter. The curl vector is the scalar fBm
 * potential's gradient rotated 90°, so it follows that potential's contour
 * lines. A round local hill or basin therefore produces the visible circulation
 * around a center. For each seeded radius, the private placement helper searches
 * radius-inset canvas candidates and scores high center-to-rim contrast, a
 * low-variance rim, and a rim consistently above or below the center. Those
 * terms penalize slopes, stretched turbulence, and saddles without requiring
 * every exact-count fallback to be a mathematical critical point. It refines
 * the best candidates below grid resolution, prefers separated centers with
 * deterministic relaxation, and always returns exactly `sphereCount`.
 * `fieldPhase` re-prepares those centers against its own field slice. Within one
 * prepared `(t) => Scene` sampler they stay anchored at its t=0 phase so future
 * animation cannot pop as best-candidate rankings change; only leaf orientation
 * advances with `t`.
 *
 * DRAW BOUNDARY (load-bearing): only generic {@link Primitive}s cross into the
 * Scene. The leaf domain type ({@link LeafShape}) is reached ONLY through the
 * relative `../single-leaf/leaf` import below and never re-exported, so it stays
 * private and never leaks across the public barrel / draw boundary.
 *
 * STATIC / DETERMINISTIC: there is no `time` metadata (the Harness hides the
 * scrubber), and `generate` is a pure function of `(params, seed, t)`. `t` is
 * threaded LIVE into the normalized phase around the 4D flow loop (ADR-0002),
 * so animating later is a metadata swap, not a rewrite; with no `time` metadata
 * t is 0 in practice, so the field is a static phase today. Everything random
 * flows from the explicit Seed via `createRandom` / the sampler's seed: NO
 * `Math.random`, no clock read, and no state carried across `generate` calls.
 * Re-seeding reshuffles the whole field while the params hold. The five color
 * knobs consume NO rng draws from either stream — they touch only fill/stroke
 * colors and the Scene's `background` — so every leaf outline and disc
 * silhouette stays byte-identical at any color value. The "Nice One" preset
 * pins all five color knobs EXPLICITLY (the shipped gray/white/dark/paper palette,
 * 2026-07-07) and pins `fieldPhase` at 0 so its image stays stable against future
 * default changes instead of silently tracking them; the original white-on-white
 * capture is recoverable by setting both color knobs white.
 *
 * CALLER-OWNED PREPARATION (2026-07-09): this Sketch splits its stateless frame
 * logic at the real time boundary. `prepare(params, seed)` derives one immutable
 * layout — Poisson scatter, painter order, sphere placement, seeded leaf shapes,
 * and unrotated silhouettes — then returns a pure `(t) → Scene` sampler that only
 * evaluates curl orientation and transforms fresh Scene-owned point arrays. The
 * Harness may retain that sampler while `(params, seed)` hold; the Sketch retains
 * no hidden cache. `definePreparedSketch` derives the public cold `generate` from
 * the same implementation, so exploration, Remotion, and export cannot drift.
 *
 * SPHERE STREAM OFF THE LEAF SEQUENCE (2026-07-03 audit, placement widened
 * 2026-07-10): every sphere consumes a FIXED three draws from the separate
 * `createRandom(`${seed}-sphere`)` stream: two candidate tie-break coordinates,
 * then its radius. Actual centers come from the seeded field search above; the
 * first two draws preserve deterministic entropy and the historical three-draw
 * prefix without pretending to be positions. No sphere roll is interleaved with
 * the per-leaf loop, so raising `sphereCount` cannot shift a leaf. Splice depth
 * is still derived solely from `sphereDepth` and each selected cy/r; changing
 * depth leaves every disc geometry and leaf byte-identical.
 *
 * PAPER-RIM DEFAULT RATIONALE (2026-07-01 audit): a matching dark stroke would
 * make the painter's-order overlap visually unobservable — adjacent dark leaves
 * merge into one shape and the layering is invisible. So each leaf keeps the
 * bold dark FILL (linocut idiom, initiative #3) but carries a paper-colored
 * (light) STROKE, giving every overlap a light separating rim so the draw order
 * reads live. `leafColor` and `leafStrokeColor` now make both choices tunable
 * while preserving that palette as the default.
 */

import { prepareCurlAngle4D } from '../../curl'
import { prepareFbm4D } from '../../fbm'
import { circle } from '../../geometry'
import { lerp } from '../../math'
import { samplePoissonDisk } from '../../poisson'
import { createRandom } from '../../random'
import { createScene } from '../../scene'
import type { Scene } from '../../scene'
import {
  definePreparedSketch,
  type Params,
  type ParamSpec,
  type Seed,
} from '../../sketch'
import type { Polyline } from '../../types'
import { colorParam, HEIGHT, numberParam, WIDTH } from '../sketch-util'
import { leaf } from '../single-leaf/leaf'
import type { LeafShape } from '../single-leaf/leaf'
import { placeSpheresAtVortices } from './vortex-placement'

/**
 * The leaf-field Parameter Schema — nineteen knobs (fourteen numeric, five
 * color), all consumed NOW. Declaration order is the Studio control order:
 * phase first, field/shape controls, sphere controls, then colors with each
 * object's fill and stroke adjacent. `satisfies`
 * keeps the literal key set (so `numberParam`/`colorParam` can filter
 * `keyof typeof schema` by each spec's literal `kind`) while enforcing the spec
 * type — the target is the full `ParamSpec` union now that the kinds mix.
 */
const schema = {
  /** Normalized position around the seamless 4D flow-field loop. Consumed NOW. */
  fieldPhase: { kind: 'number', min: 0, max: 1, default: 0, step: 0.001 },
  /**
   * Curl-field base frequency, in noise features across the canvas (the sampled
   * coords are canvas-normalized). A tight range with a low default: the flow
   * stays coherent near 1–2 and the low end is where the fine control lives —
   * higher values start to look random. Consumed NOW (flow orientation).
   */
  fieldScale: { kind: 'number', min: 0.05, max: 4, default: 0.75, step: 0.05 },
  /** Curl-field roughness — mapped to fBm's per-octave amplitude multiplier (`gain`); values above 1 make finer octaves progressively stronger. Consumed NOW. */
  turbulence: { kind: 'number', min: 0.1, max: 3, default: 0.1536 },
  /** Number of noise layers stacked into the flow field (fbm `octaves`); fewer = broader, less turbulent. Consumed NOW. */
  octaves: { kind: 'number', min: 1, max: 6, default: 2, step: 1, integer: true },
  /** Drives the Poisson spacing radius (radius = REFERENCE_SPACING / density). Consumed NOW. */
  density: { kind: 'number', min: 1, max: 80, default: 18.696 },
  /** Midpoint of the per-leaf length range, in coordinate-space units. Consumed NOW. */
  leafScale: { kind: 'number', min: 10, max: 400, default: 57.3 },
  /** Symmetric ± spread around `leafScale`; zero makes every leaf the same size. Consumed NOW. */
  leafSizeVariance: { kind: 'number', min: 0, max: 200, default: 7.3 },
  /** Midpoint length-to-width ratio. Higher values make leaves longer and skinnier. Consumed NOW. */
  leafSlenderness: { kind: 'number', min: 0.5, max: 6.5, default: 1.435, step: 0.05 },
  /** Symmetric ± spread around `leafSlenderness`; zero gives uniform proportions. Consumed NOW. */
  leafSlendernessVariance: { kind: 'number', min: 0, max: 3, default: 0.565, step: 0.05 },
  /** Per-leaf shape variation — scales curl and broad, correlated contour roughness. Consumed NOW. */
  variation: { kind: 'number', min: 0, max: 1, default: 0 },
  /**
   * How many implied-sphere occluder discs to place at the field's strongest
   * round vortex centers. Each radius and equal-score tie-break comes from the
   * dedicated sphere rng stream (OFF the per-leaf rolls), so raising this cannot
   * shift a leaf. The min is 0 (a plain leaf field with no implied spheres); the
   * default is 6 (the "Nice One" preset), so the field ships with the full set.
   * Consumed NOW (sphere-set count). Appended last (#141).
   */
  sphereCount: { kind: 'number', min: 0, max: 25, default: 6, step: 1, integer: true },
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
   * an opt-in param choice now (set the background, disc fill, and disc stroke
   * to the same color). Consumed NOW.
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
  /**
   * Disc outline color. Defaults to white to blend into the white disc fill.
   * Consumed NOW.
   */
  discStrokeColor: { kind: 'color', default: '#ffffff' },
  /** Leaf fill color. Defaults to the original bold dark linocut fill. Consumed NOW. */
  leafColor: { kind: 'color', default: '#1a1a1a' },
  /** Leaf outline color. Defaults to the paper-colored separating rim. Consumed NOW. */
  leafStrokeColor: { kind: 'color', default: '#f4f1ea' },
} satisfies Record<string, ParamSpec>

/** Poisson spacing radius at density 1; `radius = REFERENCE_SPACING / density`. */
const REFERENCE_SPACING = 400

/** Future animation duration for one complete traversal of the 4D loop. */
const FIELD_LOOP_DURATION_SECONDS = 12

/**
 * Radius of the circular path through 4D noise space. One noise-space unit
 * yields clear evolution over a revolution while remaining smooth under the
 * fieldPhase knob's fine step.
 */
const FIELD_LOOP_RADIUS = 1

/** Wrap any finite phase into [0, 1); degrade invalid caller time/params safely. */
function wrapUnitPhase(phase: number): number {
  return Number.isFinite(phase) ? phase - Math.floor(phase) : 0
}

/** Map a normalized loop phase to the final two coordinates of 4D noise. */
function loopCoordinatesAt(phase: number): readonly [number, number] {
  const angle = wrapUnitPhase(phase) * 2 * Math.PI
  return [
    FIELD_LOOP_RADIUS * Math.cos(angle),
    FIELD_LOOP_RADIUS * Math.sin(angle),
  ]
}

// Base shape constants. Leaf scale and slenderness each draw from their own
// centered ±variance range, independently of `variation`; pointiness stays at
// the former blunt default. Curl and wobble stray from their bases by
// seeded amounts scaled by `variation`; at `variation` 0 they collapse to the
// fixed base (base curl, zero wobble).
const FIXED_CURL = 0.12

/** Std-dev of the seeded per-leaf curl jitter (radians of bend), scaled by `variation`. */
const CURL_JITTER_STD = 0.15

/** Max seeded per-leaf wobble amplitude at `variation` 1; the base (variation 0) is 0. */
const MAX_WOBBLE = 6

/** Stroke width of each leaf's paper rim, in coordinate-space units. */
const LEAF_STROKE_WIDTH = 2

/** Stroke width of each disc outline, in coordinate-space units. */
const DISC_STROKE_WIDTH = 2

// The disc fill is the `discColor` knob (read in `generate`), which superseded
// the old hardwired DISC_FILL = 'white' constant. See the file header's occluder
// rationale: at the defaults (white on mid gray) the disc is a visible colored
// orb; setting discColor === discStrokeColor === backgroundColor makes it
// invisible as an object — the original implied-sphere figure-ground.

/**
 * Translate a newly-created leaf outline by a fixed `(dx, dy)` offset in place.
 *
 * The {@link leaf} generator grows from the origin (0, 0) along +y with signed
 * ±x spread, so a raw outline is anchored at the origin, not at the sampled
 * point. Centering works by computing the bbox-center-to-target offset, then
 * translating the (already-rotated) outline so its center lands on the sampled
 * point.
 */
function translateInPlace(outline: Polyline, dx: number, dy: number): void {
  for (const point of outline) {
    point[0] += dx
    point[1] += dy
  }
}

/**
 * Copy and rotate a prepared leaf outline by `angle` radians about the origin
 * while measuring the rotated bounds in the same pass.
 *
 * The prepared outline remains immutable and private to its caller-owned sampler;
 * the returned copy belongs to one Scene and may be translated in place. Combining
 * copying, rotation, and bounds measurement avoids the old rotate-array + bbox
 * passes while preserving their arithmetic and point order exactly.
 */
function copyRotateAndMeasure(
  outline: Polyline,
  angle: number,
): {
  rotated: Polyline
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const rotated: Polyline = new Array(outline.length)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (let i = 0; i < outline.length; i++) {
    const [x, y] = outline[i]!
    const rotatedX = x * cos - y * sin
    const rotatedY = x * sin + y * cos
    rotated[i] = [rotatedX, rotatedY]

    if (rotatedX < minX) minX = rotatedX
    if (rotatedX > maxX) maxX = rotatedX
    if (rotatedY < minY) minY = rotatedY
    if (rotatedY > maxY) maxY = rotatedY
  }

  return { rotated, minX, minY, maxX, maxY }
}

/**
 * The leaf-field Sketch: a static, stateless field of seeded-variant leaves,
 * oriented along a seeded curl-noise flow field, over a param-colored
 * background, with a seeded set of opaque `discColor`-filled occluder discs —
 * visible colored orbs at the defaults (white on mid gray), implied spheres
 * when disc and background colors match.
 *
 * `generate` reads the spacing/size/field/variation knobs plus the five color
 * knobs, blue-noise-samples the coordinate space, rolls a seeded
 * {@link LeafShape} at every sampled point (in sorted ascending-y order — that
 * IS painter's order), rotates each so its spine tracks the local flow
 * direction, emits each as a param-colored, param-rimmed closed polygon, and
 * splices a seeded set of `discColor`-filled occluder discs into the draw order
 * at their own seeded depths (see the file header's occluder rationale); the
 * built Scene carries `backgroundColor` as its declared background (ADR-0009).
 * No accumulated state — re-calling with the same `(params, seed, t)`
 * reproduces the same Scene exactly.
 */
export const leafField = definePreparedSketch({
  id: 'leaf-field',
  name: 'Leaf Field',
  schema,
  space: { width: WIDTH, height: HEIGHT },
  // NO `time` metadata ⇒ ships static (single frame, scrubber hidden).
  prepare(params: Params, seed: Seed) {
    // Shared seeded Random. It drives the per-leaf shape rolls (size, curl,
    // wobble) AND is threaded into `leaf()` for its broad contour roughness. It
    // ALSO seeds the curl field via its (separate, non-advancing) noise
    // instances — sampling curl does not consume value()/gaussian() draws, so
    // the placement/shape roll sequence stays untouched by orientation.
    const rng = createRandom(seed)

    const density = numberParam(params, schema, 'density')
    const leafScale = numberParam(params, schema, 'leafScale')
    const leafSizeVariance = numberParam(params, schema, 'leafSizeVariance')
    const leafSlenderness = numberParam(params, schema, 'leafSlenderness')
    const leafSlendernessVariance = numberParam(
      params,
      schema,
      'leafSlendernessVariance',
    )
    const fieldScale = numberParam(params, schema, 'fieldScale')
    const turbulence = numberParam(params, schema, 'turbulence')
    const octaves = numberParam(params, schema, 'octaves')
    const variation = numberParam(params, schema, 'variation')
    const sphereCount = numberParam(params, schema, 'sphereCount')

    // Color knobs consume NO rng draws: they affect only Scene styling, so every
    // leaf and disc outline stays byte-identical across any color value.
    const backgroundColor = colorParam(params, schema, 'backgroundColor')
    const discColor = colorParam(params, schema, 'discColor')
    const fieldPhase = numberParam(params, schema, 'fieldPhase')
    const leafColor = colorParam(params, schema, 'leafColor')
    const leafStrokeColor = colorParam(params, schema, 'leafStrokeColor')
    const discStrokeColor = colorParam(params, schema, 'discStrokeColor')

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

    // The sphere set keeps its SEPARATE, dedicated rng stream (keyed off the
    // seed), so its radius and tie-break rolls stay OFF the per-leaf sequence.
    // Center rolls now act only as deterministic tie-break anchors: the actual
    // centers are selected from the strongest circular-coherence candidates in
    // the same scalar potential whose rotated gradient orients the leaves.
    const sphereRng = createRandom(`${seed}-sphere`)
    const sphereRequests = Array.from({ length: sphereCount }, () => {
      const tieBreaker = [sphereRng.value(), sphereRng.value()] as const
      const radius = sphereRng.range(sphereRadiusMin, sphereRadiusMax)
      return { radius, tieBreaker }
    })

    // Sphere placement is prepared at the public fieldPhase (the returned time
    // sampler's t=0 field). Curl follows level contours of this scalar potential,
    // so round hills/basins strongly identify the visible vortex centers.
    // The chosen centers remain fixed inside this prepared sampler: fieldPhase
    // changes deliberately re-place them, while future per-frame time cannot
    // trigger best-candidate switching or visual popping.
    const noise4D = rng.noise4D
    const potential4D = prepareFbm4D(noise4D, {
      gain: turbulence,
      octaves,
    })
    const [placementZ, placementW] = loopCoordinatesAt(fieldPhase)
    const spheres = placeSpheresAtVortices(
      (x, y) =>
        potential4D(
          (x / WIDTH) * fieldScale,
          (y / HEIGHT) * fieldScale,
          placementZ,
          placementW,
        ),
      WIDTH,
      HEIGHT,
      sphereRequests,
    )

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
    // every leaf still consumes the same fixed draw sequence, so the deterministic
    // seam holds (a copy is sorted — the sampler output is not mutated).
    const points = [...sampled].sort(([ax, ay], [bx, by]) => ay - by || ax - bx)

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
    const depthMargin = (leafScale + leafSizeVariance) / 2
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

    // Prepare the time-invariant leaf layout once for this `(params, seed)` pair.
    // Sampler order IS painter's order: index 0 is drawn first (bottom). Curl
    // sampling never advances the main PRNG, so moving these shape rolls ahead of
    // the per-`t` flow sampling preserves the exact historical draw sequence.
    const leaves = points.map(([x, y]) => {
      // Roll this leaf's shape from `rng`. CRUCIAL: roll all four values (length,
      // curl, wobble, slenderness) UNCONDITIONALLY and in a fixed order —
      // the rng-consumption COUNT per leaf must stay constant regardless of knob
      // values so the deterministic seam holds and changing a knob reshapes the
      // field without desyncing the sequence. Length draws uniformly across the
      // centered scale range so leaves genuinely differ in size, and slenderness
      // draws across its own centered range. `variation` governs only
      // the curl/wobble shape strays, which collapse to the fixed base (FIXED curl
      // / zero wobble) at variation 0 while still consuming their draws.
      const length = rng.range(
        Math.max(1, leafScale - leafSizeVariance),
        leafScale + leafSizeVariance,
      )
      const curlAmount = FIXED_CURL + rng.gaussian(0, CURL_JITTER_STD) * variation
      const wobble = MAX_WOBBLE * variation * rng.value()
      const slenderness = rng.range(
        Math.max(0.1, leafSlenderness - leafSlendernessVariance),
        leafSlenderness + leafSlendernessVariance,
      )
      const shape: LeafShape = {
        length,
        width: length / slenderness,
        curl: curlAmount,
        wobble,
        tipSharpness: 0,
      }

      // The unrotated silhouette depends only on params/seed. It stays private to
      // this caller-owned prepared sampler; every sampled Scene receives newly
      // transformed point arrays, so mutating one returned Scene cannot corrupt a
      // later frame.
      return { x, y, outline: leaf(shape, rng) }
    })
    // Retain only the pure noise sampler for warm frames, not the Random whose
    // value()/gaussian() stream was advanced during preparation. This makes the
    // prepared layout's no-accumulated-state boundary explicit.
    const flowAngleAt = prepareCurlAngle4D(noise4D, {
      gain: turbulence,
      octaves,
    })

    return (t: number): Scene => {
      // Trace a circle through the final two dimensions of 4D noise. Both the
      // public phase and future time can cross either boundary; wrapping keeps
      // negative/large values stable and makes phase 0 === phase 1 exactly.
      const phase = wrapUnitPhase(
        wrapUnitPhase(fieldPhase) + wrapUnitPhase(t / FIELD_LOOP_DURATION_SECONDS),
      )
      const [loopZ, loopW] = loopCoordinatesAt(phase)

      // The Sketch-declared background (ADR-0009): the whole output surface,
      // letterbox included, painted from the `backgroundColor` knob — part of the
      // image, so it rides the (params, seed) determinism spine.
      const builder = createScene(
        { width: WIDTH, height: HEIGHT },
        { color: backgroundColor },
      )

      // Discs are rebuilt into fresh Scene-owned point arrays on every sample.
      const drawDisc = (sphere: { cx: number; cy: number; r: number }): void => {
        builder.addPath(circle(sphere.cx, sphere.cy, sphere.r), {
          closed: true,
          fill: { color: discColor },
          stroke: { color: discStrokeColor, width: DISC_STROKE_WIDTH },
        })
      }

      // Each leaf samples only the time-dependent curl direction here. Shape,
      // scatter, painter order, and sphere placement were prepared above.
      leaves.forEach(({ x, y, outline }, i) => {
        for (const sphere of placedSpheres) if (sphere.spliceIdx === i) drawDisc(sphere)

        // Sample the divergence-free x/y flow at this point while the final two
        // 4D coordinates travel around the loop. Canvas-normalized coordinates
        // make fieldScale read as features across the canvas; octaves/turbulence
        // shape the fBm stack.
        const angle = flowAngleAt(
          (x / WIDTH) * fieldScale,
          (y / HEIGHT) * fieldScale,
          loopZ,
          loopW,
        )

        // Copy the immutable prepared outline into Scene-owned points while
        // rotating and measuring it in one pass, then center it in place.
        const { rotated, minX, minY, maxX, maxY } = copyRotateAndMeasure(
          outline,
          angle - Math.PI / 2,
        )
        const centerX = (minX + maxX) / 2
        const centerY = (minY + maxY) / 2
        translateInPlace(rotated, x - centerX, y - centerY)

        builder.addPath(rotated, {
          closed: true,
          fill: { color: leafColor },
          stroke: { color: leafStrokeColor, width: LEAF_STROKE_WIDTH },
        })
      })

      // A disc whose threshold cleared the last leaf never fired in the loop, so
      // draw it on top of all leaves here.
      for (const sphere of placedSpheres) {
        if (sphere.spliceIdx >= leaves.length) drawDisc(sphere)
      }

      return builder.build()
    }
  },
})
