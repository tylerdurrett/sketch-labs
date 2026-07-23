/**
 * Bounded one-direction Flowing Contours growth.
 *
 * Weak ridge observations are provisional. They become public trajectory
 * samples only when compatible corrected evidence is found on the far side;
 * every other stop rolls the provisional suffix back to the last directly
 * supported sample.
 */

import type { Point } from '../../types'
import {
  compareFlowingContoursObjectiveOrder,
  scoreFlowingContoursCandidate,
} from './objective'
import {
  FLOWING_CONTOURS_LIMITS,
  isWithinFlowingContoursLimit,
  type FlowingContoursLimits,
} from './limits'
import {
  stepFlowingContoursRidge,
  type FlowingRidgeStepOptions,
} from './ridge'
import type {
  CorrectedFlowingRidgeSample,
  FlowingContoursDirectionalTrace,
  FlowingContoursEndpointReason,
  FlowingContoursField,
  FlowingContoursSpanSupportProvenance,
} from './types'

const VECTOR_EPSILON = 1e-12
const GAP_ALIGNMENT_FLOOR = 0.75
const DEFAULT_REPRESENTED_COLLISION_THRESHOLD = 0.7
const DEFAULT_RIDGE_OPTIONS = Object.freeze({}) as FlowingRidgeStepOptions
const EMPTY_ALTERNATIVES =
  Object.freeze([]) as readonly Readonly<Point>[]

/**
 * A pure occupancy query. It is called at most once for the anchor and once
 * per consumed search step, so its total work is bounded by FC03 accounting.
 */
export type FlowingContoursRepresentedOverlapSampler = (
  point: Readonly<Point>,
) => number

export interface FlowingContoursDirectionalGrowthOptions {
  /** Normalized authored control; changes weak travel allowance only. */
  readonly continuity: number
  /** Normalized authored control; changes objective curvature cost only. */
  readonly flowSmoothing: number
  /** FC07 policy, independent of Continuity and Flow smoothing. */
  readonly ridgeStepOptions?: Readonly<FlowingRidgeStepOptions>
  /**
   * Stable signed alternatives for the bounded beam. The primary requested
   * direction is always first and every alternative must share its sign.
   */
  readonly directionAlternatives?: readonly Readonly<Point>[]
  readonly representedOverlapSampler?: FlowingContoursRepresentedOverlapSampler
  readonly representedCollisionThreshold?: number
}

interface ResolvedOptions {
  readonly continuity: number
  readonly flowSmoothing: number
  readonly ridgeStepOptions: Readonly<FlowingRidgeStepOptions>
  readonly directions: readonly Readonly<Point>[]
  readonly representedOverlapSampler:
    | FlowingContoursRepresentedOverlapSampler
    | null
  readonly representedCollisionThreshold: number
}

interface SearchState {
  readonly stableId: number
  readonly samples: readonly Readonly<CorrectedFlowingRidgeSample>[]
  readonly spanSupport: readonly Readonly<FlowingContoursSpanSupportProvenance>[]
  readonly current: Readonly<CorrectedFlowingRidgeSample>
  readonly travelDirection: Readonly<Point>
  readonly provisional: readonly Readonly<CorrectedFlowingRidgeSample>[]
  readonly provisionalLength: number
  readonly provisionalMinimumAlignment: number
  readonly weakStepCount: number
  readonly length: number
  readonly overlapSum: number
  readonly endpointReason: FlowingContoursEndpointReason | null
}

function frozenPoint(x: number, y: number): Readonly<Point> {
  return Object.freeze([x, y] as Point)
}

function unit(vector: Readonly<Point>): Readonly<Point> | null {
  const x = vector[0]
  const y = vector[1]
  const length = Math.hypot(x, y)
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(length) ||
    length <= VECTOR_EPSILON
  ) {
    return null
  }
  return frozenPoint(x / length, y / length)
}

function aligned(
  tangent: Readonly<Point>,
  direction: Readonly<Point>,
): { readonly tangent: Readonly<Point>; readonly alignment: number } | null {
  const tangentUnit = unit(tangent)
  const directionUnit = unit(direction)
  if (tangentUnit === null || directionUnit === null) return null
  const sign =
    tangentUnit[0] * directionUnit[0] +
      tangentUnit[1] * directionUnit[1] <
    0
      ? -1
      : 1
  const signed = frozenPoint(tangentUnit[0] * sign, tangentUnit[1] * sign)
  return Object.freeze({
    tangent: signed,
    alignment: Math.max(
      -1,
      Math.min(
        1,
        signed[0] * directionUnit[0] + signed[1] * directionUnit[1],
      ),
    ),
  })
}

