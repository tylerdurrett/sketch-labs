import type { CoordinateSpace } from '../scene'
import type { ToneSource } from '../shadingFields'
import type { NumberParamSpec } from '../sketch'
import type { Point } from '../types'

/** The two artist-facing controls owned by the Stippling Strategy. */
export interface StipplingControls {
  /** Relative mark abundance; higher values also permit tighter spacing. */
  readonly stippleDensity: number
  /** Bounded effort spent improving the selected marks' distribution. */
  readonly distributionFidelity: number
}
export type StipplingControlName = keyof StipplingControls

/** Public declarations for the strategy's independent authored controls. */
export const stipplingControlSchema = Object.freeze({
  stippleDensity: Object.freeze({
    kind: 'number',
    min: 0.25,
    max: 4,
    default: 1,
    step: 0.05,
  }),
  distributionFidelity: Object.freeze({
    kind: 'number',
    min: 0,
    max: 1,
    default: 0.5,
    step: 0.01,
  }),
} satisfies Record<StipplingControlName, NumberParamSpec>)

/** Frozen defaults derived from the same declarations presented to artists. */
export const defaultStipplingControls: Readonly<StipplingControls> =
  Object.freeze({
    stippleDensity: stipplingControlSchema.stippleDensity.default,
    distributionFidelity:
      stipplingControlSchema.distributionFidelity.default,
  })

/** Run-relative geometry, spacing, and permission-weighted mark abundance. */
export interface StipplingScales {
  /** Fixed near-dot micro-stroke length in Composition Frame units. */
  readonly stippleLength: number
  /** Maximum distance between exact permission checks along a Stipple. */
  readonly maskCheckSpacing: number
  /** Blue-noise exclusion distance selected only by Stipple density. */
  readonly minimumSpacing: number
  /** Permission-weighted requested mark count selected by Stipple density. */
  readonly targetCount: number
}

/** One ordered Stipple before its two endpoints are materialized. */
export interface StippleMark {
  readonly center: Readonly<Point>
  /** Unbiased direction in radians. */
  readonly orientation: number
}

/** One immutable center sample from the equal-area demand lattice. */
export interface StipplingDemandSample {
  readonly point: Readonly<Point>
  /** Desired darkness, independent of permission. */
  readonly tone: number
  /** Ink permission, independent of desired darkness. */
  readonly permission: number
  /** Effective demand: `tone * permission`. */
  readonly demand: number
}

/** Fixed equal-area center-sampled representation of effective demand. */
export interface StipplingDemandLattice {
  readonly frame: Readonly<CoordinateSpace>
  readonly columns: number
  readonly rows: number
  readonly cellWidth: number
  readonly cellHeight: number
  readonly cellArea: number
  readonly sampleCount: number
  readonly demandSum: number
  readonly averageDemand: number
  readonly samples: readonly StipplingDemandSample[]
}

/** Immutable target model shared by placement and bounded refinement. */
export interface StipplingModel {
  readonly source: ToneSource
  readonly frame: Readonly<CoordinateSpace>
  readonly controls: Readonly<StipplingControls>
  readonly scales: Readonly<StipplingScales>
  readonly lattice: Readonly<StipplingDemandLattice>

  /**
   * Compare the actual ordered complete or partial marks with effective demand.
   * The result is finite and invariant under proportional Frame scaling.
   */
  distributionError(marks: readonly StippleMark[]): number
}
