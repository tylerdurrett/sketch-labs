import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { createRasterContainFit } from '../rasterSampling'
import type { CoordinateSpace } from '../scene'
import { cleanupPencilContourPaths } from '../sketches/pencil-contour/cleanup'
import type { PencilContourControls } from '../sketches/pencil-contour/controls'
import { localizePencilContourEdges } from '../sketches/pencil-contour/edges'
import { prunePencilContourGraph } from '../sketches/pencil-contour/fragment-pruning'
import { tracePencilContourEdges } from '../sketches/pencil-contour/tracing'
import type { AnalyzedRaster } from '../sketches/pencil-contour/types'
import { extractWatercolorSharedBoundaries } from '../sketches/watercolor-forms/boundaries'
import type { WatercolorFormsControls } from '../sketches/watercolor-forms/controls'
import { fitWatercolorBoundaryCurves } from '../sketches/watercolor-forms/curves'
import { selectWatercolorForms } from '../sketches/watercolor-forms/forms'
import { buildWatercolorFormsHierarchyWithDiagnostics } from '../sketches/watercolor-forms/hierarchy'
import { WATERCOLOR_FORMS_LIMITS } from '../sketches/watercolor-forms/limits'
import { partitionWatercolorFormsRaster } from '../sketches/watercolor-forms/partition'
import { traceWatercolorBoundaryNetwork } from '../sketches/watercolor-forms/tracing'
import type {
  PreparedWatercolorRaster,
  WatercolorFormsDiagnostics,
} from '../sketches/watercolor-forms/types'
import {
  pencilContourReferenceMetrics,
  REFERENCE_LENGTH_NORMALIZATION,
  REFERENCE_LONG_PATH_MINIMUM_NORMALIZED_LENGTH,
  REFERENCE_SHORT_PATH_MAXIMUM_NORMALIZED_LENGTH,
  watercolorFormsReferenceMetrics,
  type ReferenceMetrics,
} from './helpers/watercolorFormsReferenceMetrics'

const REPOSITORY_ROOT = fileURLToPath(
  new URL('../../../../', import.meta.url),
).replace(/\/$/, '')
const REFERENCE_ROOT =
  'packages/core/src/sketches/watercolor-forms/reference'
const FIXTURE_ROOT = 'packages/core/src/__tests__/fixtures'
const TUNING_COMMIT = 'f567708cd04b2771bdcccde9965fc738d63bf1d4'
const FIXTURE_COMMIT = 'c793c507359373262dc87aae301d0b4efe554515'
const ARTIFACT_COMMIT = 'f6b6e5c7353d703be3491b44c746c2a9622abf5e'
const ATTESTATION_COMMIT =
  'f67c2b3dbe95900e2663efc83f52b8f80a8ab1fc'
const PENCIL_REVISION = 'b6147366448d37021e20d48326045a6cba3039ca'
const README_SHA256 =
  '05d443161b52be1fb8429e7bc562c581a7fc98deb675d89ef78f968425c05744'
const FIXTURE_BUNDLE_SHA256 =
  '9525d28ae232f9dcac8ef93d8226997f92a5ba068d8e4971a4a5d04dd0107901'
const WATERCOLOR_PRODUCTION_SHA256 =
  'a7df972f6da99bacdf87dff48fe28ca6876589cd8201a138a9a94db1ff8b368c'
const PENCIL_PRODUCTION_SHA256 =
  '136cb6800aef6c31bcc7a8422568cb61dc9db7c235986fa60bed85c7a103e5f5'
const SHA256_ALGORITHM = 'sha256(path + NUL + bytes + NUL), paths sorted'
const FLOAT64_BYTES = 8
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const ISO_UTC_PATTERN = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/

const FRAME = Object.freeze({ width: 1000, height: 1000 })
const WATERCOLOR_CONTROLS = Object.freeze({
  formDetail: 0.5,
  colorSensitivity: 0.5,
  boundaryStrength: 0.5,
  boundarySmoothing: 0.5,
})
const PENCIL_CONTROLS = Object.freeze({
  gamma: 0.5,
  contrast: 0.5,
  pivot: 0.5,
  contourDetail: 0.5,
  contourSmoothing: 1,
})
const WATER_COLOR_PLANES = Object.freeze([
  'linearRed',
  'linearGreen',
  'linearBlue',
  'luminance',
  'alpha',
  'positiveSupport',
])
const PENCIL_PLANES = Object.freeze([
  'luminance',
  'alpha',
  'positiveSupport',
])
const WATERCOLOR_PRODUCTION_PATHS = Object.freeze(
  [
    'analysis',
    'boundaries',
    'controls',
    'curves',
    'forms',
    'generator',
    'hierarchy',
    'index',
    'limits',
    'partition',
    'tracing',
    'types',
  ].map(
    (name) =>
      `packages/core/src/sketches/watercolor-forms/${name}.ts`,
  ),
)
const PENCIL_PRODUCTION_PATHS = Object.freeze(
  [
    'analysis',
    'cleanup',
    'controls',
    'curve-refinement',
    'edges',
    'fragment-pruning',
    'generator',
    'index',
    'topology',
    'tracing',
    'types',
  ].map(
    (name) => `packages/core/src/sketches/pencil-contour/${name}.ts`,
  ),
)
const FIXTURE_PATHS = Object.freeze(
  ['pencil-contour', 'watercolor-forms'].flatMap((pipeline) =>
    ['flower', 'pinecone'].flatMap((name) => {
      const suffix =
        pipeline === 'watercolor-forms' ? 'prepared' : 'analysis'
      return ['f64le', 'json'].map(
        (extension) =>
          `${FIXTURE_ROOT}/${pipeline}/${name}-${suffix}.${extension}`,
      )
    }),
  ),
)

