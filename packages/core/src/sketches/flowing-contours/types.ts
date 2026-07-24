/**
 * Headless Flowing Contours pipeline contracts.
 *
 * The pipeline treats one bidirectionally searched trajectory as its atomic
 * unit. Collections and nested records are readonly so later fitting can
 * smooth a trajectory without discarding the evidence and gap provenance that
 * justified accepting it.
 */

import type { Scene } from '../../scene'
import type { Point } from '../../types'

/**
 * Stable endpoint inventory shared by tracing and aggregate diagnostics.
 *
 * The tuple is also the canonical iteration order when initializing counts.
 */
export const FLOWING_CONTOURS_ENDPOINT_REASONS = Object.freeze([
  'source-boundary',
  'alpha-boundary',
  'ambiguity',
  'curvature',
  'evidence-exhausted',
  'represented-collision',
  'safety-limit',
] as const)

export type FlowingContoursEndpointReason =
  (typeof FLOWING_CONTOURS_ENDPOINT_REASONS)[number]

/** A complete count inventory; callers may not omit a zero-count reason. */
export type FlowingContoursEndpointReasonCounts = Readonly<
  Record<FlowingContoursEndpointReason, number>
>

/**
 * Stable inventory of deterministic caps that can stop an otherwise valid
 * pipeline prefix.
 */
export const FLOWING_CONTOURS_LIMIT_NAMES = Object.freeze([
  'analysis-dimension',
  'analysis-sample-count',
  'scale-plane-count',
  'anchor-count',
  'normal-search-sample-count',
  'search-breadth',
  'search-step-count',
  'candidate-count',
  'weak-span-step-count',
  'weak-span-distance',
  'accepted-curve-count',
  'raw-trajectory-point-count',
  'fitted-curve-point-count',
  'primitive-count',
] as const)

export type FlowingContoursLimitName =
  (typeof FLOWING_CONTOURS_LIMIT_NAMES)[number]

/** Why generation stopped; empty valid inputs still report `complete`. */
export type FlowingContoursTermination =
  | 'complete'
  | 'invalid-input'
  | 'limit-reached'

/**
 * Immutable bounded raster field consumed by anchor selection and tracing.
 *
 * All row-major arrays have `width * height` entries. Tangents are continuous
 * unit-vector components, not quantized lattice directions; `ridgeScale`
 * records which bounded analysis scale supplied the strongest local evidence.
 */
export interface FlowingContoursField {
  readonly sourceWidth: number
  readonly sourceHeight: number
  readonly width: number
  readonly height: number
  readonly luminance: readonly number[]
  readonly alpha: readonly number[]
  readonly positiveSupport: readonly boolean[]
  readonly contourEvidence: readonly number[]
  readonly tangentX: readonly number[]
  readonly tangentY: readonly number[]
  readonly tangentCoherence: readonly number[]
  readonly ambiguity: readonly number[]
  readonly ridgeScale: readonly number[]
}

/**
 * Stable artistic signal hypotheses searched without collapsing their
 * orientations into one per-pixel winner.
 *
 * `broad-form` owns the widest bounded tangent scale, `mid-form` reuses the
 * existing intermediate responses, and `local-detail` retains the established
 * multiscale proof field. All share one prepared-raster extent and support mask.
 */
export const FLOWING_CONTOURS_FIELD_HYPOTHESIS_KINDS = Object.freeze([
  'broad-form',
  'mid-form',
  'local-detail',
] as const)

export type FlowingContoursFieldHypothesisKind =
  (typeof FLOWING_CONTOURS_FIELD_HYPOTHESIS_KINDS)[number]

export interface FlowingContoursFieldHypothesis {
  readonly kind: FlowingContoursFieldHypothesisKind
  readonly field: Readonly<FlowingContoursField>
}

/**
 * Bounded, stable-order field ensemble.
 *
 * Search remains whole-candidate-first inside each member. The pipeline owns
 * one global accounting record and projects only accepted geometry into shared
 * occupancy; candidate, fitting, and evidence-tube provenance stay bound to
 * the exact member field that produced them.
 */
export interface FlowingContoursFieldEnsemble {
  readonly hypotheses: readonly Readonly<FlowingContoursFieldHypothesis>[]
}

/**
 * One subpixel ridge observation corrected away from the analysis lattice.
 *
 * Keeping the continuous tangent with each sample prevents later stages from
 * reconstructing direction from grid-shaped point-to-point steps.
 */
export interface CorrectedFlowingRidgeSample {
  readonly point: Readonly<Point>
  readonly tangent: Readonly<Point>
  readonly evidence: number
  readonly coherence: number
  readonly ambiguity: number
  readonly scale: number
  readonly alpha: number
}

/** One stable, deterministically ordered starting point for whole-curve search. */
export interface FlowingContoursAnchor {
  readonly id: number
  readonly fieldSampleIndex: number
  readonly sample: Readonly<CorrectedFlowingRidgeSample>
}

/**
 * Evidence provenance for one contiguous run of trajectory segments.
 *
 * `bounded-gap` is the only unsupported-travel representation. Its boundary
 * evidence and directional alignment make the justification independently
 * inspectable rather than hiding a bridge inside a smoothed curve.
 */
