import { createHash } from 'node:crypto'

import type { CoordinateSpace } from '../../scene'
import {
  defaultFlowingContoursControls,
  type FlowingContoursControls,
} from '../../sketches/flowing-contours/controls'
import { FLOWING_CONTOURS_LIMITS } from '../../sketches/flowing-contours/limits'
import type {
  PreparedFlowingContoursRaster,
} from '../../sketches/flowing-contours/raster'
import type { PencilContourControls } from '../../sketches/pencil-contour/controls'
import type { WatercolorFormsControls } from '../../sketches/watercolor-forms/controls'
import type {
  FlowingContoursReferenceMetrics,
  FlowingContoursReferenceRegion,
} from './flowingContoursReferenceMetrics'

const FLOAT64_BYTES = 8
const PLANE_COUNT = 3
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const COMMIT_PATTERN = /^[0-9a-f]{40}$/

export const FLOWING_CONTOURS_REFERENCE_FRAME: Readonly<CoordinateSpace> =
  Object.freeze({ width: 1000, height: 1000 })

/**
 * Last revisions that define the three independently implemented comparators.
 *
 * Pencil is the immutable-topology revision pinned by Watercolor Forms'
 * evidence manifest. Watercolor is its calibrated smoothing revision. Flowing
 * Contours is the last production commit before this reference contract.
 */
export const FLOWING_CONTOURS_REFERENCE_REVISIONS = Object.freeze({
  flowingContours: 'fa3d71d423f40c1160cc259e350abe17fb6c47ce',
  pencilContour: 'b6147366448d37021e20d48326045a6cba3039ca',
  watercolorForms: '4d6f085706350fbf03a1da6f7c00721896c72fb4',
})

export const FLOWING_CONTOURS_REFERENCE_CONTROLS: Readonly<FlowingContoursControls> =
  Object.freeze({ ...defaultFlowingContoursControls })

export const PENCIL_CONTOUR_REFERENCE_CONTROLS: Readonly<PencilContourControls> =
  Object.freeze({
    gamma: 0.5,
    contrast: 0.5,
    pivot: 0.5,
    contourDetail: 0.5,
    contourSmoothing: 1,
  })

export const WATERCOLOR_FORMS_REFERENCE_CONTROLS: Readonly<WatercolorFormsControls> =
  Object.freeze({
    gamma: 0.5,
    contrast: 0.5,
    pivot: 0.5,
    formDetail: 0.5,
    colorSensitivity: 0.5,
    boundaryStrength: 0.5,
    boundarySmoothing: 1,
  })

export const FLOWING_CONTOURS_REFERENCE_COMPARATORS = Object.freeze({
  pencilContour: Object.freeze({
    sketchId: 'pencil-contour',
    revision: FLOWING_CONTOURS_REFERENCE_REVISIONS.pencilContour,
    controls: PENCIL_CONTOUR_REFERENCE_CONTROLS,
  }),
  watercolorForms: Object.freeze({
    sketchId: 'watercolor-forms',
    revision: FLOWING_CONTOURS_REFERENCE_REVISIONS.watercolorForms,
    controls: WATERCOLOR_FORMS_REFERENCE_CONTROLS,
  }),
})

export type FlowingContoursReferenceCaseName = 'flower' | 'pinecone'

export interface FlowingContoursReferenceSource {
  readonly assetId: string
  readonly repositoryPath: string
  readonly sha256: string
  readonly decodedWidth: number
  readonly decodedHeight: number
}

