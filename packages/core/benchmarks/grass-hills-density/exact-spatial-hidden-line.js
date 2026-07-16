import { DEFAULT_STROKE } from '../../src/hiddenLine.ts'
import {
  preparePolygon,
  subtractPreparedPolygonsFromPolyline,
} from '../../src/polygonClip.ts'
import { simplifyPath } from '../../src/simplifyPath.ts'

const DEFAULT_MAX_CELLS_PER_PRIMITIVE = 4_096

/**
 * Exact painter-order filled-polygon subtraction with a uniform-grid broad phase.
 *
 * This benchmark-local prototype only replaces Hidden-line's quadratic AABB
 * candidate scan. Polygon preparation, edge/ray pruning, subtraction, and final
 * simplification remain the production implementations landed by PR #275.
 */
export function exactSpatialHiddenLinePass(scene, options = {}) {
  const tolerance = options.tolerance ?? 0
  const maxCellsPerPrimitive =
    options.maxCellsPerPrimitive ?? DEFAULT_MAX_CELLS_PER_PRIMITIVE
  requirePositiveInteger(maxCellsPerPrimitive, 'maxCellsPerPrimitive')

  const totalStarted = performance.now()
  const planStarted = performance.now()
  const filled = planFilledPrimitives(scene)
  const planBuildMs = performance.now() - planStarted
  const cellSize = resolveCellSize(scene, filled, options.cellSize)
  const heapBeforeIndex = process.memoryUsage().heapUsed
  const indexStarted = performance.now()
  const index = buildUniformGrid(filled, cellSize, maxCellsPerPrimitive)
  const indexBuildMs = performance.now() - indexStarted
  const heapAfterIndex = process.memoryUsage().heapUsed

  let broadPhaseCandidatePairCount = 0
  let overlappingPairCount = 0
  let estimatedSegmentEdgeComparisons = 0
  const out = []
  const subtractionStarted = performance.now()

  for (
    let primitiveIndex = 0;
    primitiveIndex < filled.length;
    primitiveIndex++
  ) {
    const self = filled[primitiveIndex]
    if (self.outline.length < 2) continue
    const candidateIndices = queryNearerCandidates(
      index,
      filled,
      primitiveIndex,
      self.aabb,
    )
    broadPhaseCandidatePairCount += candidateIndices.length
    const occluders = []
    for (const candidateIndex of candidateIndices) {
      const other = filled[candidateIndex]
      if (!aabbOverlap(self.aabb, other.aabb)) continue
      occluders.push(other.polygon)
      overlappingPairCount++
      estimatedSegmentEdgeComparisons +=
        (self.outline.length - 1) * other.polygon.edges.length
    }

    const survivors = subtractPreparedPolygonsFromPolyline(
      self.outline,
      occluders,
    )
    const stroke = self.primitive.stroke
      ? { color: 'black', width: self.primitive.stroke.width }
      : DEFAULT_STROKE
    for (const survivor of survivors) {
      out.push({ points: simplifyPath(survivor, tolerance), stroke })
    }
  }

  const subtractionMs = performance.now() - subtractionStarted
  const durationMs = performance.now() - totalStarted
  const allPainterPairs = (filled.length * (filled.length - 1)) / 2

  return {
    scene: { space: scene.space, primitives: out },
    durationMs,
    stats: Object.freeze({
      contract: 'exact-painter-order/uniform-aabb-grid/production-polygon-clip',
      filledPrimitiveCount: filled.length,
      allPainterPairCount: allPainterPairs,
      broadPhaseCandidatePairCount,
      overlappingPairCount,
      estimatedSegmentEdgeComparisons,
      timings: Object.freeze({ planBuildMs, indexBuildMs, subtractionMs }),
      index: Object.freeze({
        cellSize,
        occupiedCellCount: index.cells.size,
        indexedReferenceCount: index.indexedReferenceCount,
        overflowPrimitiveCount: index.overflow.length,
        maxCellsPerPrimitive,
        heapDeltaBytes: heapAfterIndex - heapBeforeIndex,
        estimatedBytes:
          index.cells.size * 64 +
          index.indexedReferenceCount * 8 +
          index.overflow.length * 8,
      }),
    }),
  }
}

