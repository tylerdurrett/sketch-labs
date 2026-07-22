import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  encodePencilContourAnalyzedRaster,
  pencilContourReferenceDiagnostics,
} from './helpers/pencilContourReferenceMetrics'
import { pencilContourHysteresisReplayDiagnostics } from './helpers/pencilContourHysteresisReplay'
import type { AnalyzedRaster } from '../sketches/pencil-contour/types'
import { localizePencilContourEdges } from '../sketches/pencil-contour/edges'
import { tracePencilContourEdges } from '../sketches/pencil-contour/tracing'

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
  expect({ ...actual, sampledPaths: undefined }).toEqual({
    ...expected,
    bMedianPathLength: actual.bMedianPathLength,
    turnP95Degrees: actual.turnP95Degrees,
    turnFractionOver25Degrees: actual.turnFractionOver25Degrees,
    turnFractionOver45Degrees: actual.turnFractionOver45Degrees,
    sampledPaths: undefined,
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
  expect(actual.sampledPaths).toHaveLength(expected.sampledPaths.length)
  for (const [pathIndex, actualPath] of actual.sampledPaths.entries()) {
    const expectedPath = expected.sampledPaths[pathIndex]!
    expect({
      pathIndex: actualPath.pathIndex,
      closed: actualPath.closed,
      provenance: actualPath.provenance,
      pointCount: actualPath.points.length,
      turnCount: actualPath.turnsDegrees.length,
    }).toEqual({
      pathIndex: expectedPath.pathIndex,
      closed: expectedPath.closed,
      provenance: expectedPath.provenance,
      pointCount: expectedPath.points.length,
      turnCount: expectedPath.turnsDegrees.length,
    })
    expect(actualPath.length).toBeCloseTo(expectedPath.length, 12)
    for (const [pointIndex, actualPoint] of actualPath.points.entries()) {
      const expectedPoint = expectedPath.points[pointIndex]!
      expect(actualPoint[0]).toBeCloseTo(expectedPoint[0], 12)
      expect(actualPoint[1]).toBeCloseTo(expectedPoint[1], 12)
    }
    for (const [turnIndex, actualTurn] of actualPath.turnsDegrees.entries()) {
      expect(actualTurn).toBeCloseTo(expectedPath.turnsDegrees[turnIndex]!, 10)
    }
  }
}

describe('Pencil Contour flower downstream reference', () => {
  it('pins the browser-decoded AnalyzedRaster bytes and authored tuple', () => {
    const metadata = referenceMetadata()
    const bytes = readFileSync(FIXTURE_BINARY_URL)
    const raster = referenceRaster(bytes, metadata)

    expect(metadata).toMatchObject({
      formatVersion: 1,
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

  it('reproduces exact candidate, fragment, and sampled-turn diagnostics', () => {
    const metadata = referenceMetadata()
    const bytes = readFileSync(FIXTURE_BINARY_URL)
    const raster = referenceRaster(bytes, metadata)
    const first = pencilContourReferenceDiagnostics(
      raster,
      metadata.controls.contourDetail,
    )
    const second = pencilContourReferenceDiagnostics(
      raster,
      metadata.controls.contourDetail,
    )

    expect(first).toEqual(second)
    expect(first.candidates).toEqual(metadata.diagnostics.candidates)
    expect(first.localizedEdgeCount).toBe(
      metadata.diagnostics.localizedEdgeCount,
    )
    expect(first.tracedPathCount).toBe(metadata.diagnostics.tracedPathCount)
    expect(first.sampling).toEqual(metadata.diagnostics.sampling)
    // Chrome and Node can differ by a few final bits in Math.hypot. The
    // browser verifier is byte-exact; this cross-runtime test keeps the same
    // path identities and checks every recorded coordinate/turn narrowly.
    expectSmoothingDiagnosticsClose(
      first.smoothing075,
      metadata.diagnostics.smoothing075,
    )
    expectSmoothingDiagnosticsClose(
      first.smoothing100,
      metadata.diagnostics.smoothing100,
    )

    const { candidates } = first
    expect(candidates.afterStrengthFloor).toBe(
      candidates.selected.length + candidates.unselected.length,
    )
    expect(candidates.afterDetailSelection).toBe(candidates.selected.length)
    expect(candidates.afterSelectionLimit).toBeLessThanOrEqual(
      candidates.afterStrengthFloor,
    )
    expect(candidates.afterDetailSelection).toBeLessThanOrEqual(
      candidates.afterSelectionLimit,
    )
    expect(
      new Set(
        [...candidates.selected, ...candidates.unselected].map(({ id }) => id),
      ).size,
    ).toBe(candidates.afterStrengthFloor)
    expect(
      [...candidates.selected, ...candidates.unselected].every(
        ({ strength }) => strength >= 0.03,
      ),
    ).toBe(true)

    for (const smoothing of [first.smoothing075, first.smoothing100]) {
      expect(smoothing.sampledPaths).toHaveLength(smoothing.sampledPathCount)
      expect(
        smoothing.sampledPaths.reduce(
          (total, path) => total + path.points.length,
          0,
        ),
      ).toBe(smoothing.sampledPointCount)
      expect(
        smoothing.sampledPaths.reduce(
          (total, path) => total + path.turnsDegrees.length,
          0,
        ),
      ).toBe(smoothing.turnCount)
    }
  })

  it('keeps immutable luminance evidence stable across all 101 detail values', () => {
    const metadata = referenceMetadata()
    const raster = referenceRaster(readFileSync(FIXTURE_BINARY_URL), metadata)
    const baseline = localizePencilContourEdges(raster, 0)
    const baselineEvidence = baseline.luminanceEvidence!
    const baselineAlphaEdges = baseline.edges.filter(
      ({ provenance }) => provenance.kind === 'alpha-boundary',
    )

    expect(Object.isFrozen(baselineEvidence)).toBe(true)
    expect(baselineEvidence.length).toBeGreaterThan(0)
    expect(
      baselineEvidence.every(
        (evidence) =>
          Object.isFrozen(evidence) &&
          Object.isFrozen(evidence.adjacentEdgeIds) &&
          !Object.prototype.hasOwnProperty.call(evidence, 'isSeed'),
      ),
    ).toBe(true)

    for (let detailIndex = 0; detailIndex <= 100; detailIndex += 1) {
      const graph = localizePencilContourEdges(raster, detailIndex / 100)
      expect(graph.luminanceEvidence).toEqual(baselineEvidence)
      expect(
        graph.edges.filter(
          ({ provenance }) => provenance.kind === 'alpha-boundary',
        ),
      ).toEqual(baselineAlphaEdges)

      const evidenceById = new Map(
        graph.luminanceEvidence!.map((evidence) => [evidence.id, evidence]),
      )
      const selectedIds = graph.selectedLuminanceEdgeIds!
      const selectedEdges = graph.edges.filter(
        ({ provenance }) => provenance.kind === 'luminance',
      )
      expect(selectedEdges).toHaveLength(selectedIds.length)
      for (const [index, id] of selectedIds.entries()) {
        const evidence = evidenceById.get(id)!
        expect(selectedEdges[index]!.start).toEqual(evidence.start)
        expect(selectedEdges[index]!.end).toEqual(evidence.end)
        expect(Number.isFinite(evidence.strength)).toBe(true)
      }

      const traced = tracePencilContourEdges(graph)
      const tracedLuminance = traced.filter(
        ({ provenance }) => provenance.kind === 'luminance',
      )
      const tracedIds = tracedLuminance.flatMap(
        (path) => path.luminanceEvidence!.edgeIds,
      )
      expect(tracedIds).toHaveLength(selectedIds.length)
      expect(new Set(tracedIds)).toEqual(new Set(selectedIds))
      for (const path of tracedLuminance) {
        const summary = path.luminanceEvidence!
        const strengths = summary.edgeIds.map(
          (id) => evidenceById.get(id)!.strength,
        )
        expect(summary.edgeIds).toHaveLength(
          path.closed ? path.points.length : path.points.length - 1,
        )
        expect(summary.maximumStrength).toBe(Math.max(...strengths))
        expect(summary.meanStrength).toBe(
          strengths.reduce((sum, strength) => sum + strength, 0) /
            strengths.length,
        )
      }
      expect(
        traced.reduce(
          (total, path) =>
            total + (path.closed ? path.points.length : path.points.length - 1),
          0,
        ),
      ).toBe(graph.edges.length)
    }
  }, 120_000)

  it('measures bounded weak-evidence replay before authorizing hysteresis', () => {
    const metadata = referenceMetadata()
    const raster = referenceRaster(readFileSync(FIXTURE_BINARY_URL), metadata)
    const graph = localizePencilContourEdges(raster, 0.5)
    const replay = pencilContourHysteresisReplayDiagnostics(graph)
    const selectedCount = graph.selectedLuminanceEdgeIds!.length
    const reorderedGraph = Object.freeze({
      ...graph,
      luminanceEvidence: Object.freeze([...graph.luminanceEvidence!].reverse()),
      selectedLuminanceEdgeIds: Object.freeze(
        [...graph.selectedLuminanceEdgeIds!].reverse(),
      ),
      edges: Object.freeze([
        ...graph.edges.slice(0, selectedCount).reverse(),
        ...graph.edges.slice(selectedCount).reverse(),
      ]),
    })
    const reorderedReplay =
      pencilContourHysteresisReplayDiagnostics(reorderedGraph)

    expect(reorderedReplay).toEqual(replay)
    expect(replay.weakFloor).toBe(0.0825)
    expect(replay.matchingTube).toBe(2)
    expect(replay).toMatchObject({
      componentCount: 4_321,
      replayedComponentCount: 64,
      unreplayedComponentCount: 4_257,
      eligibleEdgeCount: 6_743,
      usedEligibleEdgeCount: 33,
      baselineShortPathCount: 686,
      recoveredBaselinePathCount: 28,
      hysteresisAuthorized: false,
    })
    expect(replay.baselineShortPathLength).toBeCloseTo(1222.364499352788, 12)
    expect(replay.recoveredLength).toBeCloseTo(48.863016510289164, 12)
    expect(replay.recoveryRatio).toBeCloseTo(0.03997417835364241, 12)
    expect(replay.unmatchedAddedLength).toBeCloseTo(0.46402864739638816, 12)
    expect(replay.unmatchedFraction).toBeCloseTo(0.009496520692673096, 12)
    expect(replay.unmatchedFraction).toBeLessThanOrEqual(0.1)
    expect(replay.recoveries).toHaveLength(13)
    expect(
      replay.recoveries.flatMap(({ addedEdgeIds }) => addedEdgeIds),
    ).toContain('horizontal:157,48')
    expect(replay.recoveryRatio).toBe(
      replay.recoveredLength / replay.baselineShortPathLength,
    )
    expect(replay.unmatchedFraction).toBe(
      replay.unmatchedAddedLength / replay.recoveredLength,
    )
    expect(replay.hysteresisAuthorized).toBe(
      replay.recoveryRatio >= 0.3 &&
        replay.usedEligibleEdgeCount > 0 &&
        Number.isFinite(replay.unmatchedFraction) &&
        replay.unmatchedFraction <= 0.1,
    )
  }, 120_000)
})
