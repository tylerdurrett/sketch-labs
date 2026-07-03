import { createRandom } from './random'
import type { Point, Random } from './types'

/** A spatially-varying minimum-distance field: returns the min radius at (x, y). */
export type RadiusField = (x: number, y: number) => number

/**
 * Upper bound on redraws when hunting for an in-domain initial seed. Generous
 * enough that any non-pathological domain (one covering a non-trivial fraction
 * of the region) seeds on the first few tries, but finite so a vanishing/empty
 * domain terminates deterministically with `[]` instead of spinning forever.
 */
const MAX_SEED_ATTEMPTS = 10_000

export interface PoissonSampleOptions {
  /** Width of the region to fill. */
  width: number
  /** Height of the region to fill. */
  height: number
  /**
   * Minimum-distance field. For each point `(x, y)` it returns the minimum
   * distance that must separate that point from its neighbours. A constant
   * field (e.g. `() => 20`) yields uniform blue-noise.
   */
  radius: RadiusField
  /**
   * Lower bound on the values `radius` can return. Used to size the background
   * acceleration grid (cell size = `minRadius / √2`), which keeps the neighbour
   * check correct in the variable-radius case: with cells this small, every
   * point that could be closer than the local radius lands within a bounded
   * ring of grid cells. If omitted it is derived by probing the field, but
   * passing an accurate hint is cheaper and safer.
   */
  minRadius?: number
  /**
   * Optional geometric DOMAIN predicate: `(x, y) => boolean` returning `true`
   * for points that are allowed to land. Defaults to `() => true` (the whole
   * region). This is pure geometry — a domain is a spatial concept, so the
   * sampler stays ignorant of what the domain means (e.g. leaf-free clearings).
   *
   * It gates BOTH the initial seed (redrawn in a bounded loop until in-domain;
   * an empty domain yields `[]`) AND every candidate (alongside the bounds and
   * min-distance checks), so no accepted point ever falls outside the domain.
   * The seed-reseed loop consumes RNG draws in a fixed order, so determinism is
   * preserved regardless of the predicate.
   */
  accept?: (x: number, y: number) => boolean
  /** Candidate samples per active point before it is retired. Defaults to 30. */
  k?: number
  /** Seed for the RNG — a seed string/number, or an already-constructed Random. */
  seed?: string | number | Random
}

function isRandom(seed: PoissonSampleOptions['seed']): seed is Random {
  return typeof seed === 'object' && seed !== null && 'value' in seed
}

/**
 * Variable-radius Poisson-disk sampler (Bridson's algorithm), seeded.
 *
 * Fills a `width × height` region with blue-noise points whose local spacing is
 * governed by the `radius` field, and returns them as `Point[]`. This is a pure
 * geometry routine — it knows nothing about scenes, primitives, or leaves.
 *
 * An optional `accept` DOMAIN predicate restricts where points may land (see
 * {@link PoissonSampleOptions.accept}); by default the domain is the whole
 * region. It is pure geometry too — the sampler does not know what the domain
 * represents.
 *
 * All randomness flows from a {@link Random} instance (via `createRandom`); there
 * is no `Math.random`. RNG consumption order is fixed by deterministic iteration
 * (the active point is chosen with `rangeFloor` over the active list, and each of
 * the `k` candidates is generated in a fixed order), so the same
 * `(seed, width, height, radius, k)` always produces an identical array — same
 * count, order, and coordinates. Changing the seed (with the region and field
 * held) yields a different point set.
 *
 * PINNED pairwise acceptance rule (variable-radius): a candidate `c` is rejected
 * against an existing point `p` when `dist(c, p) < max(radius(c), radius(p))`.
 * This is the symmetric, conservative choice — it honours BOTH points' fields, so
 * neither a sparse region nor a dense region can be violated by the other. Under
 * a constant field the three plausible rules (candidate's radius, existing
 * point's radius, or their max) collapse to the same result; they diverge once
 * the field varies, so the rule is pinned here and covered by tests.
 */
