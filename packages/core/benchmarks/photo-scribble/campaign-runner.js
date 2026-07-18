import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'

const SCHEMA_VERSION = 1
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/

export class CampaignValidationError extends Error {}

export class CampaignOperationError extends Error {
  constructor(kind, message, partial = {}) {
    super(message)
    this.kind = kind
    this.partial = partial
  }
}

function assert(condition, message) {
  if (!condition) throw new CampaignValidationError(message)
}

function tupleFor(candidate) {
  return {
    maxAcceptedSegments: candidate.maxAcceptedSegments,
    maxPolylines: candidate.maxPolylines,
    maxStagnations: candidate.maxStagnations,
    maxRestarts: candidate.maxRestarts,
  }
}

export function tupleToken(candidate) {
  const tuple = tupleFor(candidate)
  return `s${tuple.maxAcceptedSegments}-p${tuple.maxPolylines}-g${tuple.maxStagnations}-r${tuple.maxRestarts}`
}

function validateRightsEvidence(value, fixtureIds, protocol) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value),
    'A structured rightsEvidence record is required before campaign execution')
  assert(protocol.rightsGate.acceptedEvidence.includes(value.kind),
    'rightsEvidence does not use a form accepted by the frozen protocol')
  assert(typeof value.evidenceId === 'string' && value.evidenceId.trim().length >= 8,
    'rightsEvidence.evidenceId must be an auditable identifier')

  if (value.kind === 'dated-maintainer-attestation-of-ownership-and-redistribution-rights') {
    const keys = Object.keys(value).sort().join(',')
    assert(keys === [
      'attestedAt',
      'evidenceId',
      'grantsRedistributionRights',
      'kind',
      'ownsEverySelectedFixture',
    ].join(','), 'Maintainer rights attestation has unexpected or missing fields')
    assert(/^\d{4}-\d{2}-\d{2}$/.test(value.attestedAt ?? '') &&
      Number.isFinite(Date.parse(`${value.attestedAt}T00:00:00Z`)),
    'Maintainer rights attestation must contain a valid date')
    assert(value.ownsEverySelectedFixture === true &&
      value.grantsRedistributionRights === true,
    'Maintainer rights attestation does not cover ownership and redistribution')
  } else {
    const keys = Object.keys(value).sort().join(',')
    assert(keys === [
      'evidenceId',
      'fixtureIds',
      'kind',
      'license',
      'provenanceRecord',
      'rightsBasis',
    ].join(','), 'Replacement-fixture rights record has unexpected or missing fields')
    assert(Array.isArray(value.fixtureIds) && fixtureIds.every((id) => value.fixtureIds.includes(id)),
      'Replacement-fixture rights record does not cover every selected fixture')
    assert(typeof value.provenanceRecord === 'string' && value.provenanceRecord.trim().length >= 8,
      'Replacement-fixture rights record lacks durable provenance')
    assert(value.rightsBasis === 'owned' || value.rightsBasis === 'compatible-license',
      'Replacement-fixture rights basis is invalid')
    assert(value.rightsBasis === 'owned'
      ? value.license === null
      : typeof value.license === 'string' && value.license.trim().length >= 2,
    'Replacement-fixture license does not match its rights basis')
  }
  return structuredClone(value)
}

function jobKey(job) {
  return `${job.scenarioId}/${job.candidateId}--${job.tupleToken}`
}

