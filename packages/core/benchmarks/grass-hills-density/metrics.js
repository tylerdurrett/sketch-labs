import { createHash } from 'node:crypto'
import { cpus, freemem, hostname, platform, release, totalmem } from 'node:os'

import { clipSceneToBounds } from '../../src/clipToBounds.ts'
import {
  analyzeHiddenLineWorkload,
  hiddenLinePass,
} from '../../src/hiddenLine.ts'
import { renderPlotterSVG } from '../../src/plotterSvg.ts'
import { drawSceneFitted, renderToSVG } from '../../src/renderer.ts'

export const DEFAULT_CLEARANCE_SAMPLING = Object.freeze({
  maxSegments: 4_096,
  maxSearchNibWidths: 8,
})

/** SHA-256 of the exact compact JSON serialization used by fixture artifacts. */
export function sceneChecksum(scene) {
  return createHash('sha256').update(JSON.stringify(scene)).digest('hex')
}

export function sceneInventory(scene) {
  let pointCount = 0
  for (const primitive of scene.primitives) pointCount += primitive.points.length
  const serialized = JSON.stringify(scene)
  const geometry = JSON.stringify(
    scene.primitives.map((primitive) => primitive.points),
  )
  return {
    primitiveCount: scene.primitives.length,
    pointCount,
    checksum: createHash('sha256').update(serialized).digest('hex'),
    serializedBytes: Buffer.byteLength(serialized),
    geometryBytes: Buffer.byteLength(geometry),
  }
}

/**
 * Exercise core's real fitted Canvas submission path through a counting port.
 * This deliberately measures JS traversal/submission only: it makes no claim
 * about browser rasterization, compositor work, or GPU completion.
 */
export function collectCanvasSubmission(
  scene,
  { pixelWidth = 1000, pixelHeight = 1000 } = {},
) {
  const context = countingCanvasContext()
  const started = performance.now()
  drawSceneFitted(context, scene, pixelWidth, pixelHeight)
  const submissionMs = performance.now() - started
  return {
    measurement: 'counting-canvas-structural-submission-only',
    scope: 'whole-frame',
    includesRasterization: false,
    pixelWidth,
    pixelHeight,
    submissionMs,
    calls: { ...context.calls },
  }
}

/** Collect every durable Node-side structural/export metric for one Scene. */
export function collectSceneMetrics(
  scene,
  {
    profile,
    roots = [],
    nibWidthSceneUnits,
    clearanceSampling = DEFAULT_CLEARANCE_SAMPLING,
    processing,
    pixelWidth = 1000,
    pixelHeight = 1000,
    tolerance = 0,
  },
) {
  if (!Number.isFinite(nibWidthSceneUnits) || nibWidthSceneUnits <= 0) {
    throw new Error('nibWidthSceneUnits must be a finite positive number')
  }
  const source = sceneInventory(scene)
  const canvas = collectCanvasSubmission(scene, { pixelWidth, pixelHeight })
  // This is a structural reference inventory for the generic core pass. A
  // supplied candidate processor is not assumed to perform this work.
  const referenceHiddenLineWorkload = analyzeHiddenLineWorkload(scene)
  const processed = resolveProcessing(scene, processing, tolerance)
  const processedInventory = sceneInventory(processed.scene)
  const boundsClip = timed(() => clipSceneToBounds(processed.scene))
  const clipped = sceneInventory(boundsClip.value)
  const svgSerialization = timed(() => renderToSVG(boundsClip.value))
  const plotterSerialization = timed(() =>
    renderPlotterSVG(boundsClip.value, profile),
  )
  const millimetersPerSceneUnit =
    (profile.width - profile.insets.left - profile.insets.right) /
    scene.space.width

  return {
    source,
    canvas,
    referenceHiddenLineWorkload,
    processing: {
      kind: processed.kind,
      durationMs: processed.durationMs,
      processed: processedInventory,
    },
    boundsClip: {
      durationMs: boundsClip.durationMs,
      clipped,
    },
    svgSerialization: {
      durationMs: svgSerialization.durationMs,
      bytes: Buffer.byteLength(svgSerialization.value),
      pathCount: countSvgPaths(svgSerialization.value),
    },
    plotter: {
      durationMs: plotterSerialization.durationMs,
      svgBytes: Buffer.byteLength(plotterSerialization.value),
      pathCount: countSvgPaths(plotterSerialization.value),
    },
    physicalSpacing: {
      millimetersPerSceneUnit,
      nibWidthSceneUnits,
      nibWidthMillimeters: nibWidthSceneUnits * millimetersPerSceneUnit,
      // Root identity is representation-specific. Candidates must supply roots
      // explicitly; no closed-Primitive or path-start heuristic is used.
      roots: spacingPercentiles(roots, millimetersPerSceneUnit),
      clearances: pathClearanceMetrics(
        boundsClip.value,
        millimetersPerSceneUnit,
        nibWidthSceneUnits,
        clearanceSampling,
      ),
    },
  }
}