export interface FlowingContoursSpanSupportProvenance {
  readonly kind: 'direct-evidence' | 'bounded-gap'
  readonly startSampleIndex: number
  readonly endSampleIndex: number
  readonly length: number
  readonly entryEvidence: number
  readonly exitEvidence: number
  readonly directionalAlignment: number
}

/** Search in one tangent direction from an anchor to one documented endpoint. */
export interface FlowingContoursDirectionalTrace {
  readonly direction: 'forward' | 'backward'
  readonly samples: readonly Readonly<CorrectedFlowingRidgeSample>[]
  readonly spanSupport: readonly Readonly<FlowingContoursSpanSupportProvenance>[]
  readonly endpointReason: FlowingContoursEndpointReason
  readonly searchStepCount: number
}

/** Explicit terms in the deterministic objective for an entire candidate. */
export interface FlowingContoursCandidateScore {
  readonly accumulatedEvidence: number
  readonly usefulLength: number
  readonly directionalCoherence: number
  readonly curvaturePenalty: number
  readonly unsupportedTravelPenalty: number
  readonly ambiguityPenalty: number
  readonly representedOverlapPenalty: number
  readonly total: number
}

/**
 * A complete candidate assembled from both directional searches.
 *
 * Acceptance is decided on this whole value; neither directional fragment is
 * independently eligible for fitting or Scene emission.
 */
export interface FlowingContoursCandidate {
  readonly anchor: Readonly<FlowingContoursAnchor>
  readonly backward: Readonly<FlowingContoursDirectionalTrace>
  readonly forward: Readonly<FlowingContoursDirectionalTrace>
  /** Canonical start-to-end samples with the shared anchor present once. */
  readonly samples: readonly Readonly<CorrectedFlowingRidgeSample>[]
  readonly spanSupport: readonly Readonly<FlowingContoursSpanSupportProvenance>[]
  readonly length: number
  readonly score: Readonly<FlowingContoursCandidateScore>
}

/**
 * Accepted pre-fit geometry and the evidence accounting that justified it.
 *
 * These corrected raw samples survive the fitting stage so tests and reference
 * evidence can distinguish supported flow from a visually smooth shortcut.
 */
export interface AcceptedFlowingTrajectory {
  readonly id: number
  readonly anchorId: number
  readonly samples: readonly Readonly<CorrectedFlowingRidgeSample>[]
  readonly spanSupport: readonly Readonly<FlowingContoursSpanSupportProvenance>[]
  readonly startEndpointReason: FlowingContoursEndpointReason
  readonly endEndpointReason: FlowingContoursEndpointReason
  readonly length: number
  readonly maximumUnsupportedSpanLength: number
  readonly totalUnsupportedSpanLength: number
  readonly score: Readonly<FlowingContoursCandidateScore>
}

/**
 * Provenance retained beside one regularized curve.
 *
 * The source identity joins the fitted points to `acceptedTrajectories`;
 * evidence-tube and measured-deviation values make the fitting bound auditable.
 */
export interface FlowingContoursFittingProvenance {
  readonly sourceTrajectoryId: number
  /** For each fitted point, the nearest corrected raw sample in stable order. */
  readonly sourceSampleIndices: readonly number[]
  readonly evidenceTubeRadius: number
  readonly maximumDeviation: number
}

/** One smooth curve ready for frame mapping and ordinary Scene construction. */
export interface FittedFlowingCurve {
  readonly points: readonly Readonly<Point>[]
  readonly provenance: Readonly<FlowingContoursFittingProvenance>
}

/** Immutable bounded-work, search, provenance, and output accounting. */
export interface FlowingContoursDiagnostics {
  readonly termination: FlowingContoursTermination
  readonly limitedBy: FlowingContoursLimitName | null
  readonly analysisWidth: number
  readonly analysisHeight: number
  readonly analysisSampleCount: number
  readonly contourEvidenceSampleCount: number
  readonly correctedRidgeSampleCount: number
  readonly eligibleAnchorCount: number
  readonly processedAnchorCount: number
  readonly directionalTraceCount: number
  readonly searchStepCount: number
  readonly candidateCount: number
  readonly acceptedCandidateCount: number
  readonly rejectedCandidateCount: number
  readonly suppressedAnchorCount: number
  readonly suppressedEvidenceSampleCount: number
  readonly endpointReasonCounts: FlowingContoursEndpointReasonCounts
  readonly rawTrajectoryCount: number
  readonly rawTrajectoryPointCount: number
  readonly acceptedMaximumUnsupportedSpanLength: number
  readonly acceptedTotalUnsupportedSpanLength: number
  readonly fittedCurveCount: number
  readonly fittedCurvePointCount: number
  readonly primitiveCount: number
}

/**
 * Internal pipeline result retaining both accepted evidence and fitted curves.
 *
 * Scene construction may consume `fittedCurves`, but diagnostics and tests can
 * still inspect the corrected raw trajectories that preceded regularization.
 */
export interface FlowingContoursPipelineResult {
  readonly acceptedTrajectories: readonly Readonly<AcceptedFlowingTrajectory>[]
  readonly fittedCurves: readonly Readonly<FittedFlowingCurve>[]
  readonly diagnostics: Readonly<FlowingContoursDiagnostics>
}

/** Ordinary vector output plus immutable Flowing Contours diagnostics. */
export interface FlowingContoursGeneratorResult {
  readonly scene: Scene
  readonly diagnostics: Readonly<FlowingContoursDiagnostics>
}
