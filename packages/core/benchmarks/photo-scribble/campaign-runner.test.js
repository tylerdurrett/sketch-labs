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
  validateProductionResponse,
} from './browser-boundary.js'
import {
  CampaignOperationError,
  CampaignValidationError,
  runCampaign,
  validateCampaignManifest,
} from './campaign-runner.js'
import protocol from './protocol.json'

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
    forceClose: vi.fn(),
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
    identityHash: 'a'.repeat(64),
    profile: structuredClone(profile),
    fullTuple: { ...tuple },
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
      coordinatorResultDurationMs: 2,
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
      profile: structuredClone(profile),
      resolvedProductionLimits: { ...responseTuple },
      effectiveLimits: { ...tuple },
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
      targetHash: 'd'.repeat(64),
      workerDurationMs: purpose === 'measurement' ? 1 : null,
      preparationCount: 1,
      solverPassCount: 1,
      responseReadyEpochMs: 1,
    },
    presentation: purpose === 'measurement' ? {
      tone: { sha256: 'e'.repeat(64), byteLength: 10 },
      fillCanvas: { sha256: 'f'.repeat(64), byteLength: 10, width: 1000, height: 1000, paintDurationMs: 1, validState: true },
      outlineCanvas: { sha256: '1'.repeat(64), byteLength: 10, width: 1000, height: 1000, derivationDurationMs: 1, paintDurationMs: 1, validState: true },
      exports: {
        png: { sha256: 'f'.repeat(64), byteLength: 10, durationMs: 1 },
        ordinarySvg: { sha256: '2'.repeat(64), byteLength: 10, durationMs: 1, pathCount: 1, containsRasterImage: false, containsDiagnosticMarker: false },
        outlinePlotterSvg: { sha256: '3'.repeat(64), byteLength: 10, durationMs: 1, pathCount: 1, containsRasterImage: false, containsDiagnosticMarker: false },
      },
      geometryAndExportParity: true,
      exportGeometry: {
        ordinaryAuthoritativeHash: '4'.repeat(64),
        ordinaryExportHash: '4'.repeat(64),
        ordinarySvgMatchesAuthoritativeScene: true,
        outlineSceneHash: '5'.repeat(64),
        plotterAuthoritativeHash: '6'.repeat(64),
        plotterExportHash: '6'.repeat(64),
        plotterSvgMatchesOutlineScene: true,
      },
      terminalProgressToDisplayMs: 2,
      uiRoundtrips: { status: 'not-applicable', reason: 'promotion only' },
      capturePayloads: {
        tonePngDataUrl: 'data:image/png;base64,AA==',
        fillPngDataUrl: 'data:image/png;base64,AA==',
        outlinePngDataUrl: 'data:image/png;base64,AA==',
      },
    } : null,
    cancellation: purpose === 'measurement' ? {
      scope: 'direct-coordinator-cancel-after-progress',
      exercisesSupersedingControlEdit: false,
      startedAfterNonTerminalProgress: true,
      coordinatorAcknowledged: true,
      outcome: 'cancelled',
      roundtripMs: 1,
      lateReplacementObserved: false,
    } : null,
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
    resolvedTuple: { ...responseTuple },
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
  it('runs and persists technical inputs without fixture-rights metadata', async () => {
    const root = outputRoot()
    const manifest = screenManifest()
    await runCampaign({
      manifest,
      protocol,
      outputRoot: root,
      boundary: fakeBoundary(),
      inputDigests: { protocolSha256: 'a'.repeat(64) },
    })

    const persisted = JSON.parse(readFileSync(
      resolve(root, manifest.campaignId, 'campaign-manifest.json'),
      'utf8',
    ))
    expect(Object.keys(persisted).sort()).toEqual([
      'campaignId',
      'inputDigests',
      'jobs',
      'phase',
      'schemaVersion',
      'survivorCandidateIds',
    ])
    expect(persisted.inputDigests).toEqual({ protocolSha256: 'a'.repeat(64) })
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

  it('accepts one explicit two-scenario machine-ceiling tuple at a time', () => {
    const manifest = screenManifest({
      phase: 'machine-ceiling',
      jobs: [
        { scenarioId: 'flowers-opaque-fine', candidateId: 'machine-500k' },
        { scenarioId: 'pinecone-dark-alpha-fine', candidateId: 'machine-500k' },
      ],
    })
    const campaign = validateCampaignManifest(manifest, protocol)
    expect(campaign.jobs.map(({ tuple }) => tuple)).toEqual([
      {
        maxAcceptedSegments: 500000,
        maxPolylines: 16000,
        maxStagnations: 32000,
        maxRestarts: 16000,
      },
      {
        maxAcceptedSegments: 500000,
        maxPolylines: 16000,
        maxStagnations: 32000,
        maxRestarts: 16000,
      },
    ])
    manifest.jobs[1].candidateId = 'machine-1000k'
    expect(() => validateCampaignManifest(manifest, protocol)).toThrow(
      'one candidate',
    )
  })

  it('accepts only the adopted production tuple for confirmation', () => {
    const manifest = screenManifest({
      phase: 'confirmation',
      jobs: [
        { scenarioId: 'flowers-opaque-fine', candidateId: 'adopted-production' },
        { scenarioId: 'pinecone-dark-alpha-fine', candidateId: 'adopted-production' },
      ],
    })
    const campaign = validateCampaignManifest(manifest, protocol)
    expect(campaign.jobs.map((job) => ({
      productionMeasurement: job.productionMeasurement,
      expectedTargetHash: job.expectedTargetHash,
      tuple: job.tuple,
    }))).toEqual([
      {
        productionMeasurement: true,
        expectedTargetHash: protocol.adoptedPolicyConfirmation.centeredTargetHashes['flowers-opaque-fine'],
        tuple: {
          maxAcceptedSegments: 1_000_000,
          maxPolylines: 16_000,
          maxStagnations: 32_000,
          maxRestarts: 16_000,
        },
      },
      {
        productionMeasurement: true,
        expectedTargetHash: protocol.adoptedPolicyConfirmation.centeredTargetHashes['pinecone-dark-alpha-fine'],
        tuple: {
          maxAcceptedSegments: 1_000_000,
          maxPolylines: 16_000,
          maxStagnations: 32_000,
          maxRestarts: 16_000,
        },
      },
    ])
    manifest.jobs.reverse()
    expect(() => validateCampaignManifest(manifest, protocol)).toThrow(
      'only the adopted tuple',
    )
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

  it('durably fails and force-closes when the browser boundary never settles', async () => {
    const root = outputRoot()
    const manifest = screenManifest({ jobs: [
      { scenarioId: 'flowers-opaque-fine', candidateId: 'current-fine-baseline' },
      { scenarioId: 'pinecone-dark-alpha-fine', candidateId: 'current-fine-baseline' },
    ] })
    const boundary = fakeBoundary(() => new Promise(() => {}))
    boundary.close.mockImplementation(() => new Promise(() => {}))
    const fastProtocol = structuredClone(protocol)
    fastProtocol.thresholds.jobTimeoutMs = 5

    const result = await runCampaign({
      manifest,
      protocol: fastProtocol,
      outputRoot: root,
      boundary,
      hostWatchdogGraceMs: 5,
      boundaryCleanupTimeoutMs: 5,
    })

    expect(result).toMatchObject({
      completed: [{
        status: 'failed',
        failure: { kind: 'unrecoverable-instability' },
      }],
      stopped: { kind: 'unrecoverable-instability' },
    })
    expect(boundary.runJob).toHaveBeenCalledOnce()
    expect(boundary.restartBrowser).not.toHaveBeenCalled()
    expect(boundary.forceClose).toHaveBeenCalled()
    const checkpoint = JSON.parse(readFileSync(
      resolve(root, manifest.campaignId, 'campaign-checkpoint.json'), 'utf8',
    ))
    expect(checkpoint.completed).toHaveLength(1)
    expect(checkpoint.completed[0]).toMatchObject({ status: 'failed' })
    expect(checkpoint.nextJobKey).toContain('pinecone-dark-alpha-fine')
    const raw = JSON.parse(readFileSync(
      resolve(root, checkpoint.completed[0].rawRecord), 'utf8',
    ))
    expect(raw.failure).toMatchObject({ kind: 'unrecoverable-instability' })
    const summary = JSON.parse(readFileSync(
      resolve(root, checkpoint.completed[0].summary), 'utf8',
    ))
    expect(summary.failure).toEqual(raw.failure)
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
    })
    expect(validateCandidateResponse(responses.candidate, {
      campaignId: responseCampaignId,
      hostRunId: responses.candidateHostRunId,
      scenarioId: 'flowers-opaque-fine',
      imageAssetId: 'img-0672-79d639daec62',
      candidateId: 'current-fine-baseline',
      tuple: responseTuple,
      identityHash: equivalence.production.identityHash,
    })).toBe(responses.candidate)
  })

  it('accepts a one-pass production measurement only when it matches injected equivalence', () => {
    const responses = validResponses()
    const hostRunId = 'host-production-measurement'
    const production = evidenceRun({
      hostRunId,
      runId: `${hostRunId}-measurement`,
      purpose: 'measurement',
      profile: { kind: 'production' },
    })
    production.fullTuple = null
    production.telemetry.resolvedProductionLimits = null
    production.telemetry.effectiveLimits = null
    production.telemetry.productionResolverSelectedEffectiveTuple = null
    production.telemetry.execution = null
    production.telemetry.rawAcceptedSegments = null
    production.telemetry.targetHash = null

    expect(validateProductionResponse(production, {
      campaignId: responseCampaignId,
      hostRunId,
      scenarioId: 'flowers-opaque-fine',
      imageAssetId: 'img-0672-79d639daec62',
      identityHash: responses.equivalence.production.identityHash,
      sceneHash: responses.equivalence.injectedResolvedTuple.result.sceneHash,
      diagnosticsHash: responses.equivalence.injectedResolvedTuple.result.diagnosticsHash,
      label: 'Adopted production measurement',
    })).toBe(production)
    production.result.sceneHash = '9'.repeat(64)
    expect(() => validateProductionResponse(production, {
      campaignId: responseCampaignId,
      hostRunId,
      scenarioId: 'flowers-opaque-fine',
      imageAssetId: 'img-0672-79d639daec62',
      identityHash: 'a'.repeat(64),
      sceneHash: 'b'.repeat(64),
      diagnosticsHash: 'c'.repeat(64),
      label: 'Adopted production measurement',
    })).toThrow('Scene hash does not match')
  })

  it.each([
    ['campaign identity', (run) => { run.campaignId = 'issue-336-20260718T120001Z' }],
    ['host identity', (run) => { run.hostRunId = 'stale-host' }],
    ['scenario', (run) => { run.scenarioId = 'pinecone-dark-alpha-fine' }],
    ['candidate profile', (run) => { run.profile.candidateId = 'fine-100k' }],
    ['four-limit tuple', (run) => { run.fullTuple.maxRestarts++ }],
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
    })).toThrow('stale or inconsistent')
  })

  it.each([
    [
      'lying wrapper booleans',
      (value) => { value.sceneHashMatches = false },
      'wrapper assertions contradict nested evidence',
    ],
    [
      'mismatched nested Scene hashes despite a true wrapper flag',
      (value) => { value.injectedResolvedTuple.result.sceneHash = 'd'.repeat(64) },
      'nested production and injected Scene hashes do not match',
    ],
    [
      'mismatched nested diagnostics hashes despite a true wrapper flag',
      (value) => { value.injectedResolvedTuple.result.diagnosticsHash = 'd'.repeat(64) },
      'nested production and injected diagnostics hashes do not match',
    ],
    [
      'mismatched nested resolved tuples',
      (value) => {
        value.injectedResolvedTuple.telemetry.resolvedProductionLimits.maxRestarts++
      },
      'nested resolved/effective complete tuples do not match',
    ],
    [
      'a mismatched wrapper resolved tuple',
      (value) => { value.resolvedTuple.maxAcceptedSegments++ },
      'nested resolved/effective complete tuples do not match',
    ],
    [
      'mismatched nested effective tuples',
      (value) => {
        value.injectedResolvedTuple.telemetry.effectiveLimits.maxPolylines++
      },
      'telemetry tuple does not match',
    ],
    [
      'a lying resolver-selection flag',
      (value) => {
        value.injectedResolvedTuple.telemetry.productionResolverSelectedEffectiveTuple = false
      },
      'resolver attribution is inconsistent',
    ],
  ])('rejects equivalence authority from %s', (_label, mutate, message) => {
    const { equivalence, equivalenceHostRunId } = structuredClone(validResponses())
    mutate(equivalence)
    expect(() => validateEquivalenceResponse(equivalence, {
      campaignId: responseCampaignId,
      hostRunId: equivalenceHostRunId,
      scenarioId: 'flowers-opaque-fine',
      imageAssetId: 'img-0672-79d639daec62',
    })).toThrow(message)
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
      timeoutMs: 5,
      reviewEnvironment: protocol.reviewEnvironment,
    })).rejects.toMatchObject({ kind: 'job-timeout' })
    expect(page.evaluate.mock.calls.some(([fn]) => fn.toString().includes('abortActive'))).toBe(true)
    expect(page.close).toHaveBeenCalledOnce()
    await boundary.close()
    expect(browser.close).toHaveBeenCalledOnce()
    expect(server.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('force-kills owned browser and server processes without awaiting CDP', async () => {
    const browserProcess = { kill: vi.fn() }
    const browser = {
      isConnected: () => true,
      process: () => browserProcess,
      close: vi.fn(() => new Promise(() => {})),
    }
    const server = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(),
    })
    const boundary = createBrowserBoundary({
      serverFactory: async () => server,
      browserFactory: async () => browser,
      url: 'http://evidence.test',
      fetchImpl: async () => ({ ok: true }),
    })

    await boundary.start()
    boundary.forceClose()

    expect(browserProcess.kill).toHaveBeenCalledWith('SIGKILL')
    expect(server.kill).toHaveBeenCalledWith('SIGKILL')
    await boundary.close()
    expect(browser.close).not.toHaveBeenCalled()
  })
})
