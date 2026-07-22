import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  encodePencilContourAnalyzedRaster,
  pencilContourReferenceDiagnostics,
} from './helpers/pencilContourReferenceMetrics'
import type { AnalyzedRaster } from '../sketches/pencil-contour/types'

const FIXTURE_BINARY_URL = new URL(
  './fixtures/pencil-contour/flower-analysis.f64le',
  import.meta.url,
)
const FIXTURE_METADATA_URL = new URL(
  './fixtures/pencil-contour/flower-analysis.json',
  import.meta.url,
)
const FLOAT64_BYTES = 8

type ReferenceDiagnostics = ReturnType<typeof pencilContourReferenceDiagnostics>

interface ReferenceMetadata {
  readonly formatVersion: number
  readonly productionBaseline: string
  readonly source: {
    readonly assetId: string
    readonly repositoryPath: string
    readonly sha256: string
    readonly decodedWidth: number
    readonly decodedHeight: number
  }
  readonly frame: { readonly width: number; readonly height: number }
  readonly controls: {
    readonly gamma: number
    readonly contrast: number
    readonly pivot: number
    readonly contourDetail: number
    readonly contourSmoothing: number
  }
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
  readonly diagnostics: ReferenceDiagnostics
}

function referenceMetadata(): ReferenceMetadata {
  return JSON.parse(
    readFileSync(FIXTURE_METADATA_URL, 'utf8'),
  ) as ReferenceMetadata
}

