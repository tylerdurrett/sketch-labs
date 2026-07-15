import { readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

import { bundleCandidate } from './candidate-bundle.js'
import {
  ARTIFACT_DIRECTORY,
  FINALIST_ID,
  FULL_FINALIST_FIXTURES,
  fullFinalistJobs,
  summarizeResult,
} from './exact-finalist-full.js'
import { HISTORICAL_BASELINE } from './fixtures.js'
import {
  LONG_CAMPAIGN_CONFIRMATION,
  validateCampaignRequest,
} from './protocol.js'

describe('exact finalist full-campaign reproduction', () => {
  it('pins the sole finalist and exactly five literal dense fixtures', () => {
    expect(FINALIST_ID).toBe('exact-stratified-7')
    expect(FULL_FINALIST_FIXTURES.map((fixture) => fixture.id)).toEqual([
      'one-hill-5000',
      'one-hill-10000',
      'full-10000',
      'full-25000',
      'full-50000',
    ])
    expect(ARTIFACT_DIRECTORY).toBe('/tmp/issue-305-x3b-exact-stratified-7')

    const campaign = validateCampaignRequest({
      mode: 'full',
      confirmation: LONG_CAMPAIGN_CONFIRMATION,
      jobs: fullFinalistJobs('file:///tmp/exact-stratified-7.mjs'),
    })
    expect(campaign.mode).toBe('full')
    expect(campaign.policy).toMatchObject({
      timeoutMs: 600_000,
      memoryMiB: 2_048,
      samples: { preparation: 20, cold: 20, warm: 60, warmups: 3 },
    })
    expect(new Set(campaign.jobs.map((job) => job.candidate.id))).toEqual(
      new Set(['exact-stratified-7']),
    )
  })

  it('retains censored full-run results without manufacturing metrics', () => {
    expect(
      summarizeResult({
        candidateId: FINALIST_ID,
        fixtureId: 'full-50000',
        status: 'censored',
        censor: { kind: 'oom', reason: 'bounded evidence' },
      }),
    ).toEqual({
      candidateId: FINALIST_ID,
      fixtureId: 'full-50000',
      status: 'censored',
      censor: { kind: 'oom', reason: 'bounded evidence' },
      artifacts: undefined,
    })
  })

  it('persists complete five-fixture evidence and checksum-pinned artifacts', () => {
    const raw = readJson('./results/exact-stratified-7-full.raw.json')
    const summary = readJson('./results/exact-stratified-7-full.summary.json')
    const manifest = readJson(
      './results/exact-stratified-7-full.artifacts.json',
    )
    const expectedFixtures = FULL_FINALIST_FIXTURES.map((fixture) => fixture.id)

    expect(raw.mode).toBe('full')
    expect(raw.policy).toMatchObject({
      timeoutMs: 600_000,
      memoryMiB: 2_048,
      samples: { preparation: 20, cold: 20, warm: 60, warmups: 3 },
    })
    expect(raw.results.map((result) => result.fixtureId)).toEqual(
      expectedFixtures,
    )
    expect(raw.results.every((result) => result.status === 'ok')).toBe(true)
    expect(summary.results.map((result) => result.fixtureId)).toEqual(
      expectedFixtures,
    )
    expect(
      summary.results.every(
        (result) =>
          result.metrics.identity.rootKeyCount === result.metrics.rootCount &&
          result.metrics.identity.rootKeys === undefined,
      ),
    ).toBe(true)
    expect(manifest.artifacts.map((artifact) => artifact.fixtureId)).toEqual(
      expectedFixtures,
    )
    for (const artifact of manifest.artifacts) {
      expect(artifact.fillSvg.path).toBe(
        `${ARTIFACT_DIRECTORY}/${artifact.fixtureId}.fill.svg`,
      )
      expect(artifact.outlineSvg.path).toBe(
        `${ARTIFACT_DIRECTORY}/${artifact.fixtureId}.outline.svg`,
      )
      expect(artifact.fillSvg.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(artifact.outlineSvg.sha256).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it('bundles byte-deterministic fill and Outline artifact regeneration', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'exact-finalist-artifacts-'))
    const outputPath = join(directory, 'candidate.mjs')
    try {
      await bundleCandidate({
        entryPath: new URL('./exact-stratified-7.js', import.meta.url).pathname,
        outputPath,
      })
      const module = await import(`${pathToFileURL(outputPath).href}?test=1`)
      const first = module.generateExactStratified7Artifacts(
        HISTORICAL_BASELINE.payload,
      )
      const second = module.generateExactStratified7Artifacts(
        HISTORICAL_BASELINE.payload,
      )
      expect(first.fillSvg).toBe(second.fillSvg)
      expect(first.outlineSvg).toBe(second.outlineSvg)
      expect(first.fillSvg).toContain('<svg')
      expect(first.outlineSvg).toContain('<svg')
      expect(first.sourceScene.primitives).toHaveLength(410)
      expect(first.processing.stats.contract).toBe(
        'exact-painter-order/uniform-aabb-grid/production-polygon-clip',
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'))
}
