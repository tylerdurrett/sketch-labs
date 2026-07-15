import { createRandom } from '../../src/random.ts'
import {
  grassScaleAtDepth,
  grassScaleAtY,
  layoutHillBands,
} from '../../src/sketches/grass-hills/depth.ts'
import {
  createGrassHillMask,
  projectGrassRoot,
} from '../../src/sketches/grass-hills/grass-placement.ts'
import { buildRidgeBands } from '../../src/sketches/grass-hills/ridge-bands.ts'
import { createTerrainField } from '../../src/sketches/grass-hills/terrain.ts'
import { collectSceneMetrics } from './metrics.js'

export const SIMPLIFIED_CANDIDATE_ID = 'simplified-stroke-tufts'
export const SIMPLIFIED_BLADE_POINT_COUNT = 6
export const SIMPLIFIED_TUFT_SIZE = 5

const RIDGE_SAMPLES = 64
const TAU = 2 * Math.PI

/**
 * Benchmark-only dense Grass Hills representation.
 *
 * Every visible blade remains one open, six-point centerline. Tufts are stable
 * preparation metadata rather than joined Scene paths: joining distinct roots
 * would add false connector marks to SVG and plotter output. This candidate
 * deliberately performs no hidden-line removal, coarse occlusion, or LOD.
 */
export const benchmarkCandidate = Object.freeze({
  id: SIMPLIFIED_CANDIDATE_ID,
  complexity: 'linear',
  prepare(payload) {
    const prepared = prepareSimplifiedCandidate(payload)
    return (t) => sampleSimplifiedCandidate(prepared, t)
  },
  generate(payload, t) {
    return sampleSimplifiedCandidate(prepareSimplifiedCandidate(payload), t)
  },
  guard(result) {
    let pointCount = 0
    for (const primitive of result.scene.primitives) {
      pointCount += primitive.points.length
    }
    return pointCount + result.roots.length + result.tufts.length
  },
  inspect({ value, payload }) {
    const result = typeof value === 'function' ? value(payload.t) : value
    return {
      representation: {
        kind: 'open-centerline-blades/stable-tuft-metadata',
        bladeCount: result.blades.length,
        tuftCount: result.tufts.length,
        tuftMemberCount: result.tufts.reduce(
          (total, tuft) => total + tuft.members.length,
          0,
        ),
        pointsPerBlade: SIMPLIFIED_BLADE_POINT_COUNT,
      },
      ...collectSceneMetrics(result.scene, {
        profile: payload.profile,
        roots: result.roots,
        nibWidthSceneUnits: payload.pen.nibWidthSceneUnits,
        clearanceSampling: payload.metrics.clearanceSampling,
        // The identity callback records the cost and output of this candidate's
        // intentionally unobscured stroke representation without invoking the
        // generic filled-primitive hidden-line pass.
        processing: { run: (source) => source },
        pixelWidth: payload.frame.width,
        pixelHeight: payload.frame.height,
      }),
    }
  },
})

export function prepareSimplifiedCandidate(payload) {
  validatePayload(payload)
  const { frame, params, request, seed } = payload
  const projection = Object.freeze({
    frame: Object.freeze({ width: frame.width, height: frame.height }),
    horizonHeight: params.horizonHeight,
    depthFalloff: params.depthFalloff,
  })
  const bands = layoutHillBands(request.hillCount, projection)
  const counts = allocateBladeCounts(request.bladeCount, bands)
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
  const maximumLength = clamp(
    params.bladeLength + params.bladeLengthVariance,
    1,
    120,
  )

  const hills = bands.map((band, hillIndex) => {
    const roots = buildNestedTuftRoots(seed, band.hillKey, counts[hillIndex])
    const mask = createGrassHillMask({
      frame,
      projection,
      band,
      ridge: ridges[hillIndex],
      ...(hillIndex + 1 < ridges.length
        ? { nextNearerRidge: ridges[hillIndex + 1] }
        : {}),
      maxUnscaledBladeLength: maximumLength,
    })
    const blades = roots.map((root) =>
      resolveBladeDescriptor({ seed, params, band, mask, root }),
    )
    const painterOrder = [...blades].sort(compareBladePainterOrder)

    return Object.freeze({
      band: Object.freeze({ ...band }),
      blades: Object.freeze(blades),
      painterOrder: Object.freeze(painterOrder),
      tufts: buildTufts(band.hillKey, blades),
    })
  })

  return Object.freeze({
    frame: Object.freeze({ width: frame.width, height: frame.height }),
    backgroundColor: params.backgroundColor,
    bladeStrokeColor: params.bladeStrokeColor,
    hills: Object.freeze(hills),
  })
}

