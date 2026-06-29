/**
 * The "circles" Sketch — the trivial animated reference Sketch that proves the
 * stateless contract end-to-end (ADR-0002).
 *
 * It declares a small Parameter Schema (how many circles, and their radius
 * range), loops over time, and bakes a Scene of circles. Each circle is emitted
 * as a closed polygon Polyline approximating the perimeter — the Scene IR has no
 * circle/ellipse Primitive, so a ring of points is the representation.
 *
 * Everything random flows from the explicit Seed via `createRandom`; animation
 * flows from `t` alone (a periodic radius pulse). There is NO `Math.random`, no
 * clock read, and no state carried across `generate` calls: `generate` is a pure
 * function of `(params, seed, t)`.
 */

import { createScene } from '../scene'
import type { Scene } from '../scene'
import { createRandom } from '../random'
import type {
  NumberParamSpec,
  Params,
  Seed,
  StatelessSketch,
} from '../sketch'
import type { Point, Polyline } from '../types'

/** Coordinate-space extent the Scene is baked into (square, unitless). */
const WIDTH = 1000
const HEIGHT = 1000

/** Points used to approximate each circle's perimeter as a closed polygon. */
const PERIMETER_SEGMENTS = 64

/** How much the animated radius pulse swells/shrinks each circle (fraction). */
const PULSE_AMPLITUDE = 0.15

/**
 * The circles Parameter Schema. Every knob is a {@link NumberParamSpec} range.
 * `count` is marked `integer` (you cannot scatter a fractional circle); the
 * radii are continuous. `satisfies` keeps the literal key set (so `numberParam`
 * below can index by `keyof typeof schema`) while enforcing the spec type.
 */
const schema = {
  /** How many circles to scatter. Whole-number domain. */
  count: { kind: 'number', min: 1, max: 80, default: 24, integer: true },
  /** Smallest circle radius, in coordinate-space units. */
  minRadius: { kind: 'number', min: 2, max: 100, default: 12 },
  /** Largest circle radius, in coordinate-space units. */
  maxRadius: { kind: 'number', min: 2, max: 200, default: 60 },
} satisfies Record<string, NumberParamSpec>

/**
 * Read a numeric param value, falling back to the schema default when the caller
 * left the knob unset. Keeps `generate` total over partial `Params` without
 * freezing the (deliberately emergent) ParamSpec shape.
 */
function numberParam(params: Params, key: keyof typeof schema): number {
  const value = params[key as string]
  if (typeof value === 'number') return value
  return schema[key].default
}

/**
 * Approximate one circle as a closed polygon: a ring of `PERIMETER_SEGMENTS`
 * evenly-spaced points around (cx, cy) at the given radius.
 */
function circlePolygon(cx: number, cy: number, radius: number): Polyline {
  const points: Point[] = []
  for (let i = 0; i < PERIMETER_SEGMENTS; i++) {
    const angle = (i / PERIMETER_SEGMENTS) * 2 * Math.PI
    points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius])
  }
  return points
}

/**
 * The circles Sketch: a loop-animated, stateless Sketch.
 *
 * `generate` rolls `count` circles entirely from the seeded RNG (centers and
 * base radii) and animates each radius with a periodic pulse driven by `t`
 * against `time.duration`. No accumulated state — re-calling with the same
 * `(params, seed, t)` reproduces the same Scene exactly.
 */
export const circles: StatelessSketch = {
  id: 'circles',
  name: 'Circles',
  schema,
  time: { duration: 4, mode: 'loop' },
  generate(params: Params, seed: Seed, t: number): Scene {
    const rng = createRandom(seed)
    const builder = createScene({ width: WIDTH, height: HEIGHT })

    const count = Math.round(numberParam(params, 'count'))
    const minRadius = numberParam(params, 'minRadius')
    const maxRadius = numberParam(params, 'maxRadius')

    const duration = circles.time?.duration ?? 1
    // Phase of the loop in [0, 1): same at t and t + duration, so the animation
    // is seamless. Derived from t only — never from accumulated state.
    const phase = ((t / duration) % 1 + 1) % 1
    const pulse = 1 + PULSE_AMPLITUDE * Math.sin(phase * 2 * Math.PI)

    for (let i = 0; i < count; i++) {
      const cx = rng.range(0, WIDTH)
      const cy = rng.range(0, HEIGHT)
      const baseRadius = rng.range(minRadius, maxRadius)
      const radius = baseRadius * pulse

      builder.addPath(circlePolygon(cx, cy, radius), {
        closed: true,
        stroke: { color: 'black', width: 1 },
      })
    }

    return builder.build()
  },
}
