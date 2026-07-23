/**
 * Stable anchor inventory and authored-detail admission for Flowing Contours.
 *
 * Anchor discovery is deliberately independent of Curve detail. It finds
 * subpixel ridge maxima, ranks them by contour support, and greedily keeps a
 * spatially separated set. Curve detail can then expose only a nested prefix
 * of that fixed inventory. This prevents a detail change from moving, dropping,
 * or reordering an already eligible strong starting point.
 */

import type { Point } from '../../types'
import {
  terminateFlowingContoursAtSafetyLimit,
  type FlowingContoursAccounting,
} from './accounting'
import { sampleFlowingContoursField } from './field'
import {
  canConsumeFlowingContoursLimit,
  FLOWING_CONTOURS_LIMITS,
  isWithinFlowingContoursLimit,
  type FlowingContoursLimits,
} from './limits'
import type {
  CorrectedFlowingRidgeSample,
  FlowingContoursAnchor,
  FlowingContoursField,
} from './types'

const EVIDENCE_EPSILON = 1e-12
const MINIMUM_SECONDARY_SCORE = 0.04
const MINIMUM_STRONG_SCORE = 0.16
const MINIMUM_COHERENCE = 0.2
const MAXIMUM_AMBIGUITY = 0.82
const MINIMUM_SEPARATION = 3
const MAXIMUM_SEPARATION = 8
const SEPARATION_DIAGONAL_DIVISOR = 48
const NORMAL_CORRECTION_SAMPLE_COUNT = 3

export type FlowingContoursAnchorStrength = 'strong' | 'secondary'

/**
 * One ranked FC01 anchor with its immutable admission evidence.
 *
 * `selectionScore` is not a trajectory score. It exists only to establish the
 * detail-independent anchor order and primary/secondary admission boundary.
 */
export interface RankedFlowingContoursAnchor extends FlowingContoursAnchor {
  readonly rank: number
  readonly selectionScore: number
  readonly strength: FlowingContoursAnchorStrength
}

/** Detached, stable inventory consumed by tracing and later suppression. */
export interface FlowingContoursAnchorInventory {
  readonly anchors: readonly Readonly<RankedFlowingContoursAnchor>[]
  readonly correctedRidgeSampleCount: number
  readonly strongAnchorCount: number
  readonly minimumSeparation: number
}

/**
 * A literal nested inventory prefix selected by authored Curve detail.
 *
 * The metadata makes the admission boundary inspectable without requiring a
 * tracing consumer to reproduce this policy.
 */
export interface FlowingContoursAnchorAdmission {
  readonly anchors: readonly Readonly<RankedFlowingContoursAnchor>[]
  readonly curveDetail: number
  readonly inventoryPrefixLength: number
  readonly minimumSelectionScore: number
}

interface AnchorCandidate {
  readonly fieldSampleIndex: number
  readonly sample: Readonly<CorrectedFlowingRidgeSample>
  readonly selectionScore: number
}

const EMPTY_ANCHORS =
  Object.freeze([]) as readonly Readonly<RankedFlowingContoursAnchor>[]

const EMPTY_INVENTORY: FlowingContoursAnchorInventory = Object.freeze({
  anchors: EMPTY_ANCHORS,
  correctedRidgeSampleCount: 0,
  strongAnchorCount: 0,
  minimumSeparation: MINIMUM_SEPARATION,
})

const EMPTY_ADMISSION: FlowingContoursAnchorAdmission = Object.freeze({
  anchors: EMPTY_ANCHORS,
  curveDetail: 0,
  inventoryPrefixLength: 0,
  minimumSelectionScore: MINIMUM_STRONG_SCORE,
})

function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function invalidate(accounting: FlowingContoursAccounting): void {
  accounting.termination = 'invalid-input'
  accounting.limitedBy = null
  accounting.correctedRidgeSampleCount = 0
  accounting.eligibleAnchorCount = 0
}

function isEmptyField(field: Readonly<FlowingContoursField>): boolean {
  return (
    field.sourceWidth === 0 &&
    field.sourceHeight === 0 &&
    field.width === 0 &&
    field.height === 0 &&
    field.luminance.length === 0 &&
    field.alpha.length === 0 &&
    field.positiveSupport.length === 0 &&
    field.contourEvidence.length === 0 &&
    field.tangentX.length === 0 &&
    field.tangentY.length === 0 &&
    field.tangentCoherence.length === 0 &&
    field.ambiguity.length === 0 &&
    field.ridgeScale.length === 0
  )
}

