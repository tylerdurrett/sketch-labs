import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { localizePencilContourEdges } from '../../src/sketches/pencil-contour/edges'
import type { AnalyzedRaster } from '../../src/sketches/pencil-contour/types'
import { pencilContourTopWeakComponentReplayDiagnostics } from './top-weak-component-replay'

const FIXTURE_BINARY_URL = new URL(
  '../../src/__tests__/fixtures/pencil-contour/flower-analysis.f64le',
  import.meta.url,
)
const FIXTURE_METADATA_URL = new URL(
  '../../src/__tests__/fixtures/pencil-contour/flower-analysis.json',
  import.meta.url,
)
const FLOAT64_BYTES = 8

interface FixtureMetadata {
  readonly source: {
    readonly decodedWidth: number
    readonly decodedHeight: number
  }
  readonly controls: { readonly contourDetail: number }
  readonly analysis: {
    readonly width: number
    readonly height: number
    readonly sampleCount: number
  }
}

function fixtureRaster(): Readonly<AnalyzedRaster> {
  const metadata = JSON.parse(
    readFileSync(FIXTURE_METADATA_URL, 'utf8'),
  ) as FixtureMetadata
  const bytes = readFileSync(FIXTURE_BINARY_URL)
  const { sampleCount, width, height } = metadata.analysis
  const expectedBytes = sampleCount * 3 * FLOAT64_BYTES
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(
      `Expected ${expectedBytes} fixture bytes, received ${bytes.byteLength}`,
    )
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const plane = (planeIndex: number): readonly number[] =>
    Array.from({ length: sampleCount }, (_, index) =>
      view.getFloat64((planeIndex * sampleCount + index) * FLOAT64_BYTES, true),
    )
  const support = plane(2)
  if (!support.every((value) => value === 0 || value === 1)) {
    throw new Error('Fixture support plane must contain only zero or one')
  }
  return Object.freeze({
    sourceWidth: metadata.source.decodedWidth,
    sourceHeight: metadata.source.decodedHeight,
    width,
    height,
    luminance: Object.freeze(plane(0)),
    alpha: Object.freeze(plane(1)),
    positiveSupport: Object.freeze(support.map((value) => value === 1)),
  })
}

describe('Pencil Contour top weak-component replay diagnostic', () => {
  it('reports the bounded top-64 policy result without generalizing beyond it', () => {
    const raster = fixtureRaster()
    const graph = localizePencilContourEdges(raster, 0.5)
    const result = pencilContourTopWeakComponentReplayDiagnostics(graph)
    console.log(
      JSON.stringify({
        policy: result.policy,
        componentCount: result.componentCount,
        evaluatedComponentCount: result.evaluatedComponentCount,
        eligibleEdgeCount: result.eligibleEdgeCount,
        baselineShortPathCount: result.baselineShortPathCount,
        recoveredBaselinePathCount: result.recoveredBaselinePathCount,
        recoveryRatio: result.recoveryRatio,
        unmatchedFraction: result.unmatchedFraction,
        topComponentPolicyPassed: result.topComponentPolicyPassed,
      }),
    )

    expect(result).toMatchObject({
      policy: {
        selection: 'top-ranked-components',
        componentLimit: 64,
        minimumRecoveryRatio: 0.3,
        maximumUnmatchedFraction: 0.1,
      },
      weakFloor: 0.0825,
      matchingTube: 2,
      componentCount: 4_321,
      evaluatedComponentCount: 64,
      unevaluatedComponentCount: 4_257,
      eligibleEdgeCount: 6_743,
      usedEligibleEdgeCount: 32,
      baselineShortPathCount: 1_202,
      recoveredBaselinePathCount: 33,
      topComponentPolicyPassed: false,
    })
    expect(result.baselineShortPathLength).toBeCloseTo(1863.5474556444117, 12)
    expect(result.recoveredLength).toBeCloseTo(48.59366830884439, 12)
    expect(result.recoveryRatio).toBeCloseTo(0.0260758952833003, 12)
    expect(result.unmatchedAddedLength).toBeCloseTo(2.362657214730688, 12)
    expect(result.unmatchedFraction).toBeCloseTo(0.0486206803675422, 12)
    expect(result.recoveries).toHaveLength(13)
    expect(result.recoveries.flatMap(({ addedEdgeIds }) => addedEdgeIds))
      .toContain('horizontal:157,48')
    expect(result.recoveryRatio).toBe(
      result.recoveredLength / result.baselineShortPathLength,
    )
    expect(result.unmatchedFraction).toBe(
      result.unmatchedAddedLength / result.recoveredLength,
    )
    expect(result.topComponentPolicyPassed).toBe(
      result.recoveryRatio >= result.policy.minimumRecoveryRatio &&
        result.usedEligibleEdgeCount > 0 &&
        Number.isFinite(result.unmatchedFraction) &&
        result.unmatchedFraction <= result.policy.maximumUnmatchedFraction,
    )

    console.log(
      'The predefined top-64 policy failed; this does not evaluate every hysteresis strategy.',
    )
  }, 120_000)
})
