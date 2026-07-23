import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { CoordinateSpace } from '../scene'
import type { PencilContourControls } from '../sketches/pencil-contour/controls'
import type { AnalyzedRaster } from '../sketches/pencil-contour/types'
import type { WatercolorFormsControls } from '../sketches/watercolor-forms/controls'
import type { PreparedWatercolorRaster } from '../sketches/watercolor-forms/types'
import {
  measureReferenceGeometry,
  pencilContourReferenceMetrics,
  REFERENCE_LENGTH_NORMALIZATION,
  REFERENCE_LONG_PATH_MINIMUM_NORMALIZED_LENGTH,
  REFERENCE_SHORT_PATH_MAXIMUM_NORMALIZED_LENGTH,
  watercolorFormsReferenceMetrics,
  type ReferenceMetrics,
} from './helpers/watercolorFormsReferenceMetrics'

const FLOAT64_BYTES = 8
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
const LOWERCASE_COMMIT_SHA = /^[0-9a-f]{40}$/
const REFERENCE_IDENTITIES = Object.freeze({
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
    pencilBaseline: '85b4d854d29ec2ac27bf1b8016bc263fec3ccd43',
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
    pencilBaseline: 'd4c3c05c0ea0574e0f17677f7db471c34942ae24',
  }),
})

interface FixtureMetadata<Controls> {
  readonly formatVersion: number
  readonly fixtureStatus?: string
  readonly preparedFromCommit?: string
  readonly productionBaseline?: string
  readonly preparationVersion?: string
  readonly source: {
    readonly assetId: string
    readonly repositoryPath: string
    readonly sha256: string
    readonly decodedWidth: number
    readonly decodedHeight: number
  }
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

interface ReferenceCase {
  readonly name: 'flower' | 'pinecone'
  readonly watercolor: Readonly<
    FixtureMetadata<WatercolorFormsControls>
  >
  readonly watercolorRaster: Readonly<PreparedWatercolorRaster>
  readonly pencil: Readonly<FixtureMetadata<PencilContourControls>>
  readonly pencilRaster: Readonly<AnalyzedRaster>
}

function fixtureUrl(
  pipeline: 'watercolor-forms' | 'pencil-contour',
  name: ReferenceCase['name'],
  suffix: 'prepared' | 'analysis',
  extension: 'json' | 'f64le',
): URL {
  return new URL(
    `./fixtures/${pipeline}/${name}-${suffix}.${extension}`,
    import.meta.url,
  )
}

function metadata<Controls>(
  pipeline: 'watercolor-forms' | 'pencil-contour',
  name: ReferenceCase['name'],
  suffix: 'prepared' | 'analysis',
): Readonly<FixtureMetadata<Controls>> {
  return JSON.parse(
    readFileSync(fixtureUrl(pipeline, name, suffix, 'json'), 'utf8'),
  ) as FixtureMetadata<Controls>
}

function decodedPlanes(
  bytes: Readonly<Buffer>,
  fixture: Readonly<FixtureMetadata<unknown>>,
  expectedNames: readonly string[],
): readonly (readonly number[])[] {
  const { sampleCount } = fixture.analysis
  expect(bytes.byteLength).toBe(
    sampleCount * expectedNames.length * FLOAT64_BYTES,
  )
  expect(fixture.encoding.planes).toEqual(
    expectedNames.map((name, index) => ({
      name,
      offsetBytes: index * sampleCount * FLOAT64_BYTES,
      valueCount: sampleCount,
      ...(name === 'positiveSupport'
        ? { values: '0=false, 1=true' }
        : {}),
    })),
  )
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const planes = expectedNames.map((_, planeIndex) =>
    Object.freeze(
      Array.from({ length: sampleCount }, (_, index) =>
        view.getFloat64(
          (planeIndex * sampleCount + index) * FLOAT64_BYTES,
          true,
        ),
      ),
    ),
  )
  expect(
    planes.at(-1)!.every((value) => value === 0 || value === 1),
  ).toBe(true)
  return planes
}

function fixtureBytes(
  pipeline: 'watercolor-forms' | 'pencil-contour',
  name: ReferenceCase['name'],
  suffix: 'prepared' | 'analysis',
  fixture: Readonly<FixtureMetadata<unknown>>,
  expectedNames: readonly string[],
): readonly (readonly number[])[] {
  const bytes = readFileSync(fixtureUrl(pipeline, name, suffix, 'f64le'))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    fixture.fixtureSha256,
  )
  return decodedPlanes(bytes, fixture, expectedNames)
}

function watercolorRaster(
  fixture: Readonly<FixtureMetadata<WatercolorFormsControls>>,
  planes: readonly (readonly number[])[],
): Readonly<PreparedWatercolorRaster> {
  return Object.freeze({
    sourceWidth: fixture.source.decodedWidth,
    sourceHeight: fixture.source.decodedHeight,
    width: fixture.analysis.width,
    height: fixture.analysis.height,
    linearRed: planes[0]!,
    linearGreen: planes[1]!,
    linearBlue: planes[2]!,
    luminance: planes[3]!,
    alpha: planes[4]!,
    positiveSupport: Object.freeze(
      planes[5]!.map((value) => value === 1),
    ),
  })
}

