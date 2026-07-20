import type { CoordinateSpace } from '../scene'
import {
  sampleShadingMask,
  sampleToneField,
  type ToneSource,
} from '../shadingFields'
import type { Point } from '../types'
import {
  defaultStipplingControls,
  stipplingControlSchema,
  type StippleMark,
  type StipplingControlName,
  type StipplingControls,
  type StipplingDemandLattice,
  type StipplingDemandSample,
  type StipplingModel,
  type StipplingScales,
} from './types'

// Strategy-local ratios deliberately stay out of the artist-facing controls.
// Composition Frames are normalized by geometric-mean extent, so the same
// authored inputs produce the same count and normalized geometry at any scale.
const STIPPLE_LENGTH_TO_FRAME = 0.003
const MASK_CHECK_TO_STIPPLE = 0.25
const MINIMUM_SPACING_TO_FRAME = 0.025
const FULL_DEMAND_TARGET_COUNT = 800
const DEMAND_LATTICE_SAMPLE_COUNT = 4096

function validatedFrame(frame: CoordinateSpace): Readonly<CoordinateSpace> {
  const area = frame.width * frame.height
  if (
    !Number.isFinite(frame.width) ||
    !Number.isFinite(frame.height) ||
    frame.width <= 0 ||
    frame.height <= 0 ||
    !Number.isFinite(area) ||
    area <= 0
  ) {
    throw new Error(
      `Stippling frame must have finite positive dimensions and area, got ${frame.width} × ${frame.height}`,
    )
  }

  return Object.freeze({ width: frame.width, height: frame.height })
}

function boundedControl(name: StipplingControlName, value: number): number {
  const spec = stipplingControlSchema[name]
  if (!Number.isFinite(value)) return spec.default
  return Math.min(spec.max, Math.max(spec.min, value))
}

/** Bound untrusted or partial inputs with the authored control declarations. */
export function normalizeStipplingControls(
  controls: Partial<StipplingControls> = defaultStipplingControls,
): Readonly<StipplingControls> {
  return Object.freeze({
    stippleDensity: boundedControl(
      'stippleDensity',
      controls.stippleDensity ?? defaultStipplingControls.stippleDensity,
    ),
    distributionFidelity: boundedControl(
      'distributionFidelity',
      controls.distributionFidelity ??
        defaultStipplingControls.distributionFidelity,
    ),
  })
}

function normalizedDemand(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(1, value)
}

/**
 * Resolve fixed micro-stroke geometry and density-dependent abundance.
 *
 * `averageDemand` is the equal-area mean of `tone * permission`. It defaults to
 * full demand so callers can inspect pure control effects without first
 * constructing a source model.
 */
export function resolveStipplingScales(
  frame: CoordinateSpace,
  controls: Partial<StipplingControls> = defaultStipplingControls,
  averageDemand = 1,
): Readonly<StipplingScales> {
  const normalizedFrame = validatedFrame(frame)
  const normalizedControls = normalizeStipplingControls(controls)
  const frameScale = Math.sqrt(normalizedFrame.width * normalizedFrame.height)
  const stippleLength = frameScale * STIPPLE_LENGTH_TO_FRAME

  return Object.freeze({
    stippleLength,
    maskCheckSpacing: stippleLength * MASK_CHECK_TO_STIPPLE,
    minimumSpacing:
      (frameScale * MINIMUM_SPACING_TO_FRAME) /
      Math.sqrt(normalizedControls.stippleDensity),
    targetCount: Math.round(
      FULL_DEMAND_TARGET_COUNT *
        normalizedControls.stippleDensity *
        normalizedDemand(averageDemand),
    ),
  })
}

