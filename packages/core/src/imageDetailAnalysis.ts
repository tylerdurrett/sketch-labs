/**
 * Prepared, resolution-independent image-detail analysis.
 *
 * Decoding stays outside core. Preparation accepts only decoded straight-RGBA8
 * pixels, performs the fixed private analysis pipeline once, and returns a
 * structured-cloneable scalar lattice. Binding later contain-fits that lattice
 * with the decoded image's ORIGINAL dimensions so analysis-grid rounding never
 * changes image placement.
 */

import { calculateDetailEnergy } from './detailAnalysis/energy'
import { prepareAnalysisGrid } from './detailAnalysis/grid'
import { normalizeDetailEnergy } from './detailAnalysis/normalize'
import { createDetailField, type DetailField } from './detailFields'
import type { DecodedPixels } from './imageAssets'
import {
  bilinearSample,
  createRasterContainFit,
  mapFramePointToImageUv,
  mapImageUvToLatticeSample,
} from './rasterSampling'
import type { CoordinateSpace } from './scene'

const IMAGE_DETAIL_GRID_MAX_DIMENSION = 256

/**
 * Opaque version identity for records produced by this analysis definition.
 *
 * Consumers should compare this value with the exported constant, not interpret
 * or persist assumptions about its string contents.
 */
export const IMAGE_DETAIL_ANALYSIS_DEFINITION_ID =
  '@harness/core/image-detail-analysis/v1' as const

/** A prepared normalized image-detail lattice that can cross worker boundaries. */
export interface PreparedImageDetailAnalysis {
  readonly definitionId: typeof IMAGE_DETAIL_ANALYSIS_DEFINITION_ID
  /** Decoded source dimensions used exclusively for contain fitting. */
  readonly sourceWidth: number
  readonly sourceHeight: number
  /** Bounded analysis-lattice dimensions used exclusively for scalar sampling. */
  readonly gridWidth: number
  readonly gridHeight: number
  /**
   * Caller-immutable normalized row-major scalars.
   *
   * Preparation owns this copy. A bound Detail Field borrows it rather than
   * copying it again, so callers must not mutate the array while that field is
   * in use. Non-finite mutations still fail closed at the public sampler.
   */
  readonly data: Float64Array
}

const ZERO_IMAGE_DETAIL_FIELD = createDetailField(() => 0)

function expectedGridDimensions(
  sourceWidth: number,
  sourceHeight: number,
): readonly [number, number] {
  const scale = Math.min(
    1,
    IMAGE_DETAIL_GRID_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight),
  )
  return [
    Math.max(1, Math.min(sourceWidth, Math.round(sourceWidth * scale))),
    Math.max(1, Math.min(sourceHeight, Math.round(sourceHeight * scale))),
  ]
}

function invalidPreparedAnalysis(): TypeError {
  return new TypeError(
    'createImageDetailField: invalid prepared image-detail analysis',
  )
}

function validatePreparedAnalysis(
  prepared: Readonly<PreparedImageDetailAnalysis>,
): void {
  if (typeof prepared !== 'object' || prepared === null) {
    throw invalidPreparedAnalysis()
  }

  const {
    definitionId,
    sourceWidth,
    sourceHeight,
    gridWidth,
    gridHeight,
    data,
  } = prepared
  if (
    definitionId !== IMAGE_DETAIL_ANALYSIS_DEFINITION_ID ||
    !Number.isSafeInteger(sourceWidth) ||
    sourceWidth <= 0 ||
    !Number.isSafeInteger(sourceHeight) ||
    sourceHeight <= 0 ||
    !Number.isSafeInteger(sourceWidth * sourceHeight) ||
    !Number.isSafeInteger(sourceWidth * sourceHeight * 4) ||
    !Number.isSafeInteger(gridWidth) ||
    gridWidth <= 0 ||
    !Number.isSafeInteger(gridHeight) ||
    gridHeight <= 0 ||
    !(data instanceof Float64Array)
  ) {
    throw invalidPreparedAnalysis()
  }

  const [expectedWidth, expectedHeight] = expectedGridDimensions(
    sourceWidth,
    sourceHeight,
  )
  const length = gridWidth * gridHeight
  if (
    gridWidth !== expectedWidth ||
    gridHeight !== expectedHeight ||
    !Number.isSafeInteger(length) ||
    data.length !== length
  ) {
    throw invalidPreparedAnalysis()
  }

  for (let index = 0; index < data.length; index += 1) {
    const value = data[index]
    if (
      value === undefined ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    ) {
      throw invalidPreparedAnalysis()
    }
  }
}

/**
 * Run the fixed image-detail pipeline and return its worker-safe prepared form.
 *
 * The decoded byte array is borrowed read-only during this call and is never
 * retained or mutated. The returned scalar data is an independent copy.
 * Invalid decoded records and any failed pipeline stage throw a bounded
 * `TypeError` rather than exposing partial analysis.
 */
export function prepareImageDetailAnalysis(
  pixels: Readonly<DecodedPixels>,
): PreparedImageDetailAnalysis {
  // prepareAnalysisGrid is the single decoded-raster validation boundary.
  const analysis = prepareAnalysisGrid(pixels, IMAGE_DETAIL_GRID_MAX_DIMENSION)
  const energy = analysis === null ? null : calculateDetailEnergy(analysis)
  const normalized = energy === null ? null : normalizeDetailEnergy(energy)
  if (normalized === null) {
    throw new TypeError(
      'prepareImageDetailAnalysis: invalid decoded pixels or analysis failure',
    )
  }

  return Object.freeze({
    definitionId: IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
    sourceWidth: pixels.width,
    sourceHeight: pixels.height,
    gridWidth: normalized.width,
    gridHeight: normalized.height,
    data: Float64Array.from(normalized.values),
  })
}

/**
 * Bind a validated prepared lattice to one Composition Frame.
 *
 * Malformed prepared records throw. An invalid frame instead returns the safe
 * exact-zero Detail Field, matching other public field adapters. The prepared
 * record is validated once here; ordinary samples then perform only contain-fit
 * mapping and bilinear lattice lookup.
 */
export function createImageDetailField(
  prepared: Readonly<PreparedImageDetailAnalysis>,
  compositionFrame: Readonly<CoordinateSpace>,
): DetailField {
  validatePreparedAnalysis(prepared)

  const fit = createRasterContainFit(
    { width: prepared.sourceWidth, height: prepared.sourceHeight },
    compositionFrame,
  )
  if (fit === null) return ZERO_IMAGE_DETAIL_FIELD

  // Capture the validated values so a structured clone's mutable outer record
  // cannot redirect an already-bound field. The typed-array storage remains the
  // documented borrowed value.
  const { gridWidth, gridHeight, data } = prepared

  return createDetailField((point) => {
    const uv = mapFramePointToImageUv(point, fit)
    if (uv === null) return 0
    const sample = mapImageUvToLatticeSample(
      uv,
      gridWidth,
      gridHeight,
    )
    if (sample === null) return 0

    return bilinearSample(
      data[sample.topLeft]!,
      data[sample.topRight]!,
      data[sample.bottomLeft]!,
      data[sample.bottomRight]!,
      sample.horizontal,
      sample.vertical,
    )
  })
}