/** Validate before starting Vite or writing even a campaign manifest. */
export function validateCampaignManifest(input, protocol) {
  assert(input !== null && typeof input === 'object' && !Array.isArray(input),
    'Campaign manifest must be an object')
  assert(input.schemaVersion === SCHEMA_VERSION, 'Campaign manifest schemaVersion must be 1')
  assert(typeof input.campaignId === 'string' &&
    new RegExp(`^(?:${protocol.evidenceNaming.campaignIdPattern})$`).test(input.campaignId),
  'Campaign ID does not match the frozen protocol pattern')
  assert(input.phase === 'screen' || input.phase === 'promotion',
    'Campaign phase must be screen or promotion')
  assert(Array.isArray(input.jobs) && input.jobs.length > 0,
    'Campaign manifest must contain at least one explicit job')

  const scenarios = new Map(protocol.scenarios.map((scenario) => [scenario.scenarioId, scenario]))
  const candidates = new Map(protocol.orderedLimitCandidates.map((candidate) => [candidate.candidateId, candidate]))
  const jobs = input.jobs.map((inputJob, index) => {
    assert(inputJob !== null && typeof inputJob === 'object' && !Array.isArray(inputJob),
      `Job ${index} must be an object`)
    assert(SAFE_ID.test(inputJob.scenarioId ?? ''), `Job ${index} scenario ID is unsafe`)
    assert(SAFE_ID.test(inputJob.candidateId ?? ''), `Job ${index} candidate ID is unsafe`)
    const scenario = scenarios.get(inputJob.scenarioId)
    const candidate = candidates.get(inputJob.candidateId)
    assert(scenario !== undefined, `Job ${index} names unknown scenario ${inputJob.scenarioId}`)
    assert(candidate !== undefined, `Job ${index} names unknown candidate ${inputJob.candidateId}`)
    if (input.phase === 'screen') {
      assert(scenario.roles.includes('budget-calibration'),
        `Screen job ${index} is not a fine budget-calibration scenario`)
    }
    return Object.freeze({
      ordinal: index + 1,
      scenarioId: scenario.scenarioId,
      fixtureId: scenario.fixtureId,
      captureStem: scenario.captureStem,
      candidateId: candidate.candidateId,
      tuple: Object.freeze(tupleFor(candidate)),
      tupleToken: tupleToken(candidate),
    })
  })
  const keys = jobs.map(jobKey)
  assert(new Set(keys).size === keys.length,
    'Campaign contains a duplicate scenario/candidate/tuple job')

  let survivorCandidateIds = null
  if (input.phase === 'promotion') {
    assert(Array.isArray(input.survivorCandidateIds) && input.survivorCandidateIds.length > 0,
      'Promotion requires an explicit non-empty survivorCandidateIds allow-list')
    survivorCandidateIds = [...input.survivorCandidateIds]
    assert(new Set(survivorCandidateIds).size === survivorCandidateIds.length,
      'Promotion survivorCandidateIds contains duplicates')
    for (const id of survivorCandidateIds) {
      assert(candidates.has(id), `Promotion survivor ${id} is not a frozen candidate`)
    }
    const required = new Set()
    for (const id of survivorCandidateIds) {
      for (const scenario of protocol.scenarios) {
        required.add(`${scenario.scenarioId}/${id}--${tupleToken(candidates.get(id))}`)
      }
    }
    assert(required.size === keys.length && keys.every((key) => required.has(key)),
      'Promotion jobs must cover every frozen scenario exactly once for every explicit survivor')
  } else {
    assert(input.survivorCandidateIds === undefined,
      'Screen manifests cannot preselect promotion survivors')
  }

  const fixtureIds = [...new Set(jobs.map((job) => job.fixtureId))]
  const rightsEvidence = validateRightsEvidence(input.rightsEvidence, fixtureIds, protocol)
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    campaignId: input.campaignId,
    phase: input.phase,
    rightsEvidence: Object.freeze(rightsEvidence),
    survivorCandidateIds: survivorCandidateIds === null ? null : Object.freeze(survivorCandidateIds),
    jobs: Object.freeze(jobs),
  })
}

function containedPath(root, ...parts) {
  const target = resolve(root, ...parts)
  const fromRoot = relative(resolve(root), target)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || fromRoot === '') {
    if (parts.length > 0 && fromRoot === '') return target
    throw new CampaignValidationError('Evidence path escaped or collapsed its root')
  }
  return target
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function exclusiveAtomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  writeFileSync(temporary, json(value), { flag: 'wx' })
  try {
    linkSync(temporary, path)
  } finally {
    unlinkSync(temporary)
  }
}

function replaceAtomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  writeFileSync(temporary, json(value), { flag: 'wx' })
  renameSync(temporary, path)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function artifactBase(job) {
  return `${job.captureStem}--${job.candidateId}--${job.tupleToken}`
}

