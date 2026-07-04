/**
 * The "single-leaf" Sketch — one parametric leaf, baked as a single closed,
 * filled polygon in the linocut idiom (task 2 of slice #96).
 *
 * It declares a small Parameter Schema over the five leaf shape knobs
 * (length / width / curl / wobble / tipSharpness), rolls the seeded outline
 * ONCE via the private {@link leaf} generator, and centers it into a square
 * coordinate space so the leaf is visible whatever its proportions.
 *
 * STATIC: no `time` metadata (the Harness hides the scrubber when `time` is
 * absent). `generate` still takes `t` to satisfy the stateless contract, but it
 * is unused for now.
 *
 * Boundary rule (load-bearing): only generic {@link Primitive}s cross into the
 * Scene. The leaf domain type ({@link LeafShape}) is reached ONLY through the
 * relative `./leaf` import below and never re-exported, so it stays private and
 * never leaks across the public barrel / draw boundary.
 */

import { createScene } from '../../scene'
import type { Scene } from '../../scene'
import { createRandom } from '../../random'
import type {
  NumberParamSpec,
  Params,
  Seed,
  StatelessSketch,
} from '../../sketch'
import type { Point, Polyline } from '../../types'
import { bbox, HEIGHT, numberParam, WIDTH } from '../sketch-util'
import { leaf } from './leaf'
import type { LeafShape } from './leaf'

/**
 * The single-leaf Parameter Schema — one {@link NumberParamSpec} per leaf shape
 * knob. Ranges are chosen so a default roll draws a leaf that fits comfortably
 * inside the coordinate space, and so each knob's slider spans a visibly
 * distinct family of leaf silhouettes. `satisfies` keeps the literal key set
 * (so `numberParam` can index by `keyof typeof schema`) while enforcing the
 * spec type.
 */
const schema = {
  /** Length of the leaf along its spine, in coordinate-space units. */
  length: { kind: 'number', min: 100, max: 900, default: 168 },
  /** Maximum width across the spine, in coordinate-space units. */
  width: { kind: 'number', min: 40, max: 500, default: 198 },
  /** Sideways spine bend, as a fraction of length (signed). */
  curl: { kind: 'number', min: -0.5, max: 0.5, default: -0.08 },
  /** Amplitude of seeded per-vertex jitter along the outline. */
  wobble: { kind: 'number', min: 0, max: 30, default: 0.19 },
  /** Apex sharpness in [0, 1]: higher pinches the tip, lower rounds it. */
  tipSharpness: { kind: 'number', min: 0, max: 1, default: 0.6 },
} satisfies Record<string, NumberParamSpec>

/**
 * Center a leaf outline into the coordinate space.
 *
 * The {@link leaf} generator grows from the origin (0, 0) along +y with signed
 * ±x spread, so the raw outline is not centered in the WIDTH×HEIGHT space.
 * Compute its bounding box and translate so the outline is centered — visible
 * whatever length/width/curl produce, without rescaling geometry.
 */
function center(points: Polyline): Polyline {
  const { minX, minY, maxX, maxY } = bbox(points)
  const dx = (WIDTH - (maxX - minX)) / 2 - minX
  const dy = (HEIGHT - (maxY - minY)) / 2 - minY
  return points.map(([x, y]): Point => [x + dx, y + dy])
}

/**
 * The single-leaf Sketch: a static, stateless Sketch that bakes one leaf.
 *
 * `generate` reads the five knobs into a {@link LeafShape}, rolls the closed
 * outline once from the seeded RNG, centers it, and emits a single bold-filled,
 * thin-stroked polygon. No accumulated state — re-calling with the same
 * `(params, seed, t)` reproduces the same Scene exactly.
 */
export const singleLeaf: StatelessSketch = {
  id: 'single-leaf',
  name: 'Single Leaf',
  schema,
  generate(params: Params, seed: Seed, _t: number): Scene {
    const rng = createRandom(seed)
    const builder = createScene({ width: WIDTH, height: HEIGHT })

    const shape: LeafShape = {
      length: numberParam(params, schema, 'length'),
      width: numberParam(params, schema, 'width'),
      curl: numberParam(params, schema, 'curl'),
      wobble: numberParam(params, schema, 'wobble'),
      tipSharpness: numberParam(params, schema, 'tipSharpness'),
    }

    const outline = center(leaf(shape, rng))

    builder.addPath(outline, {
      closed: true,
      fill: { color: '#1a1a1a' },
      stroke: { color: '#1a1a1a', width: 2 },
    })

    return builder.build()
  },
}
