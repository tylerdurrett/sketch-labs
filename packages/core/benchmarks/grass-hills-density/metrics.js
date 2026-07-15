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
  { profile, pixelWidth = 1000, pixelHeight = 1000, tolerance = 0 },
) {
  const source = sceneInventory(scene)
  const canvas = collectCanvasSubmission(scene, { pixelWidth, pixelHeight })
  const hiddenLineWorkload = analyzeHiddenLineWorkload(scene)

  const hiddenLine = timed(() => hiddenLinePass(scene, { tolerance }))
  const outline = sceneInventory(hiddenLine.value)
  const boundsClip = timed(() => clipSceneToBounds(hiddenLine.value))
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
    hiddenLine: {
      workload: hiddenLineWorkload,
      durationMs: hiddenLine.durationMs,
      outline,
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
      roots: spacingPercentiles(
        scene.primitives
          .filter((primitive) => primitive.closed === true)
          .map((primitive) => primitive.points[0])
          .filter((point) => point !== undefined),
        millimetersPerSceneUnit,
      ),
      paths: spacingPercentiles(
        boundsClip.value.primitives
          .map((primitive) => primitive.points[0])
          .filter((point) => point !== undefined),
        millimetersPerSceneUnit,
      ),
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