/** Resolve an already-prepared root field through the sampling-time lean seam. */
export function sampleSimplifiedCandidate(prepared, t) {
  if (!Number.isFinite(t)) throw new RangeError('t must be finite')

  const primitives = []
  const roots = []
  const blades = []
  const tufts = []

  for (const hill of prepared.hills) {
    blades.push(...hill.blades)
    tufts.push(...hill.tufts)
    for (const descriptor of hill.painterOrder) {
      roots.push(descriptor.projected)
      primitives.push({
        points: simplifiedBladePoints(descriptor, t),
        closed: false,
        stroke: {
          color: prepared.bladeStrokeColor,
          width: descriptor.shape.width,
        },
      })
    }
  }

  return {
    scene: {
      space: { ...prepared.frame },
      primitives,
      background: { color: prepared.backgroundColor },
    },
    roots,
    blades,
    tufts,
  }
}

/**
 * Give each hill an exact count, weighted continuously by projected blade area.
 * Sequential highest averages makes the allocation house-monotone: increasing
 * the requested total by one always adds one root and can never remove a root
 * from another hill. Equal priorities resolve toward the farther hill.
 */
export function allocateBladeCounts(totalCount, bands) {
  requireNonNegativeInteger(totalCount, 'totalCount')
  if (bands.length === 0) return Object.freeze([])

  const weights = bands.map(({ depth }) => 1 / grassScaleAtDepth(depth) ** 2)
  const counts = bands.map(() => 0)

  for (let allocated = 0; allocated < totalCount; allocated++) {
    let bestIndex = 0
    for (let index = 1; index < bands.length; index++) {
      const priority = weights[index] / (counts[index] + 1)
      const bestPriority = weights[bestIndex] / (counts[bestIndex] + 1)
      if (priority > bestPriority) bestIndex = index
    }
    counts[bestIndex] += 1
  }
  return Object.freeze(counts)
}

/**
 * Produce an exact prefix-nested root field arranged into spatial five-member
 * tufts. Root and tuft identities depend only on seed, reduced hill identity,
 * and canonical ordinal; requested count only chooses the prefix length.
 */
export function buildNestedTuftRoots(seed, hillKey, count) {
  requireNonNegativeInteger(count, 'count')
  const roots = []

  for (let ordinal = 0; ordinal < count; ordinal++) {
    const tuftOrdinal = Math.floor(ordinal / SIMPLIFIED_TUFT_SIZE)
    const memberOrdinal = ordinal % SIMPLIFIED_TUFT_SIZE
    const tuftKey = `${hillKey}:tuft:${tuftOrdinal}`
    const rootKey = `${hillKey}:${ordinal}`
    const centerU = radicalInverse(tuftOrdinal + 1, 2)
    const centerV = radicalInverse(tuftOrdinal + 1, 3)
    const random = createRandom(`${seed}-simplified-root-${rootKey}`)
    const angle =
      TAU *
      (memberOrdinal / SIMPLIFIED_TUFT_SIZE + (random.value() - 0.5) * 0.08)
    const radius =
      memberOrdinal === 0 ? 0 : 0.006 + 0.009 * Math.sqrt(random.value())

    roots.push(
      Object.freeze({
        u: reflectUnit(centerU + Math.cos(angle) * radius),
        v: reflectUnit(centerV + Math.sin(angle) * radius),
        ordinal,
        rootKey,
        tuftOrdinal,
        tuftKey,
        memberOrdinal,
      }),
    )
  }

  return Object.freeze(roots)
}

