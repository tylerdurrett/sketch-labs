import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createBrowserBoundary,
  raceOperation,
  validateCandidateResponse,
  validateEquivalenceResponse,
} from './browser-boundary.js'
import {
  CampaignOperationError,
  CampaignValidationError,
  runCampaign,
  validateCampaignManifest,
} from './campaign-runner.js'
import protocol from './protocol.json'

const rightsEvidence = {
  kind: 'dated-maintainer-attestation-of-ownership-and-redistribution-rights',
  evidenceId: 'attestation-2026-07-18',
  attestedAt: '2026-07-18',
  ownsEverySelectedFixture: true,
  grantsRedistributionRights: true,
}

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function outputRoot() {
  const root = mkdtempSync(resolve(tmpdir(), 'photo-scribble-campaign-'))
  roots.push(root)
  return root
}

function screenManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    campaignId: 'issue-336-20260718T120000Z',
    phase: 'screen',
    rightsEvidence,
    jobs: [{
      scenarioId: 'flowers-opaque-fine',
      candidateId: 'current-fine-baseline',
    }],
    ...overrides,
  }
}

function successResult(job) {
  return {
    equivalence: {
      identityHashMatches: true,
      productionResolverSelectedTuple: true,
      sceneHashMatches: true,
      diagnosticsHashMatches: true,
    },
    observation: {
      runId: `run-${job.ordinal}`,
      result: { diagnostics: { termination: 'completed', residualError: 0 } },
      measurement: { mainWallDurationMs: 1 },
    },
    runtime: { userAgent: 'fake' },
  }
}

function fakeBoundary(runJob = async ({ job }) => successResult(job)) {
  return {
    start: vi.fn(async () => {}),
    runJob: vi.fn(runJob),
    restartBrowser: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }
}

const responseCampaignId = 'issue-336-20260718T120000Z'
const responseTuple = {
  maxAcceptedSegments: 50_000,
  maxPolylines: 4_000,
  maxStagnations: 8_000,
  maxRestarts: 4_000,
}

function evidenceRun({
  hostRunId,
  runId,
  purpose,
  profile,
  tuple = responseTuple,
}) {
  return {
    schemaVersion: 1,
    campaignId: responseCampaignId,
    hostRunId,
    runId,
    scenarioId: 'flowers-opaque-fine',
    purpose,
    rightsEvidence: {
      type: rightsEvidence.kind,
      identifier: rightsEvidence.evidenceId,
    },
    identityHash: 'a'.repeat(64),
    profile,
    fullTuple: tuple,
    result: {
      sceneHash: 'b'.repeat(64),
      diagnosticsHash: 'c'.repeat(64),
      diagnostics: {
        termination: 'completed',
        residualError: 0,
        pathLength: 1,
        polylineCount: 1,
        penLiftCount: 0,
      },
      primitiveCount: 1,
      smoothedPointCount: 2,
      serializedResultBytes: 100,
    },
    measurement: purpose === 'measurement' ? {
      coordinatorComputeTimeMs: 1,
      mainWallDurationMs: 2,
      responseReadyToMainReceiptEpochProxyMs: 0,
      heartbeat: {
        requestPostedAtMs: 1,
        progressReceiptTimesMs: [2],
        finalResponseReceivedAtMs: 3,
        requestToFirstOrEndMs: 1,
        betweenProgressGapsMs: [],
        lastProgressToEndMs: 1,
        maximumGapMs: 1,
        terminalProgressCount: 1,
      },
      memory: { scope: 'page-main-process-only-worker-heap-unavailable', before: null, after: null },
    } : null,
    telemetry: {
      schemaVersion: 1,
      runId,
      sketchId: 'photo-scribble',
      imageAssetId: 'img-0672-79d639daec62',
      purpose,
      profile,
      resolvedProductionLimits: responseTuple,
      effectiveLimits: tuple,
      productionResolverSelectedEffectiveTuple: true,
      execution: purpose === 'measurement' ? {
        stopCause: 'threshold-reached',
        bindingGuard: null,
        counters: {
          acceptedSegments: 1,
          emittedPolylines: 1,
          stagnations: 0,
          restarts: 0,
        },
      } : null,
      rawAcceptedSegments: purpose === 'measurement' ? 1 : null,
      smoothedEmittedPoints: 2,
      smoothedEmittedPolylines: 1,
      serializedArtworkBytes: 100,
      workerDurationMs: purpose === 'measurement' ? 1 : null,
      responseReadyEpochMs: 1,
    },
    protocolBoundary: {
      invalidMessageCount: 0,
      allCoordinatorMessagesValid: true,
    },
  }
}

