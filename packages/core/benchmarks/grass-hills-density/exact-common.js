import { createScene } from '../../src/scene.ts'
import { grassScaleAtY } from '../../src/sketches/grass-hills/depth.ts'
import {
  createGrassHillMask,
  projectGrassRoot,
} from '../../src/sketches/grass-hills/grass-placement.ts'
import { buildRidgeBands } from '../../src/sketches/grass-hills/ridge-bands.ts'
import { layoutHillBands } from '../../src/sketches/grass-hills/depth.ts'
import { createTerrainField } from '../../src/sketches/grass-hills/terrain.ts'
import { collectSceneMetrics } from './metrics.js'
import { exactSpatialHiddenLinePass } from './exact-spatial-hidden-line.js'

const CANONICAL_ROOT_CAPACITY = 10_000
const POISSON_RADIUS = 0.0065
const STRATIFIED_SIDE = 100
const RIDGE_SAMPLES = 128
const HILL_STROKE_WIDTH = 2
const BLADE_STROKE_WIDTH = 2
const LEGACY_FLANK_SEGMENTS = 16

export const EXACT_ROOT_STRATEGIES = Object.freeze(['poisson', 'stratified'])
export const EXACT_BLADE_GEOMETRIES = Object.freeze(['detailed-33', 'simple-7'])

/**
 * Build a completed canonical root bank, then retain a nested prefix.
 *
 * Both strategies have a fixed 10k-root capacity per reduced hill identity.
 * Requested composition counts therefore never move an existing canonical root:
 * they only lengthen or shorten the retained prefix before terrain reprojection.
 */
export function exactCanonicalRoots({ strategy, seed, hillKey, count }) {
  requireChoice(strategy, EXACT_ROOT_STRATEGIES, 'root strategy')
  requireNonNegativeInteger(count, 'root count')
  if (count > CANONICAL_ROOT_CAPACITY) {
    throw new RangeError(
      `root count ${count} exceeds exact candidate capacity ${CANONICAL_ROOT_CAPACITY}`,
    )
  }

  const roots =
    strategy === 'poisson'
      ? poissonRoots(seed, hillKey)
      : stratifiedRoots(seed, hillKey)
  if (roots.length < count) {
    throw new Error(
      `${strategy} canonical field for hill ${hillKey} produced ${roots.length} roots; ${count} requested`,
    )
  }
  return Object.freeze(roots.slice(0, count))
}

function poissonRoots(seed, hillKey) {
  const points = cappedPoissonPoints(`${seed}-exact-poisson-roots-${hillKey}`)
  return points
    .map(([u, v], ordinal) => ({
      u,
      v,
      ordinal,
      hillKey,
      rootKey: `${hillKey}:poisson:${ordinal}`,
      priority: benchmarkRandom(
        `${seed}-exact-poisson-priority-${hillKey}-${ordinal}`,
      ).value(),
    }))
    .sort((a, b) => a.priority - b.priority || a.ordinal - b.ordinal)
    .map(freezeRoot)
}

/**
 * Benchmark-local constant-radius Bridson fill with a fixed completion count.
 * The production sampler intentionally fills to exhaustion; this prototype's
 * canonical contract is instead exactly 10k roots, so retiring the saturated
 * tail would measure work that no candidate consumes.
 */
