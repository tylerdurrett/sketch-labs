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
 * GRASS / CANONICAL STABILITY: every hill owns a canonical Poisson root field
 * keyed by its reduced depth identity. Selection and the four per-blade rolls
 * stay in that hill-local space, so a shared hill retains its arrangement and
 * variation when `hillCount` changes. Only the final projection follows the
 * count-dependent terrain mask. Each hill is emitted before its blades, whose
 * ascending root-y order lets lower blades cover higher ones before the next,
 * nearer hill covers the whole group.
 *
 * CLOSED SILHOUETTES / PHYSICAL PALETTE: blades are traced by the private
 * tapered-outline generator and emitted as closed, filled-and-stroked shapes —
 * never single stroked lines. The background, hill fills, and blade fills
 * default to paper white; authored hill and blade contours default to black.
 * All five colors are tunable without participating in geometry or RNG.
 *
 * STATIC / DETERMINISTIC / PREPARED: there is no `time` metadata. All terrain
 * randomness comes from the explicit Seed, with no clock reads, `Math.random`,
 * or accumulated state. `definePreparedSketch` resolves parameters and builds
 * immutable ridge geometry plus sorted root/variation/shape descriptors once
 * per `(params, seed, frame)`. Its sampler intentionally ignores `t` for now,
 * but traces each descriptor's current static lean into fresh Scene-owned blade
 * points and styles on every call. This keeps warm and cold generation
 * identical, isolates callers from later samples, and leaves the sampling-time
 * deformation boundary ready for animated gust and wave controls.
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
import { blade } from './blade'
import { layoutHillBands } from './depth'
import {
  buildGrassBlades,
  resolveMaximumUnscaledBladeLength,
  type GrassBladeDescriptor,
} from './grass'
import { createGrassHillMask } from './grass-placement'
import { scatterGrassRoots } from './grass-scatter'
import { selectGrassRoots } from './grass-selection'
import { buildRidgeBands } from './ridge-bands'
import { createTerrainField } from './terrain'

/** Horizontal segments used to resolve each prepared ridgeline. */
const RIDGE_SAMPLES = 128

/** Plot-readable contour width in Composition Frame units. */
const HILL_STROKE_WIDTH = 2

/** Plot-readable blade-outline width in Composition Frame units. */
const BLADE_STROKE_WIDTH = 2

/**
 * Flat Studio declaration order: Terrain, Grass (including static lean), Colors.
 * Every knob is consumed by preparation; no animated controls are exposed yet.
 */
const schema = {
  /** Number of full-width hill bands. Whole-number domain. */
  hillCount: {
    kind: 'number',
    min: 1,
    max: 256,
    default: 10,
    step: 1,
    integer: true,
  },
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
  /** Relative canonical root density on every hill. */
  bladeDensity: { kind: 'number', min: 0.25, max: 2, default: 1, step: 0.05 },
  /** Nominal foreground blade length in Composition Frame units. */
  bladeLength: { kind: 'number', min: 4, max: 80, default: 28, step: 1 },
  /** Symmetric seeded variation around the nominal blade length. */
  bladeLengthVariance: { kind: 'number', min: 0, max: 40, default: 8, step: 1 },
  /** Nominal foreground blade silhouette width. */
  bladeWidth: { kind: 'number', min: 0.5, max: 12, default: 3, step: 0.1 },
  /** Seeded variation in how far toward the tip each blade bends. */
  stiffnessVariance: {
    kind: 'number',
    min: 0,
    max: 1,
    default: 0.25,
    step: 0.05,
  },
  /** Static signed blade lean; animated wind layers onto this later. */
  windLean: { kind: 'number', min: -1, max: 1, default: 0, step: 0.05 },
  /** Whole-surface paper color. */
  backgroundColor: { kind: 'color', default: '#ffffff' },
  /** Hill-band fill color. */
  hillColor: { kind: 'color', default: '#ffffff' },
  /** Authored ridgeline color. */
  hillStrokeColor: { kind: 'color', default: '#000000' },
  /** Opaque blade silhouette color. */
  bladeColor: { kind: 'color', default: '#ffffff' },
  /** Authored blade-outline color. */
  bladeStrokeColor: { kind: 'color', default: '#000000' },
} satisfies Record<string, ParamSpec>

type PreparedPoint = readonly [number, number]

interface PreparedHill {
  readonly ridge: ReadonlyArray<PreparedPoint>
  readonly blades: ReadonlyArray<GrassBladeDescriptor>
}

