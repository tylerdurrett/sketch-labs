import { cubic } from '../../geometry'
import { clamp } from '../../math'
import type { Point, Polyline, Random } from '../../types'

/**
 * Shape knobs for a single parametric leaf.
 *
 * MODULE-PRIVATE: this interface is intentionally NOT re-exported from
 * packages/core/src/index.ts. The leaf domain type must never cross the
 * public barrel / draw boundary — the single-leaf Sketch (task 2) consumes
 * {@link leaf} via a relative import and keeps the type local.
 */
export interface LeafShape {
  /** Length of the leaf along its spine (before curl bends it). */
  length: number
  /** Maximum width of the leaf across the spine. */
  width: number
  /**
   * Sideways bend of the spine, as a fraction of length.
   * 0 = straight; positive curls toward +x, negative toward -x.
   */
  curl: number
  /** Amplitude of seeded per-vertex jitter along the outline. */
  wobble: number
  /**
   * Apex shape in [0, 1]. Higher values pull the flanks' control points
   * toward the tip, producing a sharper, more pointed apex; lower values
   * give a rounder, blunter tip.
   */
  tipSharpness: number
}

/** Number of segments per flank Bezier — even, smooth silhouette. */
const FLANK_SEGMENTS = 48

/**
 * Position along the spine at parameter t in [0, 1].
 *
 * The base sits at the origin and the tip at (curlOffset, length). Curl bends
 * the spine sideways following a smooth (t^2) profile so the base stays anchored
 * and the deflection accumulates toward the tip.
 */
function spineAt(t: number, length: number, curlOffset: number): Point {
  return [curlOffset * t * t, length * t]
}

/**
 * Build a single CLOSED leaf outline from shape knobs and a seeded Random.
 *
 * The silhouette is traced base → right flank → apex → left flank → back to
 * base as one continuous closed Polyline (last point === first). Each flank is
 * a cubic Bezier bulging out to `width / 2` at mid-spine and converging on the
 * tip; `tipSharpness` slides the upper control point toward the apex to sharpen
 * it. `curl` bends the spine sideways, and `wobble` adds seeded gaussian jitter
 * to every non-anchor vertex so re-seeding varies texture while gross
 * proportions hold.
 *
 * ALL randomness flows through the passed {@link Random} — no Math.random.
 */
export function leaf(shape: LeafShape, rng: Random): Polyline {
  const { length, width, curl, wobble, tipSharpness } = shape

  const halfWidth = width / 2
  const curlOffset = curl * length
  const sharpness = clamp(tipSharpness, 0, 1)

  const base = spineAt(0, length, curlOffset)
  const apex = spineAt(1, length, curlOffset)

  // Control points for the right flank (base -> apex, bulging toward +x).
  // Lower control sits near the widest belly; the upper control slides toward
  // the apex as tipSharpness grows, pinching the tip.
  const bellyY = length * 0.35
  const shoulderY = length * (0.55 + 0.35 * sharpness)

  // Each flank's control points are offset SYMMETRICALLY about the (curled)
  // spine at their own height — `spineAt` gives the spine's sideways position
  // there. Anchoring to the spine (rather than to x = 0) keeps both flanks'
  // upper controls on their own side of the apex, so they converge on the tip
  // from opposite sides instead of crossing over it. The old formula offset the
  // left control by `2 * curlOffset`, which overshot the curled apex and made
  // the flanks cross — hooking a little loop onto the tip.
  const bellySpineX = spineAt(bellyY / length, length, curlOffset)[0]
  const shoulderSpineX = spineAt(shoulderY / length, length, curlOffset)[0]

  // Sideways pinch of the tip controls toward the spine; a higher tipSharpness
  // pinches harder (smaller offset) for a sharper, more pointed apex.
  const tipHalfWidth = halfWidth * (1 - sharpness) * 0.6

  const rightLower: Point = [bellySpineX + halfWidth, bellyY]
  const rightUpper: Point = [shoulderSpineX + tipHalfWidth, shoulderY]
  const rightFlank = cubic(base, rightLower, rightUpper, apex, FLANK_SEGMENTS)

  // Left flank mirrors the right about the spine, apex -> base.
  const leftUpper: Point = [shoulderSpineX - tipHalfWidth, shoulderY]
  const leftLower: Point = [bellySpineX - halfWidth, bellyY]
  const leftFlank = cubic(apex, leftUpper, leftLower, base, FLANK_SEGMENTS)

  // Stitch flanks into one ring, dropping the duplicated apex vertex shared
  // between the two cubics; the base is re-appended explicitly to close.
  const ring: Polyline = [...rightFlank, ...leftFlank.slice(1)]

  // Seeded per-vertex wobble. The base (first vertex) is left un-jittered so
  // the closing point can match it exactly; every other vertex gets gaussian
  // jitter scaled by `wobble`, keyed by index so it is deterministic per seed.
  const out: Polyline = ring.map(([x, y], i) => {
    if (i === 0) return [x, y]
    const jx = rng.gaussian(0, wobble)
    const jy = rng.gaussian(0, wobble)
    return [x + jx, y + jy]
  })

  // Explicitly close the polyline (last point === first).
  const first = out[0]!
  out[out.length - 1] = [first[0], first[1]]

  return out
}