export function createCampaignStore(outputRoot, campaign, provenance = {}) {
  const campaignRoot = containedPath(outputRoot, campaign.campaignId)
  const manifestPath = containedPath(campaignRoot, 'campaign-manifest.json')
  const checkpointPath = containedPath(campaignRoot, 'campaign-checkpoint.json')
  const persistedManifest = {
    schemaVersion: SCHEMA_VERSION,
    campaignId: campaign.campaignId,
    phase: campaign.phase,
    rightsEvidence: campaign.rightsEvidence,
    survivorCandidateIds: campaign.survivorCandidateIds,
    jobs: campaign.jobs.map(({ scenarioId, candidateId, tuple }) => ({
      scenarioId,
      candidateId,
      tuple,
    })),
    provenance,
  }

  function initialize() {
    mkdirSync(campaignRoot, { recursive: true })
    if (existsSync(manifestPath)) {
      assert(json(readJson(manifestPath)) === json(persistedManifest),
        `Campaign ${campaign.campaignId} already exists with a different manifest or provenance`)
    } else {
      exclusiveAtomicJson(manifestPath, persistedManifest)
    }
  }

  function paths(job) {
    const directory = containedPath(
      campaignRoot,
      job.scenarioId,
      `${job.candidateId}--${job.tupleToken}`,
    )
    const base = artifactBase(job)
    return {
      directory,
      raw: containedPath(directory, `${base}--attempt-0001.raw.json`),
      summary: containedPath(directory, `${base}--attempt-0001.summary.json`),
    }
  }

  function recover(job) {
    const artifactPaths = paths(job)
    if (!existsSync(artifactPaths.raw)) return null
    const raw = readJson(artifactPaths.raw)
    let summary
    if (existsSync(artifactPaths.summary)) {
      summary = readJson(artifactPaths.summary)
    } else {
      summary = summarizeRawRecord(raw)
      exclusiveAtomicJson(artifactPaths.summary, summary)
    }
    return { raw, summary, paths: artifactPaths }
  }

  function commit(job, raw) {
    const artifactPaths = paths(job)
    exclusiveAtomicJson(artifactPaths.raw, raw)
    const summary = summarizeRawRecord(raw)
    exclusiveAtomicJson(artifactPaths.summary, summary)
    checkpoint()
    return { raw, summary, paths: artifactPaths }
  }

  function checkpoint() {
    const completed = []
    for (const job of campaign.jobs) {
      const recovered = recover(job)
      if (recovered !== null) {
        completed.push({
          jobKey: jobKey(job),
          status: recovered.raw.status,
          rawRecord: relative(outputRoot, recovered.paths.raw),
          summary: relative(outputRoot, recovered.paths.summary),
        })
      }
    }
    replaceAtomicJson(checkpointPath, {
      schemaVersion: SCHEMA_VERSION,
      campaignId: campaign.campaignId,
      completed,
      nextJobKey: (() => {
        const next = campaign.jobs.find(
          (job) => !completed.some((entry) => entry.jobKey === jobKey(job)),
        )
        return next === undefined ? null : jobKey(next)
      })(),
      updatedAt: new Date().toISOString(),
    })
  }

  function cleanupEmptyCampaign() {
    if (!existsSync(manifestPath)) rmSync(campaignRoot, { recursive: true, force: true })
  }

  return { campaignRoot, initialize, recover, commit, checkpoint, cleanupEmptyCampaign }
}

function summarizeRawRecord(raw) {
  return {
    schemaVersion: SCHEMA_VERSION,
    campaignId: raw.campaignId,
    phase: raw.phase,
    job: raw.job,
    status: raw.status,
    failure: raw.failure,
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    equivalence: raw.equivalence === null ? null : {
      identityHashMatches: raw.equivalence.identityHashMatches,
      productionResolverSelectedTuple: raw.equivalence.productionResolverSelectedTuple,
      sceneHashMatches: raw.equivalence.sceneHashMatches,
      diagnosticsHashMatches: raw.equivalence.diagnosticsHashMatches,
    },
    observation: raw.observation === null ? null : {
      runId: raw.observation.runId,
      termination: raw.observation.result?.diagnostics?.termination ?? null,
      residualError: raw.observation.result?.diagnostics?.residualError ?? null,
      mainWallDurationMs: raw.observation.measurement?.mainWallDurationMs ?? null,
    },
    note: 'Raw observations are preserved in the sibling .raw.json file; this summary makes no adoption decision.',
  }
}

