import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const here = dirname(new URL(import.meta.url).pathname)
const campaignId = 'issue-336-20260718T230718Z'
const campaignRoot = resolve(here, 'results', campaignId)
const read = (path) => JSON.parse(readFileSync(resolve(campaignRoot, path), 'utf8'))
const checkpoint = read('campaign-checkpoint.json')
const decision = read('screen-decision.json')
const raw = checkpoint.completed.map((entry) =>
  JSON.parse(readFileSync(resolve(here, 'results', entry.rawRecord), 'utf8')),
)

describe('issue #336 Photo Scribble fine-budget screen evidence', () => {
  it('pins the immutable six-job prefix and no-survivor decision', () => {
    expect(checkpoint.completed).toHaveLength(6)
    expect(checkpoint.nextJobKey).toBeNull()
    expect(checkpoint.campaignFailures).toEqual([])
    expect(raw.map(({ job }) => [job.scenarioId, job.candidateId])).toEqual([
      ['flowers-opaque-fine', 'current-fine-baseline'],
      ['pinecone-dark-alpha-fine', 'current-fine-baseline'],
      ['flowers-opaque-fine', 'fine-100k'],
      ['pinecone-dark-alpha-fine', 'fine-100k'],
      ['flowers-opaque-fine', 'fine-250k'],
      ['pinecone-dark-alpha-fine', 'fine-250k'],
    ])
    expect(decision).toMatchObject({
      campaignId,
      survivorCandidateIds: [],
      candidatesNotRun: ['fine-500k', 'fine-1000k'],
      decision: 'retain-current-production-limits',
    })
  })

  it('retains complete real-worker, target, operational, and capture evidence', () => {
    for (const record of raw) {
      expect(record.status).toBe('completed')
      expect(record.observation.result.diagnostics.termination).toBe('budget-exhausted')
      expect(record.observation.telemetry.execution.bindingGuard).toBe(
        'accepted-segment-limit',
      )
      expect(record.observation.telemetry.execution.counters.acceptedSegments).toBe(
        record.job.tuple.maxAcceptedSegments,
      )
      expect(record.observation.telemetry.targetHash).toMatch(/^[0-9a-f]{64}$/)
      expect(record.equivalence).toMatchObject({
        identityHashMatches: true,
        productionResolverSelectedTuple: true,
        sceneHashMatches: true,
        diagnosticsHashMatches: true,
      })
      expect(record.observation.presentation).toMatchObject({
        geometryAndExportParity: true,
        fillCanvas: { validState: true },
        outlineCanvas: { validState: true },
      })
      expect(record.observation.cancellation).toMatchObject({
        startedAfterNonTerminalProgress: true,
        coordinatorAcknowledged: true,
        outcome: 'cancelled',
        lateReplacementObserved: false,
      })
      expect(record.artifacts).toHaveLength(3)
      for (const artifact of record.artifacts) {
        expect(artifact.path.startsWith('/')).toBe(false)
        expect(artifact.byteLength).toBeGreaterThan(0)
        expect(existsSync(resolve(here, '..', '..', '..', '..', artifact.path))).toBe(true)
      }
    }
  })
})