/** Six root-to-tip stations on one open, stiff-base centerline. */
export function simplifiedBladePoints(descriptor, _t) {
  const { projected, shape } = descriptor
  const points = []
  const tipOffset = shape.lean * shape.length

  for (let index = 0; index < SIMPLIFIED_BLADE_POINT_COUNT; index++) {
    const progress = index / (SIMPLIFIED_BLADE_POINT_COUNT - 1)
    points.push([
      projected[0] + tipOffset * progress ** (shape.stiffness + 1),
      projected[1] - shape.length * progress,
    ])
  }
  return points
}

function resolveBladeDescriptor({ seed, params, band, mask, root }) {
  const random = createRandom(`${seed}-simplified-blade-${root.rootKey}`)
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
      hillKey: band.hillKey,
      rootKey: root.rootKey,
      ordinal: root.ordinal,
      tuftKey: root.tuftKey,
      tuftOrdinal: root.tuftOrdinal,
      memberOrdinal: root.memberOrdinal,
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
      // Time is intentionally accepted later by simplifiedBladePoints. Y1
      // preserves today's static lean; the gust/wave function remains #301.
      lean: params.windLean * lerp(0.8, 1.2, rolls.lean),
    }),
  })
}

function buildTufts(hillKey, blades) {
  const tufts = []
  for (let start = 0; start < blades.length; start += SIMPLIFIED_TUFT_SIZE) {
    const members = blades.slice(start, start + SIMPLIFIED_TUFT_SIZE)
    const tuftOrdinal = Math.floor(start / SIMPLIFIED_TUFT_SIZE)
    tufts.push(
      Object.freeze({
        identity: Object.freeze({
          hillKey,
          tuftKey: `${hillKey}:tuft:${tuftOrdinal}`,
          ordinal: tuftOrdinal,
        }),
        members: Object.freeze(members),
      }),
    )
  }
  return Object.freeze(tufts)
}

function compareBladePainterOrder(a, b) {
  return (
    a.projected[1] - b.projected[1] ||
    a.projected[0] - b.projected[0] ||
    a.identity.ordinal - b.identity.ordinal
  )
}

function radicalInverse(index, base) {
  let fraction = 1 / base
  let value = 0
  while (index > 0) {
    value += (index % base) * fraction
    index = Math.floor(index / base)
    fraction /= base
  }
  return value
}

function reflectUnit(value) {
  const period = ((value % 2) + 2) % 2
  return period <= 1 ? period : 2 - period
}

function validatePayload(payload) {
  if (payload === null || typeof payload !== 'object') {
    throw new TypeError('payload must be an object')
  }
  requirePositiveFinite(payload.frame?.width, 'frame.width')
  requirePositiveFinite(payload.frame?.height, 'frame.height')
  requirePositiveInteger(payload.request?.hillCount, 'request.hillCount')
  requirePositiveInteger(payload.request?.bladeCount, 'request.bladeCount')

  for (const name of [
    'horizonHeight',
    'depthFalloff',
    'ridgeScale',
    'ridgeAmplitude',
    'terrainDrift',
    'bladeLength',
    'bladeLengthVariance',
    'bladeWidth',
    'stiffnessVariance',
    'windLean',
  ]) {
    if (!Number.isFinite(payload.params?.[name])) {
      throw new RangeError(`params.${name} must be finite`)
    }
  }
}

function requirePositiveFinite(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`)
  }
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`)
  }
}

function requirePositiveInteger(value, name) {
  requireNonNegativeInteger(value, name)
  if (value === 0) throw new RangeError(`${name} must be positive`)
}

function signed(value) {
  return 2 * value - 1
}

function lerp(start, end, amount) {
  return start + (end - start) * amount
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}
