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
const STIPPLE_LENGTH_TO_FRAME = 0.0003
const MASK_CHECK_TO_STIPPLE = 0.25
const MINIMUM_SPACING_TO_FRAME = 0.025
const FULL_DEMAND_TARGET_COUNT = 800
/** Largest retained set demonstrated to complete inside the 1m-dart guard. */
const MAXIMUM_SUPPORTED_TARGET_COUNT = 160_000
const MINIMUM_DEMAND_LATTICE_SAMPLE_COUNT = 4_096
const MAXIMUM_DEMAND_LATTICE_SAMPLE_COUNT = 65_536
const DEMAND_QUADRATURE_OFFSETS = [0.25, 0.75] as const

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
    voronoiRelaxation: boundedControl(
      'voronoiRelaxation',
      controls.voronoiRelaxation ??
        defaultStipplingControls.voronoiRelaxation,
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
    targetCount: Math.min(
      MAXIMUM_SUPPORTED_TARGET_COUNT,
      Math.round(
        FULL_DEMAND_TARGET_COUNT *
          normalizedControls.stippleDensity *
          normalizedDemand(averageDemand),
      ),
    ),
  })
}

function demandLatticeSampleBudget(stippleDensity: number): number {
  const fullDemandTargetCount = Math.min(
    MAXIMUM_SUPPORTED_TARGET_COUNT,
    Math.round(FULL_DEMAND_TARGET_COUNT * stippleDensity),
  )
  return Math.min(
    MAXIMUM_DEMAND_LATTICE_SAMPLE_COUNT,
    Math.max(
      MINIMUM_DEMAND_LATTICE_SAMPLE_COUNT,
      Math.ceil(fullDemandTargetCount / 2),
    ),
  )
}

function latticeDimensions(
  frame: Readonly<CoordinateSpace>,
  sampleBudget: number,
): {
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
    Math.round(Math.sqrt(sampleBudget / aspect)),
  )
  const longCount = Math.max(
    1,
    Math.floor(sampleBudget / shortCount),
  )

  return landscape
    ? { columns: longCount, rows: shortCount }
    : { columns: shortCount, rows: longCount }
}