function snapshotSample(
  source: Readonly<CorrectedFlowingRidgeSample>,
  direction?: Readonly<Point>,
): Readonly<CorrectedFlowingRidgeSample> | null {
  try {
    const point = frozenPoint(source.point[0], source.point[1])
    const tangent = direction
      ? aligned(source.tangent, direction)?.tangent
      : unit(source.tangent)
    if (
      tangent == null ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1]) ||
      !Number.isFinite(source.evidence) ||
      source.evidence < 0 ||
      source.evidence > 1 ||
      !Number.isFinite(source.coherence) ||
      source.coherence < 0 ||
      source.coherence > 1 ||
      !Number.isFinite(source.ambiguity) ||
      source.ambiguity < 0 ||
      source.ambiguity > 1 ||
      !Number.isFinite(source.scale) ||
      source.scale <= 0 ||
      !Number.isFinite(source.alpha) ||
      source.alpha <= 0 ||
      source.alpha > 1
    ) {
      return null
    }
    return Object.freeze({
      point,
      tangent,
      evidence: source.evidence,
      coherence: source.coherence,
      ambiguity: source.ambiguity,
      scale: source.scale,
      alpha: source.alpha,
    })
  } catch {
    return null
  }
}

function distance(
  first: Readonly<CorrectedFlowingRidgeSample>,
  second: Readonly<CorrectedFlowingRidgeSample>,
): number {
  return Math.hypot(
    second.point[0] - first.point[0],
    second.point[1] - first.point[1],
  )
}

function gapDirectionalAlignment(
  entry: Readonly<CorrectedFlowingRidgeSample>,
  sample: Readonly<CorrectedFlowingRidgeSample>,
): number {
  const displacement = unit([
    sample.point[0] - entry.point[0],
    sample.point[1] - entry.point[1],
  ])
  if (displacement === null) return -1
  return Math.min(
    entry.tangent[0] * sample.tangent[0] +
      entry.tangent[1] * sample.tangent[1],
    entry.tangent[0] * displacement[0] +
      entry.tangent[1] * displacement[1],
    sample.tangent[0] * displacement[0] +
      sample.tangent[1] * displacement[1],
  )
}

function limitValue(
  name:
    | 'search-breadth'
    | 'search-step-count'
    | 'weak-span-step-count'
    | 'weak-span-distance',
  limits: Readonly<FlowingContoursLimits>,
): number | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(limits, name)
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      !isWithinFlowingContoursLimit(name, descriptor.value, limits)
    ) {
      return null
    }
    return descriptor.value
  } catch {
    return null
  }
}

function resolveOptions(
  requestedDirection: Readonly<Point>,
  options: Readonly<FlowingContoursDirectionalGrowthOptions>,
  limits: Readonly<FlowingContoursLimits>,
): ResolvedOptions | null {
  try {
    const primary = unit(requestedDirection)
    const breadth = limitValue('search-breadth', limits)
    if (
      primary === null ||
      breadth === null ||
      breadth < 1 ||
      !Number.isFinite(options.continuity) ||
      options.continuity < 0 ||
      options.continuity > 1 ||
      !Number.isFinite(options.flowSmoothing) ||
      options.flowSmoothing < 0 ||
      options.flowSmoothing > 1
    ) {
      return null
    }

    const suppliedAlternatives =
      options.directionAlternatives ?? EMPTY_ALTERNATIVES
    if (
      !Array.isArray(suppliedAlternatives) ||
      suppliedAlternatives.length + 1 > breadth
    ) {
      return null
    }
    const directions = [primary]
    for (const alternative of suppliedAlternatives) {
      const candidate = unit(alternative)
      if (
        candidate === null ||
        candidate[0] * primary[0] + candidate[1] * primary[1] <=
          VECTOR_EPSILON
      ) {
        return null
      }
      directions.push(candidate)
    }

    const sampler = options.representedOverlapSampler ?? null
    const threshold =
      options.representedCollisionThreshold ??
      DEFAULT_REPRESENTED_COLLISION_THRESHOLD
    if (
      (sampler !== null && typeof sampler !== 'function') ||
      !Number.isFinite(threshold) ||
      threshold < 0 ||
      threshold > 1
    ) {
      return null
    }

    return Object.freeze({
      continuity: options.continuity,
      flowSmoothing: options.flowSmoothing,
      ridgeStepOptions: options.ridgeStepOptions ?? DEFAULT_RIDGE_OPTIONS,
      directions: Object.freeze(directions),
      representedOverlapSampler: sampler,
      representedCollisionThreshold: threshold,
    })
  } catch {
    return null
  }
}

