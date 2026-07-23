import { createHash } from 'node:crypto'

import type { CoordinateSpace, Scene } from '../../scene'
import {
  defaultFlowingContoursControls,
  type FlowingContoursControls,
} from '../../sketches/flowing-contours/controls'
import { FLOWING_CONTOURS_LIMITS } from '../../sketches/flowing-contours/limits'
import type {
  PreparedFlowingContoursRaster,
} from '../../sketches/flowing-contours/raster'
import {
  FLOWING_CONTOURS_ENDPOINT_REASONS,
} from '../../sketches/flowing-contours/types'
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
  /**
   * Case-specific review questions. A passing artifact must explicitly verify
   * source-supported connection and absence of the named shortcut.
   */
  readonly topologyChecks: readonly string[]
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
    topologyChecks: Object.freeze([
      'petal-center-supported-connections',
      'center-lower-gesture-no-background-shortcut',
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
    topologyChecks: Object.freeze([
      'scale-row-supported-connections',
      'opposite-sides-no-interior-shortcut',
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
  readonly topologyChecks: readonly string[]
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
    topologyChecks: reference.topologyChecks,
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

const FIXTURE_METADATA_KEYS = Object.freeze([
  'formatVersion',
  'fixtureStatus',
  'preparationVersion',
  'preparedFromCommit',
  'source',
  'frame',
  'controls',
  'crops',
  'regions',
  'topologyChecks',
  'comparators',
  'analysis',
  'encoding',
  'fixtureSha256',
])

function hasExactOwnDataKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return false
    }
    const keys = Reflect.ownKeys(value)
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== 'string') ||
      !expectedKeys.every((key) => keys.includes(key))
    ) {
      return false
    }
    return expectedKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor !== undefined && 'value' in descriptor
    })
  } catch {
    return false
  }
}

function validMetadata(
  metadata: Readonly<FlowingContoursFixtureMetadata>,
): boolean {
  try {
    if (!hasExactOwnDataKeys(metadata, FIXTURE_METADATA_KEYS)) return false
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
      !sameJson(metadata.topologyChecks, matchingCase.topologyChecks) ||
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
  readonly maximumTotalUnsupportedSpanLength: number
  readonly maximumUnsupportedTravelRatio: number
  readonly gridAxisPathCountFloor: number
  readonly minimumGridAxisLengthShare: number
  readonly minimumRegionSampledPointCount: Readonly<Record<string, number>>
  readonly topologyCheckNames: readonly string[]
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
  maximumTotalUnsupportedSpanLength:
    FLOWING_CONTOURS_LIMITS['weak-span-distance'] * 4,
  maximumUnsupportedTravelRatio: 0.08,
  gridAxisPathCountFloor: 2,
  minimumGridAxisLengthShare: 0.18,
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
    topologyCheckNames:
      FLOWING_CONTOURS_REFERENCE_CASES.flower.topologyChecks,
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
    topologyCheckNames:
      FLOWING_CONTOURS_REFERENCE_CASES.pinecone.topologyChecks,
  }),
})

export interface FlowingContoursReferenceGeometryEvidence {
  readonly pathCount: number
  readonly segmentCount: number
  readonly totalSegmentLength: number
  /** Fraction of length in the first best-fit unoriented axis. */
  readonly primaryAxisLengthShare: number
  /** Fraction of length in the best-fit perpendicular axis. */
  readonly perpendicularAxisLengthShare: number
  /** Paths with at least 85% of their length in the first axis. */
  readonly primaryAxisPathCount: number
  /** Paths with at least 85% of their length in the perpendicular axis. */
  readonly perpendicularAxisPathCount: number
}

export interface FlowingContoursReferenceTopologyCheck {
  readonly name: string
  readonly sourceConnectionVerified: boolean
  readonly forbiddenBridgeObserved: boolean
}

