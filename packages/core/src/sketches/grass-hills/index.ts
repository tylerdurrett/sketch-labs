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
 * `terrainOctaves` and `terrainRoughness` feed the shared field's fBm octave
 * count and gain directly, while `terrainSharpness` (a ridged fold toward
 * `1 - 2|h|`) and `terrainContrast` (a sign-preserving power curve) reshape
 * each sampled height inside the terrain module before its clamp; their
 * defaults structurally skip both steps, so the untouched field stays
 * byte-identical. `ridgeSamples` sets the horizontal resolution every
 * prepared ridgeline is resolved at.
 *
 * FOREGROUND ZOOM / COMPOSITION: `foregroundZoom` uniformly magnifies the
 * completed scene around the horizon center. Terrain, projected roots, blade
 * lengths, and blade widths transform together, so the oversized foreground
 * can continue beyond the fixed Composition Frame instead of ending visibly at
 * its bottom. This is a sketch-local prepared-geometry transform, not a crop or
 * literal 3D camera. It runs once after canonical construction and before Fill
 * and Outline diverge; authored Fill strokes and physical tool width stay fixed.
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
 * GRASS / CANONICAL STABILITY: every hill owns a canonical 100 x 100 stable-cell
 * root bank keyed by its reduced depth identity. Priority-prefix selection and
 * the four per-blade rolls stay in that hill-local space, so a shared hill
 * retains its arrangement and variation when `hillCount` changes. Only the
 * final projection follows the count-dependent terrain mask. Each hill is
 * emitted before its blades, whose ascending root-y order lets lower blades
 * cover higher ones before the next, nearer hill covers the whole group.
 *
 * DENSE / FAITHFUL OUTLINE ARCHITECTURE: the full-composition target is 10,000
 * descriptors from a seeded 100×100 stratified bank per stable hill identity.
 * Fill traces curved seven-point blade silhouettes. On-demand Outline starts
 * from that exact sampled geometry — all hill rings and every tapered blade in
 * painter order — then annotates every primitive as both source and occluder for
 * the generic indexed Hidden-line pass. There are no substitute centerline
 * spines, physical-tool root LOD, or hill-only approximation. The physical tool
 * target changes output stroke width only; it never selects roots or
 * reconstructs geometry. The optional Outline-source hook keeps this dense
 * generation in Studio's worker.
 *
 * BLADE SILHOUETTES / PHYSICAL PALETTE: blades are traced by the private
 * tapered-outline generator as filled-and-stroked shapes — never single stroked
 * lines. Every outline explicitly repeats its root. Default geometry retains
 * `closed: true` for exact compatibility; active foreground zoom uses open path
 * metadata so bounds clipping cannot synthesize a new last-to-first stroke
 * across a clipped blade. The explicit root closure keeps the uncut fill and
 * contour unchanged. The background, hill fills, and blade fills default to
 * paper white; authored hill and blade contours default to black. All five
 * colors are tunable without participating in geometry or RNG.
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
  type OutlineTarget,
  type ParamSpec,
  type Params,
  type Seed,
} from '../../sketch'
import { colorParam, numberParam } from '../sketch-util'
import { blade } from './blade'
import { layoutHillBands } from './depth'
import { applyForegroundZoom } from './foreground-zoom'
import {
  buildGrassBlades,
  resolveMaximumUnscaledBladeLength,
  type GrassBladeDescriptor,
} from './grass'
import { createGrassHillMask } from './grass-placement'
import {
  grassHillsOutlineSource,
  validateGrassHillsOutlineTarget,
} from './outline'
import { scatterGrassRoots } from './grass-scatter'
import {
  allocateGrassRootCounts,
  selectGrassRoots,
} from './grass-selection'
import { buildRidgeBands } from './ridge-bands'
import { createTerrainField } from './terrain'

/** Horizontal segments used to resolve each prepared ridgeline. */
const RIDGE_SAMPLES = 128

/** Authored Fill ridgeline width; Outline applies the active physical tool. */
const HILL_STROKE_WIDTH = 1