export function samplePoissonDisk(options: PoissonSampleOptions): Point[] {
  const { width, height, radius, accept = () => true, k = 30 } = options
  const rng: Random = isRandom(options.seed)
    ? options.seed
    : createRandom(options.seed ?? 'poisson')

  if (width <= 0 || height <= 0) return []

  // Minimum radius the field can return, used only to size the grid.
  const minRadius = options.minRadius ?? deriveMinRadius(radius, width, height)
  if (!(minRadius > 0)) {
    throw new Error(
      `samplePoissonDisk: minRadius must be > 0 (got ${minRadius}). ` +
        'Ensure the radius field returns positive values or pass a minRadius hint.'
    )
  }

  // Background grid: cell size minRadius/√2 guarantees at most one point per cell.
  const cellSize = minRadius / Math.SQRT2
  const gridWidth = Math.ceil(width / cellSize)
  const gridHeight = Math.ceil(height / cellSize)
  // -1 = empty; otherwise an index into `points`.
  const grid: number[] = new Array(gridWidth * gridHeight).fill(-1)

  const points: Point[] = []
  const active: number[] = []
  // Largest radius any placed point imposes; grows the neighbour scan so a
  // sparse (large-radius) point can never be violated by a later dense candidate.
  let maxPlacedRadius = 0

  const gridIndex = (x: number, y: number): number => {
    const gx = Math.floor(x / cellSize)
    const gy = Math.floor(y / cellSize)
    return gy * gridWidth + gx
  }

  const addPoint = (p: Point): void => {
    const index = points.length
    points.push(p)
    // Backstop invariant: the acceleration grid holds at most one point per cell.
    // For a genuine lower bound this can never fire — the cell diagonal equals
    // minRadius and acceptance already requires separation >= minRadius — so an
    // occupied target cell means minRadius (probed or hinted) was NOT a true lower
    // bound. Assert here to convert a silent min-distance violation into a loud
    // failure. Compute the cell index once and reuse it for the check and write.
    const cell = gridIndex(p[0], p[1])
    if (grid[cell] !== -1) {
      throw new Error(
        'samplePoissonDisk: two accepted points fell in the same acceleration-grid ' +
          'cell, so minRadius was not a true lower bound of the radius field (it was ' +
          'overestimated, whether derived by probing or passed as a hint). The grid ' +
          'is sized from minRadius, so a too-large value makes cells coarse enough to ' +
          'hold two points, which would silently violate the min-distance guarantee. ' +
          "Pass an accurate `minRadius` hint that is <= the field's true minimum."
      )
    }
    grid[cell] = index
    active.push(index)
    const r = radius(p[0], p[1])
    if (r > maxPlacedRadius) maxPlacedRadius = r
  }

  // How many grid cells out we must scan so that no point within `r` is missed.
  const neighbourReach = (r: number): number => Math.ceil(r / cellSize)

  /** True if `candidate` respects the pinned min-distance rule against all neighbours. */
  const isAccepted = (candidate: Point): boolean => {
    const cRadius = radius(candidate[0], candidate[1])
    // Scan enough cells to cover the larger of the candidate's own radius and
    // the largest radius any placed point could impose (the pinned rule uses
    // max(radius(c), radius(p)), so a far-off but large-radius neighbour must
    // still be reachable). Each found point is then re-tested with its own radius.
    const reach = neighbourReach(Math.max(cRadius, maxPlacedRadius))
    const cgx = Math.floor(candidate[0] / cellSize)
    const cgy = Math.floor(candidate[1] / cellSize)
    for (let gy = cgy - reach; gy <= cgy + reach; gy++) {
      if (gy < 0 || gy >= gridHeight) continue
      for (let gx = cgx - reach; gx <= cgx + reach; gx++) {
        if (gx < 0 || gx >= gridWidth) continue
        const occupant = grid[gy * gridWidth + gx]!
        if (occupant === -1) continue
        const p = points[occupant]!
        const dx = candidate[0] - p[0]
        const dy = candidate[1] - p[1]
        const dist = Math.hypot(dx, dy)
        const pRadius = radius(p[0], p[1])
        const minDist = Math.max(cRadius, pRadius)
        if (dist < minDist) return false
      }
    }
    return true
  }

  // Seed the first point deterministically from the RNG, redrawing until it
  // lands inside the domain. Each attempt consumes exactly two draws (x then y)
  // in a fixed order, so the RNG stream stays deterministic no matter how many
  // rejections `accept` forces. Bounded: if no in-domain seed is found within
  // the attempt cap the domain is treated as (effectively) empty and we bail
  // with `[]` — a deterministic outcome, not a hang.
  let seeded = false
  for (let attempt = 0; attempt < MAX_SEED_ATTEMPTS; attempt++) {
    const sx = rng.range(0, width)
    const sy = rng.range(0, height)
    if (accept(sx, sy)) {
      addPoint([sx, sy])
      seeded = true
      break
    }
  }
  if (!seeded) return []

  while (active.length > 0) {
    // Deterministic active-point selection.
    const activeIndex = rng.rangeFloor(0, active.length)
    const pointIndex = active[activeIndex]!
    const origin = points[pointIndex]!
    const r = radius(origin[0], origin[1])

    let found = false
    for (let i = 0; i < k; i++) {
      // Annulus sample in [r, 2r): fixed RNG order (angle, then distance).
      const angle = rng.range(0, 2 * Math.PI)
      const dist = rng.range(r, 2 * r)
      const cx = origin[0] + Math.cos(angle) * dist
      const cy = origin[1] + Math.sin(angle) * dist
      if (cx < 0 || cx >= width || cy < 0 || cy >= height) continue
      // Belt-and-suspenders domain gate on every candidate, alongside the bounds
      // and min-distance (`isAccepted`) checks, so no accepted point escapes the
      // domain even if a placed point sits near its boundary.
      if (!accept(cx, cy)) continue
      const candidate: Point = [cx, cy]
      if (isAccepted(candidate)) {
        addPoint(candidate)
        found = true
        break
      }
    }

    if (!found) {
      // Retire this active point (swap-remove keeps ordering deterministic).
      active[activeIndex] = active[active.length - 1]!
      active.pop()
    }
  }

  return points
}

/**
 * Probe the radius field to derive a conservative `minRadius` for grid sizing.
 * Samples a coarse lattice of the region plus its corners — cheap and adequate
 * for a smoothly-varying field. Passing an explicit `minRadius` avoids this.
 */
function deriveMinRadius(
  radius: RadiusField,
  width: number,
  height: number
): number {
  const steps = 8
  let min = Infinity
  for (let iy = 0; iy <= steps; iy++) {
    for (let ix = 0; ix <= steps; ix++) {
      const x = (width * ix) / steps
      const y = (height * iy) / steps
      const r = radius(x, y)
      if (r < min) min = r
    }
  }
  return min
}
