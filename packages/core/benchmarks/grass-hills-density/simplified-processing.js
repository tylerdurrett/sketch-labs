import {
  preparePolygon,
  subtractPreparedPolygonsFromPolyline,
} from '../../src/polygonClip.ts'

export const SIMPLIFIED_OCCLUDER_MODES = Object.freeze([
  'hill-only',
  'hill-and-clump',
])
export const SIMPLIFIED_DENSITY_MODES = Object.freeze([
  'same-density',
  'plotter-lod',
])
export const PINNED_PLOTTER_NIB_MILLIMETERS = 0.3

/**
 * Subtract benchmark-only coarse masks from open source strokes.
 *
 * Occluder polygons never enter either Scene. The returned Scene contains only
 * surviving source-stroke fragments, so it can be handed unchanged to Outline
 * preview and export renderers without exposing the coarse approximation.
 */
export function processSimplifiedStrokes({
  sourceScene,
  sourceEntries,
  hillRidges,
  occluderMode,
  densityMode,
  millimetersPerSceneUnit,
  nibWidthSceneUnits,
}) {
  requireMode(occluderMode, SIMPLIFIED_OCCLUDER_MODES, 'occluderMode')
  requireMode(densityMode, SIMPLIFIED_DENSITY_MODES, 'densityMode')
  const pinnedNibWidth =
    PINNED_PLOTTER_NIB_MILLIMETERS / millimetersPerSceneUnit
  if (
    !Number.isFinite(nibWidthSceneUnits) ||
    Math.abs(nibWidthSceneUnits - pinnedNibWidth) > 1e-12
  ) {
    throw new RangeError(
      'nibWidthSceneUnits must match the pinned 0.30 mm fineliner profile',
    )
  }

  const hillOccluders = hillRidges.map((ridge, hillIndex) =>
    coarseOccluder({
      identity: `hill:${hillIndex}`,
      kind: 'hill',
      hillIndex,
      painterY: Number.POSITIVE_INFINITY,
      polygon: ridge.points,
    }),
  )
  const clumpOccluders =
    occluderMode === 'hill-and-clump'
      ? buildClumpOccluders(sourceEntries, nibWidthSceneUnits)
      : []
  const clumpIndex = buildOccluderIndex(clumpOccluders, nibWidthSceneUnits)
  const priority = selectPlotterLod(sourceEntries, nibWidthSceneUnits)
  const includedRootKeys =
    densityMode === 'plotter-lod'
      ? new Set(priority.selectedRootKeys)
      : new Set(sourceEntries.map((entry) => entry.rootKey))
  const primitives = []
  const emittedRootKeys = []

  for (const entry of sourceEntries) {
    if (!includedRootKeys.has(entry.rootKey)) continue
    const sourceBounds = boundsOf(entry.primitive.points)
    const masks = []

    for (let hillIndex = entry.hillIndex + 1; hillIndex < hillOccluders.length; hillIndex++) {
      const occluder = hillOccluders[hillIndex]
      if (boundsOverlap(sourceBounds, occluder.bounds)) {
        masks.push(occluder.prepared)
      }
    }
    if (occluderMode === 'hill-and-clump') {
      for (const occluder of queryOccluders(clumpIndex, sourceBounds)) {
        if (
          occluder.ownerTuftKey !== entry.tuftKey &&
          isNearerClump(occluder, entry) &&
          boundsOverlap(sourceBounds, occluder.bounds)
        ) {
          masks.push(occluder.prepared)
        }
      }
    }

    const fragments =
      masks.length === 0
        ? [entry.primitive.points]
        : subtractPreparedPolygonsFromPolyline(entry.primitive.points, masks)
    for (const points of fragments) {
      if (points.length < 2) continue
      primitives.push({
        points,
        closed: false,
        stroke: { ...entry.primitive.stroke },
      })
      emittedRootKeys.push(entry.rootKey)
    }
  }

  return {
    scene: { space: { ...sourceScene.space }, primitives },
    evidence: {
      source: {
        kind: 'open-blade-strokes',
        primitiveCount: sourceEntries.length,
        rootKeys: sourceEntries.map((entry) => entry.rootKey),
      },
      occluders: {
        mode: occluderMode,
        emittedAsGeometry: false,
        hillCount: hillOccluders.length,
        clumpCount: clumpOccluders.length,
        identities: [
          ...hillOccluders.map((occluder) => occluder.identity),
          ...clumpOccluders.map((occluder) => occluder.identity),
        ],
      },
      lod: {
        mode: densityMode,
        priorityContract: 'house-allocation-rank/seeded-root-tie-break',
        nibWidthMillimeters: PINNED_PLOTTER_NIB_MILLIMETERS,
        nibWidthSceneUnits,
        eligibleCount: sourceEntries.length,
        selectedCount: includedRootKeys.size,
        priorityRootKeys: priority.selectedRootKeys,
        includedRootKeys: [...includedRootKeys],
      },
      emittedRootKeys,
    },
  }
}

/**
 * Select a prefix-stable plotter subset at one physical nib of root clearance.
 * New density candidates have later house-allocation ranks, so increasing the
 * requested count can append a selected root but never evict an earlier one.
 */