/** Authored Fill blade-contour width; Outline applies the active physical tool. */
const BLADE_STROKE_WIDTH = 0.7

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
  /** Uniform horizon-centered magnification of completed scene geometry. */
  foregroundZoom: { kind: 'number', min: 1, max: 2, default: 1, step: 0.05 },
  /** Horizontal fBm frequency in features across the frame. */
  ridgeScale: { kind: 'number', min: 0.25, max: 12, default: 3.5, step: 0.05 },
  /** Nominal relief as a fraction of each band's local height. */
  ridgeAmplitude: { kind: 'number', min: 0, max: 25, default: 0.8, step: 0.01 },
  /** Travel through the shared terrain field from foreground to horizon. */
  terrainDrift: { kind: 'number', min: 0, max: 8, default: 1.25, step: 0.05 },
  /** fBm octave count for the shared terrain field. Whole-number domain. */
  terrainOctaves: {
    kind: 'number',
    min: 1,
    max: 8,
    default: 4,
    step: 1,
    integer: true,
  },
  /** fBm per-octave gain; higher values roughen the shared terrain field. */
  terrainRoughness: {
    kind: 'number',
    min: 0.1,
    max: 0.9,
    default: 0.5,
    step: 0.05,
  },
  /** Post-fBm power curve; above one sharpens relief, below one softens. */
  terrainContrast: { kind: 'number', min: 0.25, max: 4, default: 1, step: 0.05 },
  /** Blend toward ridged terrain creases; zero keeps plain fBm. */
  terrainSharpness: { kind: 'number', min: 0, max: 1, default: 0, step: 0.05 },
  /** Horizontal segments used to resolve each prepared ridgeline. */
  ridgeSamples: {
    kind: 'number',
    min: 64,
    max: 1024,
    default: RIDGE_SAMPLES,
    step: 1,
    integer: true,
  },
  /** Relative density: 2 is the adopted 10k scene; 10 explores up to 50k. */
  bladeDensity: { kind: 'number', min: 0, max: 10, default: 0, step: 0.05 },
  /** Elevation (band-height fraction) where the treeline fade begins. */
  treelineHeight: { kind: 'number', min: 0, max: 2, default: 1, step: 0.05 },
  /** Elevation span of the treeline fade; zero yields a hard cut. */
  treelineFalloff: { kind: 'number', min: 0, max: 2, default: 0.5, step: 0.05 },
  /** Fraction of blades culled above the treeline; zero disables it. */
  treelineStrength: { kind: 'number', min: 0, max: 1, default: 0, step: 0.05 },
  /** Fraction of blades culled on steep slopes; zero disables it. */
  slopeBareness: { kind: 'number', min: 0, max: 1, default: 0, step: 0.05 },
  /** Nominal foreground blade length in Composition Frame units. */
  bladeLength: { kind: 'number', min: 4, max: 80, default: 28, step: 1 },
  /** Symmetric seeded variation around the nominal blade length. */
  bladeLengthVariance: { kind: 'number', min: 0, max: 40, default: 8, step: 1 },
  /** Nominal foreground blade silhouette width. */
  bladeWidth: { kind: 'number', min: 0.5, max: 12, default: 3, step: 0.1 },
  /** Fraction of each blade sunk below its root; cuts the silhouette open. */
  bladeRootSink: { kind: 'number', min: 0, max: 0.5, default: 0, step: 0.01 },
  /** Maximum flank stations per blade at full scale. Whole-number domain. */
  bladeDetail: {
    kind: 'number',
    min: 4,
    max: 16,
    default: 4,
    step: 1,
    integer: true,
  },
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

interface PreparedGrassHills {
  readonly frame: CoordinateSpace
  readonly backgroundColor: string
  readonly hillColor: string
  readonly hillStrokeColor: string
  readonly bladeColor: string
  readonly bladeStrokeColor: string
  readonly bladePathsClosed: boolean
  readonly hills: ReadonlyArray<PreparedHill>
}

export const grassHills = definePreparedSketch({
  id: 'grass-hills',
  name: 'Grass Hills',
  schema,
  // NO `time` metadata: this still-grass slice is intentionally static.
  prepare(params: Params, seed: Seed, frame: CoordinateSpace) {
    const prepared = prepareGrassHills(params, seed, frame)
    return (t: number): Scene => sampleGrassHills(prepared, t)
  },
  generateOutlineSource(
    params: Params,
    seed: Seed,
    _t: number,
    frame: CoordinateSpace,
    target: OutlineTarget,
  ) {
    validateGrassHillsOutlineTarget(target)
    const prepared = prepareGrassHills(params, seed, frame)
    return grassHillsOutlineSource(sampleGrassHills(prepared, _t), target)
  },
})

