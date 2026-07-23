import { describe, expect, it } from 'vitest'

import type { PreparedFlowingContoursRaster } from '../sketches/flowing-contours/raster'
import {
  createFlowingContoursFixtureMetadata,
  decodeFlowingContoursPreparedRaster,
  encodeFlowingContoursPreparedRaster,
  flowingContoursFixtureSha256,
  FLOWING_CONTOURS_REFERENCE_CASES,
  FLOWING_CONTOURS_REFERENCE_COMPARATORS,
  FLOWING_CONTOURS_REFERENCE_CONTROLS,
  FLOWING_CONTOURS_REFERENCE_FRAME,
  FLOWING_CONTOURS_REFERENCE_REVISIONS,
  type FlowingContoursFixtureMetadata,
} from './helpers/flowingContoursReferenceCases'

const COMMIT_PATTERN = /^[0-9a-f]{40}$/

function preparedRaster(
  name: 'flower' | 'pinecone' = 'flower',
): Readonly<PreparedFlowingContoursRaster> {
  const source = FLOWING_CONTOURS_REFERENCE_CASES[name].source
  const analysis = FLOWING_CONTOURS_REFERENCE_CASES[name].analysis
  const values = Array.from(
    { length: analysis.sampleCount },
    (_, index) => (index % 101) / 100,
  )
  const alpha = values.map((value, index) => (index === 0 ? 0 : value || 1))
  return Object.freeze({
    sourceWidth: source.decodedWidth,
    sourceHeight: source.decodedHeight,
    width: analysis.width,
    height: analysis.height,
    luminance: Object.freeze(values),
    alpha: Object.freeze(alpha),
    positiveSupport: Object.freeze(
      alpha.map((sample) => sample > 0),
    ),
  })
}

function encodedFixture(name: 'flower' | 'pinecone' = 'flower') {
  const raster = preparedRaster(name)
  const bytes = encodeFlowingContoursPreparedRaster(raster)!
  const hash = flowingContoursFixtureSha256(bytes)!
  const metadata = createFlowingContoursFixtureMetadata(
    name,
    raster,
    hash,
  )!
  return { raster, bytes, metadata }
}

function withMetadata(
  metadata: Readonly<FlowingContoursFixtureMetadata>,
  update: Partial<FlowingContoursFixtureMetadata>,
): Readonly<FlowingContoursFixtureMetadata> {
  return { ...metadata, ...update }
}