function hasValidFieldShape(field: Readonly<FlowingContoursField>): boolean {
  if (
    !Number.isSafeInteger(field.sourceWidth) ||
    field.sourceWidth <= 0 ||
    !Number.isSafeInteger(field.sourceHeight) ||
    field.sourceHeight <= 0 ||
    !Number.isSafeInteger(field.width) ||
    field.width <= 0 ||
    !Number.isSafeInteger(field.height) ||
    field.height <= 0
  ) {
    return false
  }
  const sampleCount = field.width * field.height
  if (
    !Number.isSafeInteger(sampleCount) ||
    field.luminance.length !== sampleCount ||
    field.alpha.length !== sampleCount ||
    field.positiveSupport.length !== sampleCount ||
    field.contourEvidence.length !== sampleCount ||
    field.tangentX.length !== sampleCount ||
    field.tangentY.length !== sampleCount ||
    field.tangentCoherence.length !== sampleCount ||
    field.ambiguity.length !== sampleCount ||
    field.ridgeScale.length !== sampleCount
  ) {
    return false
  }

  for (let index = 0; index < sampleCount; index += 1) {
    const tangentX = field.tangentX[index]!
    const tangentY = field.tangentY[index]!
    const tangentLength = Math.hypot(tangentX, tangentY)
    const values = [
      field.luminance[index]!,
      field.alpha[index]!,
      field.contourEvidence[index]!,
      field.tangentCoherence[index]!,
      field.ambiguity[index]!,
      field.ridgeScale[index]!,
    ]
    if (
      !Number.isFinite(tangentX) ||
      !Number.isFinite(tangentY) ||
      !Number.isFinite(tangentLength) ||
      values.some((value) => !Number.isFinite(value)) ||
      values[0]! < 0 ||
      values[0]! > 1 ||
      values[1]! < 0 ||
      values[1]! > 1 ||
      values[2]! < 0 ||
      values[2]! > 1 ||
      values[3]! < 0 ||
      values[3]! > 1 ||
      values[4]! < 0 ||
      values[4]! > 1 ||
      values[5]! < 0 ||
      typeof field.positiveSupport[index] !== 'boolean' ||
      field.positiveSupport[index] !== (values[1]! > 0) ||
      (values[2]! > EVIDENCE_EPSILON &&
        Math.abs(tangentLength - 1) > 1e-8)
    ) {
      return false
    }
  }
  return true
}

function bilinearEvidence(
  field: Readonly<FlowingContoursField>,
  point: Readonly<Point>,
): number | null {
  const x = point[0]
  const y = point[1]
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x > field.width - 1 ||
    y > field.height - 1
  ) {
    return null
  }
  const left = Math.floor(x)
  const top = Math.floor(y)
  const right = Math.min(left + 1, field.width - 1)
  const bottom = Math.min(top + 1, field.height - 1)
  const horizontal = x - left
  const vertical = y - top
  const topValue =
    field.contourEvidence[top * field.width + left]! * (1 - horizontal) +
    field.contourEvidence[top * field.width + right]! * horizontal
  const bottomValue =
    field.contourEvidence[bottom * field.width + left]! * (1 - horizontal) +
    field.contourEvidence[bottom * field.width + right]! * horizontal
  const value = topValue * (1 - vertical) + bottomValue * vertical
  return Number.isFinite(value) ? value : null
}

function selectionScore(
  sample: Readonly<CorrectedFlowingRidgeSample>,
): number {
  // Evidence remains the dominant term. Coherence can strengthen a supported
  // ridge, while ambiguity can only reduce its suitability as a seed.
  return clampUnit(
    sample.evidence *
      (0.45 + 0.55 * sample.coherence) *
      (1 - 0.7 * sample.ambiguity),
  )
}

