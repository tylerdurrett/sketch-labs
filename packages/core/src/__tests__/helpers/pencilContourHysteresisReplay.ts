import type { Point } from '../../types'
import { cleanupPencilContourPaths } from '../../sketches/pencil-contour/cleanup'
import { tracePencilContourEdges } from '../../sketches/pencil-contour/tracing'
import type {
  LocalizedEdge,
  LocalizedEdgeGraph,
  LocalizedLuminanceEdgeEvidence,
  TracedContourPath,
} from '../../sketches/pencil-contour/types'

const FLOWER_DETAIL = 0.5
const FLOWER_WEAK_FLOOR = 0.0825
const SHORT_PATH_LENGTH = 3
const SAMPLE_STEP = 0.5
const MATCHING_TUBE = 2
const REPLAY_LIMIT = 64
const LUMINANCE_PROVENANCE = Object.freeze({ kind: 'luminance' as const })

interface WeakComponent {
  readonly edgeIds: readonly string[]
  readonly selectedContacts: readonly string[]
  readonly totalStrength: number
  readonly length: number
  readonly canonicalEdgeId: string
}

export interface PencilContourReplayRecovery {
  readonly componentRank: number
  readonly addedEdgeIds: readonly string[]
  readonly recoveredBaselinePathIndices: readonly number[]
  readonly recoveredLength: number
  readonly unmatchedAddedLength: number
  readonly outputPathLength: number
}

export interface PencilContourHysteresisReplayDiagnostics {
  readonly weakFloor: number
  readonly matchingTube: number
  readonly componentCount: number
  readonly replayedComponentCount: number
  readonly unreplayedComponentCount: number
  readonly eligibleEdgeCount: number
  readonly usedEligibleEdgeCount: number
  readonly baselineShortPathCount: number
  readonly baselineShortPathLength: number
  readonly recoveredBaselinePathCount: number
  readonly recoveredLength: number
  readonly recoveryRatio: number
  readonly unmatchedAddedLength: number
  readonly unmatchedFraction: number
  readonly hysteresisAuthorized: boolean
  readonly recoveries: readonly Readonly<PencilContourReplayRecovery>[]
}

function pathLength(path: Readonly<TracedContourPath>): number {
  const segmentCount = path.closed ? path.points.length : path.points.length - 1
  let length = 0
  for (let index = 0; index < segmentCount; index += 1) {
    const start = path.points[index]!
    const end = path.points[(index + 1) % path.points.length]!
    length += Math.hypot(end[0] - start[0], end[1] - start[1])
  }
  return length
}

function pointAtDistance(
  path: Readonly<TracedContourPath>,
  distance: number,
): Readonly<Point> {
  const segmentCount = path.closed ? path.points.length : path.points.length - 1
  let remaining = distance
  for (let index = 0; index < segmentCount; index += 1) {
    const start = path.points[index]!
    const end = path.points[(index + 1) % path.points.length]!
    const length = Math.hypot(end[0] - start[0], end[1] - start[1])
    if (remaining <= length || index + 1 === segmentCount) {
      const amount = length === 0 ? 0 : Math.min(1, remaining / length)
      return [
        start[0] + (end[0] - start[0]) * amount,
        start[1] + (end[1] - start[1]) * amount,
      ]
    }
    remaining -= length
  }
  return path.points.at(-1)!
}

function sampledPath(
  path: Readonly<TracedContourPath>,
): readonly Readonly<Point>[] {
  const length = pathLength(path)
  const result: Readonly<Point>[] = []
  for (let distance = 0; distance < length; distance += SAMPLE_STEP) {
    result.push(pointAtDistance(path, distance))
  }
  if (!path.closed) result.push(pointAtDistance(path, length))
  return result
}

function squaredDistance(
  first: Readonly<Point>,
  second: Readonly<Point>,
): number {
  return (second[0] - first[0]) ** 2 + (second[1] - first[1]) ** 2
}

function samplesInsideTube(
  source: readonly Readonly<Point>[],
  target: readonly Readonly<Point>[],
): boolean {
  const tubeSquared = MATCHING_TUBE * MATCHING_TUBE
  return source.every((point) =>
    target.some(
      (candidate) => squaredDistance(point, candidate) <= tubeSquared,
    ),
  )
}

function edgeLength(edge: Readonly<LocalizedLuminanceEdgeEvidence>): number {
  return Math.hypot(edge.end[0] - edge.start[0], edge.end[1] - edge.start[1])
}

