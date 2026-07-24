/**
 * Bounded multiscale contour evidence for Flowing Contours.
 *
 * Visible luminance and alpha are analysed independently and combined only as
 * structure-tensor evidence. This keeps an internal alpha transition useful
 * without allowing RGB hidden behind exact-zero alpha to enter the field.
 * Gaussian scale-space and Scharr derivatives are rotationally symmetric
 * enough for diagonal and curved evidence to retain continuous, non-lattice
 * tangents. Convolution is renormalized over in-raster samples and derivatives
 * are evaluated only where their complete stencil exists, so the fitted-image
 * perimeter is never compared with an invented outside value.
 */

import type { Point } from '../../types'
import {
  createFlowingContoursAccounting,
  terminateFlowingContoursAtSafetyLimit,
  type FlowingContoursAccounting,
} from './accounting'
import {
  FLOWING_CONTOURS_LIMITS,
  isWithinFlowingContoursLimit,
  type FlowingContoursLimits,
} from './limits'
import type { PreparedFlowingContoursRaster } from './raster'
import type {
  CorrectedFlowingRidgeSample,
  FlowingContoursField,
  FlowingContoursFieldEnsemble,
} from './types'

const SCHARR_AXIS_WEIGHT = 10
const SCHARR_DIAGONAL_WEIGHT = 3
const SCHARR_NORMALIZATION = 32
const GAUSSIAN_TRUNCATION_SIGMAS = 3
const ALPHA_TENSOR_WEIGHT = 0.8
const EVIDENCE_GAIN = 2
const EVIDENCE_EPSILON = 1e-10
const ORIENTATION_EPSILON = 1e-12

/**
 * Fixed logarithmic analysis policy in lattice pixels.
 *
 * Four bands leave one plane of headroom under the FC03 safety ceiling.
 * Scale-normalized gradients make responses comparable; the mild fine-scale
 * preference breaks near-ties without preventing a broad transition from
 * selecting a larger band.
 */
const SCALE_POLICY = Object.freeze([
  Object.freeze({ sigma: 1, preference: 1 }),
  Object.freeze({ sigma: 2, preference: 0.96 }),
  Object.freeze({ sigma: 4, preference: 0.9 }),
  Object.freeze({ sigma: 8, preference: 0.82 }),
] as const)
/**
 * The broad plane is deliberately separate rather than appended to
 * `SCALE_POLICY`: a wide form tangent must remain searchable even where a
 * stronger local texture response wins at the same sample.
 */
const BROAD_FORM_SCALE_POLICY = Object.freeze([
  Object.freeze({ sigma: 16, preference: 1 }),
] as const)
const BROAD_FORM_LOCAL_SUPPORT_FLOOR = 0.04
const FIELD_ENSEMBLE_SCALE_PLANE_COUNTS = new WeakMap<
  Readonly<FlowingContoursFieldEnsemble>,
  number
>()

interface ScalePolicyEntry {
  readonly sigma: number
  readonly preference: number
}

export function flowingContoursFieldEnsembleScalePlaneCount(
  ensemble: Readonly<FlowingContoursFieldEnsemble>,
): number | null {
  return FIELD_ENSEMBLE_SCALE_PLANE_COUNTS.get(ensemble) ?? null
}

const EMPTY_VALUES = Object.freeze([]) as readonly number[]
const EMPTY_SUPPORT = Object.freeze([]) as readonly boolean[]

const EMPTY_FLOWING_CONTOURS_FIELD: FlowingContoursField = Object.freeze({
  sourceWidth: 0,
  sourceHeight: 0,
  width: 0,
  height: 0,
  luminance: EMPTY_VALUES,
  alpha: EMPTY_VALUES,
  positiveSupport: EMPTY_SUPPORT,
  contourEvidence: EMPTY_VALUES,
  tangentX: EMPTY_VALUES,
  tangentY: EMPTY_VALUES,
  tangentCoherence: EMPTY_VALUES,
  ambiguity: EMPTY_VALUES,
  ridgeScale: EMPTY_VALUES,
})

interface GradientPlane {
  readonly x: readonly number[]
  readonly y: readonly number[]
}