function validResponses() {
  const equivalenceHostRunId = 'host-equivalence'
  const production = evidenceRun({
    hostRunId: equivalenceHostRunId,
    runId: `${equivalenceHostRunId}-production`,
    purpose: 'equivalence-proof',
    profile: { kind: 'production' },
  })
  const injectedResolvedTuple = evidenceRun({
    hostRunId: equivalenceHostRunId,
    runId: `${equivalenceHostRunId}-injected`,
    purpose: 'equivalence-proof',
    profile: {
      kind: 'injected',
      candidateId: 'resolved-production-tuple-equivalence',
      limits: responseTuple,
    },
  })
  const equivalence = {
    scenarioId: 'flowers-opaque-fine',
    identityHashMatches: true,
    resolvedTuple: responseTuple,
    productionResolverSelectedTuple: true,
    sceneHashMatches: true,
    diagnosticsHashMatches: true,
    production,
    injectedResolvedTuple,
  }
  const candidateHostRunId = 'host-candidate'
  const candidate = evidenceRun({
    hostRunId: candidateHostRunId,
    runId: `${candidateHostRunId}-measurement`,
    purpose: 'measurement',
    profile: {
      kind: 'injected',
      candidateId: 'current-fine-baseline',
      limits: responseTuple,
    },
  })
  return { equivalence, candidate, equivalenceHostRunId, candidateHostRunId }
}