export interface FlowingContoursReferenceGateEvidence {
  readonly geometry: Readonly<FlowingContoursReferenceGeometryEvidence>
  readonly topology: readonly Readonly<FlowingContoursReferenceTopologyCheck>[]
}

const ORIENTATION_TOLERANCE_RADIANS = (7.5 * Math.PI) / 180
const ORIENTATION_FAMILY_PATH_SHARE = 0.85
const ORIENTATION_AXIS_CANDIDATE_COUNT = 24

function normalizedOrientation(angle: number): number {
  const normalized = angle % Math.PI
  return normalized < 0 ? normalized + Math.PI : normalized
}

function unorientedDistance(first: number, second: number): number {
  const difference = Math.abs(
    normalizedOrientation(first) - normalizedOrientation(second),
  )
  return Math.min(difference, Math.PI - difference)
}

/**
 * Inspect collection-level orientation without treating one straight source
 * contour as a grid. A lattice requires both concentrated orthogonal geometry
 * and a repeated family of independently emitted paths.
 */
export function measureFlowingContoursReferenceGeometryEvidence(
  scene: Readonly<Scene>,
): Readonly<FlowingContoursReferenceGeometryEvidence> | null {
  try {
    if (
      scene === null ||
      typeof scene !== 'object' ||
      !Array.isArray(scene.primitives)
    ) {
      return null
    }
    const segments: Array<{
      readonly pathIndex: number
      readonly angle: number
      readonly length: number
    }> = []
    const pathLengths = new Array<number>(scene.primitives.length).fill(0)
    for (
      let pathIndex = 0;
      pathIndex < scene.primitives.length;
      pathIndex += 1
    ) {
      const primitive = scene.primitives[pathIndex]
      if (
        primitive === null ||
        typeof primitive !== 'object' ||
        !Array.isArray(primitive.points) ||
        primitive.points.length < 2
      ) {
        return null
      }
      const segmentCount =
        primitive.points.length - 1 + (primitive.closed ? 1 : 0)
      for (let index = 0; index < segmentCount; index += 1) {
        const first = primitive.points[index]!
        const second =
          primitive.points[(index + 1) % primitive.points.length]!
        if (
          !Array.isArray(first) ||
          first.length !== 2 ||
          !Array.isArray(second) ||
          second.length !== 2 ||
          !Number.isFinite(first[0]) ||
          !Number.isFinite(first[1]) ||
          !Number.isFinite(second[0]) ||
          !Number.isFinite(second[1])
        ) {
          return null
        }
        const dx = second[0] - first[0]
        const dy = second[1] - first[1]
        const length = Math.hypot(dx, dy)
        if (!Number.isFinite(length)) return null
        if (length === 0) continue
        pathLengths[pathIndex]! += length
        segments.push({
          pathIndex,
          angle: normalizedOrientation(Math.atan2(dy, dx)),
          length,
        })
      }
      if (!(pathLengths[pathIndex]! > 0)) return null
    }
    const totalSegmentLength = pathLengths.reduce(
      (total, length) => total + length,
      0,
    )
    if (segments.length === 0) {
      return Object.freeze({
        pathCount: scene.primitives.length,
        segmentCount: 0,
        totalSegmentLength: 0,
        primaryAxisLengthShare: 0,
        perpendicularAxisLengthShare: 0,
        primaryAxisPathCount: 0,
        perpendicularAxisPathCount: 0,
      })
    }
    let bestAxis = 0
    let bestPrimaryLength = 0
    let bestPerpendicularLength = 0
    let bestBalancedLength = -1
    let bestCombinedLength = -1
    for (
      let candidateIndex = 0;
      candidateIndex < ORIENTATION_AXIS_CANDIDATE_COUNT;
      candidateIndex += 1
    ) {
      const candidateAxis =
        (candidateIndex * (Math.PI / 2)) /
        ORIENTATION_AXIS_CANDIDATE_COUNT
      const primaryLength = segments.reduce(
        (total, segment) =>
          total +
          (unorientedDistance(segment.angle, candidateAxis) <=
          ORIENTATION_TOLERANCE_RADIANS
            ? segment.length
            : 0),
        0,
      )
      const perpendicularLength = segments.reduce(
        (total, segment) =>
          total +
          (unorientedDistance(
            segment.angle,
            candidateAxis + Math.PI / 2,
          ) <= ORIENTATION_TOLERANCE_RADIANS
            ? segment.length
            : 0),
        0,
      )
      const balancedLength = Math.min(
        primaryLength,
        perpendicularLength,
      )
      const combinedLength = primaryLength + perpendicularLength
      if (
        balancedLength > bestBalancedLength ||
        (balancedLength === bestBalancedLength &&
          combinedLength > bestCombinedLength)
      ) {
        bestBalancedLength = balancedLength
        bestCombinedLength = combinedLength
        bestAxis = candidateAxis
        bestPrimaryLength = primaryLength
        bestPerpendicularLength = perpendicularLength
      }
    }
    const primaryByPath = new Array<number>(pathLengths.length).fill(0)
    const perpendicularByPath = new Array<number>(
      pathLengths.length,
    ).fill(0)
    for (const segment of segments) {
      if (
        unorientedDistance(segment.angle, bestAxis) <=
        ORIENTATION_TOLERANCE_RADIANS
      ) {
        primaryByPath[segment.pathIndex]! += segment.length
      }
      if (
        unorientedDistance(
          segment.angle,
          bestAxis + Math.PI / 2,
        ) <= ORIENTATION_TOLERANCE_RADIANS
      ) {
        perpendicularByPath[segment.pathIndex]! += segment.length
      }
    }
    return Object.freeze({
      pathCount: scene.primitives.length,
      segmentCount: segments.length,
      totalSegmentLength,
      primaryAxisLengthShare: bestPrimaryLength / totalSegmentLength,
      perpendicularAxisLengthShare:
        bestPerpendicularLength / totalSegmentLength,
      primaryAxisPathCount: primaryByPath.filter(
        (length, index) =>
          length / pathLengths[index]! >= ORIENTATION_FAMILY_PATH_SHARE,
      ).length,
      perpendicularAxisPathCount: perpendicularByPath.filter(
        (length, index) =>
          length / pathLengths[index]! >= ORIENTATION_FAMILY_PATH_SHARE,
      ).length,
    })
  } catch {
    return null
  }
}