interface SampledOrientation {
  readonly tangent: Readonly<Point>
  /** Resultant length of the locally weighted doubled-angle axes. */
  readonly concentration: number
  readonly coherence: number
  readonly ambiguity: number
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function invalidate(accounting: FlowingContoursAccounting): void {
  accounting.termination = 'invalid-input'
  accounting.limitedBy = null
  accounting.contourEvidenceSampleCount = 0
}

function isValidPreparedRaster(
  raster: Readonly<PreparedFlowingContoursRaster>,
): boolean {
  if (
    typeof raster !== 'object' ||
    raster === null ||
    !Number.isSafeInteger(raster.sourceWidth) ||
    raster.sourceWidth <= 0 ||
    !Number.isSafeInteger(raster.sourceHeight) ||
    raster.sourceHeight <= 0 ||
    !Number.isSafeInteger(raster.width) ||
    raster.width <= 0 ||
    !Number.isSafeInteger(raster.height) ||
    raster.height <= 0
  ) {
    return false
  }

  const sampleCount = raster.width * raster.height
  if (
    !Number.isSafeInteger(sampleCount) ||
    raster.luminance.length !== sampleCount ||
    raster.alpha.length !== sampleCount ||
    raster.positiveSupport.length !== sampleCount
  ) {
    return false
  }

  for (let index = 0; index < sampleCount; index += 1) {
    const luminance = raster.luminance[index]
    const alpha = raster.alpha[index]
    const positiveSupport = raster.positiveSupport[index]
    if (
      typeof luminance !== 'number' ||
      !Number.isFinite(luminance) ||
      luminance < 0 ||
      luminance > 1 ||
      typeof alpha !== 'number' ||
      !Number.isFinite(alpha) ||
      alpha < 0 ||
      alpha > 1 ||
      typeof positiveSupport !== 'boolean' ||
      positiveSupport !== alpha > 0 ||
      (alpha === 0 && luminance !== 0)
    ) {
      return false
    }
  }
  return true
}

function gaussianKernel(sigma: number): readonly number[] {
  const radius = Math.ceil(sigma * GAUSSIAN_TRUNCATION_SIGMAS)
  const weights = new Array<number>(radius * 2 + 1)
  for (let offset = -radius; offset <= radius; offset += 1) {
    weights[offset + radius] = Math.exp(
      -(offset * offset) / (2 * sigma * sigma),
    )
  }
  return weights
}

/**
 * Separable convolution using only real in-raster samples.
 *
 * Renormalizing each truncated kernel preserves a constant field exactly,
 * including corners, without reflection or clamping that could turn the
 * source perimeter into a synthetic transition.
 */
function gaussianSmooth(
  values: readonly number[],
  width: number,
  height: number,
  sigma: number,
): readonly number[] {
  const kernel = gaussianKernel(sigma)
  const radius = (kernel.length - 1) / 2
  const horizontal = new Array<number>(values.length)
  const output = new Array<number>(values.length)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let weighted = 0
      let weightTotal = 0
      for (let offset = -radius; offset <= radius; offset += 1) {
        const sourceX = x + offset
        if (sourceX < 0 || sourceX >= width) continue
        const weight = kernel[offset + radius]!
        weighted += values[y * width + sourceX]! * weight
        weightTotal += weight
      }
      horizontal[y * width + x] = weightTotal > 0 ? weighted / weightTotal : 0
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let weighted = 0
      let weightTotal = 0
      for (let offset = -radius; offset <= radius; offset += 1) {
        const sourceY = y + offset
        if (sourceY < 0 || sourceY >= height) continue
        const weight = kernel[offset + radius]!
        weighted += horizontal[sourceY * width + x]! * weight
        weightTotal += weight
      }
      output[y * width + x] = weightTotal > 0 ? weighted / weightTotal : 0
    }
  }
  return output
}

function scharrGradients(
  values: readonly number[],
  width: number,
  height: number,
  scale: number,
): GradientPlane {
  const xGradient = new Array<number>(values.length).fill(0)
  const yGradient = new Array<number>(values.length).fill(0)
  if (width < 3 || height < 3) {
    return { x: xGradient, y: yGradient }
  }

  const at = (x: number, y: number) => values[y * width + x]!
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const upperLeft = at(x - 1, y - 1)
      const upperMiddle = at(x, y - 1)
      const upperRight = at(x + 1, y - 1)
      const middleLeft = at(x - 1, y)
      const middleRight = at(x + 1, y)
      const lowerLeft = at(x - 1, y + 1)
      const lowerMiddle = at(x, y + 1)
      const lowerRight = at(x + 1, y + 1)
      const index = y * width + x
      xGradient[index] =
        (scale *
          (SCHARR_DIAGONAL_WEIGHT * (upperRight - upperLeft) +
            SCHARR_AXIS_WEIGHT * (middleRight - middleLeft) +
            SCHARR_DIAGONAL_WEIGHT * (lowerRight - lowerLeft))) /
        SCHARR_NORMALIZATION
      yGradient[index] =
        (scale *
          (SCHARR_DIAGONAL_WEIGHT * (lowerLeft - upperLeft) +
            SCHARR_AXIS_WEIGHT * (lowerMiddle - upperMiddle) +
            SCHARR_DIAGONAL_WEIGHT * (lowerRight - upperRight))) /
        SCHARR_NORMALIZATION
    }
  }
  return { x: xGradient, y: yGradient }
}