function pencilRaster(
  fixture: Readonly<FixtureMetadata<PencilContourControls>>,
  planes: readonly (readonly number[])[],
): Readonly<AnalyzedRaster> {
  return Object.freeze({
    sourceWidth: fixture.source.decodedWidth,
    sourceHeight: fixture.source.decodedHeight,
    width: fixture.analysis.width,
    height: fixture.analysis.height,
    luminance: planes[0]!,
    alpha: planes[1]!,
    positiveSupport: Object.freeze(
      planes[2]!.map((value) => value === 1),
    ),
  })
}

function loadReference(name: ReferenceCase['name']): ReferenceCase {
  const watercolor = metadata<WatercolorFormsControls>(
    'watercolor-forms',
    name,
    'prepared',
  )
  const pencil = metadata<PencilContourControls>(
    'pencil-contour',
    name,
    'analysis',
  )
  const watercolorPlanes = fixtureBytes(
    'watercolor-forms',
    name,
    'prepared',
    watercolor,
    WATER_COLOR_PLANES,
  )
  const pencilPlanes = fixtureBytes(
    'pencil-contour',
    name,
    'analysis',
    pencil,
    PENCIL_PLANES,
  )
  return {
    name,
    watercolor,
    watercolorRaster: watercolorRaster(watercolor, watercolorPlanes),
    pencil,
    pencilRaster: pencilRaster(pencil, pencilPlanes),
  }
}

function expectFiniteMetrics(
  metrics: Readonly<ReferenceMetrics>,
): void {
  expect(metrics.definitions).toMatchObject({
    lengthNormalization: 'fitted-image-diagonal',
    shortPathMaximumNormalizedLength: 0.01,
    longPathMinimumNormalizedLength: 0.05,
  })
  expect(metrics.pathCount).toBeGreaterThanOrEqual(0)
  expect(Number.isSafeInteger(metrics.pathCount)).toBe(true)
  expect(metrics.shortPathShare).toBeGreaterThanOrEqual(0)
  expect(metrics.shortPathShare).toBeLessThanOrEqual(1)
  expect(metrics.shortPathShare * metrics.pathCount).toBeCloseTo(
    Math.round(metrics.shortPathShare * metrics.pathCount),
    12,
  )
  expect(metrics.medianNormalizedPathLength).toBeGreaterThanOrEqual(0)
  expect(Number.isFinite(metrics.medianNormalizedPathLength)).toBe(true)
  expect(metrics.longPathShareOfTotalGeometry).toBeGreaterThanOrEqual(0)
  expect(metrics.longPathShareOfTotalGeometry).toBeLessThanOrEqual(1)
  expect(metrics.closedFormCount).toBeGreaterThanOrEqual(0)
  expect(metrics.closedFormCount).toBeLessThanOrEqual(metrics.pathCount)
  expect(Number.isSafeInteger(metrics.closedFormCount)).toBe(true)
  expect(metrics.totalPlottedLength).toBeGreaterThanOrEqual(0)
  expect(Number.isFinite(metrics.totalPlottedLength)).toBe(true)
  expect(metrics.definitions.fittedImageDiagonal).toBeGreaterThan(0)
  expect(Number.isFinite(metrics.definitions.fittedImageDiagonal)).toBe(true)
}

describe('Watercolor Forms shared reference metric definitions', () => {
  it('pins exact diagonal normalization and inclusive short/long thresholds', () => {
    expect(REFERENCE_LENGTH_NORMALIZATION).toBe(
      'fitted-image-diagonal',
    )
    expect(REFERENCE_SHORT_PATH_MAXIMUM_NORMALIZED_LENGTH).toBe(0.01)
    expect(REFERENCE_LONG_PATH_MINIMUM_NORMALIZED_LENGTH).toBe(0.05)

    const metrics = measureReferenceGeometry(
      [
        { points: [[0, 0], [1, 0]], closed: false },
        { points: [[0, 0], [3, 0]], closed: false },
        { points: [[0, 0], [5, 0]], closed: false },
        {
          points: [[0, 0], [2, 0], [2, 2], [0, 2]],
          closed: true,
        },
      ],
      100,
    )

    expect(metrics).toEqual({
      definitions: {
        lengthNormalization: 'fitted-image-diagonal',
        fittedImageDiagonal: 100,
        shortPathMaximumNormalizedLength: 0.01,
        longPathMinimumNormalizedLength: 0.05,
      },
      pathCount: 4,
      shortPathShare: 0.25,
      medianNormalizedPathLength: 0.04,
      longPathShareOfTotalGeometry: 13 / 17,
      closedFormCount: 1,
      totalPlottedLength: 17,
    })
  })

  it('defines empty geometry without non-finite ratios', () => {
    expect(measureReferenceGeometry([], 10)).toEqual({
      definitions: {
        lengthNormalization: 'fitted-image-diagonal',
        fittedImageDiagonal: 10,
        shortPathMaximumNormalizedLength: 0.01,
        longPathMinimumNormalizedLength: 0.05,
      },
      pathCount: 0,
      shortPathShare: 0,
      medianNormalizedPathLength: 0,
      longPathShareOfTotalGeometry: 0,
      closedFormCount: 0,
      totalPlottedLength: 0,
    })
  })
})