export type FlowingContoursReferenceGateFinding =
  | 'invalid-metrics'
  | 'invalid-evidence'
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
  | 'total-unsupported-span'
  | 'unsupported-travel-ratio'
  | 'orthogonal-grid-family'
  | `region:${string}`
  | `topology:${string}`

export type FlowingContoursPencilComparisonFinding =
  | 'invalid-comparison-metrics'
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
  try {
    const values = [flowing, pencil].flatMap((metrics) => [
      metrics.shortPathShare,
      metrics.medianPathLength,
      metrics.upperQuartilePathLength,
      metrics.longestPathLength,
    ])
    if (
      values.some((value) => !Number.isFinite(value) || value < 0) ||
      flowing.shortPathShare > 1 ||
      pencil.shortPathShare > 1 ||
      flowing.medianPathLength > flowing.upperQuartilePathLength ||
      flowing.upperQuartilePathLength > flowing.longestPathLength ||
      pencil.medianPathLength > pencil.upperQuartilePathLength ||
      pencil.upperQuartilePathLength > pencil.longestPathLength
    ) {
      return Object.freeze(['invalid-comparison-metrics'])
    }
    const findings: FlowingContoursPencilComparisonFinding[] = []
    if (flowing.shortPathShare >= pencil.shortPathShare) {
      findings.push('pencil-short-path-share')
    }
    if (flowing.medianPathLength <= pencil.medianPathLength) {
      findings.push('pencil-median-path-length')
    }
    if (
      flowing.upperQuartilePathLength <= pencil.upperQuartilePathLength
    ) {
      findings.push('pencil-upper-quartile-path-length')
    }
    if (flowing.longestPathLength <= pencil.longestPathLength) {
      findings.push('pencil-longest-path-length')
    }
    return Object.freeze(findings)
  } catch {
    return Object.freeze(['invalid-comparison-metrics'])
  }
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function safeNonNegativeInteger(value: unknown): value is number {
  return finiteNonNegative(value) && Number.isSafeInteger(value)
}