export function selectPlotterLod(sourceEntries, nibWidthSceneUnits) {
  if (!Number.isFinite(nibWidthSceneUnits) || nibWidthSceneUnits <= 0) {
    throw new RangeError('nibWidthSceneUnits must be finite and positive')
  }
  const priorityOrder = [...sourceEntries].sort(compareLodPriority)
  const cells = new Map()
  const selected = []

  for (const entry of priorityOrder) {
    const [x, y] = entry.descriptor.projected
    const cellX = Math.floor(x / nibWidthSceneUnits)
    const cellY = Math.floor(y / nibWidthSceneUnits)
    let blocked = false

    for (let dx = -1; dx <= 1 && !blocked; dx++) {
      for (let dy = -1; dy <= 1 && !blocked; dy++) {
        const neighbors = cells.get(cellKey(cellX + dx, cellY + dy)) ?? []
        for (const neighbor of neighbors) {
          if (Math.hypot(x - neighbor[0], y - neighbor[1]) < nibWidthSceneUnits) {
            blocked = true
            break
          }
        }
      }
    }
    if (blocked) continue
    selected.push(entry)
    const key = cellKey(cellX, cellY)
    const bucket = cells.get(key)
    if (bucket === undefined) cells.set(key, [[x, y]])
    else bucket.push([x, y])
  }

  return Object.freeze({
    entries: Object.freeze(selected),
    selectedRootKeys: Object.freeze(selected.map((entry) => entry.rootKey)),
  })
}

export function buildClumpOccluders(sourceEntries, nibWidthSceneUnits) {
  const groups = new Map()
  for (const entry of sourceEntries) {
    const group = groups.get(entry.tuftKey)
    if (group === undefined) groups.set(entry.tuftKey, [entry])
    else group.push(entry)
  }

  return [...groups.entries()]
    .map(([tuftKey, entries]) => {
      const roots = entries.map((entry) => entry.descriptor.projected)
      const tips = entries.map((entry) => entry.primitive.points.at(-1))
      const allPoints = entries.flatMap((entry) => entry.primitive.points)
      const pad = nibWidthSceneUnits / 2
      const topY = Math.min(...allPoints.map((point) => point[1])) - pad
      const bottomY = Math.max(...roots.map((point) => point[1])) + pad
      const polygon = [
        [Math.min(...tips.map((point) => point[0])) - pad, topY],
        [Math.max(...tips.map((point) => point[0])) + pad, topY],
        [Math.max(...roots.map((point) => point[0])) + pad, bottomY],
        [Math.min(...roots.map((point) => point[0])) - pad, bottomY],
      ]
      return coarseOccluder({
        identity: `clump:${tuftKey}`,
        kind: 'clump',
        hillIndex: entries[0].hillIndex,
        ownerTuftKey: tuftKey,
        painterY:
          roots.reduce((total, point) => total + point[1], 0) / roots.length,
        polygon,
      })
    })
    .sort(
      (a, b) =>
        a.hillIndex - b.hillIndex ||
        a.painterY - b.painterY ||
        compareString(a.identity, b.identity),
    )
}

function coarseOccluder({
  identity,
  kind,
  hillIndex,
  ownerTuftKey,
  painterY,
  polygon,
}) {
  return Object.freeze({
    identity,
    kind,
    hillIndex,
    ownerTuftKey,
    painterY,
    polygon,
    bounds: boundsOf(polygon),
    prepared: preparePolygon(polygon),
  })
}

function buildOccluderIndex(occluders, nibWidthSceneUnits) {
  const cellSize = Math.max(16, nibWidthSceneUnits * 8)
  const cells = new Map()
  for (const occluder of occluders) {
    forEachBoundsCell(occluder.bounds, cellSize, (key) => {
      const entries = cells.get(key)
      if (entries === undefined) cells.set(key, [occluder])
      else entries.push(occluder)
    })
  }
  return { cellSize, cells }
}

function queryOccluders(index, bounds) {
  const found = new Map()
  forEachBoundsCell(bounds, index.cellSize, (key) => {
    for (const occluder of index.cells.get(key) ?? []) {
      found.set(occluder.identity, occluder)
    }
  })
  return [...found.values()].sort(
    (a, b) =>
      a.hillIndex - b.hillIndex ||
      a.painterY - b.painterY ||
      compareString(a.identity, b.identity),
  )
}

function forEachBoundsCell(bounds, cellSize, visit) {
  const minX = Math.floor(bounds.minX / cellSize)
  const maxX = Math.floor(bounds.maxX / cellSize)
  const minY = Math.floor(bounds.minY / cellSize)
  const maxY = Math.floor(bounds.maxY / cellSize)
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) visit(cellKey(x, y))
  }
}

function isNearerClump(occluder, entry) {
  return (
    occluder.hillIndex > entry.hillIndex ||
    (occluder.hillIndex === entry.hillIndex &&
      occluder.painterY > entry.descriptor.projected[1])
  )
}

function compareLodPriority(a, b) {
  return (
    a.descriptor.lod.rank - b.descriptor.lod.rank ||
    a.descriptor.lod.tieBreak - b.descriptor.lod.tieBreak ||
    compareString(a.rootKey, b.rootKey)
  )
}

function boundsOf(points) {
  return {
    minX: Math.min(...points.map((point) => point[0])),
    minY: Math.min(...points.map((point) => point[1])),
    maxX: Math.max(...points.map((point) => point[0])),
    maxY: Math.max(...points.map((point) => point[1])),
  }
}

function boundsOverlap(a, b) {
  return (
    a.minX <= b.maxX &&
    a.maxX >= b.minX &&
    a.minY <= b.maxY &&
    a.maxY >= b.minY
  )
}

function cellKey(x, y) {
  return `${x}:${y}`
}

function compareString(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function requireMode(value, allowed, name) {
  if (!allowed.includes(value)) {
    throw new RangeError(`${name} must be one of ${allowed.join(', ')}`)
  }
}
