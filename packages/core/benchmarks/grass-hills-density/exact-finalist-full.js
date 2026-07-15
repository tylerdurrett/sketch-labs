import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { bundleCandidate } from './candidate-bundle.js'
import { DENSITY_FIXTURES } from './fixtures.js'
import { LONG_CAMPAIGN_CONFIRMATION } from './protocol.js'
import { runCampaign } from './runner.js'

export const FINALIST_ID = 'exact-stratified-7'
export const FULL_FINALIST_FIXTURES = Object.freeze(DENSITY_FIXTURES.slice(1))
export const ARTIFACT_DIRECTORY = '/tmp/issue-305-x3b-exact-stratified-7'

const DIRECTORY = fileURLToPath(new URL('.', import.meta.url))
const RESULTS_DIRECTORY = fileURLToPath(new URL('./results/', import.meta.url))
const RAW_RESULT_PATH = `${RESULTS_DIRECTORY}exact-stratified-7-full.raw.json`
const SUMMARY_RESULT_PATH = `${RESULTS_DIRECTORY}exact-stratified-7-full.summary.json`
const ARTIFACT_MANIFEST_PATH = `${RESULTS_DIRECTORY}exact-stratified-7-full.artifacts.json`
const BUNDLE_PATH = `${ARTIFACT_DIRECTORY}/candidate.mjs`

export function fullFinalistJobs(moduleUrl) {
  return FULL_FINALIST_FIXTURES.map((fixture) => ({
    candidate: {
      id: FINALIST_ID,
      moduleUrl,
      complexity: 'linear',
    },
    fixture,
  }))
}

export async function runExactFinalistFull() {
  mkdirSync(RESULTS_DIRECTORY, { recursive: true })
  mkdirSync(ARTIFACT_DIRECTORY, { recursive: true })
  await bundleCandidate({
    entryPath: `${DIRECTORY}exact-stratified-7.js`,
    outputPath: BUNDLE_PATH,
  })

  const started = performance.now()
  const campaign = await runCampaign({
    mode: 'full',
    confirmation: LONG_CAMPAIGN_CONFIRMATION,
    jobs: fullFinalistJobs(pathToFileURL(BUNDLE_PATH).href),
  })
  const campaignDurationMs = performance.now() - started
  writeJson(RAW_RESULT_PATH, campaign)

  const artifacts = await generateArtifacts(BUNDLE_PATH)
  const manifest = {
    schemaVersion: 1,
    candidateId: FINALIST_ID,
    capturedOn: '2026-07-15',
    artifactDirectory: ARTIFACT_DIRECTORY,
    bundle: fileEvidence(BUNDLE_PATH),
    reproduction: {
      command:
        'node packages/core/benchmarks/grass-hills-density/exact-finalist-full.js',
      workingDirectory: 'repository root',
      mode: 'full',
      confirmation: LONG_CAMPAIGN_CONFIRMATION,
    },
    artifacts,
  }
  writeJson(ARTIFACT_MANIFEST_PATH, manifest)

  const summary = buildSummary(campaign, manifest, campaignDurationMs)
  writeJson(SUMMARY_RESULT_PATH, summary)
  console.log(JSON.stringify(summary, null, 2))
  return { campaign, summary, manifest }
}

export function refreshExactFinalistSummary() {
  const campaign = JSON.parse(readFileSync(RAW_RESULT_PATH, 'utf8'))
  const manifest = JSON.parse(readFileSync(ARTIFACT_MANIFEST_PATH, 'utf8'))
  const previousSummary = JSON.parse(readFileSync(SUMMARY_RESULT_PATH, 'utf8'))
  const summary = buildSummary(
    campaign,
    manifest,
    previousSummary.campaignDurationMs,
  )
  writeJson(SUMMARY_RESULT_PATH, summary)
  return summary
}