function canonicalTangent(
  tangentX: number,
  tangentY: number,
): readonly [number, number] {
  const length = Math.hypot(tangentX, tangentY)
  if (!Number.isFinite(length) || length <= ORIENTATION_EPSILON) {
    return [1, 0]
  }

  let x = tangentX / length
  let y = tangentY / length
  // This sign is only a stable representation of an undirected axis.
  if (y < 0 || (Math.abs(y) <= ORIENTATION_EPSILON && x < 0)) {
    x = -x
    y = -y
  }
  return [x, y]
}

function updateFromScale(
  raster: Readonly<PreparedFlowingContoursRaster>,
  scale: Readonly<ScalePolicyEntry>,
  contourEvidence: number[],
  tangentX: number[],
  tangentY: number[],
  tangentCoherence: number[],
  ambiguity: number[],
  ridgeScale: number[],
): void {
  const { width, height } = raster
  const luminance = gaussianSmooth(raster.luminance, width, height, scale.sigma)
  const alpha = gaussianSmooth(raster.alpha, width, height, scale.sigma)
  const luminanceGradient = scharrGradients(
    luminance,
    width,
    height,
    scale.sigma,
  )
  const alphaGradient = scharrGradients(alpha, width, height, scale.sigma)

  const tensorXX = new Array<number>(luminance.length)
  const tensorXY = new Array<number>(luminance.length)
  const tensorYY = new Array<number>(luminance.length)
  const alphaWeightSquared = ALPHA_TENSOR_WEIGHT * ALPHA_TENSOR_WEIGHT
  for (let index = 0; index < luminance.length; index += 1) {
    const luminanceX = luminanceGradient.x[index]!
    const luminanceY = luminanceGradient.y[index]!
    const alphaX = alphaGradient.x[index]!
    const alphaY = alphaGradient.y[index]!
    tensorXX[index] =
      luminanceX * luminanceX + alphaWeightSquared * alphaX * alphaX
    tensorXY[index] =
      luminanceX * luminanceY + alphaWeightSquared * alphaX * alphaY
    tensorYY[index] =
      luminanceY * luminanceY + alphaWeightSquared * alphaY * alphaY
  }

  const aggregationSigma = Math.max(0.75, scale.sigma * 0.5)
  const aggregateXX = gaussianSmooth(tensorXX, width, height, aggregationSigma)
  const aggregateXY = gaussianSmooth(tensorXY, width, height, aggregationSigma)
  const aggregateYY = gaussianSmooth(tensorYY, width, height, aggregationSigma)

  for (let index = 0; index < contourEvidence.length; index += 1) {
    if (!raster.positiveSupport[index]) continue
    const xx = Math.max(0, aggregateXX[index]!)
    const xy = aggregateXY[index]!
    const yy = Math.max(0, aggregateYY[index]!)
    const trace = xx + yy
    if (!Number.isFinite(trace) || trace <= EVIDENCE_EPSILON) continue

    const anisotropy = Math.hypot(xx - yy, 2 * xy)
    const coherence = clampUnit(anisotropy / trace)
    const response =
      clampUnit(1 - Math.exp(-EVIDENCE_GAIN * Math.sqrt(trace))) *
      scale.preference
    if (response <= contourEvidence[index]!) continue

    // Principal tensor direction is the contour normal; rotate by 90°.
    const normalAngle = 0.5 * Math.atan2(2 * xy, xx - yy)
    const tangent = canonicalTangent(
      -Math.sin(normalAngle),
      Math.cos(normalAngle),
    )
    contourEvidence[index] = response
    tangentX[index] = tangent[0]
    tangentY[index] = tangent[1]
    tangentCoherence[index] = coherence
    ambiguity[index] = clampUnit(1 - coherence)
    ridgeScale[index] = scale.sigma
  }
}

