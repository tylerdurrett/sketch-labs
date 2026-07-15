import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const report = readResult('simplified-screen-2026-07-15.json')
const campaign = readResult('simplified-screen-2026-07-15.campaign-raw.json')
const browserEnvelope = readResult(
  'simplified-screen-2026-07-15.browser-raw.json',
)

describe('simplified Grass Hills screen result', () => {
  it('pins the complete screen policy and its single finalist', () => {
    expect(report.recordedAt).toBe('2026-07-15')
    expect(report.evidence).toEqual({
      campaignRaw: {
        file: 'simplified-screen-2026-07-15.campaign-raw.json',
        contract:
          'verbatim protocol envelope with every timing/memory sample and collector result',
      },
      browserRaw: {
        file: 'simplified-screen-2026-07-15.browser-raw.json',
        contract:
          'verbatim Chrome envelope with every load, first draw, and redraw sample',
      },
    })
    expect(report.campaign).toMatchObject({
      mode: 'screen',
      policy: {
        timeoutMs: 90_000,
        memoryMiB: 1024,
        samples: { preparation: 3, cold: 3, warm: 12, warmups: 1 },
      },
      resultCount: 8,
      okCount: 8,
      censoredCount: 0,
    })
    expect(report.results).toHaveLength(8)
    expect(report.results.every((result) => result.status === 'ok')).toBe(true)
    expect(report.browser).toMatchObject({
      harness: 'core drawSceneFitted',
      canvas: { width: 1000, height: 1000 },
      redrawsPerScene: 12,
      observationCount: 16,
    })
    expect(report.finalist).toMatchObject({
      representation: 'open six-point blades/stable five-member tufts',
      occluderMode: 'hill-and-clump',
      densityMode: 'plotter-lod',
      selectedCount: 1,
    })
  })

  it('keeps source identity and browser checksum evidence aligned', () => {
    const byFixture = new Map()
    for (const result of report.results) {
      const fixture = result.fixtureId.startsWith('historical-baseline-400')
        ? 'baseline'
        : 'one-hill-5000'
      byFixture.set(fixture, [...(byFixture.get(fixture) ?? []), result])
    }

    for (const variants of byFixture.values()) {
      expect(new Set(variants.map((result) => result.source.checksum)).size).toBe(1)
    }
    for (const result of report.results) {
      expect(result.browser.source.checksum).toBe(result.source.checksum)
      expect(result.browser.processed.checksum).toBe(result.processing.checksum)
      for (const observation of Object.values(result.browser)) {
        expect(observation.loadMs).toBeGreaterThanOrEqual(0)
        expect(observation.firstDrawMs).toBeGreaterThanOrEqual(0)
        expect(observation.redrawMedianMs).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('records the physical-spacing effect and selected 5k artifact', () => {
    const sameDensity = report.results.filter(
      (result) => result.variant.densityMode === 'same-density',
    )
    const plotterLod = report.results.filter(
      (result) => result.variant.densityMode === 'plotter-lod',
    )
    expect(
      sameDensity.every(
        (result) => result.physicalSpacing.rootMinimumMillimeters < 0.3,
      ),
    ).toBe(true)
    expect(
      plotterLod.every(
        (result) => result.physicalSpacing.rootMinimumMillimeters >= 0.3,
      ),
    ).toBe(true)

    const finalist = report.results.find(
      (result) =>
        result.fixtureId.startsWith('one-hill-5000') &&
        result.variant.occluderMode === report.finalist.occluderMode &&
        result.variant.densityMode === report.finalist.densityMode,
    )
    expect(finalist).toMatchObject({
      representation: { bladeCount: 5000, tuftCount: 1000 },
      processing: {
        primitiveCount: 2950,
        pointCount: 14548,
        checksum:
          '5a1fb74ae8d486af03d8878fb07f75011e706cc26272e547cc69993c5194cf97',
      },
    })
  })

  it('retains every protocol sample, memory snapshot, and evidence collector', () => {
    expect(campaign).toMatchObject({
      protocolVersion: 1,
      mode: 'screen',
      policy: report.campaign.policy,
    })
    expect(campaign.results).toHaveLength(8)

    const sampleCounts = { preparation: 3, cold: 3, warm: 12 }
    for (const result of campaign.results) {
      expect(result.status).toBe('ok')
      for (const [phaseName, sampleCount] of Object.entries(sampleCounts)) {
        const samples = result.phases[phaseName].samples
        expect(samples).toHaveLength(sampleCount)
        for (const sample of samples) {
          expect(sample.durationMs).toBeGreaterThanOrEqual(0)
          expect(sample.memory).toMatchObject({
            before: {
              heapUsedBytes: expect.any(Number),
              rssBytes: expect.any(Number),
              maxRssBytes: expect.any(Number),
            },
            after: {
              heapUsedBytes: expect.any(Number),
              rssBytes: expect.any(Number),
              maxRssBytes: expect.any(Number),
            },
            heapUsedDeltaBytes: expect.any(Number),
            rssDeltaBytes: expect.any(Number),
            maxRssDeltaBytes: expect.any(Number),
          })
        }
      }

      const metrics = result.phases.preparation.samples[0].metrics
      expect(metrics.referenceHiddenLineWorkload).toMatchObject({
        filledPrimitiveCount: expect.any(Number),
        sourceSegmentCount: expect.any(Number),
        overlappingPairCount: expect.any(Number),
        estimatedSegmentEdgeComparisons: expect.any(Number),
        totalWorkUnits: expect.any(Number),
      })
      expect(metrics.boundsClip).toMatchObject({
        durationMs: expect.any(Number),
        clipped: {
          primitiveCount: expect.any(Number),
          pointCount: expect.any(Number),
          checksum: expect.any(String),
          serializedBytes: expect.any(Number),
          geometryBytes: expect.any(Number),
        },
      })
      expect(metrics.svgSerialization).toMatchObject({
        durationMs: expect.any(Number),
        bytes: expect.any(Number),
        pathCount: expect.any(Number),
      })
      expect(metrics.plotter).toMatchObject({
        durationMs: expect.any(Number),
        svgBytes: expect.any(Number),
        pathCount: expect.any(Number),
      })
      expect(metrics.physicalSpacing).toMatchObject({
        roots: {
          sampleCount: expect.any(Number),
          min: expect.any(Number),
          p05: expect.any(Number),
          p50: expect.any(Number),
          p95: expect.any(Number),
          max: expect.any(Number),
        },
        clearances: {
          contract: expect.any(String),
          sampling: {
            method: expect.any(String),
            totalSegmentCount: expect.any(Number),
            sampledSegmentCount: expect.any(Number),
            segmentCoverage: expect.any(Number),
            censoredSegmentCount: expect.any(Number),
            totalPathCount: expect.any(Number),
            sampledPathCount: expect.any(Number),
            pathCoverage: expect.any(Number),
          },
          paths: expect.any(Object),
          segments: expect.any(Object),
          collisions: {
            threshold: expect.any(String),
            segmentPairCount: expect.any(Number),
            pathPairCount: expect.any(Number),
            collidingSegmentCount: expect.any(Number),
            collidingPathCount: expect.any(Number),
            candidatePairChecks: expect.any(Number),
          },
          spatial: expect.any(Object),
        },
      })
    }
  })

  it('retains all browser observations and raw redraw samples', () => {
    expect(browserEnvelope.success).toBe(true)
    expect(browserEnvelope.result.observations).toHaveLength(16)
    const observations = new Map(
      browserEnvelope.result.observations.map((observation) => [
        observation.kind,
        observation,
      ]),
    )

    for (const result of report.results) {
      const campaignResult = campaign.results.find(
        (candidate) => candidate.fixtureId === result.fixtureId,
      )
      if (campaignResult === undefined) {
        throw new Error(`missing raw campaign result ${result.fixtureId}`)
      }
      const metrics = campaignResult.phases.preparation.samples[0].metrics
      const source = observations.get(`${result.fixtureId}--source`)
      const processed = observations.get(`${result.fixtureId}--processed`)
      if (source === undefined || processed === undefined) {
        throw new Error(`missing raw browser observations ${result.fixtureId}`)
      }
      expect(source).toMatchObject({
        sha256: metrics.source.checksum,
        primitiveCount: metrics.source.primitiveCount,
        pointCount: metrics.source.pointCount,
      })
      expect(processed).toMatchObject({
        sha256: metrics.processing.processed.checksum,
        primitiveCount: metrics.processing.processed.primitiveCount,
        pointCount: metrics.processing.processed.pointCount,
      })
      for (const observation of [source, processed]) {
        expect(observation.redrawSamplesMs).toHaveLength(12)
        expect(
          observation.redrawSamplesMs.every(
            (sample) => Number.isFinite(sample) && sample >= 0,
          ),
        ).toBe(true)
      }
    }
  })
})

function readResult(file) {
  return JSON.parse(
    readFileSync(new URL(`./results/${file}`, import.meta.url), 'utf8'),
  )
}