describe('Watercolor Forms flower and pinecone reference fixtures', () => {
  const references = (['flower', 'pinecone'] as const).map(loadReference)

  it('records one valid shared Watercolor preparation lineage', () => {
    const first = references[0]!.watercolor
    expect(first.preparedFromCommit).toMatch(LOWERCASE_COMMIT_SHA)
    expect(first.preparationVersion).toBe(
      'watercolor-forms-prepared-raster-v1',
    )
    for (const { watercolor } of references.slice(1)) {
      expect(watercolor.preparedFromCommit).toBe(first.preparedFromCommit)
      expect(watercolor.preparationVersion).toBe(first.preparationVersion)
    }
  })

  it.each(references)(
    '$name pins matching source, frame, analysis, encoding, and finite planes',
    ({ name, watercolor, watercolorRaster, pencil, pencilRaster }) => {
      const identity = REFERENCE_IDENTITIES[name]
      expect(watercolor).toMatchObject({
        formatVersion: 1,
        fixtureStatus: 'provisional',
        preparationVersion: 'watercolor-forms-prepared-raster-v1',
        source: identity.source,
        frame: { width: 1000, height: 1000 },
        controls: {
          formDetail: 0.5,
          colorSensitivity: 0.5,
          boundaryStrength: 0.5,
          boundarySmoothing: 0.5,
        },
        analysis: identity.analysis,
        encoding: {
          byteOrder: 'little-endian',
          valueType: 'float64',
        },
      })
      expect(pencil).toMatchObject({
        frame: watercolor.frame,
        controls: {
          gamma: 0.5,
          contrast: 0.5,
          pivot: 0.5,
          contourDetail: 0.5,
          contourSmoothing: 1,
        },
        encoding: {
          byteOrder: 'little-endian',
          valueType: 'float64',
        },
      })
      expect(pencil.source).toEqual(watercolor.source)
      expect(pencil.analysis).toEqual(watercolor.analysis)
      expect(pencil.preparedFromCommit ?? pencil.productionBaseline).toBe(
        identity.pencilBaseline,
      )
      expect(watercolor.analysis.sampleCount).toBe(
        watercolor.analysis.width * watercolor.analysis.height,
      )
      for (const values of [
        watercolorRaster.linearRed,
        watercolorRaster.linearGreen,
        watercolorRaster.linearBlue,
        watercolorRaster.luminance,
        watercolorRaster.alpha,
        pencilRaster.luminance,
        pencilRaster.alpha,
      ]) {
        expect(values).toHaveLength(watercolor.analysis.sampleCount)
        expect(
          values.every(
            (value) =>
              Number.isFinite(value) && value >= 0 && value <= 1,
          ),
        ).toBe(true)
      }
      expect(watercolorRaster.positiveSupport).toHaveLength(
        watercolor.analysis.sampleCount,
      )
      expect(pencilRaster.positiveSupport).toHaveLength(
        pencil.analysis.sampleCount,
      )
    },
  )

  it.each(references)(
    '$name recomputes deterministic, self-consistent metrics for both current algorithms',
    ({ watercolor, watercolorRaster, pencil, pencilRaster }) => {
      const watercolorInput = {
        raster: watercolorRaster,
        controls: watercolor.controls,
        frame: watercolor.frame,
      }
      const pencilInput = {
        raster: pencilRaster,
        controls: pencil.controls,
        frame: pencil.frame,
      }
      const watercolorFirst = watercolorFormsReferenceMetrics(watercolorInput)
      const pencilFirst =
        pencilContourReferenceMetrics(pencilInput)

      expect(watercolorFormsReferenceMetrics(watercolorInput)).toEqual(
        watercolorFirst,
      )
      expect(pencilContourReferenceMetrics(pencilInput)).toEqual(
        pencilFirst,
      )
      expect(watercolorFirst.definitions).toEqual(pencilFirst.definitions)
      expectFiniteMetrics(watercolorFirst)
      expectFiniteMetrics(pencilFirst)
      // The pre-tuning Watercolor flower baseline is intentionally allowed to
      // be empty. Its zero-safe metrics remain useful input to the later
      // coverage/tuning gate. Established Pencil comparison cases are not.
      expect(pencilFirst.pathCount).toBeGreaterThan(0)
      expect(pencilFirst.totalPlottedLength).toBeGreaterThan(0)
    },
  )
})