function normalizedFailure(error) {
  if (error instanceof CampaignOperationError) {
    return { kind: error.kind, message: error.message, restartBrowser: [
      'job-timeout',
      'campaign-aborted',
      'page-crash',
      'browser-lost',
      'suspected-oom',
    ].includes(error.kind), partial: error.partial }
  }
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  let kind = 'runner-failure'
  if (lower.includes('out of memory') || lower.includes('oom') || lower.includes('memory pressure')) {
    kind = 'suspected-oom'
  } else if (lower.includes('target closed') || lower.includes('page crashed') || lower.includes('session closed')) {
    kind = 'page-crash'
  } else if (lower.includes('browser') && (lower.includes('closed') || lower.includes('disconnect'))) {
    kind = 'browser-lost'
  } else if (lower.includes('worker')) {
    kind = 'worker-failure'
  }
  return {
    kind,
    message: message.slice(0, 1000),
    restartBrowser: ['page-crash', 'browser-lost', 'suspected-oom'].includes(kind),
    partial: error !== null && typeof error === 'object' && error.partial !== undefined
      ? error.partial
      : {},
  }
}

/** Serial by construction: the next job starts only after durable commit. */
export async function runCampaign({ manifest, protocol, outputRoot, boundary, provenance = {}, signal }) {
  const campaign = validateCampaignManifest(manifest, protocol)
  const store = createCampaignStore(outputRoot, campaign, provenance)
  store.initialize()
  const completed = []
  let boundaryAttempted = false
  try {
    boundaryAttempted = true
    await boundary.start()
    for (const job of campaign.jobs) {
      const recovered = store.recover(job)
      if (recovered !== null) {
        completed.push(recovered.summary)
        continue
      }
      const startedAt = new Date().toISOString()
      let raw
      try {
        if (signal?.aborted) {
          throw new CampaignOperationError('campaign-aborted', 'Campaign was aborted before the job started')
        }
        const result = await boundary.runJob({
          job,
          rightsEvidence: campaign.rightsEvidence,
          timeoutMs: protocol.thresholds.jobTimeoutMs,
          reviewEnvironment: protocol.reviewEnvironment,
          signal,
        })
        raw = {
          schemaVersion: SCHEMA_VERSION,
          campaignId: campaign.campaignId,
          phase: campaign.phase,
          job,
          rightsEvidence: campaign.rightsEvidence,
          status: 'completed',
          failure: null,
          startedAt,
          finishedAt: new Date().toISOString(),
          equivalence: result.equivalence,
          observation: result.observation,
          runtime: result.runtime ?? null,
        }
      } catch (error) {
        const failure = normalizedFailure(error)
        raw = {
          schemaVersion: SCHEMA_VERSION,
          campaignId: campaign.campaignId,
          phase: campaign.phase,
          job,
          rightsEvidence: campaign.rightsEvidence,
          status: 'failed',
          failure: { kind: failure.kind, message: failure.message },
          startedAt,
          finishedAt: new Date().toISOString(),
          equivalence: failure.partial.equivalence ?? null,
          observation: failure.partial.observation ?? null,
          runtime: failure.partial.runtime ?? null,
        }
        if (failure.restartBrowser) await boundary.restartBrowser()
      }
      const committed = store.commit(job, raw)
      completed.push(committed.summary)
    }
    store.checkpoint()
    return { campaignId: campaign.campaignId, phase: campaign.phase, completed }
  } finally {
    if (boundaryAttempted) await boundary.close()
  }
}

export function classifyOperationError(error) {
  return normalizedFailure(error)
}
