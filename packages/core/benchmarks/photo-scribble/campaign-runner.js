import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'

const SCHEMA_VERSION = 1
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/
const HOST_WATCHDOG_GRACE_MS = 5_000
const BOUNDARY_CLEANUP_TIMEOUT_MS = 2_000

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
  assert(
    input.phase === 'screen' || input.phase === 'promotion' ||
      input.phase === 'machine-ceiling',
    'Campaign phase must be screen, promotion, or machine-ceiling',
  )
  assert(Array.isArray(input.jobs) && input.jobs.length > 0,
    'Campaign manifest must contain at least one explicit job')

  const scenarios = new Map(protocol.scenarios.map((scenario) => [scenario.scenarioId, scenario]))
  const machineCeilingCandidates = protocol.machineCeilingCandidates ?? []
  const candidates = new Map(
    [...protocol.orderedLimitCandidates, ...machineCeilingCandidates]
      .map((candidate) => [candidate.candidateId, candidate]),
  )
  const jobs = input.jobs.map((inputJob, index) => {
    assert(inputJob !== null && typeof inputJob === 'object' && !Array.isArray(inputJob),
      `Job ${index} must be an object`)
    assert(SAFE_ID.test(inputJob.scenarioId ?? ''), `Job ${index} scenario ID is unsafe`)
    assert(SAFE_ID.test(inputJob.candidateId ?? ''), `Job ${index} candidate ID is unsafe`)
    const scenario = scenarios.get(inputJob.scenarioId)
    const candidate = candidates.get(inputJob.candidateId)
    assert(scenario !== undefined, `Job ${index} names unknown scenario ${inputJob.scenarioId}`)
    assert(candidate !== undefined, `Job ${index} names unknown candidate ${inputJob.candidateId}`)
    if (input.phase === 'screen' || input.phase === 'machine-ceiling') {
      assert(scenario.roles.includes('budget-calibration'),
        `${input.phase} job ${index} is not a fine budget-calibration scenario`)
    }
    return Object.freeze({
      ordinal: index + 1,
      scenarioId: scenario.scenarioId,
      fixtureId: scenario.fixtureId,
      imageAssetId: scenario.params.imageAsset,
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
  if (input.phase === 'screen') {
    assert(input.survivorCandidateIds === undefined,
      'Screen manifests cannot preselect promotion survivors')
    const fineScenarios = protocol.scenarios.filter(
      (scenario) => scenario.roles.includes('budget-calibration'),
    )
    const frozenOrder = protocol.orderedLimitCandidates.flatMap((candidate) =>
      fineScenarios.map((scenario) =>
        `${scenario.scenarioId}/${candidate.candidateId}--${tupleToken(candidate)}`,
      ),
    )
    assert(keys.every((key, index) => key === frozenOrder[index]),
      'Screen jobs must be a non-empty prefix of the frozen candidate/scenario order')
  } else if (input.phase === 'machine-ceiling') {
    assert(input.survivorCandidateIds === undefined,
      'Machine-ceiling manifests cannot preselect promotion survivors')
    const fineScenarios = protocol.scenarios.filter(
      (scenario) => scenario.roles.includes('budget-calibration'),
    )
    assert(jobs.length === fineScenarios.length,
      'Machine-ceiling manifests must contain both fine scenarios exactly once')
    const candidateId = jobs[0]?.candidateId
    assert(machineCeilingCandidates.some((candidate) => candidate.candidateId === candidateId),
      'Machine-ceiling manifest candidate is not in the explicit machine sequence')
    const candidate = candidates.get(candidateId)
    const required = fineScenarios.map((scenario) =>
      `${scenario.scenarioId}/${candidateId}--${tupleToken(candidate)}`,
    )
    assert(keys.every((key, index) => key === required[index]),
      'Machine-ceiling jobs must contain the two fine scenarios in frozen order for one candidate')
  } else {
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
  }

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    campaignId: input.campaignId,
    phase: input.phase,
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

export function createCampaignStore(outputRoot, campaign, inputDigests = {}) {
  const campaignRoot = containedPath(outputRoot, campaign.campaignId)
  const manifestPath = containedPath(campaignRoot, 'campaign-manifest.json')
  const checkpointPath = containedPath(campaignRoot, 'campaign-checkpoint.json')
  const failureDirectory = containedPath(campaignRoot, 'campaign-failures')
  const persistedManifest = {
    schemaVersion: SCHEMA_VERSION,
    campaignId: campaign.campaignId,
    phase: campaign.phase,
    survivorCandidateIds: campaign.survivorCandidateIds,
    jobs: campaign.jobs.map(({ scenarioId, candidateId, tuple }) => ({
      scenarioId,
      candidateId,
      tuple,
    })),
    inputDigests,
  }

  function initialize() {
    mkdirSync(campaignRoot, { recursive: true })
    if (existsSync(manifestPath)) {
      assert(json(readJson(manifestPath)) === json(persistedManifest),
        `Campaign ${campaign.campaignId} already exists with different inputs or digests`)
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
      campaignFailures: existsSync(failureDirectory)
        ? readdirSync(failureDirectory)
          .filter((name) => name.endsWith('.raw.json'))
          .sort()
          .map((name) => relative(outputRoot, containedPath(failureDirectory, name)))
        : [],
      updatedAt: new Date().toISOString(),
    })
  }

  function recordCampaignFailure(job, failure) {
    const safeJob = jobKey(job).replaceAll('/', '--')
    const path = containedPath(
      failureDirectory,
      `restart-after--${safeJob}--attempt-0001.raw.json`,
    )
    exclusiveAtomicJson(path, {
      schemaVersion: SCHEMA_VERSION,
      campaignId: campaign.campaignId,
      kind: 'browser-restart-failed',
      afterJobKey: jobKey(job),
      failure,
      recordedAt: new Date().toISOString(),
      resume: 'The failed job is durable. Start the same campaign again; the next job remains pending.',
    })
    checkpoint()
    return path
  }

  function cleanupEmptyCampaign() {
    if (!existsSync(manifestPath)) rmSync(campaignRoot, { recursive: true, force: true })
  }

  return {
    campaignRoot,
    initialize,
    recover,
    commit,
    checkpoint,
    recordCampaignFailure,
    cleanupEmptyCampaign,
  }
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
    artifacts: raw.artifacts ?? null,
    note: 'Raw observations are preserved in the sibling .raw.json file; this summary makes no adoption decision.',
  }
}

function normalizedFailure(error) {
  if (error instanceof CampaignOperationError) {
    return { kind: error.kind, message: error.message, restartBrowser: [
      'job-timeout',
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

function watchdog(operation, timeoutMs, label) {
  let timer
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CampaignOperationError(
      'unrecoverable-instability',
      `${label} did not settle within the ${timeoutMs} ms host watchdog`,
    )), timeoutMs)
  })
  operation.catch(() => {})
  return Promise.race([operation, expired]).finally(() => clearTimeout(timer))
}

async function closeBoundary(boundary, { force, timeoutMs }) {
  if (force) {
    try {
      boundary.forceClose?.()
    } catch {
      // The bounded graceful close below is still worth attempting.
    }
  }
  let timer
  let closed = false
  const close = Promise.resolve()
    .then(() => boundary.close())
    .then(() => { closed = true })
    .catch(() => {})
  const expired = new Promise((done) => {
    timer = setTimeout(done, timeoutMs)
  })
  await Promise.race([close, expired])
  clearTimeout(timer)
  if (!closed) {
    try {
      boundary.forceClose?.()
    } catch {
      // forceClose is deliberately best-effort and non-awaiting.
    }
  }
}

/** Serial by construction: the next job starts only after durable commit. */
export async function runCampaign({
  manifest,
  protocol,
  outputRoot,
  boundary,
  inputDigests = {},
  signal,
  hostWatchdogGraceMs = HOST_WATCHDOG_GRACE_MS,
  boundaryCleanupTimeoutMs = BOUNDARY_CLEANUP_TIMEOUT_MS,
}) {
  const campaign = validateCampaignManifest(manifest, protocol)
  const store = createCampaignStore(outputRoot, campaign, inputDigests)
  store.initialize()
  const completed = []
  let stopped = null
  let boundaryAttempted = false
  let forceBoundaryClose = false
  try {
    boundaryAttempted = true
    await boundary.start()
    for (const job of campaign.jobs) {
      const recovered = store.recover(job)
      if (recovered !== null) {
        completed.push(recovered.summary)
        continue
      }
      if (signal?.aborted) {
        stopped = {
          kind: 'campaign-aborted',
          resume: 'No job was active; remaining jobs are pending and resumable.',
        }
        break
      }
      const startedAt = new Date().toISOString()
      let raw
      let failure = null
      try {
        if (signal?.aborted) {
          throw new CampaignOperationError('campaign-aborted', 'Campaign was aborted before the job started')
        }
        const watchdogMs = protocol.thresholds.jobTimeoutMs + hostWatchdogGraceMs
        const result = await watchdog(
          Promise.resolve().then(() => boundary.runJob({
            job,
            campaignId: campaign.campaignId,
            timeoutMs: protocol.thresholds.jobTimeoutMs,
            reviewEnvironment: protocol.reviewEnvironment,
            signal,
          })),
          watchdogMs,
          `Browser job ${jobKey(job)}`,
        )
        raw = {
          schemaVersion: SCHEMA_VERSION,
          campaignId: campaign.campaignId,
          phase: campaign.phase,
          job,
          status: 'completed',
          failure: null,
          startedAt,
          finishedAt: new Date().toISOString(),
          equivalence: result.equivalence,
          observation: result.observation,
          runtime: result.runtime ?? null,
          artifacts: result.artifacts ?? null,
        }
      } catch (error) {
        failure = normalizedFailure(error)
        raw = {
          schemaVersion: SCHEMA_VERSION,
          campaignId: campaign.campaignId,
          phase: campaign.phase,
          job,
          status: 'failed',
          failure: { kind: failure.kind, message: failure.message },
          startedAt,
          finishedAt: new Date().toISOString(),
          equivalence: failure.partial.equivalence ?? null,
          observation: failure.partial.observation ?? null,
          runtime: failure.partial.runtime ?? null,
          artifacts: failure.partial.artifacts ?? null,
        }
      }
      const committed = store.commit(job, raw)
      completed.push(committed.summary)
      if (failure?.kind === 'unrecoverable-instability') {
        forceBoundaryClose = true
        stopped = {
          kind: 'unrecoverable-instability',
          failure: { kind: failure.kind, message: failure.message },
          resume: 'The failed job is durable; later jobs remain pending. Review the host/browser instability before resuming.',
        }
        break
      }
      if (failure?.kind === 'campaign-aborted') {
        stopped = {
          kind: 'campaign-aborted',
          resume: 'The active job outcome is durable; remaining jobs are pending and resumable.',
        }
        break
      }
      if (failure?.restartBrowser) {
        try {
          await boundary.restartBrowser()
        } catch (restartError) {
          const normalizedRestart = normalizedFailure(restartError)
          const campaignFailure = {
            kind: normalizedRestart.kind,
            message: normalizedRestart.message,
          }
          store.recordCampaignFailure(job, campaignFailure)
          stopped = {
            kind: 'browser-restart-failed',
            failure: campaignFailure,
            resume: 'The failed job is durable; the next job remains pending and resumable.',
          }
          break
        }
      }
    }
    store.checkpoint()
    return {
      campaignId: campaign.campaignId,
      phase: campaign.phase,
      completed,
      stopped,
    }
  } finally {
    if (boundaryAttempted) {
      await closeBoundary(boundary, {
        force: forceBoundaryClose,
        timeoutMs: boundaryCleanupTimeoutMs,
      })
    }
  }
}

export function classifyOperationError(error) {
  return normalizedFailure(error)
}