export interface FlowingContoursReferenceCrop {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface FlowingContoursReferenceCase {
  readonly name: FlowingContoursReferenceCaseName
  readonly source: Readonly<FlowingContoursReferenceSource>
  readonly frame: Readonly<CoordinateSpace>
  readonly analysis: {
    readonly width: number
    readonly height: number
    readonly sampleCount: number
  }
  readonly crops: {
    readonly fullFrame: Readonly<FlowingContoursReferenceCrop>
    readonly denseDetail: Readonly<FlowingContoursReferenceCrop>
  }
  /** Normalized Scene rectangles sampled from long geometry. */
  readonly regions: readonly Readonly<FlowingContoursReferenceRegion>[]
}

function region(
  name: string,
  left: number,
  top: number,
  right: number,
  bottom: number,
): Readonly<FlowingContoursReferenceRegion> {
  return Object.freeze({ name, left, top, right, bottom })
}

const FULL_FRAME_CROP = Object.freeze({
  x: 0,
  y: 0,
  width: 1000,
  height: 1000,
})

/**
 * Named regions prevent deletion from manufacturing attractive aggregate
 * shares. Flower regions cover the central bloom and both lateral gestures;
 * pinecone regions cover both sides and every vertical tier of the scales.
 */
export const FLOWING_CONTOURS_REFERENCE_CASES: Readonly<
  Record<FlowingContoursReferenceCaseName, FlowingContoursReferenceCase>
> = Object.freeze({
  flower: Object.freeze({
    name: 'flower',
    source: Object.freeze({
      assetId: 'img-0672-79d639daec62',
      repositoryPath: 'assets/image-assets/img-0672-79d639daec62.png',
      sha256:
        '79d639daec62a2af4a59954b9d102e51ff30d11cd14246fffc52a53250858a7d',
      decodedWidth: 1536,
      decodedHeight: 2048,
    }),
    frame: FLOWING_CONTOURS_REFERENCE_FRAME,
    analysis: Object.freeze({
      width: 192,
      height: 256,
      sampleCount: 49_152,
    }),
    crops: Object.freeze({
      fullFrame: FULL_FRAME_CROP,
      denseDetail: Object.freeze({
        x: 250,
        y: 40,
        width: 500,
        height: 500,
      }),
    }),
    regions: Object.freeze([
      region('left-petals', 0.2, 0.05, 0.46, 0.36),
      region('flower-center', 0.35, 0.16, 0.65, 0.36),
      region('right-petals', 0.54, 0.05, 0.8, 0.36),
      region('lower-gesture', 0.3, 0.36, 0.7, 0.78),
    ]),
  }),
  pinecone: Object.freeze({
    name: 'pinecone',
    source: Object.freeze({
      assetId: 'pinecone-4330aa0314f7',
      repositoryPath: 'assets/image-assets/pinecone-4330aa0314f7.png',
      sha256:
        '4330aa0314f7b0acb150c7c22eab41e2a15008a04a3a17dd54cc1df03ac32c79',
      decodedWidth: 512,
      decodedHeight: 768,
    }),
    frame: FLOWING_CONTOURS_REFERENCE_FRAME,
    analysis: Object.freeze({
      width: 171,
      height: 256,
      sampleCount: 43_776,
    }),
    crops: Object.freeze({
      fullFrame: FULL_FRAME_CROP,
      denseDetail: Object.freeze({
        x: 200,
        y: 180,
        width: 600,
        height: 600,
      }),
    }),
    regions: Object.freeze([
      region('upper-scales', 0.23, 0.18, 0.77, 0.38),
      region('middle-scales', 0.23, 0.38, 0.77, 0.6),
      region('lower-scales', 0.23, 0.6, 0.77, 0.82),
      region('left-interior', 0.23, 0.22, 0.5, 0.78),
      region('right-interior', 0.5, 0.22, 0.77, 0.78),
    ]),
  }),
})

export interface FlowingContoursFixturePlane {
  readonly name: 'luminance' | 'alpha' | 'positiveSupport'
  readonly offsetBytes: number
  readonly valueCount: number
  readonly values?: '0=false, 1=true'
}

export interface FlowingContoursFixtureMetadata {
  readonly formatVersion: 1
  readonly fixtureStatus: 'provisional'
  readonly preparationVersion: 'flowing-contours-prepared-raster-v1'
  readonly preparedFromCommit: string
  readonly source: Readonly<FlowingContoursReferenceSource>
  readonly frame: Readonly<CoordinateSpace>
  readonly controls: Readonly<FlowingContoursControls>
  readonly crops: FlowingContoursReferenceCase['crops']
  readonly regions: readonly Readonly<FlowingContoursReferenceRegion>[]
  readonly comparators: typeof FLOWING_CONTOURS_REFERENCE_COMPARATORS
  readonly analysis: {
    readonly width: number
    readonly height: number
    readonly sampleCount: number
  }
  readonly encoding: {
    readonly byteOrder: 'little-endian'
    readonly valueType: 'float64'
    readonly planes: readonly Readonly<FlowingContoursFixturePlane>[]
  }
  readonly fixtureSha256: string
}

function positiveSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
  )
}

function validUnit(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  )
}

