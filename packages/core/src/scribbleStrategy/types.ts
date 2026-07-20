import type { CoordinateSpace } from '../scene'
import type { ScribbleScaleField } from '../scribbleScaleField'
import type { ToneSource } from '../shadingFields'
import type { NumberParamSpec } from '../sketch'
import type { Point } from '../types'

/** The six artist-facing controls shared by every Scribble Strategy consumer. */
export interface ScribbleControls {
  /** Relative mark abundance. More density means less darkness per pass. */
  readonly pathDensity: number
  /** Relative spatial size of all solver geometry. */
  readonly scribbleScale: number
  /** Preference for continuing along the current heading. */
  readonly momentum: number
  /** Amount of seeded directional variation. */
  readonly chaos: number
  /** Requested tonal accuracy before the strategy may report completion. */
  readonly toneFidelity: number
  /** Percentage of ordinary accepted-segment work to retain. */
  readonly stopPoint: number
}
export type ScribbleControlName = keyof ScribbleControls

/**
 * Public parameter declarations for Scribble's authored controls.
 *
 * Solver ratios are deliberately absent. They derive coherently from
 * `scribbleScale` in {@link resolveScribbleScales} rather than becoming UI.
 */
export const scribbleControlSchema = Object.freeze({
  pathDensity: {
    kind: 'number',
    min: 0.5,
    max: 20,
    default: 1,
    step: 0.05,
  },
  scribbleScale: {
    kind: 'number',
    min: 0.1,
    max: 2,
    default: 1,
    step: 0.05,
  },
  momentum: { kind: 'number', min: 0, max: 1, default: 0.75, step: 0.01 },
  chaos: { kind: 'number', min: 0, max: 1, default: 0.25, step: 0.01 },
  toneFidelity: {
    kind: 'number',
    min: 0,
    max: 1,
    default: 0.9,
    step: 0.01,
  },
  stopPoint: {
    kind: 'number',
    min: 0,
    max: 100,
    default: 100,
    step: 1,
    integer: true,
  },
} satisfies Record<ScribbleControlName, NumberParamSpec>)

/** Frozen defaults derived from the same declarations the Harness presents. */
export const defaultScribbleControls: Readonly<ScribbleControls> = Object.freeze({
  pathDensity: scribbleControlSchema.pathDensity.default,
  scribbleScale: scribbleControlSchema.scribbleScale.default,
  momentum: scribbleControlSchema.momentum.default,
  chaos: scribbleControlSchema.chaos.default,
  toneFidelity: scribbleControlSchema.toneFidelity.default,
  stopPoint: scribbleControlSchema.stopPoint.default,
})

/** Point-local geometry derived coherently from one Scribble scale sample. */
export interface ScribbleLocalScales {
  readonly segmentLength: number
  readonly coverageRadius: number
  readonly maskCheckSpacing: number
}

/** Internal authored fine/global lengths and thresholds for one run. */
export interface ScribbleScales extends ScribbleLocalScales {
  /** Geometric-mean frame extent: invariant for equal-area aspect changes. */
  readonly frameScale: number
  readonly residualSpacing: number
  /** Peak darkness added by one pass; inverse to authored path density. */
  readonly coveragePerPass: number
  /** Permission-weighted residual at or below which work is complete. */
  readonly completionThreshold: number
}

/** One deterministic fine-safe local-scale station on an exact segment. */
export interface ScribbleSegmentScaleSample {
  readonly point: Readonly<Point>
  /** Normalized position on the exact segment, including both 0 and 1. */
  readonly progress: number
  readonly scales: ScribbleLocalScales
}

/** Conservative local-scale bounds sampled along one exact segment. */
export interface ScribbleSegmentScaleProfile {
  readonly length: number
  readonly samples: readonly ScribbleSegmentScaleSample[]
  readonly minimumSegmentLength: number
  readonly minimumMaskCheckSpacing: number
  readonly maximumCoverageRadius: number
}

/** Fixed lattice geometry. Every cell has the same area and a center sample. */
export interface ScribbleLattice {
  readonly frame: Readonly<CoordinateSpace>
  readonly columns: number
  readonly rows: number
  readonly cellWidth: number
  readonly cellHeight: number
  readonly cellArea: number
  readonly sampleCount: number
}

/** A read-only snapshot of one residual-lattice cell. */
export interface ScribbleResidualSample {
  readonly point: Readonly<Point>
  /** Desired darkness, kept independent of mask permission. */
  readonly tone: number
  /** Ink permission, kept independent of desired darkness. */
  readonly permission: number
  readonly coverage: number
  readonly residual: number
}

/** Mutable virtual-coverage model owned by one deterministic strategy run. */
export interface ScribbleModel {
  readonly source: ToneSource
  readonly controls: Readonly<ScribbleControls>
  /** Optional spatial scale, kept independent of tone and authored controls. */
  readonly scaleField?: ScribbleScaleField
  /** Authored fine/global scales; never widened by the optional field. */
  readonly scales: ScribbleScales
  readonly lattice: ScribbleLattice

  /** Resolve coupled scene-unit geometry at one Composition Frame point. */
  localScalesAt(point: Readonly<Point>): ScribbleLocalScales
  /**
   * Profile exact-segment local geometry at authored-fine-safe intervals.
   * Invalid/non-finite geometry has no profile.
   */
  profileSegment(
    start: Readonly<Point>,
    end: Readonly<Point>,
  ): ScribbleSegmentScaleProfile | undefined
  /**
   * Apply the shared conservative scale, mask, and frame safety decision.
   * Without a field this is exactly the original uniform mask check.
   */
  isSegmentSafe(start: Readonly<Point>, end: Readonly<Point>): boolean

  /** `sum(permission * max(0, tone - coverage)) / sampleCount`. */
  residualError(): number
  /** Residual reconstructed at a Composition Frame point. */
  residualAt(point: Readonly<Point>): number
  /** Virtual coverage reconstructed at a Composition Frame point. */
  coverageAt(point: Readonly<Point>): number
  /** Visit current residuals row-major; return false to stop without snapshots. */
  visitResidualSamples(
    visit: (
      index: number,
      point: Readonly<Point>,
      residual: number,
    ) => boolean | void,
  ): void
  /** Stable row-major frozen snapshots of the current model state. */
  samples(): readonly ScribbleResidualSample[]
  /** Add one compact, smooth coverage footprint. */
  depositPoint(point: Readonly<Point>): void
  /** Add compact, smooth coverage around a complete line segment. */
  depositSegment(start: Readonly<Point>, end: Readonly<Point>): void
}