function buildSummary(campaign, manifest, campaignDurationMs) {
  return {
    schemaVersion: 1,
    candidateId: FINALIST_ID,
    capturedOn: '2026-07-15',
    campaignDurationMs,
    protocolVersion: campaign.protocolVersion,
    mode: campaign.mode,
    policy: campaign.policy,
    artifactManifest: relativeResultPath(ARTIFACT_MANIFEST_PATH),
    rawResult: relativeResultPath(RAW_RESULT_PATH),
    results: campaign.results.map((result) =>
      summarizeResult(result, manifest.artifacts),
    ),
  }
}

export function summarizeResult(result, artifacts = []) {
  if (result.status !== 'ok') {
    return {
      candidateId: result.candidateId,
      fixtureId: result.fixtureId,
      status: result.status,
      censor: result.censor,
      artifacts: artifacts.find((item) => item.fixtureId === result.fixtureId),
    }
  }

  return {
    candidateId: result.candidateId,
    fixtureId: result.fixtureId,
    status: result.status,
    runtime: result.runtime,
    phases: Object.fromEntries(
      Object.entries(result.phases).map(([phase, measurement]) => [
        phase,
        summarizePhase(measurement.samples),
      ]),
    ),
    metrics: summarizeMetrics(result.phases.cold.samples[0].metrics),
    artifacts: artifacts.find((item) => item.fixtureId === result.fixtureId),
  }
}

function summarizeMetrics(metrics) {
  const { rootKeys, ...identity } = metrics.identity
  return {
    ...metrics,
    identity: {
      ...identity,
      rootKeyCount: rootKeys.length,
      rootKeysSha256: checksumJson(rootKeys),
      rootKeysEvidence: relativeResultPath(RAW_RESULT_PATH),
    },
  }
}

async function generateArtifacts(bundlePath) {
  const { generateExactStratified7Artifacts } = await import(
    `${pathToFileURL(bundlePath).href}?artifacts=${Date.now()}`
  )
  const artifacts = []
  for (const fixture of FULL_FINALIST_FIXTURES) {
    const generated = generateExactStratified7Artifacts(
      fixture.payload,
      fixture.payload.t,
    )
    const fillPath = `${ARTIFACT_DIRECTORY}/${fixture.id}.fill.svg`
    const outlinePath = `${ARTIFACT_DIRECTORY}/${fixture.id}.outline.svg`
    writeFileSync(fillPath, generated.fillSvg)
    writeFileSync(outlinePath, generated.outlineSvg)
    artifacts.push({
      fixtureId: fixture.id,
      sourceSceneChecksum: checksumJson(generated.sourceScene),
      fillSceneChecksum: checksumJson(generated.fillScene),
      outlineSceneChecksum: checksumJson(generated.outlineScene),
      fillSvg: fileEvidence(fillPath),
      outlineSvg: fileEvidence(outlinePath),
      processingDurationMs: generated.processing.durationMs,
      exactSpatialHiddenLine: generated.processing.stats,
    })
  }
  return artifacts
}

function summarizePhase(samples) {
  return {
    sampleCount: samples.length,
    durationMs: distribution(samples.map((sample) => sample.durationMs)),
    heapUsedAfterBytes: distribution(
      samples.map((sample) => sample.memory.after.heapUsedBytes),
    ),
    rssAfterBytes: distribution(
      samples.map((sample) => sample.memory.after.rssBytes),
    ),
    maxRssAfterBytes: distribution(
      samples.map((sample) => sample.memory.after.maxRssBytes),
    ),
    heapUsedDeltaBytes: distribution(
      samples.map((sample) => sample.memory.heapUsedDeltaBytes),
    ),
    rssDeltaBytes: distribution(
      samples.map((sample) => sample.memory.rssDeltaBytes),
    ),
  }
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    min: sorted[0],
    p05: percentile(sorted, 0.05),
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1),
  }
}

function percentile(sorted, quantile) {
  const index = (sorted.length - 1) * quantile
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
}

function fileEvidence(path) {
  const bytes = readFileSync(path)
  return {
    path,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function checksumJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function relativeResultPath(path) {
  return `results/${path.slice(RESULTS_DIRECTORY.length)}`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--summary-only')) {
    console.log(JSON.stringify(refreshExactFinalistSummary(), null, 2))
  } else {
    await runExactFinalistFull()
  }
}
