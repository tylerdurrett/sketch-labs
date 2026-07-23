/**
 * Once-owned boundary extraction from a completed Watercolor Forms selection.
 *
 * Evidence is aggregated over each complete surviving interface before the
 * authored strength threshold is applied. Only then are the partition's
 * canonical right/down unit segments emitted, so weak micro-forms cannot leak
 * back into geometry and shared outlines can never be doubled.
 */

import { WATERCOLOR_FORMS_LIMITS } from './limits'
import type { WatercolorFormSelection } from './forms'
import type {
  SelectedWatercolorForms,
  SharedBoundarySegment,
} from './types'

const TRANSPARENT_SUPPORT_REGION_ID = -1

interface InterfaceEvidence {
  readonly outputFirstRegionId: number
  readonly outputSecondRegionId: number
  strengthLengthSum: number
  length: number
  hasAlphaEvidence: boolean
  readonly segments: Readonly<SharedBoundarySegment>[]
}

export interface WatercolorBoundaryExtractionLimits {
  readonly maxRetainedBoundarySegmentCount?: number
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function validLimit(value: number | undefined): boolean {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= WATERCOLOR_FORMS_LIMITS.maxRetainedBoundarySegmentCount)
  )
}

function pairKey(firstRegionId: number, secondRegionId: number): string {
  return `${Math.min(firstRegionId, secondRegionId)}:${Math.max(
    firstRegionId,
    secondRegionId,
  )}`
}

function segmentLength(segment: Readonly<SharedBoundarySegment>): number {
  return Math.hypot(
    segment.end[0] - segment.start[0],
    segment.end[1] - segment.start[1],
  )
}

function canonicalSegmentOrder(
  first: Readonly<SharedBoundarySegment>,
  second: Readonly<SharedBoundarySegment>,
): number {
  return (
    Math.min(first.start[1], first.end[1]) -
      Math.min(second.start[1], second.end[1]) ||
    Math.min(first.start[0], first.end[0]) -
      Math.min(second.start[0], second.end[0]) ||
    Math.max(first.start[1], first.end[1]) -
      Math.max(second.start[1], second.end[1]) ||
    Math.max(first.start[0], first.end[0]) -
      Math.max(second.start[0], second.end[0]) ||
    first.id - second.id
  )
}

function frozenPoint(
  point: readonly [number, number],
): readonly [number, number] {
  return Object.freeze([point[0], point[1]])
}

function frozenSegment(
  segment: Readonly<SharedBoundarySegment>,
  interfaceEvidence: Readonly<InterfaceEvidence>,
  strength: number,
): Readonly<SharedBoundarySegment> {
  return Object.freeze({
    id: segment.id,
    regionIds: Object.freeze([
      interfaceEvidence.outputFirstRegionId,
      interfaceEvidence.outputSecondRegionId,
    ]) as readonly [number, number],
    start: frozenPoint(segment.start),
    end: frozenPoint(segment.end),
    strength,
    provenance: interfaceEvidence.hasAlphaEvidence
      ? 'alpha-boundary'
      : 'visible-color',
  })
}

function emptyResult(
  selection: Readonly<WatercolorFormSelection>,
): Readonly<SelectedWatercolorForms> {
  return Object.freeze({
    hierarchy: selection.hierarchy,
    regionIds: Object.freeze([...selection.regionIds]),
    sharedBoundarySegments: Object.freeze([]),
  })
}

/**
 * Extract significant shared interfaces from an already-suppressed selection.
 *
 * Transparent support is assigned one deterministic non-negative sentinel
 * above every hierarchy ID. That preserves alpha silhouettes for the tracing
 * stage without pretending the sentinel is a selected visible form.
 */