/**
 * Exact nib-threshold collisions plus deterministic capped nearest-clearance
 * sampling between centerline segments belonging to different processed paths.
 */
export function pathClearanceMetrics(
  scene,
  millimetersPerSceneUnit,
  nibWidthSceneUnits,
  sampling = DEFAULT_CLEARANCE_SAMPLING,
) {
  validateClearanceSampling(sampling)
  const segments = sceneSegments(scene)
  const spatial = buildSegmentSpatialIndex(segments, nibWidthSceneUnits)
  const collisions = exactNibCollisions(
    segments,
    spatial.collisionCells,
    nibWidthSceneUnits,
  )
  const nearest = sampleNearestClearances(
    segments,
    spatial.baseCells,
    spatial.cellSize,
    nibWidthSceneUnits,
    sampling,
  )

  return {
    contract: 'exact-nib-collisions/capped-deterministic-nearest-sampling',
    sampling: nearest.sampling,
    paths: clearancePercentiles(
      nearest.pathClearances,
      millimetersPerSceneUnit,
      nibWidthSceneUnits,
    ),
    segments: clearancePercentiles(
      nearest.segmentClearances,
      millimetersPerSceneUnit,
      nibWidthSceneUnits,
    ),
    collisions,
    spatial: {
      cellSizeSceneUnits: spatial.cellSize,
      occupiedBaseCellCount: spatial.baseCells.size,
      occupiedCollisionCellCount: spatial.collisionCells.size,
      collisionCandidatePairChecks: collisions.candidatePairChecks,
      nearestCandidateChecks: nearest.candidateChecks,
    },
  }
}

export function collectMachineMetadata() {
  const processors = cpus()
  return {
    hostname: hostname(),
    os: { platform: platform(), release: release() },
    runtime: { node: process.version, v8: process.versions.v8 },
    architecture: process.arch,
    cpu: {
      model: processors[0]?.model ?? 'unknown',
      logicalCount: processors.length,
    },
    memory: {
      totalBytes: totalmem(),
      freeBytesAtCapture: freemem(),
    },
  }
}

export function spacingPercentiles(points, scale = 1) {
  if (points.length < 2) return emptyPercentiles()
  const ordered = points
    .map(([x, y]) => ({ x, y }))
    .sort((a, b) => a.x - b.x || a.y - b.y)
  const distances = []

  for (let index = 0; index < ordered.length; index++) {
    const point = ordered[index]
    let nearest = Number.POSITIVE_INFINITY
    for (let left = index - 1; left >= 0; left--) {
      const other = ordered[left]
      if (point.x - other.x >= nearest) break
      nearest = Math.min(
        nearest,
        Math.hypot(point.x - other.x, point.y - other.y),
      )
    }
    for (let right = index + 1; right < ordered.length; right++) {
      const other = ordered[right]
      if (other.x - point.x >= nearest) break
      nearest = Math.min(
        nearest,
        Math.hypot(point.x - other.x, point.y - other.y),
      )
    }
    if (Number.isFinite(nearest)) distances.push(nearest * scale)
  }

  distances.sort((a, b) => a - b)
  return {
    sampleCount: distances.length,
    min: distances[0],
    p05: percentile(distances, 0.05),
    p50: percentile(distances, 0.5),
    p95: percentile(distances, 0.95),
    max: distances[distances.length - 1],
  }
}