function cappedPoissonPoints(seed) {
  const random = benchmarkRandom(seed)
  const cellSize = POISSON_RADIUS / Math.SQRT2
  const side = Math.ceil(1 / cellSize)
  const grid = new Int32Array(side * side)
  grid.fill(-1)
  const points = []
  const active = []

  function add(point) {
    const index = points.length
    points.push(point)
    active.push(index)
    grid[gridIndex(point)] = index
  }

  function gridIndex([x, y]) {
    return Math.floor(y / cellSize) * side + Math.floor(x / cellSize)
  }

  function accepted([x, y]) {
    const cellX = Math.floor(x / cellSize)
    const cellY = Math.floor(y / cellSize)
    for (let offsetY = -2; offsetY <= 2; offsetY++) {
      const row = cellY + offsetY
      if (row < 0 || row >= side) continue
      for (let offsetX = -2; offsetX <= 2; offsetX++) {
        const column = cellX + offsetX
        if (column < 0 || column >= side) continue
        const occupant = grid[row * side + column]
        if (occupant === -1) continue
        const [otherX, otherY] = points[occupant]
        if (Math.hypot(x - otherX, y - otherY) < POISSON_RADIUS) return false
      }
    }
    return true
  }

  add([random.value(), random.value()])
  while (active.length > 0 && points.length < CANONICAL_ROOT_CAPACITY) {
    const activeIndex = random.rangeFloor(0, active.length)
    const origin = points[active[activeIndex]]
    let found = false
    for (let attempt = 0; attempt < 30; attempt++) {
      const angle = random.range(0, 2 * Math.PI)
      const distance = random.range(POISSON_RADIUS, 2 * POISSON_RADIUS)
      const candidate = [
        origin[0] + Math.cos(angle) * distance,
        origin[1] + Math.sin(angle) * distance,
      ]
      if (
        candidate[0] < 0 ||
        candidate[0] >= 1 ||
        candidate[1] < 0 ||
        candidate[1] >= 1 ||
        !accepted(candidate)
      )
        continue
      add(candidate)
      found = true
      break
    }
    if (!found) {
      active[activeIndex] = active[active.length - 1]
      active.pop()
    }
  }

  if (points.length < CANONICAL_ROOT_CAPACITY) {
    throw new Error(
      `Poisson radius ${POISSON_RADIUS} exhausted at ${points.length} roots`,
    )
  }
  return points
}

function stratifiedRoots(seed, hillKey) {
  const roots = []
  for (let row = 0; row < STRATIFIED_SIDE; row++) {
    for (let column = 0; column < STRATIFIED_SIDE; column++) {
      const cellKey = `${column},${row}`
      const jitter = benchmarkRandom(
        `${seed}-exact-stratified-root-${hillKey}-${cellKey}`,
      )
      const priority = benchmarkRandom(
        `${seed}-exact-stratified-priority-${hillKey}-${cellKey}`,
      ).value()
      roots.push({
        u: (column + jitter.value()) / STRATIFIED_SIDE,
        v: (row + jitter.value()) / STRATIFIED_SIDE,
        hillKey,
        rootKey: `${hillKey}:cell:${cellKey}`,
        priority,
        cellOrdinal: row * STRATIFIED_SIDE + column,
      })
    }
  }

  roots.sort((a, b) => a.priority - b.priority || a.cellOrdinal - b.cellOrdinal)
  return roots.map((root, ordinal) => freezeRoot({ ...root, ordinal }))
}

function freezeRoot({ u, v, ordinal, hillKey, rootKey }) {
  return Object.freeze({ u, v, ordinal, hillKey, rootKey })
}

/** Prepare canonical descriptors and their count-dependent physical projection. */
export function prepareExactComposition(payload, options) {
  validatePayload(payload)
  const { rootStrategy, bladeGeometry } = options
  requireChoice(rootStrategy, EXACT_ROOT_STRATEGIES, 'root strategy')
  requireChoice(bladeGeometry, EXACT_BLADE_GEOMETRIES, 'blade geometry')

  const { seed, frame, params, request } = payload
  const hillCount = Math.round(request.hillCount)
  const requestedBladeCount = Math.round(request.bladeCount)
  const projection = {
    frame,
    horizonHeight: params.horizonHeight,
    depthFalloff: params.depthFalloff,
  }
  const bands = layoutHillBands(hillCount, projection)
  const terrainAt = createTerrainField(seed, {
    ridgeScale: params.ridgeScale,
    terrainDrift: params.terrainDrift,
  })
  const ridges = buildRidgeBands({
    frame,
    bands,
    terrainAt,
    ridgeAmplitude: params.ridgeAmplitude,
    ridgeSamples: RIDGE_SAMPLES,
  })
  const maxUnscaledBladeLength = clamp(
    params.bladeLength + params.bladeLengthVariance,
    1,
    120,
  )
  const baseCount = Math.floor(requestedBladeCount / hillCount)
  const remainder = requestedBladeCount % hillCount

  const hills = bands.map((band, hillIndex) => {
    const count = baseCount + (hillIndex < remainder ? 1 : 0)
    const roots = exactCanonicalRoots({
      strategy: rootStrategy,
      seed,
      hillKey: band.hillKey,
      count,
    })
    const ridge = ridges[hillIndex]
    const mask = createGrassHillMask({
      frame,
      projection,
      band,
      ridge,
      ...(hillIndex + 1 < ridges.length
        ? { nextNearerRidge: ridges[hillIndex + 1] }
        : {}),
      maxUnscaledBladeLength,
    })
    const blades = roots
      .map((root) =>
        exactBladeDescriptor({
          seed,
          root,
          mask,
          params,
        }),
      )
      .sort(
        (a, b) =>
          a.projected[1] - b.projected[1] ||
          a.projected[0] - b.projected[0] ||
          a.identity.ordinal - b.identity.ordinal,
      )

    return Object.freeze({
      hillKey: band.hillKey,
      ridge: Object.freeze(ridge.points.map(freezePoint)),
      roots,
      blades: Object.freeze(blades),
    })
  })

  return Object.freeze({
    rootStrategy,
    bladeGeometry,
    frame: Object.freeze({ ...frame }),
    styles: Object.freeze({
      background: params.backgroundColor,
      hillFill: params.hillColor,
      hillStroke: params.hillStrokeColor,
      bladeFill: params.bladeColor,
      bladeStroke: params.bladeStrokeColor,
    }),
    hills: Object.freeze(hills),
    bladeCount: requestedBladeCount,
  })
}