function unitShare(value: unknown): value is number {
  return finiteNonNegative(value) && value <= 1
}

function nearlyEqual(first: number, second: number): boolean {
  return (
    Math.abs(first - second) <=
    1e-10 * Math.max(1, Math.abs(first), Math.abs(second))
  )
}

function ratioIs(
  share: number,
  numerator: number,
  denominator: number,
): boolean {
  return nearlyEqual(share, denominator === 0 ? 0 : numerator / denominator)
}

function hasFiniteMetricInventory(
  metrics: Readonly<FlowingContoursReferenceMetrics>,
): boolean {
  try {
    if (metrics === null || typeof metrics !== 'object') return false
    const counts = [
      metrics.pathCount,
      metrics.shortPathCount,
      metrics.longPathCount,
      metrics.visibleEndpointCount,
      metrics.endpointCount,
      metrics.sampledPathCount,
      metrics.sampledPointCount,
      metrics.turnCount,
      metrics.turnsOver25DegreesCount,
      metrics.turnsOver45DegreesCount,
      metrics.orthogonalTurnCount,
      metrics.staircasePairCount,
      metrics.coverageColumns,
      metrics.coverageRows,
      metrics.occupiedCoverageBinCount,
    ]
    const quantities = [
      metrics.medianPathLength,
      metrics.upperQuartilePathLength,
      metrics.longestPathLength,
      metrics.totalPathLength,
      metrics.longGeometryLength,
      metrics.maximumUnsupportedSpanLength,
      metrics.totalUnsupportedSpanLength,
      metrics.totalAcceptedTrajectoryLength,
      metrics.turnEnergy,
      metrics.maximumTurnDegrees,
      metrics.sampleSpacing,
      metrics.shortPathLength,
      metrics.longPathLength,
      metrics.numericTolerance,
    ]
    const shares = [
      metrics.shortPathShare,
      metrics.longGeometryShare,
      metrics.turnsOver25DegreesShare,
      metrics.turnsOver45DegreesShare,
      metrics.orthogonalStaircaseSignature,
      metrics.occupiedCoverageBinShare,
    ]
    if (
      counts.some((value) => !safeNonNegativeInteger(value)) ||
      quantities.some((value) => !finiteNonNegative(value)) ||
      shares.some((value) => !unitShare(value)) ||
      metrics.coverageColumns < 1 ||
      metrics.coverageRows < 1 ||
      metrics.sampleSpacing <= 0 ||
      metrics.shortPathLength <= 0 ||
      metrics.longPathLength <= metrics.shortPathLength ||
      metrics.numericTolerance <= 0
    ) {
      return false
    }
    if (
      metrics.shortPathCount > metrics.pathCount ||
      metrics.longPathCount > metrics.pathCount ||
      metrics.shortPathCount + metrics.longPathCount >
        metrics.pathCount ||
      metrics.sampledPathCount !== metrics.pathCount ||
      metrics.sampledPointCount < metrics.sampledPathCount ||
      metrics.visibleEndpointCount % 2 !== 0 ||
      metrics.visibleEndpointCount > metrics.pathCount * 2 ||
      metrics.endpointCount !== metrics.pathCount * 2 ||
      metrics.orthogonalTurnCount > metrics.turnCount ||
      metrics.staircasePairCount > metrics.turnCount ||
      metrics.turnsOver25DegreesCount > metrics.turnCount ||
      metrics.turnsOver45DegreesCount >
        metrics.turnsOver25DegreesCount ||
      metrics.longGeometryLength > metrics.totalPathLength ||
      (metrics.longPathCount === 0) !==
        (metrics.longGeometryLength === 0) ||
      metrics.maximumUnsupportedSpanLength >
        metrics.totalUnsupportedSpanLength ||
      (metrics.totalUnsupportedSpanLength === 0) !==
        (metrics.maximumUnsupportedSpanLength === 0) ||
      metrics.totalUnsupportedSpanLength >
        metrics.totalAcceptedTrajectoryLength ||
      (metrics.turnCount === 0 &&
        (metrics.turnEnergy !== 0 ||
          metrics.maximumTurnDegrees !== 0 ||
          metrics.orthogonalTurnCount !== 0 ||
          metrics.staircasePairCount !== 0 ||
          metrics.orthogonalStaircaseSignature !== 0)) ||
      (metrics.staircasePairCount === 0 &&
        metrics.orthogonalStaircaseSignature !== 0) ||
      metrics.medianPathLength > metrics.upperQuartilePathLength ||
      metrics.upperQuartilePathLength > metrics.longestPathLength ||
      metrics.longestPathLength > metrics.totalPathLength ||
      !ratioIs(
        metrics.shortPathShare,
        metrics.shortPathCount,
        metrics.pathCount,
      ) ||
      !ratioIs(
        metrics.longGeometryShare,
        metrics.longGeometryLength,
        metrics.totalPathLength,
      ) ||
      !ratioIs(
        metrics.turnsOver25DegreesShare,
        metrics.turnsOver25DegreesCount,
        metrics.turnCount,
      ) ||
      !ratioIs(
        metrics.turnsOver45DegreesShare,
        metrics.turnsOver45DegreesCount,
        metrics.turnCount,
      )
    ) {
      return false
    }
    if (
      metrics.pathCount === 0
        ? metrics.totalPathLength !== 0
        : metrics.totalPathLength <= 0
    ) {
      return false
    }
    const endpointCounts = metrics.endpointReasonCounts
    if (
      !hasExactOwnDataKeys(
        endpointCounts,
        FLOWING_CONTOURS_ENDPOINT_REASONS,
      )
    ) {
      return false
    }
    const endpointTotal = FLOWING_CONTOURS_ENDPOINT_REASONS.reduce(
      (total, reason) => {
        const count = endpointCounts[reason]
        return safeNonNegativeInteger(count)
          ? total + count
          : Number.NaN
      },
      0,
    )
    if (endpointTotal !== metrics.endpointCount) return false
    if (
      !Array.isArray(metrics.occupiedCoverageBins) ||
      metrics.occupiedCoverageBins.length !==
        metrics.occupiedCoverageBinCount ||
      new Set(metrics.occupiedCoverageBins).size !==
        metrics.occupiedCoverageBinCount ||
      !ratioIs(
        metrics.occupiedCoverageBinShare,
        metrics.occupiedCoverageBinCount,
        metrics.coverageColumns * metrics.coverageRows,
      )
    ) {
      return false
    }
    for (const key of metrics.occupiedCoverageBins) {
      if (typeof key !== 'string') return false
      const match = /^(\d+),(\d+)$/.exec(key)
      if (
        match === null ||
        Number(match[1]) >= metrics.coverageRows ||
        Number(match[2]) >= metrics.coverageColumns
      ) {
        return false
      }
    }
    if (!Array.isArray(metrics.regions)) return false
    const regionNames = new Set<string>()
    for (const region of metrics.regions) {
      if (
        region === null ||
        typeof region !== 'object' ||
        typeof region.name !== 'string' ||
        region.name.length === 0 ||
        regionNames.has(region.name) ||
        typeof region.occupied !== 'boolean' ||
        !safeNonNegativeInteger(region.sampledPointCount) ||
        region.occupied !== (region.sampledPointCount > 0)
      ) {
        return false
      }
      regionNames.add(region.name)
    }
    return true
  } catch {
    return false
  }
}