function resolveProcessing(scene, processing, tolerance) {
  if (processing === undefined) {
    const measured = timed(() => hiddenLinePass(scene, { tolerance }))
    return {
      kind: 'core-hidden-line',
      scene: measured.value,
      durationMs: measured.durationMs,
    }
  }
  if (processing?.scene !== undefined) {
    if (typeof processing.run === 'function') {
      throw new Error('processing must provide either scene or run, not both')
    }
    if (
      processing.durationMs !== undefined &&
      (!Number.isFinite(processing.durationMs) || processing.durationMs < 0)
    ) {
      throw new Error('processing.durationMs must be finite and non-negative')
    }
    return {
      kind: 'supplied',
      scene: processing.scene,
      durationMs: processing.durationMs ?? null,
    }
  }
  if (typeof processing?.run === 'function') {
    const measured = timed(() => processing.run(scene))
    return {
      kind: 'measured-callback',
      scene: measured.value,
      durationMs: measured.durationMs,
    }
  }
  throw new Error('processing must provide a processed scene or run callback')
}

function sceneSegments(scene) {
  const segments = []
  for (let pathIndex = 0; pathIndex < scene.primitives.length; pathIndex++) {
    const primitive = scene.primitives[pathIndex]
    for (let index = 1; index < primitive.points.length; index++) {
      segments.push(
        segment(
          pathIndex,
          primitive.points[index - 1],
          primitive.points[index],
        ),
      )
    }
    if (
      primitive.closed === true &&
      primitive.points.length > 2 &&
      !samePoint(
        primitive.points[0],
        primitive.points[primitive.points.length - 1],
      )
    ) {
      segments.push(
        segment(
          pathIndex,
          primitive.points[primitive.points.length - 1],
          primitive.points[0],
        ),
      )
    }
  }
  return segments
}

function validateClearanceSampling(sampling) {
  if (!Number.isSafeInteger(sampling.maxSegments) || sampling.maxSegments <= 0) {
    throw new Error('clearanceSampling.maxSegments must be a positive integer')
  }
  if (
    !Number.isFinite(sampling.maxSearchNibWidths) ||
    sampling.maxSearchNibWidths <= 0
  ) {
    throw new Error(
      'clearanceSampling.maxSearchNibWidths must be finite and positive',
    )
  }
}

function buildSegmentSpatialIndex(segments, nibWidthSceneUnits) {
  const cellSize = nibWidthSceneUnits * 4
  const baseCells = new Map()
  const collisionCells = new Map()
  const collisionExpansion = Math.ceil(nibWidthSceneUnits / cellSize)

  for (let index = 0; index < segments.length; index++) {
    const current = segments[index]
    current.baseCells = traceSegmentCells(current, cellSize)
    current.collisionCells = expandCells(
      current.baseCells,
      collisionExpansion,
    )
    current.collisionCellKeys = new Set(
      current.collisionCells.map((cell) => cell.key),
    )
    addToCells(baseCells, current.baseCells, index)
    addToCells(collisionCells, current.collisionCells, index)
  }
  return { cellSize, baseCells, collisionCells }
}

function exactNibCollisions(
  segments,
  collisionCells,
  nibWidthSceneUnits,
) {
  let segmentPairCount = 0
  const pathPairs = new Set()
  const collidingSegments = new Set()
  const collidingPaths = new Set()
  let candidatePairChecks = 0

  for (const [cellKey, indices] of collisionCells) {
    for (let left = 0; left < indices.length; left++) {
      const firstIndex = indices[left]
      const first = segments[firstIndex]
      for (let right = left + 1; right < indices.length; right++) {
        const secondIndex = indices[right]
        const second = segments[secondIndex]
        if (first.pathIndex === second.pathIndex) continue
        candidatePairChecks += 1
        if (segmentDistance(first, second) > nibWidthSceneUnits) continue
        if (collisionOwnerCell(first, second) !== cellKey) continue

        segmentPairCount += 1
        collidingSegments.add(firstIndex)
        collidingSegments.add(secondIndex)
        collidingPaths.add(first.pathIndex)
        collidingPaths.add(second.pathIndex)
        pathPairs.add(
          first.pathIndex < second.pathIndex
            ? `${first.pathIndex}:${second.pathIndex}`
            : `${second.pathIndex}:${first.pathIndex}`,
        )
      }
    }
  }

  return {
    threshold: 'centerline-distance-lte-one-nib-width',
    segmentPairCount,
    pathPairCount: pathPairs.size,
    collidingSegmentCount: collidingSegments.size,
    collidingPathCount: collidingPaths.size,
    candidatePairChecks,
  }
}