export const grassHills = definePreparedSketch({
  id: 'grass-hills',
  name: 'Grass Hills',
  schema,
  // NO `time` metadata: this still-grass slice is intentionally static.
  prepare(params: Params, seed: Seed, frame: CoordinateSpace) {
    const hillCount = Math.round(numberParam(params, schema, 'hillCount'))
    const horizonHeight = numberParam(params, schema, 'horizonHeight')
    const depthFalloff = numberParam(params, schema, 'depthFalloff')
    const ridgeScale = numberParam(params, schema, 'ridgeScale')
    const ridgeAmplitude = numberParam(params, schema, 'ridgeAmplitude')
    const terrainDrift = numberParam(params, schema, 'terrainDrift')
    const bladeDensity = numberParam(params, schema, 'bladeDensity')
    const bladeLength = numberParam(params, schema, 'bladeLength')
    const bladeLengthVariance = numberParam(
      params,
      schema,
      'bladeLengthVariance',
    )
    const bladeWidth = numberParam(params, schema, 'bladeWidth')
    const stiffnessVariance = numberParam(
      params,
      schema,
      'stiffnessVariance',
    )
    const windLean = numberParam(params, schema, 'windLean')
    const backgroundColor = colorParam(params, schema, 'backgroundColor')
    const hillColor = colorParam(params, schema, 'hillColor')
    const hillStrokeColor = colorParam(params, schema, 'hillStrokeColor')
    const bladeColor = colorParam(params, schema, 'bladeColor')
    const bladeStrokeColor = colorParam(params, schema, 'bladeStrokeColor')

    const projection = {
      frame,
      horizonHeight,
      depthFalloff,
    }
    const bands = layoutHillBands(hillCount, projection)
    const terrainAt = createTerrainField(seed, { ridgeScale, terrainDrift })
    const ridges = buildRidgeBands({
      frame,
      bands,
      terrainAt,
      ridgeAmplitude,
      ridgeSamples: RIDGE_SAMPLES,
    })
    const maxUnscaledBladeLength = resolveMaximumUnscaledBladeLength(
      bladeLength,
      bladeLengthVariance,
    )
    const preparedHills: ReadonlyArray<PreparedHill> = Object.freeze(
      bands.map((band, hillIndex) => {
        const ridge = ridges[hillIndex]!
        const candidates = scatterGrassRoots({
          seed,
          hillKey: band.hillKey,
          bladeDensity,
        })
        const roots = selectGrassRoots({
          seed,
          depth: band.depth,
          bladeDensity,
          candidates,
        })
        const mask = createGrassHillMask({
          frame,
          projection,
          band,
          ridge,
          ...(hillIndex + 1 < ridges.length
            ? { nextNearerRidge: ridges[hillIndex + 1]! }
            : {}),
          maxUnscaledBladeLength,
        })
        const descriptors = [
          ...buildGrassBlades({
            seed,
            hillKey: band.hillKey,
            roots,
            mask,
            bladeLength,
            bladeLengthVariance,
            bladeWidth,
            stiffnessVariance,
            windLean,
          }),
        ].sort(
          (a, b) =>
            a.projected[1] - b.projected[1] ||
            a.projected[0] - b.projected[0] ||
            a.identity.ordinal - b.identity.ordinal,
        )

        return Object.freeze({
          ridge: Object.freeze(
            ridge.points.map(([x, y]) => Object.freeze([x, y] as const)),
          ),
          blades: Object.freeze(descriptors),
        })
      }),
    )

    return (_t: number): Scene => {
      const builder = createScene(frame, { color: backgroundColor })

      for (const hill of preparedHills) {
        builder.addPath(
          hill.ridge.map(([x, y]) => [x, y]),
          {
            closed: false,
            fill: { color: hillColor },
            stroke: { color: hillStrokeColor, width: HILL_STROKE_WIDTH },
          },
        )

        for (const descriptor of hill.blades) {
          const [rootX, rootY] = descriptor.projected
          builder.addPath(
            blade(descriptor.shape).map(([x, y]) => [
              x + rootX,
              y + rootY,
            ]),
            {
              closed: true,
              fill: { color: bladeColor },
              stroke: { color: bladeStrokeColor, width: BLADE_STROKE_WIDTH },
            },
          )
        }
      }

      return builder.build()
    }
  },
})