describe('Photo Scribble campaign runner', () => {
  it('refuses missing rights evidence before starting or writing', async () => {
    const root = outputRoot()
    const boundary = fakeBoundary()
    const manifest = screenManifest()
    delete manifest.rightsEvidence
    await expect(runCampaign({ manifest, protocol, outputRoot: root, boundary }))
      .rejects.toThrow('rightsEvidence')
    expect(boundary.start).not.toHaveBeenCalled()
    expect(() => readFileSync(resolve(root, manifest.campaignId))).toThrow()
  })

  it('separates screen scenarios from explicit, fully-covered promotion survivors', () => {
    expect(() => validateCampaignManifest(screenManifest({
      jobs: [{ scenarioId: 'flowers-opaque-control', candidateId: 'fine-100k' }],
    }), protocol)).toThrow('not a fine')

    const survivorCandidateIds = ['fine-100k']
    const promotion = screenManifest({
      phase: 'promotion',
      survivorCandidateIds,
      jobs: protocol.scenarios.map(({ scenarioId }) => ({
        scenarioId,
        candidateId: 'fine-100k',
      })),
    })
    expect(validateCampaignManifest(promotion, protocol).jobs).toHaveLength(4)
    promotion.jobs.pop()
    expect(() => validateCampaignManifest(promotion, protocol)).toThrow('every frozen scenario')
  })

  it('allows only non-empty prefixes of the exact frozen screen order', () => {
    expect(validateCampaignManifest(screenManifest(), protocol).jobs).toHaveLength(1)
    expect(validateCampaignManifest(screenManifest({ jobs: [
      { scenarioId: 'flowers-opaque-fine', candidateId: 'current-fine-baseline' },
      { scenarioId: 'pinecone-dark-alpha-fine', candidateId: 'current-fine-baseline' },
      { scenarioId: 'flowers-opaque-fine', candidateId: 'fine-100k' },
    ] }), protocol).jobs).toHaveLength(3)
    for (const jobs of [
      [{ scenarioId: 'pinecone-dark-alpha-fine', candidateId: 'current-fine-baseline' }],
      [{ scenarioId: 'flowers-opaque-fine', candidateId: 'fine-100k' }],
      [
        { scenarioId: 'flowers-opaque-fine', candidateId: 'current-fine-baseline' },
        { scenarioId: 'flowers-opaque-fine', candidateId: 'fine-100k' },
      ],
    ]) {
      expect(() => validateCampaignManifest(screenManifest({ jobs }), protocol))
        .toThrow('non-empty prefix')
    }
  })

  it('runs serially, checkpoints each outcome, and closes the boundary', async () => {
    let active = 0
    let maximumActive = 0
    const boundary = fakeBoundary(async ({ job }) => {
      active++
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      active--
      return successResult(job)
    })
    const manifest = screenManifest({ jobs: [
      { scenarioId: 'flowers-opaque-fine', candidateId: 'current-fine-baseline' },
      { scenarioId: 'pinecone-dark-alpha-fine', candidateId: 'current-fine-baseline' },
    ] })
    const root = outputRoot()
    const result = await runCampaign({ manifest, protocol, outputRoot: root, boundary })
    expect(result.completed).toHaveLength(2)
    expect(maximumActive).toBe(1)
    expect(boundary.close).toHaveBeenCalledOnce()
    const checkpoint = JSON.parse(readFileSync(
      resolve(root, manifest.campaignId, 'campaign-checkpoint.json'), 'utf8',
    ))
    expect(checkpoint.completed).toHaveLength(2)
  })

  it('preserves a failed raw record, restarts after browser loss, and resumes without overwrite', async () => {
    const root = outputRoot()
    const manifest = screenManifest({ jobs: [
      { scenarioId: 'flowers-opaque-fine', candidateId: 'current-fine-baseline' },
      { scenarioId: 'pinecone-dark-alpha-fine', candidateId: 'current-fine-baseline' },
    ] })
    let call = 0
    const first = fakeBoundary(async ({ job }) => {
      call++
      if (call === 1) throw new CampaignOperationError(
        'browser-lost', 'Browser disconnected', { equivalence: { sceneHashMatches: true } },
      )
      return successResult(job)
    })
    await runCampaign({ manifest, protocol, outputRoot: root, boundary: first })
    expect(first.restartBrowser).toHaveBeenCalledOnce()
    const rawPath = resolve(root, manifest.campaignId, 'flowers-opaque-fine',
      'current-fine-baseline--s50000-p4000-g8000-r4000',
      'issue-336-trial-flowers-opaque-fine--current-fine-baseline--s50000-p4000-g8000-r4000--attempt-0001.raw.json')
    const before = readFileSync(rawPath, 'utf8')
    expect(JSON.parse(before)).toMatchObject({
      status: 'failed',
      failure: { kind: 'browser-lost' },
      equivalence: { sceneHashMatches: true },
    })

    const resumed = fakeBoundary()
    await runCampaign({ manifest, protocol, outputRoot: root, boundary: resumed })
    expect(resumed.runJob).not.toHaveBeenCalled()
    expect(readFileSync(rawPath, 'utf8')).toBe(before)
  })

  it('records only an active aborted job and leaves later jobs pending', async () => {
    const root = outputRoot()
    const manifest = screenManifest({ jobs: [
      { scenarioId: 'flowers-opaque-fine', candidateId: 'current-fine-baseline' },
      { scenarioId: 'pinecone-dark-alpha-fine', candidateId: 'current-fine-baseline' },
    ] })
    const boundary = fakeBoundary(async () => {
      throw new CampaignOperationError('campaign-aborted', 'user aborted active job')
    })
    const result = await runCampaign({ manifest, protocol, outputRoot: root, boundary })
    expect(result).toMatchObject({
      stopped: { kind: 'campaign-aborted' },
      completed: [{ status: 'failed', failure: { kind: 'campaign-aborted' } }],
    })
    expect(boundary.runJob).toHaveBeenCalledOnce()
    const pendingDirectory = resolve(
      root,
      manifest.campaignId,
      'pinecone-dark-alpha-fine',
    )
    expect(existsSync(pendingDirectory)).toBe(false)
    const checkpoint = JSON.parse(readFileSync(
      resolve(root, manifest.campaignId, 'campaign-checkpoint.json'), 'utf8',
    ))
    expect(checkpoint.completed).toHaveLength(1)
    expect(checkpoint.nextJobKey).toContain('pinecone-dark-alpha-fine')
  })

  it('does not synthesize a raw outcome when aborted between jobs', async () => {
    const controller = new AbortController()
    controller.abort()
    const root = outputRoot()
    const boundary = fakeBoundary()
    const result = await runCampaign({
      manifest: screenManifest(),
      protocol,
      outputRoot: root,
      boundary,
      signal: controller.signal,
    })
    expect(result.completed).toEqual([])
    expect(result.stopped).toMatchObject({ kind: 'campaign-aborted' })
    expect(boundary.runJob).not.toHaveBeenCalled()
  })

  it('checkpoints the failed outcome before restart and preserves a restart failure for resume', async () => {
    const root = outputRoot()
    const manifest = screenManifest({ jobs: [
      { scenarioId: 'flowers-opaque-fine', candidateId: 'current-fine-baseline' },
      { scenarioId: 'pinecone-dark-alpha-fine', candidateId: 'current-fine-baseline' },
    ] })
    const first = fakeBoundary(async () => {
      throw new CampaignOperationError('job-timeout', 'timed out')
    })
    first.restartBrowser.mockImplementation(async () => {
      const checkpoint = JSON.parse(readFileSync(
        resolve(root, manifest.campaignId, 'campaign-checkpoint.json'), 'utf8',
      ))
      expect(checkpoint.completed).toHaveLength(1)
      throw new Error('browser relaunch failed')
    })
    const firstResult = await runCampaign({ manifest, protocol, outputRoot: root, boundary: first })
    expect(firstResult.stopped).toMatchObject({ kind: 'browser-restart-failed' })
    expect(first.runJob).toHaveBeenCalledOnce()
    const checkpoint = JSON.parse(readFileSync(
      resolve(root, manifest.campaignId, 'campaign-checkpoint.json'), 'utf8',
    ))
    expect(checkpoint.campaignFailures).toHaveLength(1)
    expect(checkpoint.nextJobKey).toContain('pinecone-dark-alpha-fine')

    const resumed = fakeBoundary()
    const resumedResult = await runCampaign({ manifest, protocol, outputRoot: root, boundary: resumed })
    expect(resumed.runJob).toHaveBeenCalledOnce()
    expect(resumedResult.completed).toHaveLength(2)
  })

  it('rejects duplicate tuple paths and campaign ID collisions', async () => {
    expect(() => validateCampaignManifest(screenManifest({ jobs: [
      { scenarioId: 'flowers-opaque-fine', candidateId: 'fine-100k' },
      { scenarioId: 'flowers-opaque-fine', candidateId: 'fine-100k' },
    ] }), protocol)).toThrow('duplicate')
    const root = outputRoot()
    const first = screenManifest()
    await runCampaign({ manifest: first, protocol, outputRoot: root, boundary: fakeBoundary() })
    await expect(runCampaign({
      manifest: screenManifest({ jobs: [
        { scenarioId: 'flowers-opaque-fine', candidateId: 'fine-100k' },
      ] }),
      protocol,
      outputRoot: root,
      boundary: fakeBoundary(),
    })).rejects.toBeInstanceOf(CampaignValidationError)
  })
})