function validRaster(
  raster: Readonly<PreparedFlowingContoursRaster>,
): boolean {
  try {
    if (
      raster === null ||
      typeof raster !== 'object' ||
      !positiveSafeInteger(raster.sourceWidth) ||
      !positiveSafeInteger(raster.sourceHeight) ||
      !positiveSafeInteger(raster.width) ||
      !positiveSafeInteger(raster.height) ||
      raster.width > FLOWING_CONTOURS_LIMITS['analysis-dimension'] ||
      raster.height > FLOWING_CONTOURS_LIMITS['analysis-dimension']
    ) {
      return false
    }
    const sampleCount = raster.width * raster.height
    if (
      !Number.isSafeInteger(sampleCount) ||
      sampleCount > FLOWING_CONTOURS_LIMITS['analysis-sample-count'] ||
      !Array.isArray(raster.luminance) ||
      !Array.isArray(raster.alpha) ||
      !Array.isArray(raster.positiveSupport) ||
      raster.luminance.length !== sampleCount ||
      raster.alpha.length !== sampleCount ||
      raster.positiveSupport.length !== sampleCount
    ) {
      return false
    }
    for (let index = 0; index < sampleCount; index += 1) {
      if (
        !Object.prototype.hasOwnProperty.call(raster.luminance, index) ||
        !Object.prototype.hasOwnProperty.call(raster.alpha, index) ||
        !Object.prototype.hasOwnProperty.call(raster.positiveSupport, index) ||
        !validUnit(raster.luminance[index]) ||
        !validUnit(raster.alpha[index]) ||
        typeof raster.positiveSupport[index] !== 'boolean' ||
        raster.positiveSupport[index] !== (raster.alpha[index]! > 0)
      ) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

/** Canonical three-plane Float64LE encoding; malformed inputs return `null`. */
export function encodeFlowingContoursPreparedRaster(
  raster: Readonly<PreparedFlowingContoursRaster>,
): Uint8Array | null {
  if (!validRaster(raster)) return null
  try {
    const sampleCount = raster.width * raster.height
    const bytes = new Uint8Array(
      sampleCount * PLANE_COUNT * FLOAT64_BYTES,
    )
    const view = new DataView(bytes.buffer)
    const planes: readonly (readonly number[])[] = [
      raster.luminance,
      raster.alpha,
      raster.positiveSupport.map((supported) => (supported ? 1 : 0)),
    ]
    let offset = 0
    for (const plane of planes) {
      for (const value of plane) {
        view.setFloat64(offset, value, true)
        offset += FLOAT64_BYTES
      }
    }
    return bytes
  } catch {
    return null
  }
}

export function flowingContoursFixtureSha256(
  bytes: Readonly<Uint8Array>,
): string | null {
  try {
    return createHash('sha256').update(bytes).digest('hex')
  } catch {
    return null
  }
}

function canonicalPlanes(
  sampleCount: number,
): readonly Readonly<FlowingContoursFixturePlane>[] {
  return Object.freeze([
    Object.freeze({
      name: 'luminance',
      offsetBytes: 0,
      valueCount: sampleCount,
    }),
    Object.freeze({
      name: 'alpha',
      offsetBytes: sampleCount * FLOAT64_BYTES,
      valueCount: sampleCount,
    }),
    Object.freeze({
      name: 'positiveSupport',
      offsetBytes: sampleCount * FLOAT64_BYTES * 2,
      valueCount: sampleCount,
      values: '0=false, 1=true',
    }),
  ])
}

/** Construct metadata only for the exact named source and bounded raster. */
export function createFlowingContoursFixtureMetadata(
  name: FlowingContoursReferenceCaseName,
  raster: Readonly<PreparedFlowingContoursRaster>,
  fixtureSha256: string,
  preparedFromCommit = FLOWING_CONTOURS_REFERENCE_REVISIONS.flowingContours,
): Readonly<FlowingContoursFixtureMetadata> | null {
  const reference = FLOWING_CONTOURS_REFERENCE_CASES[name]
  if (
    reference === undefined ||
    !validRaster(raster) ||
    raster.sourceWidth !== reference.source.decodedWidth ||
    raster.sourceHeight !== reference.source.decodedHeight ||
    raster.width !== reference.analysis.width ||
    raster.height !== reference.analysis.height ||
    !SHA256_PATTERN.test(fixtureSha256) ||
    !COMMIT_PATTERN.test(preparedFromCommit)
  ) {
    return null
  }
  const sampleCount = raster.width * raster.height
  return Object.freeze({
    formatVersion: 1,
    fixtureStatus: 'provisional',
    preparationVersion: 'flowing-contours-prepared-raster-v1',
    preparedFromCommit,
    source: reference.source,
    frame: reference.frame,
    controls: FLOWING_CONTOURS_REFERENCE_CONTROLS,
    crops: reference.crops,
    regions: reference.regions,
    comparators: FLOWING_CONTOURS_REFERENCE_COMPARATORS,
    analysis: Object.freeze({
      width: raster.width,
      height: raster.height,
      sampleCount,
    }),
    encoding: Object.freeze({
      byteOrder: 'little-endian',
      valueType: 'float64',
      planes: canonicalPlanes(sampleCount),
    }),
    fixtureSha256,
  })
}

function sameJson(first: unknown, second: unknown): boolean {
  try {
    return JSON.stringify(first) === JSON.stringify(second)
  } catch {
    return false
  }
}

function validMetadata(
  metadata: Readonly<FlowingContoursFixtureMetadata>,
): boolean {
  try {
    const matchingCase = Object.values(
      FLOWING_CONTOURS_REFERENCE_CASES,
    ).find(({ source }) => source.assetId === metadata.source?.assetId)
    if (
      matchingCase === undefined ||
      metadata.formatVersion !== 1 ||
      metadata.fixtureStatus !== 'provisional' ||
      metadata.preparationVersion !==
        'flowing-contours-prepared-raster-v1' ||
      !COMMIT_PATTERN.test(metadata.preparedFromCommit) ||
      !SHA256_PATTERN.test(metadata.fixtureSha256) ||
      !sameJson(metadata.source, matchingCase.source) ||
      !sameJson(metadata.frame, matchingCase.frame) ||
      !sameJson(metadata.analysis, matchingCase.analysis) ||
      !sameJson(metadata.controls, FLOWING_CONTOURS_REFERENCE_CONTROLS) ||
      !sameJson(metadata.crops, matchingCase.crops) ||
      !sameJson(metadata.regions, matchingCase.regions) ||
      !sameJson(
        metadata.comparators,
        FLOWING_CONTOURS_REFERENCE_COMPARATORS,
      ) ||
      !positiveSafeInteger(metadata.analysis?.width) ||
      !positiveSafeInteger(metadata.analysis?.height) ||
      metadata.analysis.width >
        FLOWING_CONTOURS_LIMITS['analysis-dimension'] ||
      metadata.analysis.height >
        FLOWING_CONTOURS_LIMITS['analysis-dimension'] ||
      metadata.analysis.sampleCount !==
        metadata.analysis.width * metadata.analysis.height ||
      metadata.analysis.sampleCount >
        FLOWING_CONTOURS_LIMITS['analysis-sample-count'] ||
      metadata.encoding?.byteOrder !== 'little-endian' ||
      metadata.encoding.valueType !== 'float64' ||
      !sameJson(
        metadata.encoding.planes,
        canonicalPlanes(metadata.analysis.sampleCount),
      )
    ) {
      return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Decode and validate one fixture as the production prepared-raster contract.
 *
 * Hash, dimensions, canonical offsets, unit ranges, and binary support must
 * all agree. Any corruption returns `null`; no prefix is accepted.
 */
export function decodeFlowingContoursPreparedRaster(
  bytes: Readonly<Uint8Array>,
  metadata: Readonly<FlowingContoursFixtureMetadata>,
): Readonly<PreparedFlowingContoursRaster> | null {
  if (!validMetadata(metadata)) return null
  try {
    const sampleCount = metadata.analysis.sampleCount
    if (
      bytes.byteLength !== sampleCount * PLANE_COUNT * FLOAT64_BYTES ||
      flowingContoursFixtureSha256(bytes) !== metadata.fixtureSha256
    ) {
      return null
    }
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    )
    const values = (planeIndex: number): number[] => {
      const plane = new Array<number>(sampleCount)
      for (let index = 0; index < sampleCount; index += 1) {
        plane[index] = view.getFloat64(
          (planeIndex * sampleCount + index) * FLOAT64_BYTES,
          true,
        )
      }
      return plane
    }
    const luminance = values(0)
    const alpha = values(1)
    const supportValues = values(2)
    if (
      !luminance.every(validUnit) ||
      !alpha.every(validUnit) ||
      !supportValues.every((value) => value === 0 || value === 1)
    ) {
      return null
    }
    const positiveSupport = supportValues.map((value) => value === 1)
    if (
      positiveSupport.some(
        (supported, index) => supported !== (alpha[index]! > 0),
      )
    ) {
      return null
    }
    const raster = Object.freeze({
      sourceWidth: metadata.source.decodedWidth,
      sourceHeight: metadata.source.decodedHeight,
      width: metadata.analysis.width,
      height: metadata.analysis.height,
      luminance: Object.freeze(luminance),
      alpha: Object.freeze(alpha),
      positiveSupport: Object.freeze(positiveSupport),
    })
    return validRaster(raster) ? raster : null
  } catch {
    return null
  }
}

export interface FlowingContoursReferenceGate {
  readonly minimumPathCount: number
  readonly maximumPathCount: number
  readonly maximumShortPathShare: number
  readonly minimumMedianPathDiagonalFraction: number
  readonly minimumUpperQuartilePathDiagonalFraction: number
  readonly minimumLongestPathDiagonalFraction: number
  readonly minimumTotalPathDiagonalMultiple: number
  readonly minimumLongGeometryShare: number
  readonly minimumLongPathCount: number
  readonly maximumTurnsOver25DegreesShare: number
  readonly maximumTurnsOver45DegreesShare: number
  readonly maximumStaircasePairCount: number
  readonly maximumOrthogonalStaircaseSignature: number
  readonly minimumOccupiedCoverageBinCount: number
  readonly maximumUnsupportedSpanLength: number
  readonly minimumRegionSampledPointCount: Readonly<Record<string, number>>
}

const COMMON_REFERENCE_GATE = Object.freeze({
  minimumPathCount: 4,
  maximumPathCount: 256,
  maximumShortPathShare: 0.15,
  minimumMedianPathDiagonalFraction: 0.03,
  minimumUpperQuartilePathDiagonalFraction: 0.06,
  minimumLongestPathDiagonalFraction: 0.15,
  minimumTotalPathDiagonalMultiple: 0.75,
  minimumLongGeometryShare: 0.7,
  minimumLongPathCount: 4,
  maximumTurnsOver25DegreesShare: 0.1,
  maximumTurnsOver45DegreesShare: 0.025,
  maximumStaircasePairCount: 3,
  maximumOrthogonalStaircaseSignature: 0.025,
  minimumOccupiedCoverageBinCount: 8,
  maximumUnsupportedSpanLength:
    FLOWING_CONTOURS_LIMITS['weak-span-distance'],
})

export const FLOWING_CONTOURS_REFERENCE_GATES: Readonly<
  Record<FlowingContoursReferenceCaseName, FlowingContoursReferenceGate>
> = Object.freeze({
  flower: Object.freeze({
    ...COMMON_REFERENCE_GATE,
    minimumRegionSampledPointCount: Object.freeze({
      'left-petals': 2,
      'flower-center': 4,
      'right-petals': 2,
      'lower-gesture': 2,
    }),
  }),
  pinecone: Object.freeze({
    ...COMMON_REFERENCE_GATE,
    minimumRegionSampledPointCount: Object.freeze({
      'upper-scales': 2,
      'middle-scales': 4,
      'lower-scales': 2,
      'left-interior': 3,
      'right-interior': 3,
    }),
  }),
})

export type FlowingContoursReferenceGateFinding =
  | 'path-count'
  | 'short-path-share'
  | 'median-path-length'
  | 'upper-quartile-path-length'
  | 'longest-path-length'
  | 'total-path-length'
  | 'long-geometry-share'
  | 'long-path-count'
  | 'turns-over-25'
  | 'turns-over-45'
  | 'staircase-pairs'
  | 'orthogonal-staircase'
  | 'coverage'
  | 'unsupported-span'
  | `region:${string}`

export type FlowingContoursPencilComparisonFinding =
  | 'pencil-short-path-share'
  | 'pencil-median-path-length'
  | 'pencil-upper-quartile-path-length'
  | 'pencil-longest-path-length'

export type FlowingContoursLengthComparisonMetrics = Pick<
  FlowingContoursReferenceMetrics,
  | 'shortPathShare'
  | 'medianPathLength'
  | 'upperQuartilePathLength'
  | 'longestPathLength'
>

/**
 * The issue's directional Pencil comparison is strict on every case. Absolute
 * quality gates still apply separately: beating a particularly poor baseline
 * cannot by itself release Flowing Contours.
 */
export function flowingContoursPencilComparisonFindings(
  flowing: Readonly<FlowingContoursLengthComparisonMetrics>,
  pencil: Readonly<FlowingContoursLengthComparisonMetrics>,
): readonly FlowingContoursPencilComparisonFinding[] {
  const findings: FlowingContoursPencilComparisonFinding[] = []
  if (flowing.shortPathShare >= pencil.shortPathShare) {
    findings.push('pencil-short-path-share')
  }
  if (flowing.medianPathLength <= pencil.medianPathLength) {
    findings.push('pencil-median-path-length')
  }
  if (flowing.upperQuartilePathLength <= pencil.upperQuartilePathLength) {
    findings.push('pencil-upper-quartile-path-length')
  }
  if (flowing.longestPathLength <= pencil.longestPathLength) {
    findings.push('pencil-longest-path-length')
  }
  return Object.freeze(findings)
}

/**
 * Hard release gates for the two versioned cases.
 *
 * Shares are paired with total length, long-path count, coverage, and named
 * regions so deleting difficult geometry cannot improve the verdict.
 */
export function flowingContoursReferenceGateFindings(
  name: FlowingContoursReferenceCaseName,
  metrics: Readonly<FlowingContoursReferenceMetrics>,
): readonly FlowingContoursReferenceGateFinding[] {
  const gate = FLOWING_CONTOURS_REFERENCE_GATES[name]
  const diagonal = Math.hypot(
    FLOWING_CONTOURS_REFERENCE_FRAME.width,
    FLOWING_CONTOURS_REFERENCE_FRAME.height,
  )
  const findings: FlowingContoursReferenceGateFinding[] = []
  if (
    metrics.pathCount < gate.minimumPathCount ||
    metrics.pathCount > gate.maximumPathCount
  ) findings.push('path-count')
  if (metrics.shortPathShare > gate.maximumShortPathShare) {
    findings.push('short-path-share')
  }
  if (
    metrics.medianPathLength <
    diagonal * gate.minimumMedianPathDiagonalFraction
  ) findings.push('median-path-length')
  if (
    metrics.upperQuartilePathLength <
    diagonal * gate.minimumUpperQuartilePathDiagonalFraction
  ) findings.push('upper-quartile-path-length')
  if (
    metrics.longestPathLength <
    diagonal * gate.minimumLongestPathDiagonalFraction
  ) findings.push('longest-path-length')
  if (
    metrics.totalPathLength <
    diagonal * gate.minimumTotalPathDiagonalMultiple
  ) findings.push('total-path-length')
  if (metrics.longGeometryShare < gate.minimumLongGeometryShare) {
    findings.push('long-geometry-share')
  }
  if (metrics.longPathCount < gate.minimumLongPathCount) {
    findings.push('long-path-count')
  }
  if (
    metrics.turnsOver25DegreesShare >
    gate.maximumTurnsOver25DegreesShare
  ) findings.push('turns-over-25')
  if (
    metrics.turnsOver45DegreesShare >
    gate.maximumTurnsOver45DegreesShare
  ) findings.push('turns-over-45')
  if (metrics.staircasePairCount > gate.maximumStaircasePairCount) {
    findings.push('staircase-pairs')
  }
  if (
    metrics.orthogonalStaircaseSignature >
    gate.maximumOrthogonalStaircaseSignature
  ) findings.push('orthogonal-staircase')
  if (
    metrics.occupiedCoverageBinCount <
    gate.minimumOccupiedCoverageBinCount
  ) findings.push('coverage')
  if (
    metrics.maximumUnsupportedSpanLength >
    gate.maximumUnsupportedSpanLength
  ) findings.push('unsupported-span')
  const regions = new Map(
    metrics.regions.map((region) => [region.name, region.sampledPointCount]),
  )
  for (const [regionName, minimum] of Object.entries(
    gate.minimumRegionSampledPointCount,
  )) {
    if ((regions.get(regionName) ?? 0) < minimum) {
      findings.push(`region:${regionName}`)
    }
  }
  return Object.freeze(findings)
}
