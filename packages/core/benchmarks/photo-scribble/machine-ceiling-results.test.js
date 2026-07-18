import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const here = dirname(new URL(import.meta.url).pathname)
const resultsRoot = resolve(here, 'results')
const campaignIds = [
  'issue-336-20260718T232556Z',
  'issue-336-20260718T232816Z',
]
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const readCampaignRaw = (campaignId) => {
  const checkpoint = readJson(resolve(resultsRoot, campaignId, 'campaign-checkpoint.json'))
  return checkpoint.completed.map((entry) => readJson(resolve(resultsRoot, entry.rawRecord)))
}

describe('issue #336 maintainer-authorized machine-ceiling evidence', () => {
  it('selects 1m as the largest tuple that fully passed both fine scenarios', () => {
    const decisionRoot = resolve(resultsRoot, 'issue-336-20260718T233038Z')
    const decision = readJson(resolve(decisionRoot, 'machine-ceiling-decision.json'))
    const boundary = readJson(resolve(decisionRoot, 'machine-ceiling-boundary.json'))

    expect(decision).toMatchObject({
      decision: 'select-largest-fully-passing-machine-tuple',
      selectedCandidateId: 'machine-1000k',
      selectedTuple: {
        maxAcceptedSegments: 1_000_000,
        maxPolylines: 16_000,
        maxStagnations: 32_000,
        maxRestarts: 16_000,
      },
      hardBoundaryCandidateId: 'machine-2000k',
      hardBoundaryKind: 'unrecoverable-instability',
      candidatesNotRun: ['machine-4000k', 'machine-8000k'],
      productionLimitsChanged: false,
    })
    expect(boundary.boundary).toMatchObject({
      kind: 'unrecoverable-instability',
      scenarioId: 'flowers-opaque-fine',
      operationTimeoutMs: 300_000,
      observedElapsedMs: 366_732,
    })
    expect(boundary.postBoundaryObservation.useInSelection).toBe(false)
  })

  it('retains complete deterministic Canvas and geometry evidence for 500k and 1m', () => {
    const records = campaignIds.flatMap(readCampaignRaw)
    expect(records).toHaveLength(4)

    for (const record of records) {
      expect(record.status).toBe('completed')
      expect(record.observation.result.diagnostics.termination).toBe('budget-exhausted')
      expect(record.observation.telemetry.execution.bindingGuard).toBe(
        'accepted-segment-limit',
      )
      expect(record.observation.telemetry.execution.counters.acceptedSegments).toBe(
        record.job.tuple.maxAcceptedSegments,
      )
      expect(record.observation.telemetry.execution.counters.emittedPolylines).toBeLessThan(
        record.job.tuple.maxPolylines,
      )
      expect(record.observation.telemetry.execution.counters.stagnations).toBeLessThan(
        record.job.tuple.maxStagnations,
      )
      expect(record.observation.telemetry.execution.counters.restarts).toBeLessThan(
        record.job.tuple.maxRestarts,
      )
      expect(record.equivalence).toMatchObject({
        identityHashMatches: true,
        productionResolverSelectedTuple: true,
        sceneHashMatches: true,
        diagnosticsHashMatches: true,
      })
      expect(record.observation.presentation.geometryAndExportParity).toBe(true)
      expect(record.observation.presentation.exportGeometry).toMatchObject({
        ordinarySvgMatchesAuthoritativeScene: true,
        plotterSvgMatchesOutlineScene: true,
      })
      expect(record.observation.presentation.exportGeometry.ordinaryAuthoritativeHash).toBe(
        record.observation.presentation.exportGeometry.ordinaryExportHash,
      )
      expect(record.observation.presentation.exportGeometry.plotterAuthoritativeHash).toBe(
        record.observation.presentation.exportGeometry.plotterExportHash,
      )
      expect(record.observation.cancellation).toMatchObject({
        scope: 'direct-coordinator-cancel-after-progress',
        exercisesSupersedingControlEdit: false,
        startedAfterNonTerminalProgress: true,
        coordinatorAcknowledged: true,
        outcome: 'cancelled',
        lateReplacementObserved: false,
      })
      expect(record.artifacts).toHaveLength(3)
      for (const artifact of record.artifacts) {
        expect(artifact.sha256).toBe(artifact.measuredCanvasSha256)
        expect(artifact.pixelDimensions).toEqual({ width: 1000, height: 1000 })
        expect(existsSync(resolve(here, '..', '..', '..', '..', artifact.path))).toBe(true)
      }
    }
  })

  it('preserves the 2m failure and does not manufacture later campaigns', () => {
    const campaignId = 'issue-336-20260718T233038Z'
    const [flowers, pinecone] = readCampaignRaw(campaignId)
    const elapsed = Date.parse(flowers.finishedAt) - Date.parse(flowers.startedAt)

    expect(flowers).toMatchObject({
      status: 'failed',
      job: { scenarioId: 'flowers-opaque-fine', candidateId: 'machine-2000k' },
      failure: { kind: 'runner-failure' },
    })
    expect(elapsed).toBe(366_732)
    expect(elapsed).toBeGreaterThan(300_000)
    expect(pinecone).toMatchObject({
      status: 'completed',
      job: { scenarioId: 'pinecone-dark-alpha-fine', candidateId: 'machine-2000k' },
    })
    const manifestBodies = readdirSync(resolve(here, 'manifests'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => readFileSync(resolve(here, 'manifests', name), 'utf8'))
    expect(manifestBodies.some((body) => body.includes('machine-4000k'))).toBe(false)
    expect(manifestBodies.some((body) => body.includes('machine-8000k'))).toBe(false)
  })
})