function sampleOverlap(
  sampler: FlowingContoursRepresentedOverlapSampler | null,
  point: Readonly<Point>,
): number | null {
  if (sampler === null) return 0
  try {
    const value = sampler(point)
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null
  } catch {
    return null
  }
}

function appendDirectSpan(
  spans: readonly Readonly<FlowingContoursSpanSupportProvenance>[],
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
  next: Readonly<CorrectedFlowingRidgeSample>,
  segmentLength: number,
  alignment: number,
): readonly Readonly<FlowingContoursSpanSupportProvenance>[] {
  const endSampleIndex = samples.length
  const previous = spans[spans.length - 1]
  if (
    previous?.kind === 'direct-evidence' &&
    previous.endSampleIndex === endSampleIndex - 1
  ) {
    return Object.freeze([
      ...spans.slice(0, -1),
      Object.freeze({
        ...previous,
        endSampleIndex,
        length: previous.length + segmentLength,
        exitEvidence: next.evidence,
        directionalAlignment: Math.min(
          previous.directionalAlignment,
          alignment,
        ),
      }),
    ])
  }
  return Object.freeze([
    ...spans,
    Object.freeze({
      kind: 'direct-evidence' as const,
      startSampleIndex: endSampleIndex - 1,
      endSampleIndex,
      length: segmentLength,
      entryEvidence: samples[endSampleIndex - 1]!.evidence,
      exitEvidence: next.evidence,
      directionalAlignment: alignment,
    }),
  ])
}

function prefixOrderKey(
  state: Readonly<SearchState>,
  field: Readonly<FlowingContoursField>,
  flowSmoothing: number,
) {
  const samples = [...state.samples, ...state.provisional]
  let evidence = 0
  let ambiguity = 0
  let alignment = 0
  let curvatureChange = 0
  let previousTurn = 0
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!
    evidence += sample.evidence
    ambiguity += sample.ambiguity
    if (index === 0) continue
    const previous = samples[index - 1]!
    const dot = Math.max(
      -1,
      Math.min(
        1,
        previous.tangent[0] * sample.tangent[0] +
          previous.tangent[1] * sample.tangent[1],
      ),
    )
    alignment += Math.max(0, dot)
    const turn = Math.acos(dot)
    if (index > 1) curvatureChange += Math.abs(turn - previousTurn) / Math.PI
    previousTurn = turn
  }
  const segmentCount = Math.max(1, samples.length - 1)
  const diagonal = Math.max(1, Math.hypot(field.width, field.height))
  return {
    score: scoreFlowingContoursCandidate(
      {
        accumulatedEvidence: evidence / Math.max(1, samples.length),
        usefulLength: (state.length + state.provisionalLength) / diagonal,
        directionalCoherence: alignment / segmentCount,
        curvatureChange: curvatureChange / segmentCount,
        unsupportedTravel: state.provisionalLength / diagonal,
        ambiguity: ambiguity / Math.max(1, samples.length),
        representedOverlap:
          state.overlapSum / Math.max(1, samples.length),
      },
      flowSmoothing,
    ),
    stableId: state.stableId,
    sampleIndex: samples.length - 1,
    point: state.current.point,
  }
}

function orderStates(
  first: Readonly<SearchState>,
  second: Readonly<SearchState>,
  field: Readonly<FlowingContoursField>,
  flowSmoothing: number,
): number {
  return compareFlowingContoursObjectiveOrder(
    prefixOrderKey(first, field, flowSmoothing),
    prefixOrderKey(second, field, flowSmoothing),
  )
}

function stopped(
  state: Readonly<SearchState>,
  reason: FlowingContoursEndpointReason,
): SearchState {
  const current = state.samples[state.samples.length - 1]!
  return {
    ...state,
    current,
    travelDirection: current.tangent,
    provisional: Object.freeze([]),
    provisionalLength: 0,
    provisionalMinimumAlignment: 1,
    weakStepCount: 0,
    endpointReason: reason,
  }
}