function referenceRaster(
  bytes: Readonly<Buffer>,
  metadata: Readonly<ReferenceMetadata>,
): Readonly<AnalyzedRaster> {
  const { sampleCount, width, height } = metadata.analysis
  const expectedBytes = sampleCount * 3 * FLOAT64_BYTES
  expect(bytes.byteLength).toBe(expectedBytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const plane = (planeIndex: number) =>
    Array.from({ length: sampleCount }, (_, index) =>
      view.getFloat64((planeIndex * sampleCount + index) * FLOAT64_BYTES, true),
    )
  const supportValues = plane(2)
  expect(supportValues.every((value) => value === 0 || value === 1)).toBe(true)

  return Object.freeze({
    sourceWidth: metadata.source.decodedWidth,
    sourceHeight: metadata.source.decodedHeight,
    width,
    height,
    luminance: Object.freeze(plane(0)),
    alpha: Object.freeze(plane(1)),
    positiveSupport: Object.freeze(
      supportValues.map((supported) => supported === 1),
    ),
  })
}

function expectSmoothingDiagnosticsClose(
  actual: ReferenceDiagnostics['smoothing100'],
  expected: ReferenceDiagnostics['smoothing100'],
): void {
  expect({
    ...actual,
    bMedianPathLength: undefined,
    turnP95Degrees: undefined,
    turnFractionOver25Degrees: undefined,
    turnFractionOver45Degrees: undefined,
  }).toEqual({
    ...expected,
    bMedianPathLength: undefined,
    turnP95Degrees: undefined,
    turnFractionOver25Degrees: undefined,
    turnFractionOver45Degrees: undefined,
  })
  expect(actual.bMedianPathLength).toBeCloseTo(expected.bMedianPathLength, 12)
  expect(actual.turnP95Degrees).toBeCloseTo(expected.turnP95Degrees, 12)
  expect(actual.turnFractionOver25Degrees).toBeCloseTo(
    expected.turnFractionOver25Degrees,
    12,
  )
  expect(actual.turnFractionOver45Degrees).toBeCloseTo(
    expected.turnFractionOver45Degrees,
    12,
  )
}

describe('Pencil Contour flower downstream reference', () => {
  it('pins the browser-decoded AnalyzedRaster bytes and authored tuple', () => {
    const metadata = referenceMetadata()
    const bytes = readFileSync(FIXTURE_BINARY_URL)
    const raster = referenceRaster(bytes, metadata)

    expect(metadata).toMatchObject({
      formatVersion: 2,
      productionBaseline: '85b4d854d29ec2ac27bf1b8016bc263fec3ccd43',
      source: {
        assetId: 'img-0672-79d639daec62',
        repositoryPath: 'assets/image-assets/img-0672-79d639daec62.png',
        sha256:
          '79d639daec62a2af4a59954b9d102e51ff30d11cd14246fffc52a53250858a7d',
        decodedWidth: 1536,
        decodedHeight: 2048,
      },
      frame: { width: 1000, height: 1000 },
      controls: {
        gamma: 0.5,
        contrast: 0.5,
        pivot: 0.5,
        contourDetail: 0.5,
        contourSmoothing: 1,
      },
      analysis: { width: 192, height: 256, sampleCount: 49_152 },
      encoding: {
        byteOrder: 'little-endian',
        valueType: 'float64',
      },
    })
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      metadata.fixtureSha256,
    )
    expect(Buffer.from(encodePencilContourAnalyzedRaster(raster))).toEqual(
      bytes,
    )
  })

  it('reproduces compact candidate, fragment, turn, spatial, and geometry diagnostics', () => {
    const metadata = referenceMetadata()
    const bytes = readFileSync(FIXTURE_BINARY_URL)
    const raster = referenceRaster(bytes, metadata)
    const first = pencilContourReferenceDiagnostics(
      raster,
      metadata.controls.contourDetail,
    )
    expect(first.candidates).toEqual(metadata.diagnostics.candidates)
    expect(first.localizedEdgeCount).toBe(
      metadata.diagnostics.localizedEdgeCount,
    )
    expect(first.tracedPathCount).toBe(metadata.diagnostics.tracedPathCount)
    expect(first.sampling).toEqual(metadata.diagnostics.sampling)
    expect(first.smoothing050).toMatchObject({
      pathCount: 1_632,
      b2TwoPointOpenPaths: 540,
      b3PathsShorterThanThree: 1_143,
      sampledPathCount: 87,
    })
    expect(first.smoothing075).toMatchObject({
      pathCount: 1_493,
      b2TwoPointOpenPaths: 431,
      b3PathsShorterThanThree: 1_011,
      sampledPathCount: 87,
    })
    expect(first.smoothing100).toMatchObject({
      pathCount: 1_327,
      b2TwoPointOpenPaths: 319,
      b3PathsShorterThanThree: 862,
      sampledPathCount: 87,
    })
    expect(first.smoothing050.bMedianPathLength).toBeCloseTo(
      2.006288318519201,
      12,
    )
    expect(first.smoothing075.bMedianPathLength).toBeCloseTo(
      2.0874436678104935,
      12,
    )
    // The frozen diagnostics describe the combined pruning and high-smoothing
    // behavior. Chrome and Node can differ by a few final bits in Math.hypot.
    expectSmoothingDiagnosticsClose(
      first.smoothing075,
      metadata.diagnostics.smoothing075,
    )
    expectSmoothingDiagnosticsClose(
      first.smoothing100,
      metadata.diagnostics.smoothing100,
    )
    expect(first.smoothing100.occupiedLongPathBins).toEqual([
      '0,0', '0,1',
      '1,0', '1,1', '1,2', '1,3',
      '2,0', '2,1', '2,2', '2,3',
      '3,0', '3,1', '3,2', '3,3',
    ])
    expect(first.smoothing075.turnP95Degrees).toBeGreaterThan(1)
    expect(first.smoothing100.turnP95Degrees).toBeLessThanOrEqual(25)
    expect(first.smoothing100.turnP95Degrees).toBeLessThanOrEqual(
      first.smoothing075.turnP95Degrees * 0.85,
    )
    expect(first.smoothing100.turnFractionOver25Degrees).toBeLessThanOrEqual(
      0.05,
    )
    expect(first.smoothing100.turnFractionOver45Degrees).toBeLessThanOrEqual(
      0.01,
    )
    expect(first.smoothing100.bMedianPathLength).toBeGreaterThanOrEqual(
      first.smoothing075.bMedianPathLength * 0.98,
    )

    const { candidates } = first
    expect(candidates.afterStrengthFloor).toBe(22_557)
    expect(candidates.afterSelectionLimit).toBeLessThanOrEqual(
      candidates.afterStrengthFloor,
    )
    expect(candidates.afterDetailSelection).toBeLessThanOrEqual(
      candidates.afterSelectionLimit,
    )
    for (const smoothing of [
      first.smoothing050,
      first.smoothing075,
      first.smoothing100,
    ]) {
      expect(smoothing.geometryHash).toMatch(/^[0-9a-f]{16}$/)
      expect(smoothing.occupiedLongPathBins.length).toBeGreaterThan(0)
      expect(smoothing.sampledPointCount).toBeGreaterThan(
        smoothing.sampledPathCount,
      )
      expect(smoothing.turnCount).toBeGreaterThan(0)
    }
  })
})
