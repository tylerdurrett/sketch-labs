import type { Point } from '../../types'
import { cleanupPencilContourPaths } from '../../sketches/pencil-contour/cleanup'
import {
  inspectPencilContourLuminanceSelection,
  localizePencilContourEdges,
} from '../../sketches/pencil-contour/edges'
import { tracePencilContourEdges } from '../../sketches/pencil-contour/tracing'
import { prunePencilContourGraph } from '../../sketches/pencil-contour/fragment-pruning'
import type {
  AnalyzedRaster,
  TracedContourPath,
} from '../../sketches/pencil-contour/types'

export const PENCIL_CONTOUR_REFERENCE_SAMPLE_STEP = 0.5
export const PENCIL_CONTOUR_REFERENCE_LONG_PATH_LENGTH = 8

const FLOAT64_BYTES = 8
const TURN_25_DEGREES = 25
const TURN_45_DEGREES = 45

function pathLength(path: Readonly<TracedContourPath>): number {
  const segmentCount = path.closed
    ? path.points.length
    : Math.max(0, path.points.length - 1)
  let length = 0
  for (let index = 0; index < segmentCount; index += 1) {
    const first = path.points[index]!
    const second = path.points[(index + 1) % path.points.length]!
    length += Math.hypot(second[0] - first[0], second[1] - first[1])
  }
  return length
}

function pointAtDistance(
  path: Readonly<TracedContourPath>,
  distance: number,
): Point {
  const segmentCount = path.closed ? path.points.length : path.points.length - 1
  let remaining = distance
  for (let index = 0; index < segmentCount; index += 1) {
    const first = path.points[index]!
    const second = path.points[(index + 1) % path.points.length]!
    const length = Math.hypot(second[0] - first[0], second[1] - first[1])
    if (remaining <= length || index + 1 === segmentCount) {
      const amount = length > 0 ? Math.min(1, remaining / length) : 0
      return [
        first[0] + (second[0] - first[0]) * amount,
        first[1] + (second[1] - first[1]) * amount,
      ]
    }
    remaining -= length
  }
  const last = path.points.at(-1)!
  return [last[0], last[1]]
}

function sampledGeometry(
  path: Readonly<TracedContourPath>,
  length: number,
): readonly Readonly<Point>[] {
  const points: Point[] = []
  for (
    let distance = 0;
    distance < length;
    distance += PENCIL_CONTOUR_REFERENCE_SAMPLE_STEP
  ) {
    points.push(pointAtDistance(path, distance))
  }
  if (!path.closed) points.push(pointAtDistance(path, length))
  return points
}

function turnDegrees(
  previous: Readonly<Point>,
  current: Readonly<Point>,
  next: Readonly<Point>,
): number | undefined {
  const incomingX = current[0] - previous[0]
  const incomingY = current[1] - previous[1]
  const outgoingX = next[0] - current[0]
  const outgoingY = next[1] - current[1]
  const incomingLength = Math.hypot(incomingX, incomingY)
  const outgoingLength = Math.hypot(outgoingX, outgoingY)
  if (incomingLength === 0 || outgoingLength === 0) return undefined
  const cosine = Math.min(
    1,
    Math.max(
      -1,
      (incomingX * outgoingX + incomingY * outgoingY) /
      (incomingLength * outgoingLength),
    ),
  )
  // Avoid magnifying cross-runtime last-bit normalization differences into
  // visually meaningless micro-degree turns near an exactly straight sample.
  if (cosine >= 1 - 1e-12) return 0
  if (cosine <= -1 + 1e-12) return 180
  return (Math.acos(cosine) * 180) / Math.PI
}

function sampledTurns(
  points: readonly Readonly<Point>[],
  closed: boolean,
): readonly number[] {
  if (points.length < 3) return []
  const turns: number[] = []
  const start = closed ? 0 : 1
  const end = closed ? points.length : points.length - 1
  for (let index = start; index < end; index += 1) {
    const turn = turnDegrees(
      points[(index - 1 + points.length) % points.length]!,
      points[index]!,
      points[(index + 1) % points.length]!,
    )
    if (turn !== undefined) turns.push(turn)
  }
  return turns
}

