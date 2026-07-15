import { createHash } from 'node:crypto'
import { cpus, freemem, hostname, platform, release, totalmem } from 'node:os'

import { clipSceneToBounds } from '../../src/clipToBounds.ts'
import {
  analyzeHiddenLineWorkload,
  hiddenLinePass,
} from '../../src/hiddenLine.ts'
import { renderPlotterSVG } from '../../src/plotterSvg.ts'
import { drawSceneFitted, renderToSVG } from '../../src/renderer.ts'

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
      ),
    },
  }
}

/**
 * Exact nearest clearance between centerline segments belonging to different
 * processed paths. Returns both per-segment and per-path distributions; path
 * clearance is the smallest clearance of any segment on that path.
 */
export function pathClearanceMetrics(
  scene,
  millimetersPerSceneUnit,
  nibWidthSceneUnits,
) {
  const segments = sceneSegments(scene)
  const segmentClearances = exactSegmentClearances(segments)
  const collisionPairs = countCollisionPairs(segments, nibWidthSceneUnits)
  const pathClearances = Array.from(
    { length: scene.primitives.length },
    () => Number.POSITIVE_INFINITY,
  )
  for (let index = 0; index < segments.length; index++) {
    const pathIndex = segments[index].pathIndex
    pathClearances[pathIndex] = Math.min(
      pathClearances[pathIndex],
      segmentClearances[index],
    )
  }

  return {
    paths: clearanceSummary(
      pathClearances,
      millimetersPerSceneUnit,
      nibWidthSceneUnits,
    ),
    segments: clearanceSummary(
      segmentClearances,
      millimetersPerSceneUnit,
      nibWidthSceneUnits,
    ),
    collisionPairs,
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
  return segments.sort((a, b) => a.minX - b.minX || a.maxX - b.maxX)
}

function exactSegmentClearances(segments) {
  const nearest = Array.from(
    { length: segments.length },
    () => Number.POSITIVE_INFINITY,
  )
  const prefixMaxX = []
  for (let index = 0; index < segments.length; index++) {
    prefixMaxX[index] = Math.max(
      prefixMaxX[index - 1] ?? -Infinity,
      segments[index].maxX,
    )
  }

  for (let index = 0; index < segments.length; index++) {
    const current = segments[index]
    for (let left = index - 1; left >= 0; left--) {
      if (current.minX - prefixMaxX[left] >= nearest[index]) break
      const other = segments[left]
      if (other.pathIndex === current.pathIndex) continue
      nearest[index] = Math.min(nearest[index], segmentDistance(current, other))
    }
    for (let right = index + 1; right < segments.length; right++) {
      const other = segments[right]
      if (other.minX - current.maxX >= nearest[index]) break
      if (other.pathIndex === current.pathIndex) continue
      nearest[index] = Math.min(nearest[index], segmentDistance(current, other))
    }
  }
  return nearest
}

function countCollisionPairs(segments, nibWidthSceneUnits) {
  let segmentPairCount = 0
  const pathPairs = new Set()
  for (let index = 0; index < segments.length; index++) {
    const current = segments[index]
    for (let right = index + 1; right < segments.length; right++) {
      const other = segments[right]
      if (other.minX - current.maxX > nibWidthSceneUnits) break
      if (other.pathIndex === current.pathIndex) continue
      if (segmentDistance(current, other) > nibWidthSceneUnits) continue
      segmentPairCount += 1
      pathPairs.add(
        current.pathIndex < other.pathIndex
          ? `${current.pathIndex}:${other.pathIndex}`
          : `${other.pathIndex}:${current.pathIndex}`,
      )
    }
  }
  return { segmentPairCount, pathPairCount: pathPairs.size }
}

function clearanceSummary(values, millimetersPerSceneUnit, nibWidthSceneUnits) {
  const finite = values.filter(Number.isFinite)
  const collisions = finite.filter((value) => value <= nibWidthSceneUnits).length
  return {
    millimeters: numberPercentiles(
      finite.map((value) => value * millimetersPerSceneUnit),
    ),
    nibWidths: numberPercentiles(
      finite.map((value) => value / nibWidthSceneUnits),
    ),
    collisionCount: collisions,
    collisionFraction: finite.length === 0 ? null : collisions / finite.length,
  }
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
  return {
    pathIndex,
    a,
    b,
    minX: Math.min(a[0], b[0]),
    maxX: Math.max(a[0], b[0]),
  }
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