function latticeDimensions(frame: Readonly<CoordinateSpace>): {
  readonly columns: number
  readonly rows: number
} {
  const landscape = frame.width >= frame.height
  const longExtent = landscape ? frame.width : frame.height
  const shortExtent = landscape ? frame.height : frame.width
  const aspect = longExtent / shortExtent
  if (!Number.isFinite(aspect)) {
    throw new Error('Stippling frame aspect ratio must be finite')
  }

  const shortCount = Math.max(
    1,
    Math.round(Math.sqrt(DEMAND_LATTICE_SAMPLE_COUNT / aspect)),
  )
  const longCount = Math.max(
    1,
    Math.round(DEMAND_LATTICE_SAMPLE_COUNT / shortCount),
  )

  return landscape
    ? { columns: longCount, rows: shortCount }
    : { columns: shortCount, rows: longCount }
}

function createDemandLattice(
  source: ToneSource,
  frame: Readonly<CoordinateSpace>,
): Readonly<StipplingDemandLattice> {
  const { columns, rows } = latticeDimensions(frame)
  const cellWidth = frame.width / columns
  const cellHeight = frame.height / rows
  const cellArea = cellWidth * cellHeight
  const sampleCount = columns * rows
  const samples: StipplingDemandSample[] = new Array(sampleCount)
  let demandSum = 0

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const point = Object.freeze([
        (column + 0.5) * cellWidth,
        (row + 0.5) * cellHeight,
      ] as Point)
      const permission = sampleShadingMask(source.shadingMask, point)
      const tone =
        permission === 0 ? 0 : sampleToneField(source.toneField, point)
      const demand = tone * permission
      demandSum += demand
      samples[row * columns + column] = Object.freeze({
        point,
        tone,
        permission,
        demand,
      })
    }
  }

  return Object.freeze({
    frame,
    columns,
    rows,
    cellWidth,
    cellHeight,
    cellArea,
    sampleCount,
    demandSum,
    averageDemand: demandSum / sampleCount,
    samples: Object.freeze(samples),
  })
}

function markCellIndex(
  mark: Readonly<StippleMark>,
  lattice: Readonly<StipplingDemandLattice>,
): number | undefined {
  const [x, y] = mark.center
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(mark.orientation) ||
    x < 0 ||
    y < 0 ||
    x > lattice.frame.width ||
    y > lattice.frame.height
  ) {
    return undefined
  }

  const column = Math.min(lattice.columns - 1, Math.floor(x / lattice.cellWidth))
  const row = Math.min(lattice.rows - 1, Math.floor(y / lattice.cellHeight))
  return row * lattice.columns + column
}

/** Build the immutable effective-demand target used by placement and refinement. */
export function createStipplingModel(
  source: ToneSource,
  frame: CoordinateSpace,
  controls: Partial<StipplingControls> = defaultStipplingControls,
): StipplingModel {
  const normalizedFrame = validatedFrame(frame)
  const normalizedControls = normalizeStipplingControls(controls)
  const lattice = createDemandLattice(source, normalizedFrame)
  const scales = resolveStipplingScales(
    normalizedFrame,
    normalizedControls,
    lattice.averageDemand,
  )

  function distributionError(marks: readonly StippleMark[]): number {
    const actualCounts = new Uint32Array(lattice.sampleCount)
    let unmatchedCount = 0
    for (const mark of marks) {
      const index = markCellIndex(mark, lattice)
      if (index === undefined) unmatchedCount++
      else actualCounts[index] = actualCounts[index]! + 1
    }

    if (marks.length === 0) return scales.targetCount === 0 ? 0 : 1

    let absoluteError = unmatchedCount
    for (let index = 0; index < lattice.sampleCount; index++) {
      const expected =
        lattice.demandSum === 0
          ? 0
          : (scales.targetCount * lattice.samples[index]!.demand) /
            lattice.demandSum
      absoluteError += Math.abs(actualCounts[index]! - expected)
    }

    const denominator = Math.max(1, scales.targetCount, marks.length)
    return Math.min(2, absoluteError / denominator)
  }

  return Object.freeze({
    source,
    frame: normalizedFrame,
    controls: normalizedControls,
    scales,
    lattice,
    distributionError,
  })
}