function correctedCandidate(
  field: Readonly<FlowingContoursField>,
  fieldSampleIndex: number,
): AnchorCandidate | null {
  if (
    !field.positiveSupport[fieldSampleIndex] ||
    field.contourEvidence[fieldSampleIndex]! <= EVIDENCE_EPSILON
  ) {
    return null
  }

  const x = fieldSampleIndex % field.width
  const y = Math.floor(fieldSampleIndex / field.width)
  const tangentX = field.tangentX[fieldSampleIndex]!
  const tangentY = field.tangentY[fieldSampleIndex]!
  const normalX = -tangentY
  const normalY = tangentX
  const centerEvidence = field.contourEvidence[fieldSampleIndex]!
  const minusEvidence = bilinearEvidence(field, [
    x - normalX,
    y - normalY,
  ])
  const plusEvidence = bilinearEvidence(field, [
    x + normalX,
    y + normalY,
  ])
  if (
    minusEvidence === null ||
    plusEvidence === null ||
    centerEvidence + EVIDENCE_EPSILON < minusEvidence ||
    centerEvidence + EVIDENCE_EPSILON < plusEvidence
  ) {
    return null
  }

  const denominator =
    minusEvidence - 2 * centerEvidence + plusEvidence
  const correction =
    denominator < -EVIDENCE_EPSILON
      ? Math.max(
          -0.5,
          Math.min(
            0.5,
            (0.5 * (minusEvidence - plusEvidence)) / denominator,
          ),
        )
      : 0
  const point: Point = [
    x + normalX * correction,
    y + normalY * correction,
  ]
  const sample = sampleFlowingContoursField(field, point)
  if (
    sample === null ||
    sample.evidence <= EVIDENCE_EPSILON ||
    sample.coherence < MINIMUM_COHERENCE ||
    sample.ambiguity > MAXIMUM_AMBIGUITY
  ) {
    return null
  }
  const score = selectionScore(sample)
  if (score + EVIDENCE_EPSILON < MINIMUM_SECONDARY_SCORE) return null
  return { fieldSampleIndex, sample, selectionScore: score }
}

function compareCandidates(
  left: Readonly<AnchorCandidate>,
  right: Readonly<AnchorCandidate>,
): number {
  if (left.selectionScore !== right.selectionScore) {
    return right.selectionScore - left.selectionScore
  }
  if (left.sample.evidence !== right.sample.evidence) {
    return right.sample.evidence - left.sample.evidence
  }
  if (left.sample.coherence !== right.sample.coherence) {
    return right.sample.coherence - left.sample.coherence
  }
  if (left.sample.ambiguity !== right.sample.ambiguity) {
    return left.sample.ambiguity - right.sample.ambiguity
  }
  // Row-major index is the canonical lexicographic (y, x) tie-break.
  return left.fieldSampleIndex - right.fieldSampleIndex
}