function compareEvidenceIds(first: string, second: string): number {
  const parse = (id: string) => {
    const [orientation, coordinates = '0,0'] = id.split(':')
    const [x = 0, y = 0] = coordinates.split(',').map(Number)
    return { orientation: orientation === 'horizontal' ? 0 : 1, x, y }
  }
  const a = parse(first)
  const b = parse(second)
  return a.orientation - b.orientation || a.y - b.y || a.x - b.x
}

/** Enumerate eligible weak components once in O(E), then rank canonically. */
function weakComponents(
  graph: Readonly<LocalizedEdgeGraph>,
): readonly Readonly<WeakComponent>[] {
  const evidence = graph.luminanceEvidence ?? []
  const selected = new Set(graph.selectedLuminanceEdgeIds ?? [])
  const eligible = new Set(
    evidence
      .filter(
        ({ id, strength }) =>
          !selected.has(id) && strength >= FLOWER_WEAK_FLOOR,
      )
      .map(({ id }) => id),
  )
  const evidenceById = new Map(evidence.map((edge) => [edge.id, edge]))
  const visited = new Set<string>()
  const components: WeakComponent[] = []

  for (const startId of [...eligible].sort(compareEvidenceIds)) {
    if (visited.has(startId)) continue
    const edgeIds: string[] = []
    const contacts = new Set<string>()
    const stack = [startId]
    visited.add(startId)
    while (stack.length > 0) {
      const id = stack.pop()!
      edgeIds.push(id)
      for (const adjacentId of evidenceById.get(id)!.adjacentEdgeIds) {
        if (selected.has(adjacentId)) contacts.add(adjacentId)
        if (eligible.has(adjacentId) && !visited.has(adjacentId)) {
          visited.add(adjacentId)
          stack.push(adjacentId)
        }
      }
    }
    edgeIds.sort(compareEvidenceIds)
    const componentEdges = edgeIds.map((id) => evidenceById.get(id)!)
    components.push({
      edgeIds: Object.freeze(edgeIds),
      selectedContacts: Object.freeze([...contacts].sort(compareEvidenceIds)),
      totalStrength: componentEdges.reduce(
        (total, edge) => total + edge.strength,
        0,
      ),
      length: componentEdges.reduce(
        (total, edge) => total + edgeLength(edge),
        0,
      ),
      canonicalEdgeId: edgeIds[0]!,
    })
  }

  components.sort(
    (first, second) =>
      second.selectedContacts.length - first.selectedContacts.length ||
      second.totalStrength - first.totalStrength ||
      second.length - first.length ||
      compareEvidenceIds(first.canonicalEdgeId, second.canonicalEdgeId),
  )
  return components
}

function replayGraph(
  baseline: Readonly<LocalizedEdgeGraph>,
  component: Readonly<WeakComponent>,
): Readonly<LocalizedEdgeGraph> {
  const included = new Set([
    ...(baseline.selectedLuminanceEdgeIds ?? []),
    ...component.edgeIds,
  ])
  const evidence = (baseline.luminanceEvidence ?? [])
    .filter(({ id }) => included.has(id))
    .sort((first, second) => compareEvidenceIds(first.id, second.id))
  const luminanceEdges: Readonly<LocalizedEdge>[] = evidence.map((edge) =>
    Object.freeze({
      start: edge.start,
      end: edge.end,
      provenance: LUMINANCE_PROVENANCE,
    }),
  )
  const alphaEdges = baseline.edges.filter(
    ({ provenance }) => provenance.kind === 'alpha-boundary',
  )
  return Object.freeze({
    ...baseline,
    selectedLuminanceEdgeIds: Object.freeze(evidence.map(({ id }) => id)),
    edges: Object.freeze([...luminanceEdges, ...alphaEdges]),
  })
}

function cleanedPaths(
  graph: Readonly<LocalizedEdgeGraph>,
): readonly Readonly<TracedContourPath>[] {
  return cleanupPencilContourPaths({
    paths: tracePencilContourEdges(graph),
    graph,
    detail: FLOWER_DETAIL,
    smoothing: 1,
  })
}

function unmatchedLength(
  path: Readonly<TracedContourPath>,
  baselineSamples: readonly Readonly<Point>[],
): number {
  const segmentCount = path.closed ? path.points.length : path.points.length - 1
  const tubeSquared = MATCHING_TUBE * MATCHING_TUBE
  let unmatched = 0
  for (let index = 0; index < segmentCount; index += 1) {
    const start = path.points[index]!
    const end = path.points[(index + 1) % path.points.length]!
    const length = Math.hypot(end[0] - start[0], end[1] - start[1])
    const intervals = Math.max(1, Math.ceil(length / SAMPLE_STEP))
    for (let interval = 0; interval < intervals; interval += 1) {
      const amount = (interval + 0.5) / intervals
      const midpoint: Point = [
        start[0] + (end[0] - start[0]) * amount,
        start[1] + (end[1] - start[1]) * amount,
      ]
      if (
        !baselineSamples.some(
          (point) => squaredDistance(midpoint, point) <= tubeSquared,
        )
      ) {
        unmatched += length / intervals
      }
    }
  }
  return unmatched
}