function buildFieldFromScalePolicy(
  raster: Readonly<PreparedFlowingContoursRaster>,
  accounting: FlowingContoursAccounting,
  limits: Readonly<FlowingContoursLimits>,
  scalePolicy: readonly Readonly<ScalePolicyEntry>[],
): FlowingContoursField {
  try {
    if (
      raster.width === 0 &&
      raster.height === 0 &&
      raster.sourceWidth === 0 &&
      raster.sourceHeight === 0
    ) {
      accounting.contourEvidenceSampleCount = 0
      return EMPTY_FLOWING_CONTOURS_FIELD
    }
    if (!isValidPreparedRaster(raster)) {
      invalidate(accounting)
      return EMPTY_FLOWING_CONTOURS_FIELD
    }

    const sampleCount = raster.width * raster.height
    if (
      !isWithinFlowingContoursLimit(
        'analysis-dimension',
        Math.max(raster.width, raster.height),
        limits,
      )
    ) {
      terminateFlowingContoursAtSafetyLimit(accounting, 'analysis-dimension')
      accounting.contourEvidenceSampleCount = 0
      return EMPTY_FLOWING_CONTOURS_FIELD
    }
    if (
      !isWithinFlowingContoursLimit(
        'analysis-sample-count',
        sampleCount,
        limits,
      )
    ) {
      terminateFlowingContoursAtSafetyLimit(accounting, 'analysis-sample-count')
      accounting.contourEvidenceSampleCount = 0
      return EMPTY_FLOWING_CONTOURS_FIELD
    }
    if (
      !isWithinFlowingContoursLimit(
        'scale-plane-count',
        scalePolicy.length,
        limits,
      )
    ) {
      terminateFlowingContoursAtSafetyLimit(accounting, 'scale-plane-count')
      accounting.contourEvidenceSampleCount = 0
      return EMPTY_FLOWING_CONTOURS_FIELD
    }

    const contourEvidence = new Array<number>(sampleCount).fill(0)
    const tangentX = new Array<number>(sampleCount).fill(1)
    const tangentY = new Array<number>(sampleCount).fill(0)
    const tangentCoherence = new Array<number>(sampleCount).fill(0)
    const ambiguity = new Array<number>(sampleCount).fill(0)
    const ridgeScale = new Array<number>(sampleCount).fill(0)

    for (const scale of scalePolicy) {
      updateFromScale(
        raster,
        scale,
        contourEvidence,
        tangentX,
        tangentY,
        tangentCoherence,
        ambiguity,
        ridgeScale,
      )
    }

    accounting.contourEvidenceSampleCount = contourEvidence.reduce(
      (count, evidence) => count + (evidence > 0 ? 1 : 0),
      0,
    )
    return Object.freeze({
      sourceWidth: raster.sourceWidth,
      sourceHeight: raster.sourceHeight,
      width: raster.width,
      height: raster.height,
      luminance: Object.freeze(Array.from(raster.luminance)),
      alpha: Object.freeze(Array.from(raster.alpha)),
      positiveSupport: Object.freeze(Array.from(raster.positiveSupport)),
      contourEvidence: Object.freeze(contourEvidence),
      tangentX: Object.freeze(tangentX),
      tangentY: Object.freeze(tangentY),
      tangentCoherence: Object.freeze(tangentCoherence),
      ambiguity: Object.freeze(ambiguity),
      ridgeScale: Object.freeze(ridgeScale),
    })
  } catch {
    invalidate(accounting)
    return EMPTY_FLOWING_CONTOURS_FIELD
  }
}