const CASE_IDENTITIES = Object.freeze({
  flower: Object.freeze({
    source: Object.freeze({
      assetId: 'img-0672-79d639daec62',
      repositoryPath: 'assets/image-assets/img-0672-79d639daec62.png',
      sha256:
        '79d639daec62a2af4a59954b9d102e51ff30d11cd14246fffc52a53250858a7d',
      decodedWidth: 1536,
      decodedHeight: 2048,
    }),
    analysis: Object.freeze({
      width: 192,
      height: 256,
      sampleCount: 49_152,
    }),
    crop: Object.freeze({ x: 250, y: 40, width: 500, height: 500 }),
    watercolorBinarySha256:
      '96566d85d6f3deb1775359a1cf5d702f00b32e83e34ede933090af9f74c35b29',
    watercolorMetadataSha256:
      '6f9d2a99632a39bb2c7945e8a03414b6cb163887009f33835f82d9b59a7538fd',
    pencilBinarySha256:
      '4f5b3585da7214c2ac1ab848f094e0c155f1dbed96430128a4a1cc0a6a7c13b5',
    pencilMetadataSha256:
      '7da9a8b51935d948ae3007f3cedf0ea1ab2edb1fdafdcbfd0899766bd073a087',
    pencilFixtureRevision: '85b4d854d29ec2ac27bf1b8016bc263fec3ccd43',
    pencilGeometrySha256:
      'd50eff09aa829042df2b1aa5bc7e9bb2df35d27bbad67e3acbb176a024f71bec',
    pngs: Object.freeze({
      'flower-full-frame-comparison.png':
        '916014a0836f16d8b68c461b4ee1b275db70dd349abad30075ec6f240375c6f0',
      'flower-dense-detail-comparison.png':
        '771c6caeef0a79566d91e3cb79ed17fde91d8d8b06fcc1272bac9867c9900496',
    }),
  }),
  pinecone: Object.freeze({
    source: Object.freeze({
      assetId: 'pinecone-4330aa0314f7',
      repositoryPath: 'assets/image-assets/pinecone-4330aa0314f7.png',
      sha256:
        '4330aa0314f7b0acb150c7c22eab41e2a15008a04a3a17dd54cc1df03ac32c79',
      decodedWidth: 512,
      decodedHeight: 768,
    }),
    analysis: Object.freeze({
      width: 171,
      height: 256,
      sampleCount: 43_776,
    }),
    crop: Object.freeze({ x: 200, y: 180, width: 600, height: 600 }),
    watercolorBinarySha256:
      'fc5dfd6b9e2b08b7a974aa6355d65a3ed95ef3e180e5224a10d228707b7b5619',
    watercolorMetadataSha256:
      'f04f4daf34ce89ec3e395d3d945dda2b744460e4f271663a0884d5933c3c70df',
    pencilBinarySha256:
      '6fce17db851aebe835316e6c898f035070a0ebcd3e8dcc12a000c163b0eab004',
    pencilMetadataSha256:
      'f5b8f502a7c352e1eea1fc81973354a512ba2a830153589e4a8127395d4cc716',
    pencilFixtureRevision: 'd4c3c05c0ea0574e0f17677f7db471c34942ae24',
    pencilGeometrySha256:
      '8f23638a1a24f600590d360b4ebca3d710a59ad45d3bd7a5334434a2e33a42cb',
    pngs: Object.freeze({
      'pinecone-full-frame-comparison.png':
        '90e76499046a1f0740b0e1159726efc5f929a4706b6bef1ebb4fe08ed8872686',
      'pinecone-dense-detail-comparison.png':
        '55c90f63c8298ee057bdfee4ed18fb47a2ec9cd19451dbb6e38d5bdf4e4d9469',
    }),
  }),
})

type CaseName = keyof typeof CASE_IDENTITIES

interface FixtureMetadata<Controls> {
  readonly formatVersion: number
  readonly fixtureStatus?: string
  readonly preparedFromCommit?: string
  readonly productionBaseline?: string
  readonly preparationVersion?: string
  readonly source: (typeof CASE_IDENTITIES)[CaseName]['source']
  readonly frame: Readonly<CoordinateSpace>
  readonly controls: Readonly<Controls>
  readonly analysis: {
    readonly width: number
    readonly height: number
    readonly sampleCount: number
  }
  readonly encoding: {
    readonly byteOrder: string
    readonly valueType: string
    readonly planes: readonly {
      readonly name: string
      readonly offsetBytes: number
      readonly valueCount: number
      readonly values?: string
    }[]
  }
  readonly fixtureSha256: string
}

interface GeometryPath {
  readonly points: readonly (readonly [number, number])[]
  readonly closed: boolean
}

function repositoryBytes(path: string): Buffer {
  return readFileSync(`${REPOSITORY_ROOT}/${path}`)
}