function planFilledPrimitives(scene) {
  const filled = []
  for (const primitive of scene.primitives) {
    if (!primitive.fill) continue
    const aabb = computeAABB(primitive.points)
    if (aabb === null) continue
    filled.push({
      primitive,
      aabb,
      polygon: preparePolygon(primitive.points),
      outline: outlineRing(primitive),
    })
  }
  return filled
}

function buildUniformGrid(filled, cellSize, maxCellsPerPrimitive) {
  const cells = new Map()
  const overflow = []
  let indexedReferenceCount = 0

  for (let index = 0; index < filled.length; index++) {
    const range = cellRange(filled[index].aabb, cellSize)
    if (range === null || range.cellCount > maxCellsPerPrimitive) {
      overflow.push(index)
      continue
    }
    for (let y = range.minY; y <= range.maxY; y++) {
      for (let x = range.minX; x <= range.maxX; x++) {
        const key = cellKey(x, y)
        const occupants = cells.get(key)
        if (occupants === undefined) cells.set(key, [index])
        else occupants.push(index)
        indexedReferenceCount++
      }
    }
  }

  return {
    cells,
    overflow,
    indexedReferenceCount,
    cellSize,
    maxCellsPerPrimitive,
  }
}

function queryNearerCandidates(index, filled, selfIndex, aabb) {
  const range = cellRange(aabb, index.cellSize)
  if (range === null || range.cellCount > index.maxCellsPerPrimitive) {
    return Array.from(
      { length: filled.length - selfIndex - 1 },
      (_, offset) => selfIndex + offset + 1,
    )
  }

  const candidates = new Set()
  for (let y = range.minY; y <= range.maxY; y++) {
    for (let x = range.minX; x <= range.maxX; x++) {
      const occupants = index.cells.get(cellKey(x, y))
      if (occupants === undefined) continue
      for (const candidate of occupants) {
        if (candidate > selfIndex) candidates.add(candidate)
      }
    }
  }
  for (const candidate of index.overflow) {
    if (candidate > selfIndex) candidates.add(candidate)
  }

  // Grid insertion order is not an occlusion contract. Restore source painter
  // order before passing prepared polygons to the exact subtraction routine.
  return [...candidates].sort((a, b) => a - b)
}

function resolveCellSize(scene, filled, requested) {
  if (requested !== undefined) {
    if (!Number.isFinite(requested) || requested <= 0) {
      throw new RangeError('cellSize must be a finite positive number')
    }
    return requested
  }

  let span = Math.max(scene.space.width, scene.space.height)
  if (!Number.isFinite(span) || span <= 0) {
    span = 1
    for (const primitive of filled) {
      if (!isFiniteAABB(primitive.aabb)) continue
      span = Math.max(
        span,
        primitive.aabb.maxX - primitive.aabb.minX,
        primitive.aabb.maxY - primitive.aabb.minY,
      )
    }
  }
  return span / Math.max(1, Math.ceil(Math.sqrt(filled.length)))
}

function cellRange(aabb, cellSize) {
  if (!isFiniteAABB(aabb)) return null
  const minX = Math.floor(aabb.minX / cellSize)
  const minY = Math.floor(aabb.minY / cellSize)
  const maxX = Math.floor(aabb.maxX / cellSize)
  const maxY = Math.floor(aabb.maxY / cellSize)
  if (![minX, minY, maxX, maxY].every(Number.isSafeInteger)) return null
  const columns = maxX - minX + 1
  const rows = maxY - minY + 1
  const cellCount = columns * rows
  if (!Number.isSafeInteger(cellCount) || cellCount <= 0) return null
  return { minX, minY, maxX, maxY, cellCount }
}

function cellKey(x, y) {
  return `${x},${y}`
}

function computeAABB(points) {
  if (points.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of points) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

function isFiniteAABB(aabb) {
  return (
    Number.isFinite(aabb.minX) &&
    Number.isFinite(aabb.minY) &&
    Number.isFinite(aabb.maxX) &&
    Number.isFinite(aabb.maxY)
  )
}

function aabbOverlap(a, b) {
  return (
    a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
  )
}

function outlineRing(primitive) {
  const ring = primitive.points.map(([x, y]) => [x, y])
  if (primitive.closed && ring.length >= 2) {
    const first = ring[0]
    const last = ring.at(-1)
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1]])
    }
  }
  return ring
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`)
  }
}
