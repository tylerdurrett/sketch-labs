import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createBrowserBoundary } from './browser-boundary.js'
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
