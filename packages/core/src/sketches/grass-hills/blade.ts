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

/** Stations pinned by the approved seven-point architecture-decision fixture. */
const FLANK_STATIONS = [0, 0.5, 0.82, 1] as const

function requirePositiveFinite(value: number, name: 'length' | 'width'): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`)
  }
}

/**
 * Build one deterministic, explicitly closed grass-blade outline.
 *
 * The blade is rooted at `[0, 0]` and grows upward in the Scene's top-origin
 * coordinate space. Its spine uses a power curve with zero slope at the root:
 * every blade therefore has a stiff base, while increasing `stiffness` pushes
 * the same total deflection progressively nearer the floppy tip. Symmetric
 * flank offsets widen from the root and taper to the single shared apex.
 * Because the two flanks share strictly ordered y stations and a non-negative
 * width at every station, they cannot cross.
 *
 * This primitive consumes no RNG. Seeded per-blade variation belongs to the
 * caller so geometry generation has a stable, auditable random-draw budget.
 */
export function blade(shape: BladeShape): Polyline {
  const { length, width, lean, stiffness } = shape
  requirePositiveFinite(length, 'length')
  requirePositiveFinite(width, 'width')
  if (!Number.isFinite(lean)) throw new RangeError('lean must be finite')
  if (!Number.isFinite(stiffness) || stiffness < 1 || stiffness > 4) {
    throw new RangeError('stiffness must be a finite number in [1, 4]')
  }

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

  for (const t of FLANK_STATIONS) {
    if (t === 0) {
      rightFlank.push([0, 0])
      leftFlank.push([0, 0])
      continue
    }

    const spineX = tipOffset * t ** bendExponent
    const y = -length * t
    // A parabolic profile is exactly zero at both ends, reaches the requested
    // full width halfway up, and remains non-negative between them.
    const halfWidth = width * (2 * t * (1 - t))

    rightFlank.push([spineX + halfWidth, y])
    leftFlank.push([spineX - halfWidth, y])
  }

  // Trace root -> right flank -> shared apex -> left flank -> root. Drop the
  // left copy of the apex, then retain its root copy as the explicit closure.
  return [...rightFlank, ...leftFlank.slice(0, -1).reverse()]
}
