import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { campaignPolicy } from './protocol.js'

const campaignPath = argument('campaign')
const outputDirectory = argument('out-dir')
const campaignSource = readFileSync(campaignPath, 'utf8')
const campaign = JSON.parse(campaignSource)

if (campaign.mode !== 'full') throw new Error('expected a full-mode campaign')
if (campaign.results.length !== 5) throw new Error('expected five finalist jobs')
const expectedFixtureIds = [
  'one-hill-5000',
  'one-hill-10000',
  'full-10000',
  'full-25000',
  'full-50000',
]
if (
  JSON.stringify(campaign.results.map((result) => result.fixtureId)) !==
  JSON.stringify(expectedFixtureIds)
) {
  throw new Error('full campaign fixtures do not match the literal Y3b set')
}
if (
  campaign.results.some(
    (result) => result.candidateId !== 'simplified-stroke-tufts',
  )
) {
  throw new Error('full campaign contains a non-finalist candidate')
}
if (JSON.stringify(campaign.policy) !== JSON.stringify(campaignPolicy('full'))) {
  throw new Error('full campaign policy does not match the fixed protocol')
}

const results = campaign.results.map((result) => {
  if (result.status !== 'ok') {
    return {
      fixtureId: result.fixtureId,
      status: result.status,
      censor: result.censor,
    }
  }

  const representativeMetrics = result.phases.preparation.samples[0].metrics
  return {
    fixtureId: result.fixtureId,
    status: 'ok',
    phaseTimingMs: Object.fromEntries(
      Object.entries(result.phases).map(([name, phase]) => {
        const durations = phase.samples.map((sample) => sample.durationMs)
        return [
          name,
          {
            sampleCount: durations.length,
            min: Math.min(...durations),
            median: median(durations),
            max: Math.max(...durations),
          },
        ]
      }),
    ),
    maxRssBytes: Math.max(
      ...Object.values(result.phases).flatMap((phase) =>
        phase.samples.map((sample) => sample.memory.after.maxRssBytes),
      ),
    ),
    representativeMetrics,
    runtime: result.runtime,
  }
})

const recordedAt = '2026-07-15'
const report = {
  recordedAt,
  candidate: {
    id: 'simplified-stroke-tufts',
    representation: 'open six-point blades/stable five-member tufts',
    occluderMode: 'hill-and-clump',
    densityMode: 'plotter-lod',
  },
  evidence: {
    campaignRaw: {
      file: `simplified-full-${recordedAt}.campaign-raw.json`,
      contract:
        'verbatim full-mode envelope with every timing/memory sample and collector result',
    },
    artifactManifest: {
      file: `simplified-full-${recordedAt}.svg-manifest.json`,
      contract:
        'checksums and inventories for reproducible /tmp fill/Outline SVGs',
    },
  },
  campaign: {
    protocolVersion: campaign.protocolVersion,
    mode: campaign.mode,
    policy: campaign.policy,
    resultCount: campaign.results.length,
    completedCount: campaign.results.filter((result) => result.status === 'ok')
      .length,
    censoredCount: campaign.results.filter(
      (result) => result.status === 'censored',
    ).length,
  },
  results,
}

const directory = resolve(outputDirectory)
mkdirSync(directory, { recursive: true })
const outputs = {
  summary: resolve(directory, `simplified-full-${recordedAt}.json`),
  campaign: resolve(
    directory,
    `simplified-full-${recordedAt}.campaign-raw.json`,
  ),
}
writeFileSync(outputs.summary, `${JSON.stringify(report, null, 2)}\n`)
writeFileSync(outputs.campaign, campaignSource)
process.stdout.write(`${JSON.stringify(outputs, null, 2)}\n`)

function argument(name) {
  const prefix = `--${name}=`
  const value = process.argv.find((item) => item.startsWith(prefix))?.slice(
    prefix.length,
  )
  if (!value) throw new Error(`${prefix}<path> is required`)
  return value
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}
