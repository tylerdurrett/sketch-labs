import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { CoordinateSpace } from '../scene'
import type { PencilContourControls } from '../sketches/pencil-contour/controls'
import type { AnalyzedRaster } from '../sketches/pencil-contour/types'
import type { WatercolorFormsControls } from '../sketches/watercolor-forms/controls'
import type { PreparedWatercolorRaster } from '../sketches/watercolor-forms/types'
import { extractWatercolorSharedBoundaries } from '../sketches/watercolor-forms/boundaries'
import { fitWatercolorBoundaryCurves } from '../sketches/watercolor-forms/curves'
import { selectWatercolorForms } from '../sketches/watercolor-forms/forms'
import { buildWatercolorFormsHierarchy } from '../sketches/watercolor-forms/hierarchy'
import { partitionWatercolorFormsRaster } from '../sketches/watercolor-forms/partition'
import { traceWatercolorBoundaryNetwork } from '../sketches/watercolor-forms/tracing'
import {
  pencilContourReferenceMetrics,
  watercolorFormsReferenceMetrics,
} from './helpers/watercolorFormsReferenceMetrics'

const FLOAT64_BYTES = 8

interface FixtureMetadata<Controls> {
  readonly frame: Readonly<CoordinateSpace>
  readonly controls: Readonly<Controls>
  readonly source: {
    readonly decodedWidth: number
    readonly decodedHeight: number
  }
  readonly analysis: {
    readonly width: number
    readonly height: number
    readonly sampleCount: number
  }
}