/**
 * Bounded counterfactual flower replay. This is deliberately test-only: it
 * measures whether fixed weak evidence earns a production hysteresis change.
 */
export function pencilContourHysteresisReplayDiagnostics(
  baselineGraph: Readonly<LocalizedEdgeGraph>,
): Readonly<PencilContourHysteresisReplayDiagnostics> {
  const components = weakComponents(baselineGraph)
  const replayed = components.slice(0, REPLAY_LIMIT)
  const baselinePaths = cleanedPaths(baselineGraph)
  const baselineSamples = baselinePaths.flatMap((path) => sampledPath(path))
  const shortPaths = baselinePaths
    .map((path, pathIndex) => ({
      path,
      pathIndex,
      length: pathLength(path),
      samples: sampledPath(path),
    }))
    .filter(
      ({ path, length }) =>
        path.provenance.kind === 'luminance' && length < SHORT_PATH_LENGTH,
    )
  const recovered = new Set<number>()
  const recoveries: PencilContourReplayRecovery[] = []

  for (const [componentRank, component] of replayed.entries()) {
    const outputPaths = cleanedPaths(replayGraph(baselineGraph, component))
    const candidates = outputPaths
      .map((path) => ({
        path,
        edgeIds: path.luminanceEvidence?.edgeIds ?? Object.freeze([]),
        length: pathLength(path),
        samples: sampledPath(path),
      }))
      .filter(
        ({ path, edgeIds }) =>
          path.provenance.kind === 'luminance' &&
          component.edgeIds.some((id) => edgeIds.includes(id)),
      )
      .sort(
        (first, second) =>
          second.length - first.length ||
          first.samples[0]![1] - second.samples[0]![1] ||
          first.samples[0]![0] - second.samples[0]![0],
      )

    for (const candidate of candidates) {
      const matches = shortPaths
        .filter(
          (short) =>
            !recovered.has(short.pathIndex) &&
            samplesInsideTube(short.samples, candidate.samples),
        )
        .sort((first, second) => first.pathIndex - second.pathIndex)
      if (
        matches.length < 2 ||
        candidate.length < 2 * Math.max(...matches.map(({ length }) => length))
      ) {
        continue
      }
      const recoveredLength = matches.reduce(
        (total, { length }) => total + length,
        0,
      )
      const unmatchedAddedLength = unmatchedLength(
        candidate.path,
        baselineSamples,
      )
      for (const match of matches) recovered.add(match.pathIndex)
      recoveries.push({
        componentRank,
        addedEdgeIds: component.edgeIds,
        recoveredBaselinePathIndices: Object.freeze(
          matches.map(({ pathIndex }) => pathIndex),
        ),
        recoveredLength,
        unmatchedAddedLength,
        outputPathLength: candidate.length,
      })
      break
    }
  }

  const baselineShortPathLength = shortPaths.reduce(
    (total, { length }) => total + length,
    0,
  )
  const recoveredLength = recoveries.reduce(
    (total, recovery) => total + recovery.recoveredLength,
    0,
  )
  const unmatchedAddedLength = recoveries.reduce(
    (total, recovery) => total + recovery.unmatchedAddedLength,
    0,
  )
  const recoveryRatio =
    baselineShortPathLength === 0
      ? 0
      : recoveredLength / baselineShortPathLength
  const unmatchedFraction =
    recoveredLength === 0 ? Infinity : unmatchedAddedLength / recoveredLength
  const usedEligibleEdgeCount = new Set(
    recoveries.flatMap(({ addedEdgeIds }) => addedEdgeIds),
  ).size

  return Object.freeze({
    weakFloor: FLOWER_WEAK_FLOOR,
    matchingTube: MATCHING_TUBE,
    componentCount: components.length,
    replayedComponentCount: replayed.length,
    unreplayedComponentCount: components.length - replayed.length,
    eligibleEdgeCount: components.reduce(
      (total, component) => total + component.edgeIds.length,
      0,
    ),
    usedEligibleEdgeCount,
    baselineShortPathCount: shortPaths.length,
    baselineShortPathLength,
    recoveredBaselinePathCount: recovered.size,
    recoveredLength,
    recoveryRatio,
    unmatchedAddedLength,
    unmatchedFraction,
    hysteresisAuthorized: recoveryRatio >= 0.3 && usedEligibleEdgeCount > 0,
    recoveries: Object.freeze(recoveries),
  })
}
