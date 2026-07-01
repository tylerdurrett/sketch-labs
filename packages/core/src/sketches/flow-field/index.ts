/**
 * The "flow-field" Sketch — stage 1 of the Leaf Field build-up (slice #100).
 *
 * It samples the seeded curl field (a divergence-free, current-like vector
 * field, see `../../curl`) on a regular grid and draws one oriented tick per
 * grid point: a short 2-point open Polyline centered on the point and rotated to
 * the field vector's direction. Read together, the ticks trace the coherent
 * "current" of the field — the visual spine every later stage (point sampling,
 * leaf placement, masks) builds on.
 *
 * It ships STATIC — there is no `time` metadata, so the Harness renders a single
 * frame and hides the scrubber. Even so, `generate` threads `t` through the
 * field sampling (passed as the curl field's `z`, its 3D path): the field is a
 * function of `(x, y, t)` so turning this into an animation later is a cheap
 * add — no `generate` rework, just `time` metadata and a moving `t`.
 *
 * Everything random flows from the explicit Seed via `createRandom`, which the
 * curl helper consumes directly as its noise source. There is NO `Math.random`,
 * no clock read, and no state carried across calls: `generate` is a pure
 * function of `(params, seed, t)`. Re-seeding reshuffles the underlying field
 * (and thus every tick's orientation) while the params hold.
 */

import { createScene } from '../../scene'
import type { Scene } from '../../scene'
import { createRandom } from '../../random'
import { curl } from '../../curl'
import type {
  NumberParamSpec,
  Params,
  Seed,
  StatelessSketch,
} from '../../sketch'
import type { Point, Polyline } from '../../types'

/** Coordinate-space extent the Scene is baked into (square, unitless). */
const WIDTH = 1000
const HEIGHT = 1000

/**
 * The flow-field Parameter Schema — the five knobs the brief exposes, all
 * live-tunable. `octaves` and `tickDensity` are whole-number domains (marked
 * `integer`); the rest are continuous. `satisfies` keeps the literal key set (so
 * `numberParam` can index by `keyof typeof schema`) while enforcing the spec
 * type.
 *
 * The mapping onto {@link curl}'s options is deliberate:
 * - `fieldScale` → curl's `scale` (the field's base frequency — larger swirls at
 *   smaller values, tighter detail at larger).
 * - `octaves` → curl's `octaves` (how many fbm layers compound into the
 *   potential).
 * - `turbulence` → curl's `gain` (per-octave amplitude falloff): higher gain
 *   lets finer octaves contribute more, roughening the flow into turbulence;
 *   lower gain keeps it smooth and laminar. `gain` is the natural turbulence
 *   knob because it governs exactly that high-frequency contribution.
 */
const schema = {
  /** Base frequency of the field (curl `scale`): lower = broader swirls. */
  fieldScale: { kind: 'number', min: 0.5, max: 8, default: 2 },
  /** Number of fbm octaves compounded into the potential (curl `octaves`). */
  octaves: { kind: 'number', min: 1, max: 8, default: 4, integer: true },
  /** Per-octave amplitude falloff (curl `gain`): higher = rougher/turbulent. */
  turbulence: { kind: 'number', min: 0.1, max: 0.9, default: 0.5 },
  /** Grid resolution per axis — a `tickDensity` × `tickDensity` lattice. */
  tickDensity: { kind: 'number', min: 4, max: 64, default: 24, integer: true },
  /** Length of each oriented tick, in coordinate-space units. */
  tickLength: { kind: 'number', min: 2, max: 60, default: 18 },
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
 * One oriented tick: a 2-point open Polyline of length `length` centered on
 * `(cx, cy)` and rotated to `angle` (radians). The tick spans half its length
 * on each side of the center so the grid point sits at its midpoint.
 */
function tick(cx: number, cy: number, angle: number, length: number): Polyline {
  const half = length / 2
  const dx = Math.cos(angle) * half
  const dy = Math.sin(angle) * half
  const a: Point = [cx - dx, cy - dy]
  const b: Point = [cx + dx, cy + dy]
  return [a, b]
}

/**
 * The flow-field Sketch: a static, stateless sampler of the seeded curl field.
 *
 * `generate` walks a `tickDensity × tickDensity` grid across the coordinate
 * space, samples the curl field at each grid point (threading `t` as the field's
 * `z` so animation is a later cheap add), turns the returned field vector into an
 * angle, and emits a stroked oriented tick there. No accumulated state —
 * re-calling with the same `(params, seed, t)` reproduces the same Scene exactly.
 */
export const flowField: StatelessSketch = {
  id: 'flow-field',
  name: 'Flow Field',
  schema,
  // NO `time` metadata ⇒ ships static (single frame, scrubber hidden).
  generate(params: Params, seed: Seed, t: number): Scene {
    const rng = createRandom(seed)
    const builder = createScene({ width: WIDTH, height: HEIGHT })

    const fieldScale = numberParam(params, 'fieldScale')
    const octaves = Math.round(numberParam(params, 'octaves'))
    const turbulence = numberParam(params, 'turbulence')
    const density = Math.round(numberParam(params, 'tickDensity'))
    const tickLength = numberParam(params, 'tickLength')

    // Grid points sit at cell centers, so the lattice is inset from the edges
    // symmetrically (spacing/2 margin) rather than crowding the borders.
    const cellW = WIDTH / density
    const cellH = HEIGHT / density

    for (let row = 0; row < density; row++) {
      for (let col = 0; col < density; col++) {
        const cx = (col + 0.5) * cellW
        const cy = (row + 0.5) * cellH

        // 3D curl path: `t` is passed as `z` to thread animation. Held fixed
        // per frame, so within a frame the field is a plain function of (x, y).
        // `fieldScale`→scale, `octaves`→octaves, `turbulence`→gain (see schema).
        const [vx, vy] = curl(rng, cx, cy, t, {
          scale: fieldScale,
          octaves,
          gain: turbulence,
        })

        // Orientation is all we need — the tick length is fixed, only its angle
        // follows the field. `atan2(0, 0)` is 0, a safe fallback at a null point.
        const angle = Math.atan2(vy, vx)

        builder.addPath(tick(cx, cy, angle, tickLength), {
          closed: false,
          stroke: { color: 'black', width: 1 },
        })
      }
    }

    return builder.build()
  },
}