function sampleNearestClearances(
  segments,
  baseCells,
  cellSize,
  nibWidthSceneUnits,
  sampling,
) {
  const sampledIndices = evenlySpacedIndices(
    segments.length,
    sampling.maxSegments,
  )
  const capSceneUnits = sampling.maxSearchNibWidths * nibWidthSceneUnits
  const cellRadius = Math.ceil(capSceneUnits / cellSize) + 1
  const segmentClearances = []
  const pathClearanceByIndex = new Map()
  const sampledPaths = new Set()
  let censoredSegmentCount = 0
  let candidateChecks = 0

  for (const index of sampledIndices) {
    const current = segments[index]
    sampledPaths.add(current.pathIndex)
    const candidates = new Set()
    for (const cell of current.baseCells) {
      for (let dx = -cellRadius; dx <= cellRadius; dx++) {
        for (let dy = -cellRadius; dy <= cellRadius; dy++) {
          const entries =
            baseCells.get(cellKey(cell.x + dx, cell.y + dy)) ?? []
          for (const candidate of entries) {
            candidates.add(candidate)
          }
        }
      }
    }

    let nearest = Number.POSITIVE_INFINITY
    for (const candidate of candidates) {
      const other = segments[candidate]
      if (candidate === index || other.pathIndex === current.pathIndex) continue
      candidateChecks += 1
      nearest = Math.min(nearest, segmentDistance(current, other))
    }
    if (nearest > capSceneUnits) {
      censoredSegmentCount += 1
      continue
    }
    segmentClearances.push(nearest)
    pathClearanceByIndex.set(
      current.pathIndex,
      Math.min(pathClearanceByIndex.get(current.pathIndex) ?? Infinity, nearest),
    )
  }

  const totalPathCount = new Set(segments.map((item) => item.pathIndex)).size
  return {
    segmentClearances,
    pathClearances: [...pathClearanceByIndex.values()],
    candidateChecks,
    sampling: {
      method: 'deterministic-even-segment-index/capped-spatial-search',
      maxSegments: sampling.maxSegments,
      maxSearchNibWidths: sampling.maxSearchNibWidths,
      totalSegmentCount: segments.length,
      sampledSegmentCount: sampledIndices.length,
      segmentCoverage:
        segments.length === 0 ? 0 : sampledIndices.length / segments.length,
      resolvedSegmentCount: segmentClearances.length,
      censoredSegmentCount,
      totalPathCount,
      sampledPathCount: sampledPaths.size,
      pathCoverage:
        totalPathCount === 0 ? 0 : sampledPaths.size / totalPathCount,
      resolvedPathCount: pathClearanceByIndex.size,
    },
  }
}

function clearancePercentiles(
  values,
  millimetersPerSceneUnit,
  nibWidthSceneUnits,
) {
  return {
    millimeters: numberPercentiles(
      values.map((value) => value * millimetersPerSceneUnit),
    ),
    nibWidths: numberPercentiles(
      values.map((value) => value / nibWidthSceneUnits),
    ),
  }
}

function evenlySpacedIndices(total, limit) {
  const count = Math.min(total, limit)
  if (count === 0) return []
  if (count === total) return Array.from({ length: total }, (_, index) => index)
  if (count === 1) return [0]
  return Array.from({ length: count }, (_, index) =>
    Math.floor((index * (total - 1)) / (count - 1)),
  )
}

function traceSegmentCells(current, cellSize) {
  let x = Math.floor(current.a[0] / cellSize)
  let y = Math.floor(current.a[1] / cellSize)
  const endX = Math.floor(current.b[0] / cellSize)
  const endY = Math.floor(current.b[1] / cellSize)
  const dx = current.b[0] - current.a[0]
  const dy = current.b[1] - current.a[1]
  const stepX = Math.sign(dx)
  const stepY = Math.sign(dy)
  const deltaX = stepX === 0 ? Infinity : cellSize / Math.abs(dx)
  const deltaY = stepY === 0 ? Infinity : cellSize / Math.abs(dy)
  let maxX =
    stepX === 0
      ? Infinity
      : ((stepX > 0 ? (x + 1) * cellSize : x * cellSize) - current.a[0]) / dx
  let maxY =
    stepY === 0
      ? Infinity
      : ((stepY > 0 ? (y + 1) * cellSize : y * cellSize) - current.a[1]) / dy
  const cells = [gridCell(x, y)]

  while (x !== endX || y !== endY) {
    if (maxX < maxY) {
      x += stepX
      maxX += deltaX
    } else if (maxY < maxX) {
      y += stepY
      maxY += deltaY
    } else {
      x += stepX
      y += stepY
      maxX += deltaX
      maxY += deltaY
    }
    cells.push(gridCell(x, y))
  }
  return cells
}