function combineFlowingContoursFields(
  fine: Readonly<FlowingContoursField>,
  mid: Readonly<FlowingContoursField>,
): FlowingContoursField {
  const contourEvidence = fine.contourEvidence.map((evidence, index) =>
    Math.max(evidence, mid.contourEvidence[index]!),
  )
  const useMid = fine.contourEvidence.map(
    (evidence, index) => mid.contourEvidence[index]! > evidence,
  )
  return Object.freeze({
    ...fine,
    contourEvidence: Object.freeze(contourEvidence),
    tangentX: Object.freeze(
      fine.tangentX.map((value, index) =>
        useMid[index] ? mid.tangentX[index]! : value,
      ),
    ),
    tangentY: Object.freeze(
      fine.tangentY.map((value, index) =>
        useMid[index] ? mid.tangentY[index]! : value,
      ),
    ),
    tangentCoherence: Object.freeze(
      fine.tangentCoherence.map((value, index) =>
        useMid[index] ? mid.tangentCoherence[index]! : value,
      ),
    ),
    ambiguity: Object.freeze(
      fine.ambiguity.map((value, index) =>
        useMid[index] ? mid.ambiguity[index]! : value,
      ),
    ),
    ridgeScale: Object.freeze(
      fine.ridgeScale.map((value, index) =>
        useMid[index] ? mid.ridgeScale[index]! : value,
      ),
    ),
  })
}

function locallyGatedGuideField(
  source: Readonly<FlowingContoursField>,
  local: Readonly<FlowingContoursField>,
): FlowingContoursField {
  return Object.freeze({
    ...source,
    contourEvidence: Object.freeze(
      source.contourEvidence.map((evidence, index) =>
        local.contourEvidence[index]! >= BROAD_FORM_LOCAL_SUPPORT_FLOOR
          ? Math.min(evidence, local.contourEvidence[index]!)
          : 0,
      ),
    ),
  })
}

/**
 * Build one immutable, bounded contour field from FC04's prepared raster.
 *
 * Production always uses the four fixed scale bands. A lowered FC03 scale cap
 * fails before allocating scale planes. Exact positive-alpha permission is
 * retained independently from interpolated alpha and contour evidence.
 */
export function buildFlowingContoursField(
  raster: Readonly<PreparedFlowingContoursRaster>,
  accounting: FlowingContoursAccounting,
  limits: Readonly<FlowingContoursLimits> = FLOWING_CONTOURS_LIMITS,
): FlowingContoursField {
  return buildFieldFromScalePolicy(raster, accounting, limits, SCALE_POLICY)
}

/**
 * Build the three-member bounded field ensemble used by production generation.
 *
 * The five total planes consume the existing FC03 ceiling exactly: four local
 * detail planes plus one broad-form plane. Mid form reuses the sigma 2/4/8
 * responses already consumed by local detail. Evidence accounting is the
 * union of occupied lattice samples across all hypotheses.
 */
export function buildFlowingContoursFieldEnsemble(
  raster: Readonly<PreparedFlowingContoursRaster>,
  accounting: FlowingContoursAccounting,
  limits: Readonly<FlowingContoursLimits> = FLOWING_CONTOURS_LIMITS,
): Readonly<FlowingContoursFieldEnsemble> {
  const empty = Object.freeze({
    hypotheses: Object.freeze([]),
  }) as Readonly<FlowingContoursFieldEnsemble>
  try {
    const totalScalePlanes =
      SCALE_POLICY.length + BROAD_FORM_SCALE_POLICY.length
    if (
      !isWithinFlowingContoursLimit(
        'scale-plane-count',
        totalScalePlanes,
        limits,
      )
    ) {
      terminateFlowingContoursAtSafetyLimit(accounting, 'scale-plane-count')
      accounting.contourEvidenceSampleCount = 0
      return empty
    }
    const broadAccounting = createFlowingContoursAccounting()
    const scaleAccountings = SCALE_POLICY.map(() =>
      createFlowingContoursAccounting(),
    )
    const broadSource = buildFieldFromScalePolicy(
      raster,
      broadAccounting,
      limits,
      BROAD_FORM_SCALE_POLICY,
    )
    const scaleFields = SCALE_POLICY.map((scale, index) =>
      buildFieldFromScalePolicy(
        raster,
        scaleAccountings[index]!,
        limits,
        Object.freeze([scale]),
      ),
    )
    if (
      broadAccounting.termination !== 'complete' ||
      scaleAccountings.some(
        ({ termination }) => termination !== 'complete',
      )
    ) {
      accounting.termination =
        broadAccounting.termination === 'invalid-input' ||
        scaleAccountings.some(
          ({ termination }) => termination === 'invalid-input',
        )
          ? 'invalid-input'
          : 'limit-reached'
      accounting.limitedBy =
        broadAccounting.limitedBy ??
        scaleAccountings.find(({ limitedBy }) => limitedBy !== null)
          ?.limitedBy ??
        null
      accounting.contourEvidenceSampleCount = 0
      return empty
    }
    const [sigma1, sigma2, sigma4, sigma8] = scaleFields as [
      FlowingContoursField,
      FlowingContoursField,
      FlowingContoursField,
      FlowingContoursField,
    ]
    const fine = combineFlowingContoursFields(sigma1, sigma2)
    const coarseLocalSource = combineFlowingContoursFields(sigma4, sigma8)
    const midSource = combineFlowingContoursFields(
      sigma2,
      coarseLocalSource,
    )
    const local = combineFlowingContoursFields(fine, coarseLocalSource)
    // Broad form contributes orientation, not a detached blurred contour.
    // Local evidence gates and caps its magnitude on the visible ridge so
    // sigma 16 cannot create detached parallel marks around one feature.
    const broad = locallyGatedGuideField(broadSource, local)
    const mid = locallyGatedGuideField(midSource, local)
    let evidenceUnionCount = 0
    for (let index = 0; index < broad.contourEvidence.length; index += 1) {
      if (
        broad.contourEvidence[index]! > 0 ||
        local.contourEvidence[index]! > 0
      ) {
        evidenceUnionCount += 1
      }
    }
    accounting.contourEvidenceSampleCount = evidenceUnionCount
    const ensemble = Object.freeze({
      hypotheses: Object.freeze([
        Object.freeze({ kind: 'broad-form' as const, field: broad }),
        Object.freeze({ kind: 'mid-form' as const, field: mid }),
        Object.freeze({ kind: 'local-detail' as const, field: local }),
      ]),
    })
    FIELD_ENSEMBLE_SCALE_PLANE_COUNTS.set(ensemble, totalScalePlanes)
    return ensemble
  } catch {
    invalidate(accounting)
    return empty
  }
}