function exactBladeDescriptor({ seed, root, mask, params }) {
  const random = benchmarkRandom(`${seed}-grass-blade-${root.rootKey}`)
  // This draw order is deliberately unconditional and shared by every exact
  // candidate so geometry swaps cannot perturb per-root variation.
  const rolls = Object.freeze({
    length: random.value(),
    width: random.value(),
    stiffness: random.value(),
    lean: random.value(),
  })
  const projected = Object.freeze(projectGrassRoot(root, mask))
  const scale = grassScaleAtY(projected[1], mask.projection)
  const unscaledLength = clamp(
    params.bladeLength + signed(rolls.length) * params.bladeLengthVariance,
    1,
    120,
  )
  const unscaledWidth = clamp(
    params.bladeWidth * lerp(0.8, 1.2, rolls.width),
    0.1,
    0.8 * unscaledLength,
  )

  return Object.freeze({
    identity: Object.freeze({
      hillKey: root.hillKey,
      rootKey: root.rootKey,
      ordinal: root.ordinal,
    }),
    canonical: Object.freeze({ u: root.u, v: root.v }),
    projected,
    rolls,
    shape: Object.freeze({
      length: unscaledLength * scale,
      width: unscaledWidth * scale,
      stiffness: clamp(
        2.5 + signed(rolls.stiffness) * params.stiffnessVariance * 1.5,
        1,
        4,
      ),
      lean: params.windLean * lerp(0.8, 1.2, rolls.lean),
    }),
  })
}

/** Materialize one exact filled-blade Scene from retained preparation. */
export function sampleExactComposition(prepared, _t = 0) {
  const builder = createScene(prepared.frame, {
    color: prepared.styles.background,
  })
  const projectedRoots = []

  for (const hill of prepared.hills) {
    builder.addPath(hill.ridge.map(copyPoint), {
      closed: false,
      fill: { color: prepared.styles.hillFill },
      stroke: { color: prepared.styles.hillStroke, width: HILL_STROKE_WIDTH },
    })

    for (const descriptor of hill.blades) {
      const [rootX, rootY] = descriptor.projected
      const local =
        prepared.bladeGeometry === 'detailed-33'
          ? legacyDetailedBlade(descriptor.shape)
          : simpleBlade(descriptor.shape)
      builder.addPath(
        local.map(([x, y]) => [x + rootX, y + rootY]),
        {
          closed: true,
          fill: { color: prepared.styles.bladeFill },
          stroke: {
            color: prepared.styles.bladeStroke,
            width: BLADE_STROKE_WIDTH,
          },
        },
      )
      projectedRoots.push(copyPoint(descriptor.projected))
    }
  }

  return {
    scene: builder.build(),
    roots: projectedRoots,
    identity: {
      rootStrategy: prepared.rootStrategy,
      bladeGeometry: prepared.bladeGeometry,
      hillKeys: prepared.hills.map((hill) => hill.hillKey),
      rootKeys: prepared.hills.flatMap((hill) =>
        hill.blades.map((descriptor) => descriptor.identity.rootKey),
      ),
    },
  }
}

/** Issue-start 33-point blade, isolated from production's adopted seven points. */
function legacyDetailedBlade(shape) {
  const { length, width, lean, stiffness } = shape
  const right = []
  const left = []
  for (let index = 0; index <= LEGACY_FLANK_SEGMENTS; index++) {
    if (index === 0) {
      right.push([0, 0])
      left.push([0, 0])
      continue
    }
    const t = index / LEGACY_FLANK_SEGMENTS
    const spineX = lean * length * t ** (stiffness + 1)
    const y = -length * t
    const halfWidth = width * (2 * t * (1 - t))
    right.push([spineX + halfWidth, y])
    left.push([spineX - halfWidth, y])
  }
  return [...right, ...left.slice(0, -1).reverse()]
}

