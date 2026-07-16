import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const summary = readResult('simplified-full-2026-07-15.json')
const campaign = readResult('simplified-full-2026-07-15.campaign-raw.json')
const svgManifest = readResult('simplified-full-2026-07-15.svg-manifest.json')
const fixtureIds = [
  'one-hill-5000',
  'one-hill-10000',
  'full-10000',
  'full-25000',
  'full-50000',
]

describe('simplified Grass Hills full result', () => {
  it('pins the sole finalist, literal jobs, and fixed full policy', () => {
    expect(summary.candidate).toEqual({
      id: 'simplified-stroke-tufts',
      representation: 'open six-point blades/stable five-member tufts',
      occluderMode: 'hill-and-clump',
      densityMode: 'plotter-lod',
    })
    expect(summary.campaign).toEqual({
      protocolVersion: 1,
      mode: 'full',
      policy: {
        timeoutMs: 600_000,
        memoryMiB: 2048,
        samples: { preparation: 20, cold: 20, warm: 60, warmups: 3 },
      },
      resultCount: 5,
      completedCount: 3,
      censoredCount: 2,
    })
    expect(campaign.policy).toEqual(summary.campaign.policy)
    expect(campaign.results.map((result) => result.fixtureId)).toEqual(
      fixtureIds,
    )
    expect(
      campaign.results.every(
        (result) => result.candidateId === summary.candidate.id,
      ),
    ).toBe(true)
  })

  it('retains every full sample, memory snapshot, metric, and machine field', () => {
    const completed = campaign.results.filter((result) => result.status === 'ok')
    expect(completed.map((result) => result.fixtureId)).toEqual(
      fixtureIds.slice(0, 3),
    )

    for (const result of completed) {
      for (const [phase, count] of Object.entries({
        preparation: 20,
        cold: 20,
        warm: 60,
      })) {
        expect(result.phases[phase].samples).toHaveLength(count)
        for (const sample of result.phases[phase].samples) {
          expect(sample.durationMs).toBeGreaterThanOrEqual(0)
          expect(sample.memory).toMatchObject({
            before: memorySnapshot(),
            after: memorySnapshot(),
            heapUsedDeltaBytes: expect.any(Number),
            rssDeltaBytes: expect.any(Number),
            maxRssDeltaBytes: expect.any(Number),
          })
        }
      }

      expect(result.runtime).toMatchObject({
        node: expect.any(String),
        platform: expect.any(String),
        arch: expect.any(String),
        hostname: expect.any(String),
        osRelease: expect.any(String),
        cpuModel: expect.any(String),
        logicalCpuCount: expect.any(Number),
        totalMemoryBytes: expect.any(Number),
      })
      const metrics = result.phases.preparation.samples[0].metrics
      expect(metrics.representation).toMatchObject({
        pointsPerBlade: 6,
        occluderMode: 'hill-and-clump',
        densityMode: 'plotter-lod',
        previewExportShareProcessedScene: true,
      })
      expect(metrics.source).toMatchObject(inventory())
      expect(metrics.referenceHiddenLineWorkload).toMatchObject({
        totalWorkUnits: expect.any(Number),
      })
      expect(metrics.processing).toMatchObject({
        kind: 'supplied',
        durationMs: expect.any(Number),
        processed: inventory(),
      })
      expect(metrics.boundsClip).toMatchObject({
        durationMs: expect.any(Number),
        clipped: inventory(),
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
        nibWidthMillimeters: 0.3,
        roots: { min: expect.any(Number), p50: expect.any(Number) },
        clearances: {
          contract: expect.any(String),
          sampling: {
            method: expect.any(String),
            sampledSegmentCount: expect.any(Number),
            segmentCoverage: expect.any(Number),
            censoredSegmentCount: expect.any(Number),
            sampledPathCount: expect.any(Number),
            pathCoverage: expect.any(Number),
          },
          paths: expect.any(Object),
          segments: expect.any(Object),
          collisions: {
            pathPairCount: expect.any(Number),
            candidatePairChecks: expect.any(Number),
          },
          spatial: expect.any(Object),
        },
      })

      const summarized = summary.results.find(
        (candidate) => candidate.fixtureId === result.fixtureId,
      )
      expect(summarized.representativeMetrics).toEqual(metrics)
      for (const [phaseName, phase] of Object.entries(result.phases)) {
        const durations = phase.samples.map((sample) => sample.durationMs)
        expect(summarized.phaseTimingMs[phaseName]).toEqual({
          sampleCount: durations.length,
          min: Math.min(...durations),
          median: conventionalMedian(durations),
          max: Math.max(...durations),
        })
      }
      expect(summarized.maxRssBytes).toBe(
        Math.max(
          ...Object.values(result.phases).flatMap((phase) =>
            phase.samples.map((sample) => sample.memory.after.maxRssBytes),
          ),
        ),
      )
    }
  })

  it('retains both honest timeout censors without partial metrics', () => {
    const censored = campaign.results.filter(
      (result) => result.status === 'censored',
    )
    expect(censored.map((result) => result.fixtureId)).toEqual(
      fixtureIds.slice(3),
    )
    for (const result of censored) {
      expect(result.phases).toBeUndefined()
      expect(result.censor).toMatchObject({
        kind: 'timeout',
        reason: 'child exceeded 600000 ms',
        elapsedMs: expect.any(Number),
        exitCode: null,
        signal: 'SIGKILL',
      })
      expect(result.censor.elapsedMs).toBeGreaterThanOrEqual(600_000)
    }
  })

  it('pins two reproducible external SVG artifacts per fixture', () => {
    expect(svgManifest).toMatchObject({
      candidate: summary.candidate,
      serializer: 'core renderToSVG after core clipSceneToBounds',
      artifactCount: 10,
    })
    expect(svgManifest.artifacts).toHaveLength(10)

    for (const fixtureId of fixtureIds) {
      const artifacts = svgManifest.artifacts.filter(
        (artifact) => artifact.fixtureId === fixtureId,
      )
      expect(artifacts.map((artifact) => artifact.kind)).toEqual([
        'fill',
        'outline',
      ])
      for (const artifact of artifacts) {
        expect(artifact.path).toBe(
          `/tmp/issue-305-y3b-${fixtureId}-${artifact.kind}.svg`,
        )
        expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(artifact.bytes).toBeGreaterThan(0)
        expect(artifact.pathCount).toBeGreaterThan(0)
        expect(artifact.scene).toMatchObject(inventory())
      }
    }

    for (const result of campaign.results.filter(
      (candidate) => candidate.status === 'ok',
    )) {
      const metrics = result.phases.preparation.samples[0].metrics
      const fill = svgManifest.artifacts.find(
        (artifact) =>
          artifact.fixtureId === result.fixtureId && artifact.kind === 'fill',
      )
      const outline = svgManifest.artifacts.find(
        (artifact) =>
          artifact.fixtureId === result.fixtureId && artifact.kind === 'outline',
      )
      expect(fill.scene.checksum).toBe(metrics.source.checksum)
      expect(outline.scene.checksum).toBe(metrics.processing.processed.checksum)
    }
  })
})

function memorySnapshot() {
  return {
    heapUsedBytes: expect.any(Number),
    rssBytes: expect.any(Number),
    maxRssBytes: expect.any(Number),
  }
}

function inventory() {
  return {
    primitiveCount: expect.any(Number),
    pointCount: expect.any(Number),
    checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
    serializedBytes: expect.any(Number),
    geometryBytes: expect.any(Number),
  }
}

function conventionalMedian(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const upper = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[upper - 1] + sorted[upper]) / 2
    : sorted[upper]
}

function readResult(file) {
  return JSON.parse(
    readFileSync(new URL(`./results/${file}`, import.meta.url), 'utf8'),
  )
}
