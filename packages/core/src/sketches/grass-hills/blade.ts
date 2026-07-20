import type { Point, Polyline } from '../../types'

/**
 * Shape knobs for one grass-blade silhouette.
 *
 * MODULE-PRIVATE: the grass-hills sketch consumes this type through a relative
 * import. It is intentionally absent from the package's public barrel.
 */
export interface BladeShape {
  /** Root-to-tip height in Composition Frame units. Must be finite and positive. */
  length: number
  /** Maximum full silhouette width. Must be finite and positive. */
  width: number
  /** Signed tip deflection as a fraction of length; positive leans toward +x. */
  lean: number
  /** Bend resistance in [1, 4]; higher values keep more of the blade upright. */
  stiffness: number
}

/**
 * Stations pinned by the approved seven-point architecture-decision fixture.
 * Exported so adaptive-detail resolution can return this exact array at its
 * four-station floor, keeping the default emission byte-identical.
 */
export const FLANK_STATIONS = [0, 0.5, 0.82, 1] as const

function requirePositiveFinite(value: number, name: 'length' | 'width'): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`)
  }
}

function requireValidStations(stations: readonly number[]): void {
  if (stations[0] !== 0 || stations[stations.length - 1] !== 1) {
    throw new RangeError(
      'stations must start at exactly 0 and end at exactly 1',
    )
  }
  for (let index = 1; index < stations.length; index++) {
    if (!(stations[index]! > stations[index - 1]!)) {
      throw new RangeError('stations must be strictly ascending')
    }
  }
}

/**
 * Build one deterministic grass-blade outline, closed at the root by default
 * and cut open at a positive `rootSink`.
 *
 * The blade is rooted at `[0, 0]` and grows upward in the Scene's top-origin
 * coordinate space. Its spine uses a power curve with zero slope at the root:
 * every blade therefore has a stiff base, while increasing `stiffness` pushes
 * the same total deflection progressively nearer the floppy tip. Symmetric
 * flank offsets widen from the root and taper to the single shared apex.
 * Because the two flanks share strictly ordered y stations and a non-negative
 * width at every station, they cannot cross.
 *
 * `stations` selects the flank tessellation: a strictly ascending list of
 * spine fractions starting at exactly 0 and ending at exactly 1. Absent, the
 * pinned four-station legacy array applies; adaptive detail passes the denser
 * lists it resolved per descriptor. An uncut blade emits `2 * count - 1`
 * points for `count` stations.
 *
 * `rootSink` buries the bottom fraction of the silhouette as a CUT, not a
 * translation: painter order means nothing can ever occlude a blade from its
 * own hill, so a buried fraction must simply not be emitted. The cut blade
 * emerges at partial width along a flat edge at y = 0 — first point on the
 * right flank's cut, last point on the left flank's cut — and stays OPEN with
 * no closure point. The hidden-line `outlineRing` strokes a last-to-first
 * closing edge only when `closed === true`, so the open cut never gains a
 * horizontal stroke chord tick, while Canvas fill and the Hidden-line
 * occluder role still close the region implicitly. At `rootSink` 0 (or absent
 * options) the emission is today's exact explicitly closed outline.
 *
 * This primitive consumes no RNG. Seeded per-blade variation belongs to the
 * caller so geometry generation has a stable, auditable random-draw budget.
 */
export function blade(
  shape: BladeShape,
  options?: { rootSink?: number; stations?: readonly number[] },
): Polyline {
  const { length, width, lean, stiffness } = shape
  requirePositiveFinite(length, 'length')
  requirePositiveFinite(width, 'width')
  if (!Number.isFinite(lean)) throw new RangeError('lean must be finite')
  if (!Number.isFinite(stiffness) || stiffness < 1 || stiffness > 4) {
    throw new RangeError('stiffness must be a finite number in [1, 4]')
  }
  const rootSink = options?.rootSink ?? 0
  if (!Number.isFinite(rootSink) || rootSink < 0 || rootSink > 0.5) {
    throw new RangeError('rootSink must be a finite number in [0, 0.5]')
  }
  if (options?.stations !== undefined) requireValidStations(options.stations)
  const flankStations: readonly number[] = options?.stations ?? FLANK_STATIONS

  const tipOffset = lean * length
  if (!Number.isFinite(tipOffset)) {
    throw new RangeError('lean and length must produce a finite tip offset')
  }

  // The supported stiffness range maps continuously to exponents 2..5. Every
  // value retains zero slope at the root; higher values defer more of the bend
  // toward the tip without changing the requested total tip deflection.
  const bendExponent = stiffness + 1
  const rightFlank: Point[] = []
  const leftFlank: Point[] = []

  // rootSink 0 keeps the resolved stations untouched; a positive sink re-roots
  // the walk at the cut fraction and keeps only the stations above it (any
  // station equal to the cut fraction dedupes naturally through the filter).
  const stations: readonly number[] =
    rootSink === 0
      ? flankStations
      : [rootSink, ...flankStations.filter((t) => t > rootSink)]

  for (const t of stations) {
    if (t === 0) {
      rightFlank.push([0, 0])
      leftFlank.push([0, 0])
      continue
    }

    const spineX = tipOffset * t ** bendExponent
    // A parabolic profile is exactly zero at both ends, reaches the requested
    // full width halfway up, and remains non-negative between them. The cut
    // therefore emerges at partial width without reshaping the flanks above.
    const halfWidth = width * (2 * t * (1 - t))

    if (t === rootSink) {
      // The flat cut sits at an exact y = 0, mirroring the exact-zero root.
      rightFlank.push([spineX + halfWidth, 0])
      leftFlank.push([spineX - halfWidth, 0])
      continue
    }

    // Subtracting the sink re-measures height from the cut; at rootSink 0 the
    // subtraction of an exact zero leaves today's -length * t bit-identical.
    const y = -length * (t - rootSink)

    rightFlank.push([spineX + halfWidth, y])
    leftFlank.push([spineX - halfWidth, y])
  }

  // Trace root/cut -> right flank -> shared apex -> left flank, dropping the
  // left copy of the apex. Uncut, the left flank ends at the root copy that is
  // retained as the explicit closure; cut, the path runs open from the right
  // cut point to the distinct left cut point with no closure edge.
  return [...rightFlank, ...leftFlank.slice(0, -1).reverse()]
}
