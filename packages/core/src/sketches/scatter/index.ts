/**
 * The "scatter" Sketch — stage 2 of the Leaf Field build-up (parent #3): the
 * visible checkpoint proving even-but-organic blue-noise scatter with live
 * radius tuning.
 *
 * It declares a small Parameter Schema (base radius, jitter, and Bridson's
 * candidate count), fills the coordinate space with blue-noise points via the
 * seeded variable-radius Poisson-disk sampler under a CONSTANT radius field, and
 * bakes each point as a tiny closed-polygon dot. Like the circles Sketch, a dot
 * is a small ring of points — the Scene IR has no point/circle Primitive, so a
 * closed polygon is the representation. NO leaf/circle domain type leaks into the
 * Scene; only generic Primitives.
 *
 * This Sketch is STATIC (no time metadata ⇒ the scrubber stays hidden). `t` is
 * threaded through the signature for the stateless contract, but callers pass 0
 * and it is not read. Everything random flows from the explicit Seed via
 * `createRandom` / the sampler's seed — there is NO `Math.random`, no clock read,
 * and no state carried across `generate` calls: `generate` is a pure function of
 * `(params, seed, t)`.
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
import { HEIGHT, numberParam, WIDTH } from '../sketch-util'

/** Points used to approximate each dot's perimeter as a closed polygon. */
const DOT_SEGMENTS = 12

/**
 * Radius of each baked dot, as a fraction of the base radius. The base radius is
 * the blue-noise spacing (min distance between neighbours), so a dot sized well
 * under half of it stays visibly separated from its neighbours.
 */
const DOT_RADIUS_FRACTION = 0.18

/**
 * The scatter Parameter Schema. Every knob is a {@link NumberParamSpec} range.
 * `kSamples` is marked `integer` (Bridson's candidate count is whole); the
 * radius and jitter are continuous. `satisfies` keeps the literal key set (so
 * `numberParam` below can index by `keyof typeof schema`) while enforcing the
 * spec type.
 */
const schema = {
  /**
   * Blue-noise spacing — the minimum distance between neighbouring points, in
   * coordinate-space units. Live-tunable: raising it thins the scatter, lowering
   * it packs points denser, so density visibly tracks this knob.
   */
  baseRadius: { kind: 'number', min: 12, max: 200, default: 48 },
  /**
   * Per-point positional jitter, as a fraction of the base radius. The sampler
   * already produces blue-noise placement; this is the Sketch's own seeded
   * perturbation applied AFTER sampling, nudging each point off its lattice-free
   * position for extra organic irregularity. `0` leaves the raw sample.
   */
  jitter: { kind: 'number', min: 0, max: 0.5, default: 0.15 },
  /**
   * Bridson's candidate count `k`: how many annulus candidates are tried per
   * active point before it is retired. Higher packs tighter (fewer gaps) at more
   * cost. Whole-number domain.
   */
  kSamples: { kind: 'number', min: 4, max: 40, default: 30, integer: true },
} satisfies Record<string, NumberParamSpec>

/**
 * Approximate one dot as a closed polygon: a ring of `DOT_SEGMENTS`
 * evenly-spaced points around (cx, cy) at the given radius.
 */
function dotPolygon(cx: number, cy: number, radius: number): Polyline {
  const points: Point[] = []
  for (let i = 0; i < DOT_SEGMENTS; i++) {
    const angle = (i / DOT_SEGMENTS) * 2 * Math.PI
    points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius])
  }
  return points
}

/**
 * The scatter Sketch: a static, stateless blue-noise scatter.
 *
 * `generate` fills the coordinate space with blue-noise points via the seeded
 * Poisson-disk sampler under a CONSTANT radius field (`() => baseRadius`), applies
 * a deterministic per-point jitter (RNG consumed in fixed loop order), and bakes
 * each jittered point as a tiny closed-polygon dot. No accumulated state — re-
 * calling with the same `(params, seed, t)` reproduces the same Scene exactly;
 * changing the seed reshuffles the placement while params hold.
 */
export const scatter: StatelessSketch = {
  id: 'scatter',
  name: 'Scatter',
  schema,
  generate(params: Params, seed: Seed, _t: number): Scene {
    const builder = createScene({ width: WIDTH, height: HEIGHT })

    const baseRadius = numberParam(params, schema, 'baseRadius')
    const jitter = numberParam(params, schema, 'jitter')
    const kSamples = Math.round(numberParam(params, schema, 'kSamples'))

    // Constant radius field ⇒ uniform blue-noise spacing. `minRadius` equals the
    // constant so the accel grid is sized accurately (variable/density-driven
    // radius is out of scope — lands with the clearings slice #98).
    const points = samplePoissonDisk({
      width: WIDTH,
      height: HEIGHT,
      radius: () => baseRadius,
      minRadius: baseRadius,
      k: kSamples,
      seed,
    })

    // The Sketch's own per-point jitter draws from a SEPARATE Random so the
    // sampler's internal RNG sequence is untouched. Consumption order is fixed
    // by the point loop (dx then dy per point), so the same (params, seed) always
    // perturbs identically.
    const jitterRng = createRandom(`${seed}-scatter-jitter`)
    const jitterAmount = jitter * baseRadius
    const dotRadius = baseRadius * DOT_RADIUS_FRACTION

    for (const [x, y] of points) {
      const dx = jitterRng.range(-jitterAmount, jitterAmount)
      const dy = jitterRng.range(-jitterAmount, jitterAmount)
      builder.addPath(dotPolygon(x + dx, y + dy, dotRadius), {
        closed: true,
        fill: { color: 'black' },
      })
    }

    return builder.build()
  },
}