function hasSampleShape(field: Readonly<FlowingContoursField>): boolean {
  const sampleCount = field.width * field.height
  return (
    Number.isSafeInteger(field.width) &&
    field.width > 0 &&
    Number.isSafeInteger(field.height) &&
    field.height > 0 &&
    Number.isSafeInteger(sampleCount) &&
    field.luminance.length === sampleCount &&
    field.alpha.length === sampleCount &&
    field.positiveSupport.length === sampleCount &&
    field.contourEvidence.length === sampleCount &&
    field.tangentX.length === sampleCount &&
    field.tangentY.length === sampleCount &&
    field.tangentCoherence.length === sampleCount &&
    field.ambiguity.length === sampleCount &&
    field.ridgeScale.length === sampleCount
  )
}

function bilinearFieldValue(
  values: readonly number[],
  width: number,
  height: number,
  point: Readonly<Point>,
): number | null {
  return bilinearDerivedValue(width, height, point, (index) => values[index]!)
}

function bilinearDerivedValue(
  width: number,
  height: number,
  point: Readonly<Point>,
  valueAt: (index: number) => number,
): number | null {
  const x = point[0]
  const y = point[1]
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x > width - 1 ||
    y > height - 1
  ) {
    return null
  }
  const left = Math.floor(x)
  const top = Math.floor(y)
  const right = Math.min(left + 1, width - 1)
  const bottom = Math.min(top + 1, height - 1)
  const horizontal = x - left
  const vertical = y - top
  const topValue =
    valueAt(top * width + left) * (1 - horizontal) +
    valueAt(top * width + right) * horizontal
  const bottomValue =
    valueAt(bottom * width + left) * (1 - horizontal) +
    valueAt(bottom * width + right) * horizontal
  const value = topValue * (1 - vertical) + bottomValue * vertical
  return Number.isFinite(value) ? value : null
}

function supportValue(
  field: Readonly<FlowingContoursField>,
  point: Readonly<Point>,
): number | null {
  return bilinearDerivedValue(field.width, field.height, point, (index) =>
    field.positiveSupport[index] ? 1 : 0,
  )
}