describe('Flowing Contours prepared reference fixtures', () => {
  it('pins the exact source identities, frame, crops, and comparator revisions', () => {
    expect(FLOWING_CONTOURS_REFERENCE_FRAME).toEqual({
      width: 1000,
      height: 1000,
    })
    expect(FLOWING_CONTOURS_REFERENCE_CASES).toMatchObject({
      flower: {
        source: {
          assetId: 'img-0672-79d639daec62',
          repositoryPath:
            'assets/image-assets/img-0672-79d639daec62.png',
          sha256:
            '79d639daec62a2af4a59954b9d102e51ff30d11cd14246fffc52a53250858a7d',
          decodedWidth: 1536,
          decodedHeight: 2048,
        },
        analysis: { width: 192, height: 256, sampleCount: 49_152 },
        crops: {
          fullFrame: { x: 0, y: 0, width: 1000, height: 1000 },
          denseDetail: { x: 250, y: 40, width: 500, height: 500 },
        },
      },
      pinecone: {
        source: {
          assetId: 'pinecone-4330aa0314f7',
          repositoryPath:
            'assets/image-assets/pinecone-4330aa0314f7.png',
          sha256:
            '4330aa0314f7b0acb150c7c22eab41e2a15008a04a3a17dd54cc1df03ac32c79',
          decodedWidth: 512,
          decodedHeight: 768,
        },
        analysis: { width: 171, height: 256, sampleCount: 43_776 },
        crops: {
          fullFrame: { x: 0, y: 0, width: 1000, height: 1000 },
          denseDetail: { x: 200, y: 180, width: 600, height: 600 },
        },
      },
    })
    for (const revision of Object.values(
      FLOWING_CONTOURS_REFERENCE_REVISIONS,
    )) {
      expect(revision).toMatch(COMMIT_PATTERN)
    }
    expect(FLOWING_CONTOURS_REFERENCE_COMPARATORS).toEqual({
      pencilContour: {
        sketchId: 'pencil-contour',
        revision: 'b6147366448d37021e20d48326045a6cba3039ca',
        controls: {
          gamma: 0.5,
          contrast: 0.5,
          pivot: 0.5,
          contourDetail: 0.5,
          contourSmoothing: 1,
        },
      },
      watercolorForms: {
        sketchId: 'watercolor-forms',
        revision: '4d6f085706350fbf03a1da6f7c00721896c72fb4',
        controls: {
          gamma: 0.5,
          contrast: 0.5,
          pivot: 0.5,
          formDetail: 0.5,
          colorSensitivity: 0.5,
          boundaryStrength: 0.5,
          boundarySmoothing: 1,
        },
      },
    })
  })

  it.each(['flower', 'pinecone'] as const)(
    'round-trips the %s prepared raster through canonical Float64LE planes',
    (name) => {
      const { raster, bytes, metadata } = encodedFixture(name)
      const sampleCount = raster.width * raster.height

      expect(metadata).toMatchObject({
        formatVersion: 1,
        fixtureStatus: 'provisional',
        preparationVersion: 'flowing-contours-prepared-raster-v1',
        preparedFromCommit:
          FLOWING_CONTOURS_REFERENCE_REVISIONS.flowingContours,
        source: FLOWING_CONTOURS_REFERENCE_CASES[name].source,
        frame: FLOWING_CONTOURS_REFERENCE_FRAME,
        controls: FLOWING_CONTOURS_REFERENCE_CONTROLS,
        crops: FLOWING_CONTOURS_REFERENCE_CASES[name].crops,
        regions: FLOWING_CONTOURS_REFERENCE_CASES[name].regions,
        comparators: FLOWING_CONTOURS_REFERENCE_COMPARATORS,
        analysis: FLOWING_CONTOURS_REFERENCE_CASES[name].analysis,
        encoding: {
          byteOrder: 'little-endian',
          valueType: 'float64',
          planes: [
            { name: 'luminance', offsetBytes: 0, valueCount: sampleCount },
            {
              name: 'alpha',
              offsetBytes: sampleCount * 8,
              valueCount: sampleCount,
            },
            {
              name: 'positiveSupport',
              offsetBytes: sampleCount * 16,
              valueCount: sampleCount,
              values: '0=false, 1=true',
            },
          ],
        },
      })
      expect(metadata.fixtureSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(bytes.byteLength).toBe(sampleCount * 3 * 8)
      expect(decodeFlowingContoursPreparedRaster(bytes, metadata)).toEqual(
        raster,
      )
    },
  )

  it('rejects malformed rasters rather than encoding a partial fixture', () => {
    const raster = preparedRaster()
    const invalid = [
      { ...raster, width: 0 },
      { ...raster, width: raster.width - 1 },
      { ...raster, luminance: raster.luminance.slice(1) },
      {
        ...raster,
        luminance: [Number.NaN, ...raster.luminance.slice(1)],
      },
      { ...raster, alpha: [2, ...raster.alpha.slice(1)] },
      {
        ...raster,
        positiveSupport: [true, ...raster.positiveSupport.slice(1)],
      },
      {
        ...raster,
        positiveSupport: [0, ...raster.positiveSupport.slice(1)],
      },
    ]
    for (const candidate of invalid) {
      expect(
        encodeFlowingContoursPreparedRaster(
          candidate as Readonly<PreparedFlowingContoursRaster>,
        ),
      ).toBeNull()
    }
  })

  it('rejects corrupt bytes, sizes, offsets, hashes, values, and support', () => {
    const { bytes, metadata } = encodedFixture()
    expect(
      decodeFlowingContoursPreparedRaster(bytes.slice(1), metadata),
    ).toBeNull()

    const wrongHash = withMetadata(metadata, {
      fixtureSha256: '0'.repeat(64),
    })
    expect(
      decodeFlowingContoursPreparedRaster(bytes, wrongHash),
    ).toBeNull()

    const wrongCount = withMetadata(metadata, {
      analysis: { ...metadata.analysis, sampleCount: 5 },
    })
    expect(
      decodeFlowingContoursPreparedRaster(bytes, wrongCount),
    ).toBeNull()

    const wrongOffset = withMetadata(metadata, {
      encoding: {
        ...metadata.encoding,
        planes: metadata.encoding.planes.map((plane, index) =>
          index === 1 ? { ...plane, offsetBytes: 9 } : plane,
        ),
      },
    })
    const wrongOffsetBytes = bytes.slice()
    const wrongOffsetHash = flowingContoursFixtureSha256(wrongOffsetBytes)!
    expect(
      decodeFlowingContoursPreparedRaster(
        wrongOffsetBytes,
        withMetadata(wrongOffset, { fixtureSha256: wrongOffsetHash }),
      ),
    ).toBeNull()

    for (const [planeIndex, value] of [
      [0, Number.NaN],
      [1, 1.01],
      [2, 0.5],
    ] as const) {
      const corrupt = bytes.slice()
      new DataView(corrupt.buffer).setFloat64(
        planeIndex * metadata.analysis.sampleCount * 8,
        value,
        true,
      )
      const corruptMetadata = withMetadata(metadata, {
        fixtureSha256: flowingContoursFixtureSha256(corrupt)!,
      })
      expect(
        decodeFlowingContoursPreparedRaster(corrupt, corruptMetadata),
      ).toBeNull()
    }
  })

  it('rejects metadata drift from the exact case and provenance contract', () => {
    const { bytes, metadata } = encodedFixture()
    const cases: readonly Partial<FlowingContoursFixtureMetadata>[] = [
      { formatVersion: 2 as 1 },
      { preparedFromCommit: 'short' },
      {
        source: {
          ...metadata.source,
          decodedWidth: metadata.source.decodedWidth + 1,
        },
      },
      { frame: { width: 999, height: 1000 } },
      {
        controls: {
          ...metadata.controls,
          flowSmoothing: metadata.controls.flowSmoothing - 0.01,
        },
      },
      { regions: metadata.regions.slice(1) },
      {
        comparators: {
          ...metadata.comparators,
          pencilContour: {
            ...metadata.comparators.pencilContour,
            revision: FLOWING_CONTOURS_REFERENCE_REVISIONS.watercolorForms,
          },
        },
      },
    ]
    for (const update of cases) {
      expect(
        decodeFlowingContoursPreparedRaster(
          bytes,
          withMetadata(metadata, update),
        ),
      ).toBeNull()
    }
  })

  it('keeps output evidence out of the prepared-input schema', () => {
    const { metadata } = encodedFixture()
    expect(Object.keys(metadata).sort()).toEqual([
      'analysis',
      'comparators',
      'controls',
      'crops',
      'encoding',
      'fixtureSha256',
      'fixtureStatus',
      'formatVersion',
      'frame',
      'preparationVersion',
      'preparedFromCommit',
      'regions',
      'source',
    ])
    for (const forbidden of [
      'acceptedTrajectories',
      'diagnostics',
      'geometry',
      'metrics',
      'pngs',
      'scene',
    ]) {
      expect(metadata).not.toHaveProperty(forbidden)
    }
  })
})