/** Prepare every immutable root, variation roll, projected shape, and ridge. */
function prepareGrassHills(
  params: Params,
  seed: Seed,
  frame: CoordinateSpace,
): PreparedGrassHills {
  const preparedFrame = Object.freeze({
    width: frame.width,
    height: frame.height,
  })
  const hillCount = Math.round(numberParam(params, schema, 'hillCount'))
  const horizonHeight = numberParam(params, schema, 'horizonHeight')
  const depthFalloff = numberParam(params, schema, 'depthFalloff')
  const foregroundZoom = numberParam(params, schema, 'foregroundZoom')
  const ridgeScale = numberParam(params, schema, 'ridgeScale')
  const ridgeAmplitude = numberParam(params, schema, 'ridgeAmplitude')
  const terrainDrift = numberParam(params, schema, 'terrainDrift')
  const terrainOctaves = Math.round(
    numberParam(params, schema, 'terrainOctaves'),
  )
  const terrainRoughness = numberParam(params, schema, 'terrainRoughness')
  const terrainContrast = numberParam(params, schema, 'terrainContrast')
  const terrainSharpness = numberParam(params, schema, 'terrainSharpness')
  const ridgeSamples = Math.round(numberParam(params, schema, 'ridgeSamples'))
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
    frame: preparedFrame,
    horizonHeight,
    depthFalloff,
  }
  const bands = layoutHillBands(hillCount, projection)
  const terrainAt = createTerrainField(seed, {
    ridgeScale,
    terrainDrift,
    terrainOctaves,
    terrainRoughness,
    terrainContrast,
    terrainSharpness,
  })
  const ridges = buildRidgeBands({
    frame: preparedFrame,
    bands,
    terrainAt,
    ridgeAmplitude,
    ridgeSamples,
  })
  const maxUnscaledBladeLength = resolveMaximumUnscaledBladeLength(
    bladeLength,
    bladeLengthVariance,
  )
  const rootCounts = allocateGrassRootCounts(
    bands.map(({ depth }) => depth),
    bladeDensity,
  )
  const unzoomedHills: ReadonlyArray<PreparedHill> = Object.freeze(
    bands.map((band, hillIndex) => {
      const ridge = ridges[hillIndex]!
      const count = rootCounts[hillIndex]!
      const candidates =
        count === 0
          ? Object.freeze([])
          : scatterGrassRoots({
              seed,
              hillKey: band.hillKey,
              minimumCount: count,
            })
      const roots = selectGrassRoots({ count, candidates })
      const mask = createGrassHillMask({
        frame: preparedFrame,
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
  const hills = applyForegroundZoom(unzoomedHills, {
    frame: preparedFrame,
    horizonHeight,
    zoom: foregroundZoom,
  })

  return Object.freeze({
    frame: preparedFrame,
    backgroundColor,
    hillColor,
    hillStrokeColor,
    bladeColor,
    bladeStrokeColor,
    bladePathsClosed: foregroundZoom === 1,
    hills,
  })
}

/** Trace only lean-dependent geometry/styles into fresh Scene-owned values. */
function sampleGrassHills(prepared: PreparedGrassHills, _t: number): Scene {
  const builder = createScene(prepared.frame, {
    color: prepared.backgroundColor,
  })

  for (const hill of prepared.hills) {
    builder.addPath(
      hill.ridge.map(([x, y]) => [x, y]),
      {
        closed: false,
        fill: { color: prepared.hillColor },
        stroke: {
          color: prepared.hillStrokeColor,
          width: HILL_STROKE_WIDTH,
        },
      },
    )

    for (const descriptor of hill.blades) {
      const [rootX, rootY] = descriptor.projected
      builder.addPath(
        blade(descriptor.shape).map(([x, y]) => [x + rootX, y + rootY]),
        {
          closed: prepared.bladePathsClosed,
          fill: { color: prepared.bladeColor },
          stroke: {
            color: prepared.bladeStrokeColor,
            width: BLADE_STROKE_WIDTH,
          },
        },
      )
    }
  }

  return builder.build()
}