function nearestRank(values: readonly number[], percentile: number): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((first, second) => first - second)
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]!
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((first, second) => first - second)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}

function smoothingDiagnostics(
  paths: readonly Readonly<TracedContourPath>[],
) {
  const lengths = paths.map(pathLength)
  const sampledPaths = paths.flatMap((path, pathIndex) => {
    const length = lengths[pathIndex]!
    if (length < PENCIL_CONTOUR_REFERENCE_LONG_PATH_LENGTH) return []
    const points = sampledGeometry(path, length)
    return [
      {
        pathIndex,
        closed: path.closed,
        provenance: path.provenance.kind,
        length,
        points,
        turnsDegrees: sampledTurns(points, path.closed),
      },
    ]
  })
  const turns = sampledPaths.flatMap(({ turnsDegrees }) => turnsDegrees)

  return {
    pathCount: paths.length,
    b2TwoPointOpenPaths: paths.filter(
      ({ closed, points }) => !closed && points.length === 2,
    ).length,
    b3PathsShorterThanThree: lengths.filter((length) => length < 3).length,
    bMedianPathLength: median(lengths),
    sampledPathCount: sampledPaths.length,
    sampledPointCount: sampledPaths.reduce(
      (total, { points }) => total + points.length,
      0,
    ),
    turnCount: turns.length,
    turnP95Degrees: nearestRank(turns, 0.95),
    turnFractionOver25Degrees:
      turns.filter((turn) => turn > TURN_25_DEGREES).length / turns.length,
    turnFractionOver45Degrees:
      turns.filter((turn) => turn > TURN_45_DEGREES).length / turns.length,
    sampledPaths,
  }
}

/** Encode luminance, alpha, and support as three contiguous Float64LE planes. */
export function encodePencilContourAnalyzedRaster(
  raster: Readonly<AnalyzedRaster>,
): Uint8Array {
  const sampleCount = raster.width * raster.height
  const bytes = new Uint8Array(sampleCount * 3 * FLOAT64_BYTES)
  const view = new DataView(bytes.buffer)
  const planes = [
    raster.luminance,
    raster.alpha,
    raster.positiveSupport.map((supported) => (supported ? 1 : 0)),
  ]
  let offset = 0
  for (const plane of planes) {
    for (const value of plane) {
      view.setFloat64(offset, value, true)
      offset += FLOAT64_BYTES
    }
  }
  return bytes
}

/** Exact downstream diagnostics for the committed flower analysis fixture. */
export function pencilContourReferenceDiagnostics(
  raster: Readonly<AnalyzedRaster>,
  contourDetail: number,
) {
  const candidates = inspectPencilContourLuminanceSelection(
    raster,
    contourDetail,
  )
  const graph = localizePencilContourEdges(raster, contourDetail)
  const cleanAt = (smoothing: number) =>
    (() => {
      const pruned = prunePencilContourGraph(
        graph,
        contourDetail,
        smoothing,
      )
      return cleanupPencilContourPaths({
        paths: tracePencilContourEdges(pruned),
        graph: pruned,
        detail: contourDetail,
        smoothing,
        fragmentsPrunedBeforeTracing: true,
      })
    })()

  return {
    candidates,
    localizedEdgeCount: graph.edges.length,
    tracedPathCount: tracePencilContourEdges(graph).length,
    sampling: {
      stepLatticeUnits: PENCIL_CONTOUR_REFERENCE_SAMPLE_STEP,
      minimumPathLengthLatticeUnits:
        PENCIL_CONTOUR_REFERENCE_LONG_PATH_LENGTH,
      turnPercentileMethod: 'nearest-rank',
    },
    smoothing050: smoothingDiagnostics(cleanAt(0.5)),
    smoothing075: smoothingDiagnostics(cleanAt(0.75)),
    smoothing100: smoothingDiagnostics(cleanAt(1)),
  }
}