function freezeTrace(
  direction: 'forward' | 'backward',
  state: Readonly<SearchState> | null,
  searchStepCount: number,
  fallbackSamples: readonly Readonly<CorrectedFlowingRidgeSample>[],
): Readonly<FlowingContoursDirectionalTrace> {
  const samples = Object.freeze([...(state?.samples ?? fallbackSamples)])
  const spanSupport = Object.freeze([...(state?.spanSupport ?? [])])
  return Object.freeze({
    direction: direction === 'backward' ? 'backward' : 'forward',
    samples,
    spanSupport,
    endpointReason: state?.endpointReason ?? 'safety-limit',
    searchStepCount,
  })
}

/**
 * Grow one signed trace from `start`.
 *
 * The returned `searchStepCount` is total beam work, including failed and
 * rolled-back weak hypotheses. The start sample appears exactly once in every
 * valid trace.
 */
export function growFlowingContoursDirection(
  field: Readonly<FlowingContoursField>,
  start: Readonly<CorrectedFlowingRidgeSample>,
  requestedDirection: Readonly<Point>,
  direction: 'forward' | 'backward',
  options: Readonly<FlowingContoursDirectionalGrowthOptions>,
  limits: Readonly<FlowingContoursLimits> = FLOWING_CONTOURS_LIMITS,
): Readonly<FlowingContoursDirectionalTrace> {
  const initialDirection = unit(requestedDirection)
  const anchor =
    initialDirection === null ? null : snapshotSample(start, initialDirection)
  const fallbackSamples = anchor === null ? Object.freeze([]) : [anchor]

  try {
    const resolved = resolveOptions(requestedDirection, options, limits)
    const searchStepLimit = limitValue('search-step-count', limits)
    const weakStepLimit = limitValue('weak-span-step-count', limits)
    const weakDistanceLimit = limitValue('weak-span-distance', limits)
    if (
      (direction !== 'forward' && direction !== 'backward') ||
      anchor === null ||
      resolved === null ||
      searchStepLimit === null ||
      weakStepLimit === null ||
      weakDistanceLimit === null
    ) {
      return freezeTrace(direction, null, 0, fallbackSamples)
    }

    const anchorOverlap = sampleOverlap(
      resolved.representedOverlapSampler,
      anchor.point,
    )
    if (anchorOverlap === null) {
      return freezeTrace(direction, null, 0, fallbackSamples)
    }
    if (anchorOverlap >= resolved.representedCollisionThreshold) {
      const state: SearchState = {
        stableId: 0,
        samples: Object.freeze([anchor]),
        spanSupport: Object.freeze([]),
        current: anchor,
        travelDirection: resolved.directions[0]!,
        provisional: Object.freeze([]),
        provisionalLength: 0,
        provisionalMinimumAlignment: 1,
        weakStepCount: 0,
        length: 0,
        overlapSum: anchorOverlap,
        endpointReason: 'represented-collision',
      }
      return freezeTrace(direction, state, 0, fallbackSamples)
    }

    const allowedWeakSteps = Math.min(
      weakStepLimit,
      Math.floor(
        resolved.continuity *
          FLOWING_CONTOURS_LIMITS['weak-span-step-count'],
      ),
    )
    const allowedWeakDistance = Math.min(
      weakDistanceLimit,
      resolved.continuity *
        FLOWING_CONTOURS_LIMITS['weak-span-distance'],
    )
    let active: SearchState[] = resolved.directions.map(
      (travelDirection, stableId) => ({
        stableId,
        samples: Object.freeze([anchor]),
        spanSupport: Object.freeze([]),
        current: anchor,
        travelDirection,
        provisional: Object.freeze([]),
        provisionalLength: 0,
        provisionalMinimumAlignment: 1,
        weakStepCount: 0,
        length: 0,
        overlapSum: anchorOverlap,
        endpointReason: null,
      }),
    )
    const terminal: SearchState[] = []
    let searchStepCount = 0

    while (active.length > 0) {
      const next: SearchState[] = []
      for (let activeIndex = 0; activeIndex < active.length; activeIndex += 1) {
        const state = active[activeIndex]!
        if (searchStepCount >= searchStepLimit) {
          terminal.push(stopped(state, 'safety-limit'))
          for (
            let remainder = activeIndex + 1;
            remainder < active.length;
            remainder += 1
          ) {
            terminal.push(stopped(active[remainder]!, 'safety-limit'))
          }
          break
        }

        const step = stepFlowingContoursRidge(
          field,
          state.current,
          state.travelDirection,
          resolved.ridgeStepOptions,
          limits,
        )
        searchStepCount += 1

        if (step.kind !== 'corrected' && step.kind !== 'weak') {
          terminal.push(stopped(state, step.kind))
          continue
        }
        if (step.sample === null) {
          terminal.push(stopped(state, 'evidence-exhausted'))
          continue
        }
        const sample = snapshotSample(step.sample, state.travelDirection)
        if (sample === null) {
          terminal.push(stopped(state, 'safety-limit'))
          continue
        }
        const sampleAlignment = aligned(
          sample.tangent,
          state.travelDirection,
        )?.alignment
        const segmentLength = distance(state.current, sample)
        if (
          sampleAlignment === undefined ||
          !Number.isFinite(segmentLength) ||
          segmentLength <= VECTOR_EPSILON
        ) {
          terminal.push(stopped(state, 'safety-limit'))
          continue
        }
        const overlap = sampleOverlap(
          resolved.representedOverlapSampler,
          sample.point,
        )
        if (overlap === null) {
          terminal.push(stopped(state, 'safety-limit'))
          continue
        }
        if (overlap >= resolved.representedCollisionThreshold) {
          terminal.push(stopped(state, 'represented-collision'))
          continue
        }

        if (step.kind === 'weak') {
          const weakStepCount = state.weakStepCount + 1
          const provisionalLength =
            state.provisionalLength + segmentLength
          const gapAlignment = Math.min(
            sampleAlignment,
            gapDirectionalAlignment(
              state.samples[state.samples.length - 1]!,
              sample,
            ),
          )
          const compatible =
            gapAlignment >= GAP_ALIGNMENT_FLOOR &&
            weakStepCount <= allowedWeakSteps &&
            provisionalLength <= allowedWeakDistance
          if (!compatible) {
            terminal.push(stopped(state, 'evidence-exhausted'))
            continue
          }
          next.push({
            ...state,
            current: sample,
            travelDirection: sample.tangent,
            provisional: Object.freeze([...state.provisional, sample]),
            provisionalLength,
            provisionalMinimumAlignment: Math.min(
              state.provisionalMinimumAlignment,
              gapAlignment,
            ),
            weakStepCount,
            overlapSum: state.overlapSum + overlap,
          })
          continue
        }

        if (state.provisional.length > 0) {
          const gapLength = state.provisionalLength + segmentLength
          const gapAlignment = Math.min(
            state.provisionalMinimumAlignment,
            sampleAlignment,
            gapDirectionalAlignment(
              state.samples[state.samples.length - 1]!,
              sample,
            ),
          )
          if (
            gapAlignment < GAP_ALIGNMENT_FLOOR ||
            gapLength > allowedWeakDistance
          ) {
            terminal.push(stopped(state, 'evidence-exhausted'))
            continue
          }
          const committed = Object.freeze([
            ...state.samples,
            ...state.provisional,
            sample,
          ])
          next.push({
            ...state,
            samples: committed,
            spanSupport: Object.freeze([
              ...state.spanSupport,
              Object.freeze({
                kind: 'bounded-gap' as const,
                startSampleIndex: state.samples.length - 1,
                endSampleIndex: committed.length - 1,
                length: gapLength,
                entryEvidence: state.samples[state.samples.length - 1]!
                  .evidence,
                exitEvidence: sample.evidence,
                directionalAlignment: gapAlignment,
              }),
            ]),
            current: sample,
            travelDirection: sample.tangent,
            provisional: Object.freeze([]),
            provisionalLength: 0,
            provisionalMinimumAlignment: 1,
            weakStepCount: 0,
            length: state.length + gapLength,
            overlapSum: state.overlapSum + overlap,
          })
          continue
        }

        next.push({
          ...state,
          samples: Object.freeze([...state.samples, sample]),
          spanSupport: appendDirectSpan(
            state.spanSupport,
            state.samples,
            sample,
            segmentLength,
            sampleAlignment,
          ),
          current: sample,
          travelDirection: sample.tangent,
          length: state.length + segmentLength,
          overlapSum: state.overlapSum + overlap,
        })
      }

      if (searchStepCount >= searchStepLimit && next.length > 0) {
        terminal.push(
          ...next.map((state) => stopped(state, 'safety-limit')),
        )
        active = []
      } else {
        active = next
          .sort((first, second) =>
            orderStates(
              first,
              second,
              field,
              resolved.flowSmoothing,
            ),
          )
          .slice(0, resolved.directions.length)
      }
    }

    const best = terminal.sort((first, second) =>
      orderStates(first, second, field, resolved.flowSmoothing),
    )[0]
    return freezeTrace(
      direction,
      best ?? null,
      searchStepCount,
      fallbackSamples,
    )
  } catch {
    return freezeTrace(direction, null, 0, fallbackSamples)
  }
}