function createDemandLattice(
  source: ToneSource,
  frame: Readonly<CoordinateSpace>,
  stippleDensity: number,
): Readonly<StipplingDemandLattice> {
  const { columns, rows } = latticeDimensions(
    frame,
    demandLatticeSampleBudget(stippleDensity),
  )
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
      let toneSum = 0
      let permissionSum = 0
      let demand = 0
      for (const yOffset of DEMAND_QUADRATURE_OFFSETS) {
        for (const xOffset of DEMAND_QUADRATURE_OFFSETS) {
          const probe: Point = [
            (column + xOffset) * cellWidth,
            (row + yOffset) * cellHeight,
          ]
          const probePermission = sampleShadingMask(
            source.shadingMask,
            probe,
          )
          permissionSum += probePermission
          if (probePermission === 0) continue

          const probeTone = sampleToneField(source.toneField, probe)
          toneSum += probeTone
          demand += probeTone * probePermission
        }
      }
      const tone = toneSum / 4
      const permission = permissionSum / 4
      demand /= 4
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

/** Mutable exact error accumulator for one fixed-count relocation pass. */
export interface StipplingDistributionState {
  readonly error: number
  replacementError(
    previous: Readonly<StippleMark>,
    replacement: Readonly<StippleMark>,
  ): number
  commitReplacement(
    previous: Readonly<StippleMark>,
    replacement: Readonly<StippleMark>,
  ): void
}

function distributionErrorFromAbsolute(
  absoluteError: number,
  targetCount: number,
  markCount: number,
): number {
  if (markCount === 0) return targetCount === 0 ? 0 : 1
  return Math.min(
    2,
    absoluteError / Math.max(1, targetCount, markCount),
  )
}

/** Build the exact lattice-count state used by production refinement. */
export function createStipplingDistributionState(
  model: Readonly<Pick<StipplingModel, 'lattice' | 'scales'>>,
  marks: readonly StippleMark[],
): StipplingDistributionState {
  const { lattice, scales } = model
  const actualCounts = new Uint32Array(lattice.sampleCount)
  let unmatchedCount = 0
  for (const mark of marks) {
    const index = markCellIndex(mark, lattice)
    if (index === undefined) unmatchedCount++
    else actualCounts[index] = actualCounts[index]! + 1
  }

  const expectedCount = (index: number): number =>
    lattice.demandSum === 0
      ? 0
      : (scales.targetCount * lattice.samples[index]!.demand) /
        lattice.demandSum
  let absoluteError = unmatchedCount
  for (let index = 0; index < lattice.sampleCount; index++) {
    absoluteError += Math.abs(actualCounts[index]! - expectedCount(index))
  }

  const countAdjustment = (index: number, delta: -1 | 1): number => {
    const before = actualCounts[index]!
    const expected = expectedCount(index)
    return Math.abs(before + delta - expected) - Math.abs(before - expected)
  }
  const replacementAbsoluteError = (
    previous: Readonly<StippleMark>,
    replacement: Readonly<StippleMark>,
  ): number => {
    const previousIndex = markCellIndex(previous, lattice)
    const replacementIndex = markCellIndex(replacement, lattice)
    if (previousIndex === replacementIndex) return absoluteError

    return (
      absoluteError +
      (previousIndex === undefined ? -1 : countAdjustment(previousIndex, -1)) +
      (replacementIndex === undefined
        ? 1
        : countAdjustment(replacementIndex, 1))
    )
  }

  return {
    get error() {
      return distributionErrorFromAbsolute(
        absoluteError,
        scales.targetCount,
        marks.length,
      )
    },
    replacementError(previous, replacement) {
      return distributionErrorFromAbsolute(
        replacementAbsoluteError(previous, replacement),
        scales.targetCount,
        marks.length,
      )
    },
    commitReplacement(previous, replacement) {
      const previousIndex = markCellIndex(previous, lattice)
      const replacementIndex = markCellIndex(replacement, lattice)
      if (previousIndex === replacementIndex) return

      absoluteError = replacementAbsoluteError(previous, replacement)
      if (previousIndex !== undefined) {
        actualCounts[previousIndex] = actualCounts[previousIndex]! - 1
      }
      if (replacementIndex !== undefined) {
        actualCounts[replacementIndex] = actualCounts[replacementIndex]! + 1
      }
    },
  }
}

const nativeDistributionErrors = new WeakSet<StipplingModel['distributionError']>()

/** Whether a model still carries the core's canonical lattice metric. */
export function hasNativeStipplingDistributionError(
  model: Readonly<Pick<StipplingModel, 'distributionError'>>,
): boolean {
  return nativeDistributionErrors.has(model.distributionError)
}

/** Build the immutable effective-demand target used by placement and refinement. */
export function createStipplingModel(
  source: ToneSource,
  frame: CoordinateSpace,
  controls: Partial<StipplingControls> = defaultStipplingControls,
): StipplingModel {
  const normalizedFrame = validatedFrame(frame)
  const normalizedControls = normalizeStipplingControls(controls)
  const lattice = createDemandLattice(
    source,
    normalizedFrame,
    normalizedControls.stippleDensity,
  )
  const scales = resolveStipplingScales(
    normalizedFrame,
    normalizedControls,
    lattice.averageDemand,
  )

  function distributionError(marks: readonly StippleMark[]): number {
    return createStipplingDistributionState({ lattice, scales }, marks).error
  }
  nativeDistributionErrors.add(distributionError)

  return Object.freeze({
    source,
    frame: normalizedFrame,
    controls: normalizedControls,
    scales,
    lattice,
    distributionError,
  })
}