function sha256(bytes: string | NodeJS.ArrayBufferView): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha256Files(paths: readonly string[]): string {
  const hash = createHash('sha256')
  for (const path of paths.slice().sort()) {
    hash.update(path)
    hash.update('\0')
    hash.update(repositoryBytes(path))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function git(args: readonly string[], encoding: 'buffer'): Buffer
function git(args: readonly string[], encoding?: 'utf8'): string
function git(
  args: readonly string[],
  encoding: 'buffer' | 'utf8' = 'utf8',
): Buffer | string {
  return execFileSync('git', args, {
    cwd: REPOSITORY_ROOT,
    encoding: encoding === 'buffer' ? 'buffer' : 'utf8',
  })
}

function expectAncestor(ancestor: string, descendant: string): void {
  expect(() =>
    git(['merge-base', '--is-ancestor', ancestor, descendant]),
  ).not.toThrow()
}

function fixturePath(
  pipeline: 'watercolor-forms' | 'pencil-contour',
  name: CaseName,
  extension: 'json' | 'f64le',
): string {
  const suffix = pipeline === 'watercolor-forms' ? 'prepared' : 'analysis'
  return `${FIXTURE_ROOT}/${pipeline}/${name}-${suffix}.${extension}`
}

function fixture<Controls>(
  pipeline: 'watercolor-forms' | 'pencil-contour',
  name: CaseName,
): {
  readonly metadata: Readonly<FixtureMetadata<Controls>>
  readonly metadataBytes: Buffer
  readonly binaryBytes: Buffer
  readonly planes: readonly (readonly number[])[]
} {
  const metadataBytes = repositoryBytes(fixturePath(pipeline, name, 'json'))
  const binaryBytes = repositoryBytes(fixturePath(pipeline, name, 'f64le'))
  const metadata = JSON.parse(
    metadataBytes.toString('utf8'),
  ) as FixtureMetadata<Controls>
  const planeNames =
    pipeline === 'watercolor-forms' ? WATER_COLOR_PLANES : PENCIL_PLANES
  const sampleCount = metadata.analysis.sampleCount
  expect(metadata.encoding).toEqual({
    byteOrder: 'little-endian',
    valueType: 'float64',
    planes: planeNames.map((planeName, index) => ({
      name: planeName,
      offsetBytes: index * sampleCount * FLOAT64_BYTES,
      valueCount: sampleCount,
      ...(planeName === 'positiveSupport'
        ? { values: '0=false, 1=true' }
        : {}),
    })),
  })
  expect(binaryBytes.byteLength).toBe(
    planeNames.length * sampleCount * FLOAT64_BYTES,
  )
  const view = new DataView(
    binaryBytes.buffer,
    binaryBytes.byteOffset,
    binaryBytes.byteLength,
  )
  const planes = planeNames.map((_, planeIndex) =>
    Object.freeze(
      Array.from({ length: sampleCount }, (_, index) =>
        view.getFloat64(
          (planeIndex * sampleCount + index) * FLOAT64_BYTES,
          true,
        ),
      ),
    ),
  )
  expect(planes.at(-1)!.every((value) => value === 0 || value === 1)).toBe(
    true,
  )
  return { metadata, metadataBytes, binaryBytes, planes }
}

function loadCase(name: CaseName) {
  const watercolor = fixture<WatercolorFormsControls>(
    'watercolor-forms',
    name,
  )
  const pencil = fixture<PencilContourControls>('pencil-contour', name)
  const watercolorRaster: Readonly<PreparedWatercolorRaster> = Object.freeze({
    sourceWidth: watercolor.metadata.source.decodedWidth,
    sourceHeight: watercolor.metadata.source.decodedHeight,
    width: watercolor.metadata.analysis.width,
    height: watercolor.metadata.analysis.height,
    linearRed: watercolor.planes[0]!,
    linearGreen: watercolor.planes[1]!,
    linearBlue: watercolor.planes[2]!,
    luminance: watercolor.planes[3]!,
    alpha: watercolor.planes[4]!,
    positiveSupport: Object.freeze(
      watercolor.planes[5]!.map((value) => value === 1),
    ),
  })
  const pencilRaster: Readonly<AnalyzedRaster> = Object.freeze({
    sourceWidth: pencil.metadata.source.decodedWidth,
    sourceHeight: pencil.metadata.source.decodedHeight,
    width: pencil.metadata.analysis.width,
    height: pencil.metadata.analysis.height,
    luminance: pencil.planes[0]!,
    alpha: pencil.planes[1]!,
    positiveSupport: Object.freeze(
      pencil.planes[2]!.map((value) => value === 1),
    ),
  })
  return { name, watercolor, pencil, watercolorRaster, pencilRaster }
}

function geometryIdentity(paths: readonly Readonly<GeometryPath>[]) {
  return {
    sha256: sha256(JSON.stringify(paths)),
    primitiveCount: paths.length,
    pointCount: paths.reduce((total, path) => total + path.points.length, 0),
  }
}

function watercolorRecomputation(reference: ReturnType<typeof loadCase>) {
  const { watercolorRaster: raster } = reference
  const controls = reference.watercolor.metadata.controls
  const partition = partitionWatercolorFormsRaster(raster)
  const hierarchyResult = buildWatercolorFormsHierarchyWithDiagnostics(
    partition,
    controls.colorSensitivity,
  )
  const hierarchy = hierarchyResult.hierarchy
  const forms = selectWatercolorForms(hierarchy, controls.formDetail)
  const boundaries = extractWatercolorSharedBoundaries(
    forms,
    controls.boundaryStrength,
  )
  const traced = traceWatercolorBoundaryNetwork(
    boundaries.sharedBoundarySegments,
  )
  const curves = fitWatercolorBoundaryCurves(
    traced.paths,
    controls.boundarySmoothing,
    {
      latticeWidth: raster.width,
      latticeHeight: raster.height,
      positiveSupport: raster.positiveSupport,
    },
  ).slice(0, WATERCOLOR_FORMS_LIMITS.maxPrimitiveCount)
  const fit = createRasterContainFit(
    { width: raster.sourceWidth, height: raster.sourceHeight },
    reference.watercolor.metadata.frame,
  )
  expect(fit).not.toBeNull()
  const geometry = curves.map(
    (curve): GeometryPath => ({
      points: curve.points.map(
        ([x, y]) =>
          [
            fit!.left + (x / raster.width) * fit!.fittedWidth,
            fit!.top + (y / raster.height) * fit!.fittedHeight,
          ] as const,
      ),
      closed: curve.closed,
    }),
  )
  const bins = new Set(
    geometry.flatMap((path) =>
      path.points.map(([x, y]) => {
        const column = Math.min(
          3,
          Math.max(0, Math.floor(((x - fit!.left) / fit!.fittedWidth) * 4)),
        )
        const row = Math.min(
          3,
          Math.max(0, Math.floor(((y - fit!.top) / fit!.fittedHeight) * 4)),
        )
        return `${column},${row}`
      }),
    ),
  )
  const samplesByForm = new Map<number, number>()
  for (const regionId of forms.regionBySample) {
    if (regionId < 0) continue
    samplesByForm.set(regionId, (samplesByForm.get(regionId) ?? 0) + 1)
  }
  let totalLength = 0
  let axisAlignedLength = 0
  for (const path of geometry) {
    const segmentCount = path.closed
      ? path.points.length
      : Math.max(0, path.points.length - 1)
    for (let index = 0; index < segmentCount; index += 1) {
      const first = path.points[index]!
      const second = path.points[(index + 1) % path.points.length]!
      const dx = second[0] - first[0]
      const dy = second[1] - first[1]
      const length = Math.hypot(dx, dy)
      totalLength += length
      if (dx === 0 || dy === 0) axisAlignedLength += length
    }
  }
  const curveProfiles = geometry.map((path) => {
    const xs = path.points.map(([x]) => (x - fit!.left) / fit!.fittedWidth)
    const ys = path.points.map(([, y]) => (y - fit!.top) / fit!.fittedHeight)
    return {
      closed: path.closed,
      centroid: [
        xs.reduce((sum, value) => sum + value, 0) / xs.length,
        ys.reduce((sum, value) => sum + value, 0) / ys.length,
      ] as const,
      bounds: [
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs),
        Math.max(...ys),
      ] as const,
    }
  })
  const diagnostics: Readonly<WatercolorFormsDiagnostics> = {
    termination:
      hierarchy.complete && traced.diagnostics.termination === 'complete'
        ? 'complete'
        : 'limit-reached',
    limitedBy:
      hierarchyResult.diagnostics.limitedBy ??
      traced.diagnostics.limitedBy ??
      null,
    analysisWidth: raster.width,
    analysisHeight: raster.height,
    sampleCount: raster.width * raster.height,
    initialRegionCount: partition.regions.length,
    gridAdjacencyCount:
      raster.width * Math.max(0, raster.height - 1) +
      raster.height * Math.max(0, raster.width - 1),
    mergeCount: hierarchy.merges.length,
    mergeQueueEntryCount:
      hierarchyResult.diagnostics.mergeQueueEntryCount,
    regionUpdateCount: hierarchyResult.diagnostics.regionUpdateCount,
    selectedRegionCount: forms.regionIds.length,
    retainedBoundarySegmentCount: boundaries.sharedBoundarySegments.length,
    boundaryPathCount: traced.paths.length,
    curvePointCount: curves.reduce(
      (total, curve) => total + curve.points.length,
      0,
    ),
    primitiveCount: geometry.length,
  }
  return {
    geometry,
    geometryIdentity: geometryIdentity(geometry),
    diagnostics,
    coverage: {
      occupiedBins: [...bins].sort(),
      occupiedBinCount: bins.size,
      centralBinCount: ['1,1', '2,1', '1,2', '2,2'].filter((bin) =>
        bins.has(bin),
      ).length,
      occupiedColumnCount: new Set([...bins].map((bin) => bin[0])).size,
      occupiedRowCount: new Set([...bins].map((bin) => bin[2])).size,
    },
    gates: {
      selectedFormCount: forms.regionIds.length,
      largestSelectedFormShare:
        Math.max(0, ...samplesByForm.values()) /
        raster.positiveSupport.filter(Boolean).length,
      retainedBoundarySegmentCount: boundaries.sharedBoundarySegments.length,
      axisAlignedLengthShare:
        totalLength === 0 ? 1 : axisAlignedLength / totalLength,
      curveProfiles,
    },
  }
}

function pencilGeometry(reference: ReturnType<typeof loadCase>) {
  const raster = reference.pencilRaster
  const controls = reference.pencil.metadata.controls
  const localized = localizePencilContourEdges(
    raster,
    controls.contourDetail,
  )
  const graph = prunePencilContourGraph(
    localized,
    controls.contourDetail,
    controls.contourSmoothing,
  )
  const paths = cleanupPencilContourPaths({
    paths: tracePencilContourEdges(graph),
    graph,
    detail: controls.contourDetail,
    smoothing: controls.contourSmoothing,
    fragmentsPrunedBeforeTracing: true,
  })
  const fit = createRasterContainFit(
    { width: raster.sourceWidth, height: raster.sourceHeight },
    reference.pencil.metadata.frame,
  )
  expect(fit).not.toBeNull()
  return paths.map(
    (path): GeometryPath => ({
      points: path.points.map(
        ([x, y]) =>
          [
            fit!.left + ((x + 0.5) / graph.width) * fit!.fittedWidth,
            fit!.top + ((y + 0.5) / graph.height) * fit!.fittedHeight,
          ] as const,
      ),
      closed: path.closed,
    }),
  )
}

function expectMetrics(
  actual: Readonly<ReferenceMetrics>,
  recorded: Readonly<ReferenceMetrics>,
): void {
  expect(actual.definitions.lengthNormalization).toBe(
    recorded.definitions.lengthNormalization,
  )
  expect(actual.definitions.shortPathMaximumNormalizedLength).toBe(
    recorded.definitions.shortPathMaximumNormalizedLength,
  )
  expect(actual.definitions.longPathMinimumNormalizedLength).toBe(
    recorded.definitions.longPathMinimumNormalizedLength,
  )
  expect(actual.definitions.fittedImageDiagonal).toBeCloseTo(
    recorded.definitions.fittedImageDiagonal,
    12,
  )
  expect(actual.pathCount).toBe(recorded.pathCount)
  expect(actual.shortPathShare).toBeCloseTo(recorded.shortPathShare, 14)
  expect(actual.medianNormalizedPathLength).toBeCloseTo(
    recorded.medianNormalizedPathLength,
    14,
  )
  expect(actual.longPathShareOfTotalGeometry).toBeCloseTo(
    recorded.longPathShareOfTotalGeometry,
    14,
  )
  expect(actual.closedFormCount).toBe(recorded.closedFormCount)
  expect(actual.totalPlottedLength).toBeCloseTo(
    recorded.totalPlottedLength,
    8,
  )
}

function selectedFormCount(
  reference: ReturnType<typeof loadCase>,
  formDetail: number,
  colorSensitivity: number,
): number {
  const partition = partitionWatercolorFormsRaster(
    reference.watercolorRaster,
  )
  const hierarchy = buildWatercolorFormsHierarchyWithDiagnostics(
    partition,
    colorSensitivity,
  ).hierarchy
  return selectWatercolorForms(hierarchy, formDetail).regionIds.length
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  expect([...bytes.subarray(0, 8)]).toEqual([
    137, 80, 78, 71, 13, 10, 26, 10,
  ])
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR')
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  }
}