describe('Photo Scribble Puppeteer boundary', () => {
  it('accepts only structurally complete responses bound to the current campaign and host run', () => {
    const responses = validResponses()
    const equivalence = validateEquivalenceResponse(responses.equivalence, {
      campaignId: responseCampaignId,
      hostRunId: responses.equivalenceHostRunId,
      scenarioId: 'flowers-opaque-fine',
      imageAssetId: 'img-0672-79d639daec62',
      rightsEvidence,
    })
    expect(validateCandidateResponse(responses.candidate, {
      campaignId: responseCampaignId,
      hostRunId: responses.candidateHostRunId,
      scenarioId: 'flowers-opaque-fine',
      imageAssetId: 'img-0672-79d639daec62',
      candidateId: 'current-fine-baseline',
      tuple: responseTuple,
      rightsEvidence,
      identityHash: equivalence.production.identityHash,
    })).toBe(responses.candidate)
  })

  it.each([
    ['campaign identity', (run) => { run.campaignId = 'issue-336-20260718T120001Z' }],
    ['host identity', (run) => { run.hostRunId = 'stale-host' }],
    ['scenario', (run) => { run.scenarioId = 'pinecone-dark-alpha-fine' }],
    ['candidate profile', (run) => { run.profile.candidateId = 'fine-100k' }],
    ['four-limit tuple', (run) => { run.fullTuple.maxRestarts++ }],
    ['rights evidence', (run) => { run.rightsEvidence.identifier = 'stale-attestation' }],
    ['canonical hashes', (run) => { run.result.sceneHash = 'not-a-hash' }],
    ['telemetry identity', (run) => { run.telemetry.runId = 'stale-run' }],
    ['raw telemetry', (run) => { run.telemetry.execution = null }],
  ])('rejects a candidate response with mismatched %s', (_label, mutate) => {
    const { candidate, candidateHostRunId } = structuredClone(validResponses())
    mutate(candidate)
    expect(() => validateCandidateResponse(candidate, {
      campaignId: responseCampaignId,
      hostRunId: candidateHostRunId,
      scenarioId: 'flowers-opaque-fine',
      imageAssetId: 'img-0672-79d639daec62',
      candidateId: 'current-fine-baseline',
      tuple: responseTuple,
      rightsEvidence,
      identityHash: 'a'.repeat(64),
    })).toThrow('Rejected malformed, stale, or mismatched')
  })

  it('rejects stale or internally inconsistent equivalence runs', () => {
    const { equivalence, equivalenceHostRunId } = structuredClone(validResponses())
    equivalence.injectedResolvedTuple.runId = equivalence.production.runId
    equivalence.injectedResolvedTuple.telemetry.runId = equivalence.production.runId
    expect(() => validateEquivalenceResponse(equivalence, {
      campaignId: responseCampaignId,
      hostRunId: equivalenceHostRunId,
      scenarioId: 'flowers-opaque-fine',
      imageAssetId: 'img-0672-79d639daec62',
      rightsEvidence,
    })).toThrow('stale or inconsistent')
  })

  it('rejects an operation immediately when its signal was already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const operation = new Promise(() => {})
    const page = { evaluate: vi.fn(async () => true) }
    await expect(raceOperation(operation, {
      page,
      timeoutMs: 300_000,
      signal: controller.signal,
      label: 'setup-gap operation',
    })).rejects.toMatchObject({ kind: 'campaign-aborted' })
    expect(page.evaluate).toHaveBeenCalledOnce()
  })

  it('aborts the active coordinator and closes page, browser, and server on timeout', async () => {
    let evaluation = 0
    const page = {
      setViewport: vi.fn(async () => {}),
      setDefaultTimeout: vi.fn(),
      goto: vi.fn(async () => {}),
      waitForFunction: vi.fn(async () => {}),
      evaluate: vi.fn((fn) => {
        const source = fn.toString()
        if (source.includes('abortActive')) return Promise.resolve(true)
        evaluation++
        if (evaluation === 1) return Promise.resolve({ userAgent: 'fake', platform: 'fake' })
        return new Promise(() => {})
      }),
      close: vi.fn(async () => {}),
    }
    const browser = {
      isConnected: () => true,
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {}),
    }
    const server = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(function () {
        this.exitCode = 0
        this.emit('exit', 0)
      }),
    })
    const boundary = createBrowserBoundary({
      serverFactory: async () => server,
      browserFactory: async () => browser,
      url: 'http://evidence.test',
      fetchImpl: async () => ({ ok: true }),
    })
    await boundary.start()
    await expect(boundary.runJob({
      job: { scenarioId: 'flowers-opaque-fine', candidateId: 'fine-100k' },
      rightsEvidence,
      timeoutMs: 5,
      reviewEnvironment: protocol.reviewEnvironment,
    })).rejects.toMatchObject({ kind: 'job-timeout' })
    expect(page.evaluate.mock.calls.some(([fn]) => fn.toString().includes('abortActive'))).toBe(true)
    expect(page.close).toHaveBeenCalledOnce()
    await boundary.close()
    expect(browser.close).toHaveBeenCalledOnce()
    expect(server.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