function validGateEvidence(
  gate: Readonly<FlowingContoursReferenceGate>,
  metrics: Readonly<FlowingContoursReferenceMetrics>,
  evidence: Readonly<FlowingContoursReferenceGateEvidence>,
): boolean {
  try {
    if (evidence === null || typeof evidence !== 'object') return false
    const geometry = evidence.geometry
    if (
      geometry === null ||
      typeof geometry !== 'object' ||
      !safeNonNegativeInteger(geometry.pathCount) ||
      !safeNonNegativeInteger(geometry.segmentCount) ||
      !finiteNonNegative(geometry.totalSegmentLength) ||
      !unitShare(geometry.primaryAxisLengthShare) ||
      !unitShare(geometry.perpendicularAxisLengthShare) ||
      geometry.primaryAxisLengthShare +
        geometry.perpendicularAxisLengthShare >
        1 + 1e-10 ||
      !safeNonNegativeInteger(geometry.primaryAxisPathCount) ||
      !safeNonNegativeInteger(geometry.perpendicularAxisPathCount) ||
      geometry.pathCount !== metrics.pathCount ||
      geometry.primaryAxisPathCount > geometry.pathCount ||
      geometry.perpendicularAxisPathCount > geometry.pathCount ||
      !nearlyEqual(geometry.totalSegmentLength, metrics.totalPathLength) ||
      !Array.isArray(evidence.topology)
    ) {
      return false
    }
    const names = new Set<string>()
    for (const check of evidence.topology) {
      if (
        check === null ||
        typeof check !== 'object' ||
        typeof check.name !== 'string' ||
        names.has(check.name) ||
        typeof check.sourceConnectionVerified !== 'boolean' ||
        typeof check.forbiddenBridgeObserved !== 'boolean'
      ) {
        return false
      }
      names.add(check.name)
    }
    return (
      names.size === gate.topologyCheckNames.length &&
      gate.topologyCheckNames.every((name) => names.has(name))
    )
  } catch {
    return false
  }
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
  evidence: Readonly<FlowingContoursReferenceGateEvidence>,
): readonly FlowingContoursReferenceGateFinding[] {
  const gate = FLOWING_CONTOURS_REFERENCE_GATES[name]
  if (gate === undefined || !hasFiniteMetricInventory(metrics)) {
    return Object.freeze(['invalid-metrics'])
  }
  if (!validGateEvidence(gate, metrics, evidence)) {
    return Object.freeze(['invalid-evidence'])
  }
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
  if (
    metrics.totalUnsupportedSpanLength >
    gate.maximumTotalUnsupportedSpanLength
  ) findings.push('total-unsupported-span')
  if (
    metrics.totalAcceptedTrajectoryLength > 0 &&
    metrics.totalUnsupportedSpanLength /
      metrics.totalAcceptedTrajectoryLength >
      gate.maximumUnsupportedTravelRatio
  ) findings.push('unsupported-travel-ratio')
  if (
    evidence.geometry.primaryAxisPathCount >=
      gate.gridAxisPathCountFloor &&
    evidence.geometry.perpendicularAxisPathCount >=
      gate.gridAxisPathCountFloor &&
    evidence.geometry.primaryAxisLengthShare >=
      gate.minimumGridAxisLengthShare &&
    evidence.geometry.perpendicularAxisLengthShare >=
      gate.minimumGridAxisLengthShare
  ) findings.push('orthogonal-grid-family')
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
  const topology = new Map(
    evidence.topology.map((check) => [check.name, check]),
  )
  for (const checkName of gate.topologyCheckNames) {
    const check = topology.get(checkName)!
    if (
      !check.sourceConnectionVerified ||
      check.forbiddenBridgeObserved
    ) {
      findings.push(`topology:${checkName}`)
    }
  }
  return Object.freeze(findings)
}
