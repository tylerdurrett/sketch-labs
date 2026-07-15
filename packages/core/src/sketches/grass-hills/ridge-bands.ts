import type { CoordinateSpace, Primitive } from '../../scene'
import type { HillBandDepth } from './depth'
import type { TerrainField } from './terrain'

/** Fraction of each neighboring clearance a ridge may consume. */
export const SAFE_CLEARANCE = 0.45

/** Inputs for the pure ridge-band geometry pass. */
export interface RidgeBandGeometryOptions {
  /** Coordinate space the polygons cover. */
  frame: CoordinateSpace
  /** Perspective layout in painter-friendly far-to-near order. */
  bands: readonly HillBandDepth[]
  /** Shared coherent terrain field sampled by every band. */
  terrainAt: TerrainField
  /** Nominal relief as a fraction of each band's local height. */
  ridgeAmplitude: number
  /** Number of horizontal segments across the visible frame. */
  ridgeSamples: number
}

/**
 * Resolve nominal ridge relief against the space available on both sides.
 *
 * The same amplitude applies above and below the baseline. Reserving 55% of
 * each clearance means even two adjacent ridges moving directly toward one
 * another retain a strict gap.
 */
export function ridgeBandAmplitude(
  band: HillBandDepth,
  ridgeAmplitude: number,
): number {
  return Math.min(
    ridgeAmplitude * band.localBandHeight,
    SAFE_CLEARANCE * band.upperClearance,
    SAFE_CLEARANCE * band.lowerClearance,
  )
}

/**
 * Build full-width filled ridge rings in far-to-near painter's order.
 *
 * Each ridgeline has one sample beyond either horizontal frame edge. Its sides
 * descend vertically at those off-frame x coordinates and its bottom closes
 * below the frame. Export-time clipping therefore removes the sides and bottom,
 * leaving only the visible ridgeline as stroked geometry. The ring repeats its
 * first point explicitly while `closed` remains false: source renderers still
 * fill the complete polygon, but clipping cannot recreate a visible chord from
 * path-closure metadata after it drops the off-frame edges. The returned
 * Primitives deliberately carry no fill or stroke; the sketch assembly layer
 * applies color without participating in geometry generation.
 */
export function buildRidgeBands({
  frame,
  bands,
  terrainAt,
  ridgeAmplitude,
  ridgeSamples,
}: RidgeBandGeometryOptions): Primitive[] {
  const sampleSpacing = frame.width / ridgeSamples
  const bottomY =
    frame.height +
    Math.max(sampleSpacing, frame.height / Math.max(1, bands.length + 1))

  return bands.map((band) => {
    const amplitude = ridgeBandAmplitude(band, ridgeAmplitude)
    const points: Primitive['points'] = []

    for (let sample = -1; sample <= ridgeSamples + 1; sample++) {
      const x = sample * sampleSpacing
      const normalizedX = x / frame.width
      const terrainHeight = Math.max(
        -1,
        Math.min(1, terrainAt(normalizedX, band.depth)),
      )
      points.push([x, band.baselineY - terrainHeight * amplitude])
    }

    // Keep both closing sides vertical and wholly outside the frame.
    const leftX = points[0]![0]
    const rightX = points.at(-1)![0]
    const first = points[0]!
    points.push([rightX, bottomY], [leftX, bottomY], [first[0], first[1]])

    return { points, closed: false }
  })
}
