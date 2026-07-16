export const PROTOCOL_VERSION = 1

export const CAMPAIGN_MODES = Object.freeze([
  'smoke',
  'screen',
  'full',
  'adopted',
])

export const LONG_CAMPAIGN_CONFIRMATION =
  'run-grass-hills-density-long-campaign'

const FIXED_FULL_SAMPLES = Object.freeze({
  preparation: 20,
  cold: 20,
  warm: 60,
  warmups: 3,
})

export const MODE_POLICIES = Object.freeze({
  smoke: policy(30_000, 1_024, {
    preparation: 1,
    cold: 1,
    warm: 1,
    warmups: 0,
  }),
  screen: policy(90_000, 1_024, {
    preparation: 3,
    cold: 3,
    warm: 12,
    warmups: 1,
  }),
  full: policy(600_000, 2_048, FIXED_FULL_SAMPLES),
  adopted: policy(600_000, 2_048, FIXED_FULL_SAMPLES),
})

function policy(timeoutMs, memoryMiB, samples) {
  return Object.freeze({
    timeoutMs,
    memoryMiB,
    samples: Object.freeze({ ...samples }),
  })
}

export function campaignPolicy(mode) {
  if (!CAMPAIGN_MODES.includes(mode)) {
    throw new Error(
      `mode must be one of ${CAMPAIGN_MODES.join(', ')}; received ${String(mode)}`,
    )
  }
  return MODE_POLICIES[mode]
}

export function validateCampaignRequest({
  mode = 'smoke',
  jobs,
  confirmation,
}) {
  const selectedMode = mode ?? 'smoke'
  const selectedPolicy = campaignPolicy(selectedMode)

  if (!Array.isArray(jobs) || jobs.length === 0) {
    throw new Error('campaign jobs must be a non-empty array')
  }
  if (
    (selectedMode === 'full' || selectedMode === 'adopted') &&
    confirmation !== LONG_CAMPAIGN_CONFIRMATION
  ) {
    throw new Error(
      `${selectedMode} mode requires confirmation ${LONG_CAMPAIGN_CONFIRMATION}`,
    )
  }

  const keys = new Set()
  const normalizedJobs = jobs.map((job, index) => {
    const normalized = validateJob(job, index)
    const key = `${normalized.candidate.id}\u0000${normalized.fixture.id}`
    if (keys.has(key)) {
      throw new Error(
        `duplicate candidate × fixture job ${normalized.candidate.id} × ${normalized.fixture.id}`,
      )
    }
    keys.add(key)
    return normalized
  })

  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    mode: selectedMode,
    policy: selectedPolicy,
    jobs: Object.freeze(normalizedJobs),
  })
}

function validateJob(job, index) {
  if (job === null || typeof job !== 'object') {
    throw new Error(`jobs[${index}] must be an object`)
  }
  const candidate = job.candidate
  const fixture = job.fixture
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error(`jobs[${index}].candidate must be an object`)
  }
  if (fixture === null || typeof fixture !== 'object') {
    throw new Error(`jobs[${index}].fixture must be an object`)
  }

  requireNonEmptyString(candidate.id, `jobs[${index}].candidate.id`)
  requireNonEmptyString(candidate.moduleUrl, `jobs[${index}].candidate.moduleUrl`)
  if (!['linear', 'legacy-quadratic'].includes(candidate.complexity)) {
    throw new Error(
      `jobs[${index}].candidate.complexity must be linear or legacy-quadratic`,
    )
  }
  requireNonEmptyString(fixture.id, `jobs[${index}].fixture.id`)
  if (!['baseline', 'tiny', 'dense'].includes(fixture.scale)) {
    throw new Error(
      `jobs[${index}].fixture.scale must be baseline, tiny, or dense`,
    )
  }
  if (
    candidate.complexity === 'legacy-quadratic' &&
    fixture.scale !== 'baseline' &&
    fixture.scale !== 'tiny'
  ) {
    throw new Error(
      `legacy-quadratic candidate ${candidate.id} is restricted to baseline/tiny controls; received ${fixture.id} (${fixture.scale})`,
    )
  }

  return Object.freeze({
    candidate: Object.freeze({
      id: candidate.id,
      moduleUrl: candidate.moduleUrl,
      complexity: candidate.complexity,
    }),
    fixture: Object.freeze({
      id: fixture.id,
      scale: fixture.scale,
      payload: fixture.payload,
    }),
  })
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`)
  }
}

export function workerRequest(job, mode, policy) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'run',
    mode,
    policy,
    job,
  }
}

export function censoredResult({
  job,
  mode,
  policy,
  kind,
  reason,
  elapsedMs,
  exitCode = null,
  signal = null,
}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'result',
    status: 'censored',
    mode,
    policy,
    candidateId: job.candidate.id,
    fixtureId: job.fixture.id,
    censor: {
      kind,
      reason,
      elapsedMs,
      exitCode,
      signal,
    },
  }
}