function sampledOrientation(
  field: Readonly<FlowingContoursField>,
  point: Readonly<Point>,
): SampledOrientation | null {
  const evidenceMass = bilinearFieldValue(
    field.contourEvidence,
    field.width,
    field.height,
    point,
  )
  const orientationMass = bilinearDerivedValue(
    field.width,
    field.height,
    point,
    (index) => field.contourEvidence[index]! * field.tangentCoherence[index]!,
  )
  const cosine = bilinearDerivedValue(
    field.width,
    field.height,
    point,
    (index) => {
      const tangentX = field.tangentX[index]!
      const tangentY = field.tangentY[index]!
      const confidence =
        field.contourEvidence[index]! * field.tangentCoherence[index]!
      return confidence * (tangentX * tangentX - tangentY * tangentY)
    },
  )
  const sine = bilinearDerivedValue(
    field.width,
    field.height,
    point,
    (index) => {
      const confidence =
        field.contourEvidence[index]! * field.tangentCoherence[index]!
      return confidence * 2 * field.tangentX[index]! * field.tangentY[index]!
    },
  )
  const ambiguityMass = bilinearDerivedValue(
    field.width,
    field.height,
    point,
    (index) => field.contourEvidence[index]! * field.ambiguity[index]!,
  )
  if (
    evidenceMass === null ||
    orientationMass === null ||
    cosine === null ||
    sine === null ||
    ambiguityMass === null
  ) {
    return null
  }

  const resultant = Math.hypot(cosine, sine)
  const concentration =
    orientationMass > ORIENTATION_EPSILON
      ? clampUnit(resultant / orientationMass)
      : 0
  const localCoherence =
    evidenceMass > EVIDENCE_EPSILON
      ? clampUnit(orientationMass / evidenceMass)
      : 0
  const coherence = clampUnit(localCoherence * concentration)
  const localAmbiguity =
    evidenceMass > EVIDENCE_EPSILON
      ? clampUnit(ambiguityMass / evidenceMass)
      : 1
  const ambiguity = clampUnit(Math.max(localAmbiguity, 1 - coherence))

  if (
    orientationMass <= ORIENTATION_EPSILON ||
    resultant <= ORIENTATION_EPSILON
  ) {
    return {
      // A zero vector carries no accidental axis confidence. Callers must use
      // coherence/ambiguity to decide whether a sampled tangent is usable.
      tangent: Object.freeze([0, 0] as Point),
      concentration: 0,
      coherence: 0,
      ambiguity: 1,
    }
  }

  const angle = 0.5 * Math.atan2(sine, cosine)
  return {
    tangent: Object.freeze(
      canonicalTangent(Math.cos(angle), Math.sin(angle)).slice() as Point,
    ),
    concentration,
    coherence,
    ambiguity,
  }
}

/**
 * Sample an evidence-weighted undirected tangent without sign cancellation.
 *
 * Interpolation occurs in confidence-weighted doubled-angle space, where `t`
 * and `-t` are the same value. An unresolved or evidence-free neighborhood
 * returns the finite zero vector rather than inventing a horizontal axis;
 * consumers needing confidence should use `sampleFlowingContoursField`.
 */
export function sampleFlowingContoursTangent(
  field: Readonly<FlowingContoursField>,
  point: Readonly<Point>,
): Readonly<Point> | null {
  try {
    if (!hasSampleShape(field)) return null
    return sampledOrientation(field, point)?.tangent ?? null
  } catch {
    return null
  }
}

/**
 * Sample every tracing-relevant field channel at one continuous lattice point.
 *
 * Outside points and exact-zero-alpha permission fail closed. Scalars are
 * bilinear; tangent interpolation is sign-invariant in doubled-angle space.
 */
export function sampleFlowingContoursField(
  field: Readonly<FlowingContoursField>,
  point: Readonly<Point>,
): Readonly<CorrectedFlowingRidgeSample> | null {
  try {
    if (!hasSampleShape(field)) return null
    const alpha = bilinearFieldValue(
      field.alpha,
      field.width,
      field.height,
      point,
    )
    const support = supportValue(field, point)
    if (alpha === null || support === null || alpha <= 0 || support <= 0) {
      return null
    }
    const evidence = bilinearFieldValue(
      field.contourEvidence,
      field.width,
      field.height,
      point,
    )
    const scale = bilinearFieldValue(
      field.ridgeScale,
      field.width,
      field.height,
      point,
    )
    const orientation = sampledOrientation(field, point)
    if (evidence === null || scale === null || orientation === null) {
      return null
    }
    const sampledPoint = Object.freeze([point[0], point[1]] as Point)
    return Object.freeze({
      point: sampledPoint,
      tangent: orientation.tangent,
      evidence: clampUnit(evidence),
      coherence: orientation.coherence,
      ambiguity: orientation.ambiguity,
      scale: Math.max(0, scale),
      alpha: clampUnit(alpha),
    })
  } catch {
    return null
  }
}