function minimumSeparation(field: Readonly<FlowingContoursField>): number {
  return Math.max(
    MINIMUM_SEPARATION,
    Math.min(
      MAXIMUM_SEPARATION,
      Math.hypot(field.width, field.height) /
        SEPARATION_DIAGONAL_DIVISOR,
    ),
  )
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`
}

function isSpatiallySeparated(
  candidate: Readonly<AnchorCandidate>,
  selected: readonly Readonly<AnchorCandidate>[],
  cells: ReadonlyMap<string, readonly number[]>,
  separation: number,
): boolean {
  const cellX = Math.floor(candidate.sample.point[0] / separation)
  const cellY = Math.floor(candidate.sample.point[1] / separation)
  const minimumDistanceSquared = separation * separation
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      const neighboring = cells.get(cellKey(cellX + offsetX, cellY + offsetY))
      if (neighboring === undefined) continue
      for (const selectedIndex of neighboring) {
        const point = selected[selectedIndex]!.sample.point
        const dx = candidate.sample.point[0] - point[0]
        const dy = candidate.sample.point[1] - point[1]
        if (dx * dx + dy * dy < minimumDistanceSquared) return false
      }
    }
  }
  return true
}

/**
 * Build one deterministic, spatially separated anchor inventory from FC05.
 *
 * Ridge correction samples the continuous field along the local normal. The
 * final rank and separation pass use corrected points, never grid-neighbor
 * connectivity. A lowered FC03 anchor cap returns the strongest stable prefix
 * and records the exact limiting policy.
 */
export function buildFlowingContoursAnchorInventory(
  field: Readonly<FlowingContoursField>,
  accounting: FlowingContoursAccounting,
  limits: Readonly<FlowingContoursLimits> = FLOWING_CONTOURS_LIMITS,
): Readonly<FlowingContoursAnchorInventory> {
  try {
    accounting.correctedRidgeSampleCount = 0
    accounting.eligibleAnchorCount = 0
    if (isEmptyField(field)) return EMPTY_INVENTORY
    if (
      accounting.termination === 'invalid-input' ||
      !hasValidFieldShape(field) ||
      !isWithinFlowingContoursLimit('anchor-count', 0, limits)
    ) {
      invalidate(accounting)
      return EMPTY_INVENTORY
    }
    if (
      !isWithinFlowingContoursLimit(
        'normal-search-sample-count',
        NORMAL_CORRECTION_SAMPLE_COUNT,
        limits,
      )
    ) {
      terminateFlowingContoursAtSafetyLimit(
        accounting,
        'normal-search-sample-count',
      )
      return EMPTY_INVENTORY
    }

    const candidates: AnchorCandidate[] = []
    for (
      let fieldSampleIndex = 0;
      fieldSampleIndex < field.contourEvidence.length;
      fieldSampleIndex += 1
    ) {
      const candidate = correctedCandidate(field, fieldSampleIndex)
      if (candidate !== null) candidates.push(candidate)
    }
    candidates.sort(compareCandidates)
    accounting.correctedRidgeSampleCount = candidates.length

    const separation = minimumSeparation(field)
    const selected: AnchorCandidate[] = []
    const cells = new Map<string, number[]>()
    for (const candidate of candidates) {
      if (!isSpatiallySeparated(candidate, selected, cells, separation)) {
        continue
      }
      if (
        !canConsumeFlowingContoursLimit(
          'anchor-count',
          selected.length,
          1,
          limits,
        )
      ) {
        terminateFlowingContoursAtSafetyLimit(accounting, 'anchor-count')
        break
      }
      const selectedIndex = selected.length
      selected.push(candidate)
      const cellX = Math.floor(candidate.sample.point[0] / separation)
      const cellY = Math.floor(candidate.sample.point[1] / separation)
      const key = cellKey(cellX, cellY)
      const cell = cells.get(key)
      if (cell === undefined) cells.set(key, [selectedIndex])
      else cell.push(selectedIndex)
    }

    const anchors = Object.freeze(
      selected.map((candidate, rank) =>
        Object.freeze({
          id: rank,
          rank,
          fieldSampleIndex: candidate.fieldSampleIndex,
          sample: candidate.sample,
          selectionScore: candidate.selectionScore,
          strength:
            candidate.selectionScore + EVIDENCE_EPSILON >=
            MINIMUM_STRONG_SCORE
              ? ('strong' as const)
              : ('secondary' as const),
        }),
      ),
    )
    const strongAnchorCount = anchors.findIndex(
      (anchor) => anchor.strength === 'secondary',
    )
    const inventory = Object.freeze({
      anchors,
      correctedRidgeSampleCount: candidates.length,
      strongAnchorCount:
        strongAnchorCount < 0 ? anchors.length : strongAnchorCount,
      minimumSeparation: separation,
    })
    return inventory
  } catch {
    invalidate(accounting)
    return EMPTY_INVENTORY
  }
}

/**
 * Admit a nested prefix of a previously built anchor inventory.
 *
 * Curve detail simultaneously grows the maximum prefix and lowers the weakest
 * secondary score. Since the inventory is sorted by that score, their
 * intersection is still a literal prefix; increasing detail can only append.
 */
export function admitFlowingContoursAnchors(
  inventory: Readonly<FlowingContoursAnchorInventory>,
  curveDetail: number,
  accounting: FlowingContoursAccounting,
): Readonly<FlowingContoursAnchorAdmission> {
  try {
    accounting.eligibleAnchorCount = 0
    if (!Number.isFinite(curveDetail) || curveDetail <= 0) {
      return EMPTY_ADMISSION
    }
    const detail = clampUnit(curveDetail)
    const detailPrefixLength = Math.min(
      inventory.anchors.length,
      Math.ceil(inventory.anchors.length * detail),
    )
    const minimumSelectionScore =
      MINIMUM_STRONG_SCORE -
      detail * (MINIMUM_STRONG_SCORE - MINIMUM_SECONDARY_SCORE)
    let scorePrefixLength = 0
    while (
      scorePrefixLength < inventory.anchors.length &&
      inventory.anchors[scorePrefixLength]!.selectionScore +
        EVIDENCE_EPSILON >=
        minimumSelectionScore
    ) {
      scorePrefixLength += 1
    }
    const inventoryPrefixLength = Math.min(
      detailPrefixLength,
      scorePrefixLength,
    )
    const anchors = Object.freeze(
      inventory.anchors.slice(0, inventoryPrefixLength),
    )
    accounting.eligibleAnchorCount = anchors.length
    return Object.freeze({
      anchors,
      curveDetail: detail,
      inventoryPrefixLength,
      minimumSelectionScore,
    })
  } catch {
    invalidate(accounting)
    return EMPTY_ADMISSION
  }
}