const manifest = JSON.parse(
  repositoryBytes(`${REFERENCE_ROOT}/manifest.json`).toString('utf8'),
)
const attestation = JSON.parse(
  repositoryBytes(`${REFERENCE_ROOT}/review-attestation.json`).toString(
    'utf8',
  ),
)

describe('Watercolor Forms exact reference evidence', () => {
  it('binds exact production, fixture, artifact, and attestation lineage', () => {
    for (const commit of [
      TUNING_COMMIT,
      FIXTURE_COMMIT,
      ARTIFACT_COMMIT,
      ATTESTATION_COMMIT,
      PENCIL_REVISION,
    ]) {
      expect(commit).toMatch(COMMIT_PATTERN)
      expect(git(['rev-parse', '--verify', `${commit}^{commit}`]).trim()).toBe(
        commit,
      )
    }
    expectAncestor(PENCIL_REVISION, TUNING_COMMIT)
    expectAncestor(TUNING_COMMIT, FIXTURE_COMMIT)
    expectAncestor(FIXTURE_COMMIT, ARTIFACT_COMMIT)
    expectAncestor(ARTIFACT_COMMIT, ATTESTATION_COMMIT)
    expectAncestor(ATTESTATION_COMMIT, 'HEAD')
    expect(git(['show', '-s', '--format=%P', ARTIFACT_COMMIT]).trim()).toBe(
      FIXTURE_COMMIT,
    )
    expect(
      git(['show', '-s', '--format=%P', ATTESTATION_COMMIT]).trim(),
    ).toBe(ARTIFACT_COMMIT)
    expect(
      git([
        'log',
        '-1',
        '--format=%H',
        '--',
        `${REFERENCE_ROOT}/review-attestation.json`,
      ]).trim(),
    ).toBe(ATTESTATION_COMMIT)

    expect(manifest.provenance).toMatchObject({
      tuningCommit: TUNING_COMMIT,
      fixtureCommit: FIXTURE_COMMIT,
      watercolorProduction: {
        algorithm: SHA256_ALGORITHM,
        paths: WATERCOLOR_PRODUCTION_PATHS,
        sha256: WATERCOLOR_PRODUCTION_SHA256,
      },
      pencilProduction: {
        revision: PENCIL_REVISION,
        algorithm: SHA256_ALGORITHM,
        paths: PENCIL_PRODUCTION_PATHS,
        sha256: PENCIL_PRODUCTION_SHA256,
      },
      fixtures: {
        paths: FIXTURE_PATHS,
        sha256: FIXTURE_BUNDLE_SHA256,
      },
    })
    expect(sha256Files(WATERCOLOR_PRODUCTION_PATHS)).toBe(
      WATERCOLOR_PRODUCTION_SHA256,
    )
    expect(sha256Files(PENCIL_PRODUCTION_PATHS)).toBe(
      PENCIL_PRODUCTION_SHA256,
    )
    expect(sha256Files(FIXTURE_PATHS)).toBe(FIXTURE_BUNDLE_SHA256)
    expect(
      git([
        'diff',
        '--name-only',
        TUNING_COMMIT,
        '--',
        ...WATERCOLOR_PRODUCTION_PATHS,
      ]).trim(),
    ).toBe('')
    expect(
      git([
        'diff',
        '--name-only',
        PENCIL_REVISION,
        '--',
        ...PENCIL_PRODUCTION_PATHS,
      ]).trim(),
    ).toBe('')
    expect(
      git([
        'diff',
        '--name-only',
        FIXTURE_COMMIT,
        '--',
        ...FIXTURE_PATHS,
      ]).trim(),
    ).toBe('')

    for (const path of [
      'README.md',
      'manifest.json',
      ...Object.values(CASE_IDENTITIES).flatMap(({ pngs }) =>
        Object.keys(pngs),
      ),
    ]) {
      expect(
        git(
          ['show', `${ARTIFACT_COMMIT}:${REFERENCE_ROOT}/${path}`],
          'buffer',
        ),
      ).toEqual(repositoryBytes(`${REFERENCE_ROOT}/${path}`))
    }
    expect(
      git(
        [
          'show',
          `${ATTESTATION_COMMIT}:${REFERENCE_ROOT}/review-attestation.json`,
        ],
        'buffer',
      ),
    ).toEqual(repositoryBytes(`${REFERENCE_ROOT}/review-attestation.json`))
  })

  it('pins the evidence schema, thresholds, settings, caps, and README commands', () => {
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      referenceId: 'watercolor-forms-pencil-comparison',
      status: 'generated-comparison-evidence-awaiting-independent-review',
      pencilComparison: {
        revision: PENCIL_REVISION,
        settings: PENCIL_CONTROLS,
      },
      metricDefinitions: {
        lengthNormalization: REFERENCE_LENGTH_NORMALIZATION,
        shortPathMaximumNormalizedLength:
          REFERENCE_SHORT_PATH_MAXIMUM_NORMALIZED_LENGTH,
        longPathMinimumNormalizedLength:
          REFERENCE_LONG_PATH_MINIMUM_NORMALIZED_LENGTH,
      },
      safetyCaps: WATERCOLOR_FORMS_LIMITS,
      review: {
        verdict: 'NOT-RECORDED',
        generatedAttestation: false,
        note: 'Generated evidence is not an independent visual-review verdict.',
      },
    })
    const readme = repositoryBytes(`${REFERENCE_ROOT}/README.md`)
    expect(sha256(readme)).toBe(README_SHA256)
    const commands = [
      ...readme
        .toString('utf8')
        .matchAll(/--(tuning|fixture)-commit ([0-9a-f]{40})(?:\s|$)/g),
    ].map((match) => [match[1], match[2]])
    expect(commands).toEqual([
      ['tuning', TUNING_COMMIT],
      ['fixture', FIXTURE_COMMIT],
    ])
    expect(readme.toString('utf8')).toContain(
      'node apps/studio/scripts/capture-watercolor-forms-reference.mjs \\\n  --scope evidence',
    )
    expect(readme.toString('utf8')).toContain(
      'node apps/studio/scripts/capture-watercolor-forms-reference.mjs \\\n  --scope evidence\n',
    )
    expect(readme.toString('utf8')).toContain(
      'The verify command recomputes the decoded rasters, production Scenes, metrics,\ndiagnostics, geometry hashes, and PNG bytes',
    )
  })

  it.each(['flower', 'pinecone'] as const)(
    '%s fixtures reproduce exact metrics, geometry, diagnostics, coverage, and gates',
    (name) => {
      const identity = CASE_IDENTITIES[name]
      const reference = loadCase(name)
      const watercolorMetadata = reference.watercolor.metadata
      const pencilMetadata = reference.pencil.metadata
      const recorded = manifest.cases[name]

      expect(sha256(repositoryBytes(identity.source.repositoryPath))).toBe(
        identity.source.sha256,
      )
      expect(watercolorMetadata).toMatchObject({
        formatVersion: 1,
        fixtureStatus: 'provisional',
        preparedFromCommit: TUNING_COMMIT,
        preparationVersion: 'watercolor-forms-prepared-raster-v1',
        source: identity.source,
        frame: FRAME,
        controls: WATERCOLOR_CONTROLS,
        analysis: identity.analysis,
      })
      expect(pencilMetadata).toMatchObject({
        source: identity.source,
        frame: FRAME,
        controls: PENCIL_CONTROLS,
        analysis: identity.analysis,
      })
      expect(
        pencilMetadata.preparedFromCommit ??
          pencilMetadata.productionBaseline,
      ).toBe(identity.pencilFixtureRevision)
      expect(sha256(reference.watercolor.binaryBytes)).toBe(
        identity.watercolorBinarySha256,
      )
      expect(reference.watercolor.metadata.fixtureSha256).toBe(
        identity.watercolorBinarySha256,
      )
      expect(sha256(reference.watercolor.metadataBytes)).toBe(
        identity.watercolorMetadataSha256,
      )
      expect(sha256(reference.pencil.binaryBytes)).toBe(
        identity.pencilBinarySha256,
      )
      expect(reference.pencil.metadata.fixtureSha256).toBe(
        identity.pencilBinarySha256,
      )
      expect(sha256(reference.pencil.metadataBytes)).toBe(
        identity.pencilMetadataSha256,
      )
      expect(recorded).toMatchObject({
        source: identity.source,
        frame: FRAME,
        controls: {
          watercolor: WATERCOLOR_CONTROLS,
          pencil: PENCIL_CONTROLS,
        },
        cropRects: {
          fullFrame: { x: 0, y: 0, width: 1000, height: 1000 },
          denseDetail: identity.crop,
        },
      })
      for (const [pipeline, expected] of [
        ['watercolor', reference.watercolor],
        ['pencil', reference.pencil],
      ] as const) {
        expect(recorded.fixtures[pipeline]).toEqual({
          file: fixturePath(
            pipeline === 'watercolor' ? 'watercolor-forms' : 'pencil-contour',
            name,
            'f64le',
          ),
          metadataFile: fixturePath(
            pipeline === 'watercolor' ? 'watercolor-forms' : 'pencil-contour',
            name,
            'json',
          ),
          fixtureSha256: expected.metadata.fixtureSha256,
          metadataSha256: sha256(expected.metadataBytes),
          preparedFromCommit:
            expected.metadata.preparedFromCommit ??
            expected.metadata.productionBaseline,
          preparationVersion:
            expected.metadata.preparationVersion ?? 'pencil-contour-v2',
          analysis: expected.metadata.analysis,
          source: expected.metadata.source,
          controls: expected.metadata.controls,
        })
      }

      const watercolorInput = {
        raster: reference.watercolorRaster,
        controls: watercolorMetadata.controls,
        frame: watercolorMetadata.frame,
      }
      const pencilInput = {
        raster: reference.pencilRaster,
        controls: pencilMetadata.controls,
        frame: pencilMetadata.frame,
      }
      const watercolorMetrics =
        watercolorFormsReferenceMetrics(watercolorInput)
      const pencilMetrics = pencilContourReferenceMetrics(pencilInput)
      expectMetrics(watercolorMetrics, recorded.metrics.watercolor)
      expectMetrics(pencilMetrics, recorded.metrics.pencil)

      const watercolor = watercolorRecomputation(reference)
      const pencil = pencilGeometry(reference)
      expect(watercolor.geometryIdentity).toEqual(
        recorded.geometry.watercolor,
      )
      /*
       * Pencil's curve refinement crosses the Node/Chrome floating-runtime
       * boundary. Fixture replay is authoritative for topology, inventory, and
       * tolerance-bound metrics; the pinned production-browser no-write capture
       * is authoritative for its bit-exact coordinate hash and PNG bytes.
       */
      expect(recorded.geometry.pencil).toMatchObject({
        primitiveCount: pencil.length,
        pointCount: pencil.reduce(
          (total, path) => total + path.points.length,
          0,
        ),
      })
      expect(recorded.geometry.pencil.sha256).toBe(
        identity.pencilGeometrySha256,
      )
      expect(watercolor.diagnostics).toEqual(
        recorded.watercolorDiagnostics,
      )
      expect(watercolor.coverage).toEqual(recorded.watercolorCoverage)

      expect(watercolorMetrics.shortPathShare).toBeLessThan(
        pencilMetrics.shortPathShare,
      )
      expect(watercolorMetrics.medianNormalizedPathLength).toBeGreaterThan(
        pencilMetrics.medianNormalizedPathLength,
      )
      expect(
        watercolorMetrics.longPathShareOfTotalGeometry,
      ).toBeGreaterThan(pencilMetrics.longPathShareOfTotalGeometry)
      expect(watercolor.gates.selectedFormCount).toBeGreaterThanOrEqual(4)
      expect(watercolor.gates.largestSelectedFormShare).toBeLessThan(0.15)
      expect(
        selectedFormCount(reference, 0.35, WATERCOLOR_CONTROLS.colorSensitivity),
      ).toBeLessThan(watercolor.gates.selectedFormCount)
      const fineFormCount = selectedFormCount(
        reference,
        0.65,
        WATERCOLOR_CONTROLS.colorSensitivity,
      )
      expect(fineFormCount).toBeGreaterThan(
        watercolor.gates.selectedFormCount,
      )
      expect(fineFormCount).toBeLessThan(300)
      expect(
        selectedFormCount(reference, WATERCOLOR_CONTROLS.formDetail, 0.75),
      ).toBeGreaterThan(
        selectedFormCount(reference, WATERCOLOR_CONTROLS.formDetail, 0.25),
      )
      expect(watercolor.gates.retainedBoundarySegmentCount).toBeGreaterThan(
        Math.min(
          reference.watercolorRaster.width,
          reference.watercolorRaster.height,
        ) * 2,
      )
      expect(watercolor.geometry.length).toBe(watercolorMetrics.pathCount)
      expect(watercolor.geometry.length).toBeGreaterThanOrEqual(4)
      expect(watercolor.geometry.length).toBeLessThan(150)
      expect(watercolor.coverage.occupiedBinCount).toBeGreaterThanOrEqual(8)
      expect(watercolor.gates.axisAlignedLengthShare).toBeLessThan(0.1)

      if (name === 'flower') {
        expect(watercolor.coverage.centralBinCount).toBe(4)
        expect(watercolorMetrics.closedFormCount).toBeGreaterThanOrEqual(8)
        const details = watercolor.gates.curveProfiles.filter(
          ({ centroid, bounds }) =>
            centroid[0] >= 0.35 &&
            centroid[0] <= 0.65 &&
            centroid[1] >= 0.2 &&
            centroid[1] <= 0.34 &&
            bounds[2] - bounds[0] <= 0.2 &&
            bounds[3] - bounds[1] <= 0.18,
        )
        expect(details.length).toBeGreaterThanOrEqual(6)
        expect(details.some(({ centroid }) => centroid[0] < 0.46)).toBe(true)
        expect(details.some(({ centroid }) => centroid[0] > 0.54)).toBe(true)
        expect(details.some(({ centroid }) => centroid[1] > 0.27)).toBe(true)
        expect(
          details.some(
            ({ closed, centroid }) =>
              closed &&
              Math.hypot(centroid[0] - 0.5, centroid[1] - 0.25) < 0.06,
          ),
        ).toBe(true)
      } else {
        expect(watercolor.coverage.occupiedColumnCount).toBe(4)
        expect(watercolor.coverage.occupiedRowCount).toBe(4)
        expect(watercolorMetrics.closedFormCount).toBeGreaterThanOrEqual(2)
        for (const [minY, maxY] of [
          [0.2, 0.32],
          [0.32, 0.44],
          [0.44, 0.56],
          [0.56, 0.68],
          [0.68, 0.8],
        ]) {
          const rowForms = watercolor.gates.curveProfiles.filter(
            ({ centroid }) =>
              centroid[0] >= 0.23 &&
              centroid[0] <= 0.78 &&
              centroid[1] >= minY &&
              centroid[1] < maxY,
          )
          expect(rowForms.length).toBeGreaterThanOrEqual(8)
          expect(
            rowForms.filter(({ centroid }) => centroid[0] >= 0.55).length,
          ).toBeGreaterThanOrEqual(2)
        }
        const closed = watercolor.gates.curveProfiles.filter(
          ({ closed, centroid }) =>
            closed && centroid[0] >= 0.23 && centroid[0] <= 0.78,
        )
        expect(closed.some(({ centroid }) => centroid[1] < 0.35)).toBe(true)
        expect(closed.some(({ centroid }) => centroid[1] > 0.7)).toBe(true)
      }
    },
  )

  it('binds all four exact PNGs and the independent PASS attestation', () => {
    const expectedPngs = Object.assign(
      {},
      ...Object.values(CASE_IDENTITIES).map(({ pngs }) => pngs),
    )
    for (const [file, expectedHash] of Object.entries(expectedPngs)) {
      const bytes = repositoryBytes(`${REFERENCE_ROOT}/${file}`)
      expect(sha256(bytes)).toBe(expectedHash)
      expect(pngDimensions(bytes)).toEqual({ width: 2160, height: 1120 })
      const [name, kind] = file.split('-')
      const artifact =
        manifest.cases[name].artifacts[
          kind === 'full' ? 'fullFrame' : 'denseDetail'
        ]
      expect(artifact).toEqual({
        file,
        width: 2160,
        height: 1120,
        bytes: bytes.byteLength,
        sha256: expectedHash,
      })
    }

    expect(attestation).toMatchObject({
      schemaVersion: 1,
      referenceId: 'watercolor-forms-pencil-comparison',
      reviewer: {
        identifier: '/root/attest_wf18',
        role: 'independent WF18 artistic reviewer',
      },
      reviewedAt: '2026-07-23T06:07:54Z',
      artifactCommit: ARTIFACT_COMMIT,
      independence:
        'The reviewer did not implement the tuning or capture artifacts.',
      verdict: 'PASS',
      pngEvidence: expectedPngs,
      visualJudgmentStatement:
        'Metrics did not substitute for visual judgment; the PASS verdict depends on the named forms being visibly preserved in the committed PNG evidence.',
    })
    expect(attestation.reviewedAt).toMatch(ISO_UTC_PATTERN)
    const reviewedAt = Date.parse(attestation.reviewedAt)
    const artifactTime =
      Number(git(['show', '-s', '--format=%ct', ARTIFACT_COMMIT]).trim()) *
      1000
    const attestationTime =
      Number(git(['show', '-s', '--format=%ct', ATTESTATION_COMMIT]).trim()) *
      1000
    expect(reviewedAt).toBeGreaterThan(artifactTime)
    expect(reviewedAt).toBeLessThanOrEqual(attestationTime)
    expect(Object.keys(attestation.checks).sort()).toEqual(
      [
        'flowerCentralDisks',
        'flowerOverlapAndWatercolorability',
        'flowerPetalBoundaries',
        'noFalseFrameOrGrossClipping',
        'pineconeCompleteOuterSilhouette',
        'pineconeLayeredScaleRows',
        'pineconeScaleTipsAndInteriorForms',
        'shortStrokesDescribeFormsOrJunctions',
        'smootherThanRejectedArtifacts',
      ].sort(),
    )
    for (const check of Object.values(attestation.checks) as {
      pass: boolean
      observation: string
    }[]) {
      expect(check.pass).toBe(true)
      expect(check.observation.trim().length).toBeGreaterThan(20)
    }
    expect(attestation.visualJudgmentStatement).toMatch(
      /^Metrics did not substitute for visual judgment;/,
    )
  })
})