function fixtureMetadata<Controls>(
  pipeline: 'watercolor-forms' | 'pencil-contour',
  name: 'flower' | 'pinecone',
  suffix: 'prepared' | 'analysis',
): Readonly<FixtureMetadata<Controls>> {
  return JSON.parse(
    readFileSync(
      new URL(
        `./fixtures/${pipeline}/${name}-${suffix}.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  ) as FixtureMetadata<Controls>
}

function fixturePlanes(
  pipeline: 'watercolor-forms' | 'pencil-contour',
  name: 'flower' | 'pinecone',
  suffix: 'prepared' | 'analysis',
  sampleCount: number,
  planeCount: number,
): readonly (readonly number[])[] {
  const bytes = readFileSync(
    new URL(
      `./fixtures/${pipeline}/${name}-${suffix}.f64le`,
      import.meta.url,
    ),
  )
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: planeCount }, (_, planeIndex) =>
    Object.freeze(
      Array.from({ length: sampleCount }, (_, index) =>
        view.getFloat64(
          (planeIndex * sampleCount + index) * FLOAT64_BYTES,
          true,
        ),
      ),
    ),
  )
}

function referenceInputs(name: 'flower' | 'pinecone') {
  const watercolor =
    fixtureMetadata<WatercolorFormsControls>(
      'watercolor-forms',
      name,
      'prepared',
    )
  const pencil = fixtureMetadata<PencilContourControls>(
    'pencil-contour',
    name,
    'analysis',
  )
  const watercolorPlanes = fixturePlanes(
    'watercolor-forms',
    name,
    'prepared',
    watercolor.analysis.sampleCount,
    6,
  )
  const pencilPlanes = fixturePlanes(
    'pencil-contour',
    name,
    'analysis',
    pencil.analysis.sampleCount,
    3,
  )
  const watercolorRaster: Readonly<PreparedWatercolorRaster> =
    Object.freeze({
      sourceWidth: watercolor.source.decodedWidth,
      sourceHeight: watercolor.source.decodedHeight,
      width: watercolor.analysis.width,
      height: watercolor.analysis.height,
      linearRed: watercolorPlanes[0]!,
      linearGreen: watercolorPlanes[1]!,
      linearBlue: watercolorPlanes[2]!,
      luminance: watercolorPlanes[3]!,
      alpha: watercolorPlanes[4]!,
      positiveSupport: Object.freeze(
        watercolorPlanes[5]!.map((value) => value === 1),
      ),
    })
  const pencilRaster: Readonly<AnalyzedRaster> = Object.freeze({
    sourceWidth: pencil.source.decodedWidth,
    sourceHeight: pencil.source.decodedHeight,
    width: pencil.analysis.width,
    height: pencil.analysis.height,
    luminance: pencilPlanes[0]!,
    alpha: pencilPlanes[1]!,
    positiveSupport: Object.freeze(
      pencilPlanes[2]!.map((value) => value === 1),
    ),
  })
  return {
    watercolor: {
      raster: watercolorRaster,
      controls: watercolor.controls,
      frame: watercolor.frame,
    },
    pencil: {
      raster: pencilRaster,
      controls: pencil.controls,
      frame: pencil.frame,
    },
  }
}

function watercolorCoverage(
  input: ReturnType<typeof referenceInputs>['watercolor'],
) {
  const partition = partitionWatercolorFormsRaster(input.raster)
  const hierarchy = buildWatercolorFormsHierarchy(
    partition,
    input.controls.colorSensitivity,
  )
  const forms = selectWatercolorForms(
    hierarchy,
    input.controls.formDetail,
  )
  const boundaries = extractWatercolorSharedBoundaries(
    forms,
    input.controls.boundaryStrength,
  )
  const traced = traceWatercolorBoundaryNetwork(
    boundaries.sharedBoundarySegments,
  )
  const curves = fitWatercolorBoundaryCurves(
    traced.paths,
    input.controls.boundarySmoothing,
    {
      latticeWidth: input.raster.width,
      latticeHeight: input.raster.height,
      positiveSupport: input.raster.positiveSupport,
    },
  )
  const occupiedBins = new Set(
    curves.flatMap((curve) =>
      curve.points.map(([x, y]) => {
        const column = Math.min(
          3,
          Math.floor((x / input.raster.width) * 4),
        )
        const row = Math.min(
          3,
          Math.floor((y / input.raster.height) * 4),
        )
        return `${column},${row}`
      }),
    ),
  )
  let totalLength = 0
  let axisAlignedLength = 0
  for (const curve of curves) {
    const explicitlyClosed =
      curve.closed &&
      curve.points.length > 1 &&
      curve.points[0]![0] === curve.points.at(-1)![0] &&
      curve.points[0]![1] === curve.points.at(-1)![1]
    const points = explicitlyClosed
      ? curve.points.slice(0, -1)
      : curve.points
    const segmentCount = curve.closed
      ? points.length
      : Math.max(0, points.length - 1)
    for (let index = 0; index < segmentCount; index += 1) {
      const first = points[index]!
      const second = points[(index + 1) % points.length]!
      const dx = second[0] - first[0]
      const dy = second[1] - first[1]
      const length = Math.hypot(dx, dy)
      totalLength += length
      if (dx === 0 || dy === 0) axisAlignedLength += length
    }
  }

  return {
    selectedFormCount: forms.regionIds.length,
    retainedBoundarySegmentCount:
      boundaries.sharedBoundarySegments.length,
    pathCount: curves.length,
    closedFormCount: curves.filter(({ closed }) => closed).length,
    occupiedBinCount: occupiedBins.size,
    centralBinCount: ['1,1', '2,1', '1,2', '2,2'].filter((bin) =>
      occupiedBins.has(bin),
    ).length,
    occupiedColumnCount: new Set(
      [...occupiedBins].map((bin) => bin.split(',')[0]),
    ).size,
    occupiedRowCount: new Set(
      [...occupiedBins].map((bin) => bin.split(',')[1]),
    ).size,
    axisAlignedLengthShare:
      totalLength === 0 ? 1 : axisAlignedLength / totalLength,
  }
}

describe('Watercolor Forms directional reference gates', () => {
  it.each(['flower', 'pinecone'] as const)(
    '%s improves long-form geometry without deleting useful forms',
    (name) => {
      const inputs = referenceInputs(name)
      const watercolor = watercolorFormsReferenceMetrics(inputs.watercolor)
      const pencil = pencilContourReferenceMetrics(inputs.pencil)
      const coverage = watercolorCoverage(inputs.watercolor)

      expect(watercolor.shortPathShare).toBeLessThan(
        pencil.shortPathShare,
      )
      expect(watercolor.medianNormalizedPathLength).toBeGreaterThan(
        pencil.medianNormalizedPathLength,
      )
      expect(watercolor.longPathShareOfTotalGeometry).toBeGreaterThan(
        pencil.longPathShareOfTotalGeometry,
      )

      // Deletion cannot manufacture a passing directional comparison.
      expect(coverage.selectedFormCount).toBeGreaterThanOrEqual(4)
      expect(coverage.retainedBoundarySegmentCount).toBeGreaterThan(
        Math.min(
          inputs.watercolor.raster.width,
          inputs.watercolor.raster.height,
        ) * 2,
      )
      expect(coverage.pathCount).toBe(watercolor.pathCount)
      expect(coverage.pathCount).toBeGreaterThanOrEqual(4)
      expect(coverage.closedFormCount).toBe(watercolor.closedFormCount)
      expect(coverage.closedFormCount).toBeGreaterThanOrEqual(3)
      expect(watercolor.totalPlottedLength).toBeGreaterThan(
        watercolor.definitions.fittedImageDiagonal * 2,
      )
      expect(coverage.occupiedBinCount).toBeGreaterThanOrEqual(8)
      // Organic source boundaries must not fall back to an orthogonal
      // analysis-lattice staircase after bounded curve fitting.
      expect(coverage.axisAlignedLengthShare).toBeLessThan(0.1)

      if (name === 'flower') {
        // The prominent central flower must remain represented in every
        // quadrant surrounding the image center.
        expect(coverage.centralBinCount).toBe(4)
      } else {
        // The pinecone silhouette and interior forms must span the subject in
        // both axes, not collapse to a favorable local fragment.
        expect(coverage.occupiedColumnCount).toBe(4)
        expect(coverage.occupiedRowCount).toBe(4)
      }
    },
  )
})