/** Seven explicit points: root, two stations per flank, apex, and root again. */
export function simpleBlade(shape) {
  const stations = [0, 0.5, 0.82, 1]
  const right = stations.map((t) => bladeStation(shape, t, 1))
  const left = stations.map((t) => bladeStation(shape, t, -1))
  return [right[0], right[1], right[2], right[3], left[2], left[1], left[0]]
}

function bladeStation(shape, t, side) {
  if (t === 0) return [0, 0]
  const spineX = shape.lean * shape.length * t ** (shape.stiffness + 1)
  const halfWidth = shape.width * (2 * t * (1 - t))
  return [spineX + side * halfWidth, -shape.length * t]
}

/** Create the protocol-v1 object consumed by the M2 runner and bundler. */
export function createExactBenchmarkCandidate({
  id,
  rootStrategy,
  bladeGeometry,
}) {
  requireChoice(rootStrategy, EXACT_ROOT_STRATEGIES, 'root strategy')
  requireChoice(bladeGeometry, EXACT_BLADE_GEOMETRIES, 'blade geometry')
  return Object.freeze({
    id,
    complexity: 'linear',
    prepare(payload) {
      const prepared = prepareExactComposition(payload, {
        rootStrategy,
        bladeGeometry,
      })
      return (t) => sampleExactComposition(prepared, t)
    },
    generate(payload, t) {
      return sampleExactComposition(
        prepareExactComposition(payload, { rootStrategy, bladeGeometry }),
        t,
      )
    },
    guard(value) {
      const resolved = typeof value === 'function' ? value(0) : value
      return resolved.scene.primitives.reduce(
        (count, primitive) => count + primitive.points.length,
        0,
      )
    },
    inspect({ value, payload }) {
      const resolved =
        typeof value === 'function' ? value(payload.t ?? 0) : value
      const processed = exactSpatialHiddenLinePass(resolved.scene)
      return {
        ...collectSceneMetrics(resolved.scene, {
          profile: payload.profile,
          roots: resolved.roots,
          nibWidthSceneUnits: payload.pen.nibWidthSceneUnits,
          clearanceSampling: payload.metrics.clearanceSampling,
          processing: {
            scene: processed.scene,
            durationMs: processed.durationMs,
          },
        }),
        rootCount: resolved.roots.length,
        identity: resolved.identity,
        exactSpatialHiddenLine: processed.stats,
      }
    },
  })
}

function validatePayload(payload) {
  if (payload === null || typeof payload !== 'object') {
    throw new TypeError('exact candidate payload must be an object')
  }
  const hillCount = payload.request?.hillCount
  const bladeCount = payload.request?.bladeCount
  requirePositiveInteger(hillCount, 'request.hillCount')
  requireNonNegativeInteger(bladeCount, 'request.bladeCount')
  if (Math.ceil(bladeCount / hillCount) > CANONICAL_ROOT_CAPACITY) {
    throw new RangeError(
      `request.bladeCount requires more than ${CANONICAL_ROOT_CAPACITY} roots per hill`,
    )
  }
}

function requireChoice(value, choices, name) {
  if (!choices.includes(value)) {
    throw new RangeError(`${name} must be one of ${choices.join(', ')}`)
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`)
  }
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`)
  }
}

function freezePoint([x, y]) {
  return Object.freeze([x, y])
}

function copyPoint([x, y]) {
  return [x, y]
}

function signed(value) {
  return 2 * value - 1
}

function lerp(from, to, amount) {
  return from + (to - from) * amount
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

/** Small root-local PRNG: candidates need sequential rolls, not noise fields. */
function benchmarkRandom(seed) {
  let state = 2_166_136_261
  const text = String(seed)
  for (let index = 0; index < text.length; index++) {
    state ^= text.charCodeAt(index)
    state = Math.imul(state, 16_777_619)
  }

  function value() {
    state = (state + 0x6d2b79f5) | 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }

  return {
    value,
    range(min, max) {
      return min + value() * (max - min)
    },
    rangeFloor(min, max) {
      return Math.floor(min + value() * (max - min))
    },
  }
}