function expandCells(cells, radius) {
  const expanded = new Map()
  for (const cell of cells) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const value = gridCell(cell.x + dx, cell.y + dy)
        expanded.set(value.key, value)
      }
    }
  }
  return [...expanded.values()]
}

function addToCells(index, cells, segmentIndex) {
  for (const cell of cells) {
    const entries = index.get(cell.key)
    if (entries === undefined) index.set(cell.key, [segmentIndex])
    else entries.push(segmentIndex)
  }
}

function collisionOwnerCell(first, second) {
  const primary =
    first.collisionCells.length < second.collisionCells.length
      ? first
      : first.collisionCells.length > second.collisionCells.length
        ? second
        : first.pathIndex <= second.pathIndex
          ? first
          : second
  const other = primary === first ? second : first
  return primary.collisionCells.find((cell) =>
    other.collisionCellKeys.has(cell.key),
  )?.key
}

function gridCell(x, y) {
  return { x, y, key: cellKey(x, y) }
}

function cellKey(x, y) {
  return `${x}:${y}`
}

function numberPercentiles(values) {
  if (values.length === 0) return emptyPercentiles()
  values.sort((a, b) => a - b)
  return {
    sampleCount: values.length,
    min: values[0],
    p05: percentile(values, 0.05),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values[values.length - 1],
  }
}

function segment(pathIndex, a, b) {
  return { pathIndex, a, b }
}

function segmentDistance(first, second) {
  if (segmentsIntersect(first.a, first.b, second.a, second.b)) return 0
  return Math.min(
    pointSegmentDistance(first.a, second.a, second.b),
    pointSegmentDistance(first.b, second.a, second.b),
    pointSegmentDistance(second.a, first.a, first.b),
    pointSegmentDistance(second.b, first.a, first.b),
  )
}

function segmentsIntersect(a, b, c, d) {
  const abC = cross(a, b, c)
  const abD = cross(a, b, d)
  const cdA = cross(c, d, a)
  const cdB = cross(c, d, b)
  if (
    ((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) &&
    ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))
  ) {
    return true
  }
  return (
    (abC === 0 && onSegment(a, b, c)) ||
    (abD === 0 && onSegment(a, b, d)) ||
    (cdA === 0 && onSegment(c, d, a)) ||
    (cdB === 0 && onSegment(c, d, b))
  )
}

function pointSegmentDistance(point, a, b) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const denominator = dx * dx + dy * dy
  if (denominator === 0) return Math.hypot(point[0] - a[0], point[1] - a[1])
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / denominator,
    ),
  )
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy))
}

function cross(a, b, point) {
  return (
    (b[0] - a[0]) * (point[1] - a[1]) -
    (b[1] - a[1]) * (point[0] - a[0])
  )
}

function onSegment(a, b, point) {
  return (
    point[0] >= Math.min(a[0], b[0]) &&
    point[0] <= Math.max(a[0], b[0]) &&
    point[1] >= Math.min(a[1], b[1]) &&
    point[1] <= Math.max(a[1], b[1])
  )
}

function samePoint(a, b) {
  return a[0] === b[0] && a[1] === b[1]
}

function timed(operation) {
  const started = performance.now()
  const value = operation()
  return { value, durationMs: performance.now() - started }
}

function countSvgPaths(svg) {
  return svg.match(/<path\b/g)?.length ?? 0
}

function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

function emptyPercentiles() {
  return {
    sampleCount: 0,
    min: null,
    p05: null,
    p50: null,
    p95: null,
    max: null,
  }
}

function countingCanvasContext() {
  const calls = {
    save: 0,
    restore: 0,
    beginPath: 0,
    moveTo: 0,
    lineTo: 0,
    closePath: 0,
    fill: 0,
    stroke: 0,
    setTransform: 0,
    fillRect: 0,
    clearRect: 0,
  }
  const context = {
    calls,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
  }
  for (const name of Object.keys(calls)) {
    context[name] = () => {
      calls[name] += 1
    }
  }
  return context
}