export function extractWatercolorSharedBoundaries(
  selection: Readonly<WatercolorFormSelection>,
  boundaryStrengthInput: number,
  limits: Readonly<WatercolorBoundaryExtractionLimits> = {},
): Readonly<SelectedWatercolorForms> {
  if (
    limits === null ||
    typeof limits !== 'object' ||
    !validLimit(limits.maxRetainedBoundarySegmentCount)
  ) {
    return emptyResult(selection)
  }

  const partition = selection.hierarchy.partition
  const boundaryStrength = clampUnit(boundaryStrengthInput)
  const transparentOutputId =
    selection.hierarchy.regions.reduce(
      (maximum, region) => Math.max(maximum, region.id),
      -1,
    ) + 1
  const evidenceByInterface = new Map<string, InterfaceEvidence>()

  for (const segment of partition.sharedBoundarySegments) {
    const firstSampleId =
      segment.end[0] - segment.start[0] === 0
        ? Math.floor(segment.start[1]) * partition.raster.width +
          Math.floor(segment.start[0]) -
          1
        : (Math.floor(segment.start[1]) - 1) * partition.raster.width +
          Math.floor(segment.start[0])
    const secondSampleId =
      segment.end[0] - segment.start[0] === 0
        ? firstSampleId + 1
        : firstSampleId + partition.raster.width
    const firstRegionId = selection.regionBySample[firstSampleId]
    const secondRegionId = selection.regionBySample[secondSampleId]
    if (
      firstRegionId === undefined ||
      secondRegionId === undefined ||
      firstRegionId === secondRegionId ||
      (firstRegionId === TRANSPARENT_SUPPORT_REGION_ID &&
        secondRegionId === TRANSPARENT_SUPPORT_REGION_ID)
    ) {
      continue
    }

    const orderedFirstRegionId = Math.min(firstRegionId, secondRegionId)
    const orderedSecondRegionId = Math.max(firstRegionId, secondRegionId)
    const outputFirstRegionId =
      orderedFirstRegionId === TRANSPARENT_SUPPORT_REGION_ID
        ? orderedSecondRegionId
        : orderedFirstRegionId
    const outputSecondRegionId =
      orderedFirstRegionId === TRANSPARENT_SUPPORT_REGION_ID
        ? transparentOutputId
        : orderedSecondRegionId
    const key = pairKey(orderedFirstRegionId, orderedSecondRegionId)
    const length = segmentLength(segment)
    if (!Number.isFinite(length) || length <= 0) continue

    const existing = evidenceByInterface.get(key)
    if (existing === undefined) {
      evidenceByInterface.set(key, {
        outputFirstRegionId,
        outputSecondRegionId,
        strengthLengthSum: clampUnit(segment.strength) * length,
        length,
        hasAlphaEvidence: segment.provenance === 'alpha-boundary',
        segments: [segment],
      })
    } else {
      existing.strengthLengthSum += clampUnit(segment.strength) * length
      existing.length += length
      existing.hasAlphaEvidence ||= segment.provenance === 'alpha-boundary'
      existing.segments.push(segment)
    }
  }

  const retainedInterfaces = [...evidenceByInterface.values()]
    .map((evidence) => ({
      evidence,
      strength: clampUnit(evidence.strengthLengthSum / evidence.length),
    }))
    .filter(({ strength }) => strength >= boundaryStrength)
    .sort(
      (first, second) =>
        second.strength - first.strength ||
        first.evidence.outputFirstRegionId -
          second.evidence.outputFirstRegionId ||
        first.evidence.outputSecondRegionId -
          second.evidence.outputSecondRegionId,
    )

  const cap =
    limits.maxRetainedBoundarySegmentCount ??
    WATERCOLOR_FORMS_LIMITS.maxRetainedBoundarySegmentCount
  const retainedSegments: Readonly<SharedBoundarySegment>[] = []
  for (const { evidence, strength } of retainedInterfaces) {
    for (const segment of [...evidence.segments].sort(canonicalSegmentOrder)) {
      if (retainedSegments.length >= cap) break
      retainedSegments.push(frozenSegment(segment, evidence, strength))
    }
    if (retainedSegments.length >= cap) break
  }

  return Object.freeze({
    hierarchy: selection.hierarchy,
    regionIds: Object.freeze([...selection.regionIds]),
    sharedBoundarySegments: Object.freeze(retainedSegments),
  })
}
