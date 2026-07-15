/**
 * The "grass-hills" Sketch — a static landscape of full-width hill bands whose
 * baselines recede toward a horizon in far-to-near painter's order.
 *
 * DEPTH / SHARED TERRAIN: `hillCount`, `horizonHeight`, and `depthFalloff`
 * place successively larger bands from the horizon toward the foreground. All
 * ridges sample one seeded 2D fBm terrain field at `(x, depth)`, rather than
 * rolling unrelated profiles; `terrainDrift` controls how far that shared
 * landscape moves between depths. Relief scales with each band's local height,
 * so distant ridges flatten with the same perspective cue as their spacing.
 *
 * UNBOUNDED RELIEF / PAINTER ORDER: ridge relief is a direct multiple of each
 * band's local height. Every ridge follows the shared terrain independently, so
 * high amplitudes can carry mountains above the horizon or valleys below the
 * frame without a distant profile deforming a nearer one. Bands are prepared
 * and emitted far-to-near; nearer fills, rather than geometry clamps, naturally
 * occlude the lower parts of the terrain behind them.
 *
 * EXPORT-SAFE RINGS: every hill is a filled ring whose first and last ridge
 * samples, vertical sides, and bottom edge sit beyond the frame. The first point
 * is repeated explicitly to close the fill, while `closed: false` remains
 * deliberate metadata: export clipping can discard those off-frame closure
 * edges without synthesizing a visible frame-edge stroke chord.
 *
 * PHYSICAL PALETTE: the background and hill fills default to paper white and
 * the authored ridgelines default to black. This makes the default preview and
 * Outline/SVG export share the plotter-first black-line-on-white language while
 * leaving all three colors tunable.
 *
 * STATIC / DETERMINISTIC / PREPARED: there is no `time` metadata. All terrain
 * randomness comes from the explicit Seed, with no clock reads, `Math.random`,
 * or accumulated state. `definePreparedSketch` resolves parameters and builds
 * the immutable ridge geometry once per `(params, seed, frame)`. Its sampler
 * intentionally ignores `t` and copies that geometry into fresh Scene-owned
 * arrays on every call, so warm and cold generation are identical and callers
 * cannot mutate a later frame through an earlier Scene.
 *
 * FUTURE GRASS / WIND: this slice intentionally owns only Terrain and Colors.
 * Grass blades, their palette, wind controls, and animation metadata layer onto
 * these prepared hills in later slices without changing this static terrain
 * contract.
 */

import { createScene } from '../../scene'
import type { CoordinateSpace, Scene } from '../../scene'
import {
  definePreparedSketch,
  type ParamSpec,
  type Params,
  type Seed,
} from '../../sketch'
import { colorParam, numberParam } from '../sketch-util'
import { layoutHillBands } from './depth'
import { buildRidgeBands } from './ridge-bands'
import { createTerrainField } from './terrain'

/** Horizontal segments used to resolve each prepared ridgeline. */
const RIDGE_SAMPLES = 128

/** Plot-readable contour width in Composition Frame units. */
const HILL_STROKE_WIDTH = 2

/**
 * Flat Studio declaration order: the Terrain group first, then Colors.
 * Every knob is consumed by preparation; no future-facing controls are exposed.
 */
const schema = {
  /** Number of full-width hill bands. Whole-number domain. */
  hillCount: { kind: 'number', min: 1, max: 256, default: 50, step: 1, integer: true },
  /** Horizon y as a top-origin fraction of the Composition Frame height. */
  horizonHeight: { kind: 'number', min: 0, max: 0.9, default: 0.25, step: 0.01 },
  /** Perspective exponent; values above one compress distant ridge spacing. */
  depthFalloff: { kind: 'number', min: 0.25, max: 4, default: 2, step: 0.05 },
  /** Horizontal fBm frequency in features across the frame. */
  ridgeScale: { kind: 'number', min: 0.25, max: 12, default: 3.5, step: 0.05 },
  /** Nominal relief as a fraction of each band's local height. */
  ridgeAmplitude: { kind: 'number', min: 0, max: 25, default: 0.8, step: 0.01 },
  /** Travel through the shared terrain field from foreground to horizon. */
  terrainDrift: { kind: 'number', min: 0, max: 8, default: 1.25, step: 0.05 },
  /** Whole-surface paper color. */
  backgroundColor: { kind: 'color', default: '#ffffff' },
  /** Hill-band fill color. */
  hillColor: { kind: 'color', default: '#ffffff' },
  /** Authored ridgeline color. */
  hillStrokeColor: { kind: 'color', default: '#000000' },
} satisfies Record<string, ParamSpec>

type PreparedPoint = readonly [number, number]

export const grassHills = definePreparedSketch({
  id: 'grass-hills',
  name: 'Grass Hills',
  schema,
  // NO `time` metadata: this bare-hills slice is intentionally static.
  prepare(params: Params, seed: Seed, frame: CoordinateSpace) {
    const hillCount = Math.round(numberParam(params, schema, 'hillCount'))
    const horizonHeight = numberParam(params, schema, 'horizonHeight')
    const depthFalloff = numberParam(params, schema, 'depthFalloff')
    const ridgeScale = numberParam(params, schema, 'ridgeScale')
    const ridgeAmplitude = numberParam(params, schema, 'ridgeAmplitude')
    const terrainDrift = numberParam(params, schema, 'terrainDrift')
    const backgroundColor = colorParam(params, schema, 'backgroundColor')
    const hillColor = colorParam(params, schema, 'hillColor')
    const hillStrokeColor = colorParam(params, schema, 'hillStrokeColor')

    const bands = layoutHillBands(hillCount, {
      frame,
      horizonHeight,
      depthFalloff,
    })
    const terrainAt = createTerrainField(seed, { ridgeScale, terrainDrift })
    const preparedRidges: ReadonlyArray<ReadonlyArray<PreparedPoint>> = Object.freeze(
      buildRidgeBands({
        frame,
        bands,
        terrainAt,
        ridgeAmplitude,
        ridgeSamples: RIDGE_SAMPLES,
      }).map((ridge) =>
        Object.freeze(
          ridge.points.map(([x, y]) => Object.freeze([x, y] as const)),
        ),
      ),
    )

    return (_t: number): Scene => {
      const builder = createScene(frame, { color: backgroundColor })

      for (const ridge of preparedRidges) {
        builder.addPath(
          ridge.map(([x, y]) => [x, y]),
          {
            closed: false,
            fill: { color: hillColor },
            stroke: { color: hillStrokeColor, width: HILL_STROKE_WIDTH },
          },
        )
      }

      return builder.build()
    }
  },
})
