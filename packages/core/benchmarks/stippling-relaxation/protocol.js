export const MATRIX_VERSION = 1
export const SEED = 'stippling-relaxation-benchmark-v1'
export const FRAME = Object.freeze({ width: 100, height: 100 })
export const TARGETS = Object.freeze(['flat', 'ramp', 'exact-zero-barrier'])
export const DENSITIES = Object.freeze([1, 100, 400])
export const RELAXATIONS = Object.freeze([0, 0.5, 1])
export const PHASES = Object.freeze([
  'placement',
  'distribution-refinement',
  'voronoi-assignment-centroid',
  'safe-relocation',
  'geometry-materialization',
  'end-to-end-preparation',
])
export const LIMITS = Object.freeze({ warmups: 10, samples: 25 })

const DEFAULTS = Object.freeze({
  smoke: Object.freeze({ warmups: 1, samples: 3 }),
  full: Object.freeze({ warmups: 2, samples: 9 }),
})

function relaxationId(value) {
  return value === 0.5 ? '0.5' : String(value)
}

export function caseId({ target, density, relaxation }) {
  return `${target}:density=${density}:relaxation=${relaxationId(relaxation)}`
}

export const FULL_CASES = Object.freeze(
  TARGETS.flatMap((target) =>
    DENSITIES.flatMap((density) =>
      RELAXATIONS.map((relaxation) =>
        Object.freeze({
          id: caseId({ target, density, relaxation }),
          target,
          density,
          relaxation,
        }),
      ),
    ),
  ).sort((first, second) => first.id.localeCompare(second.id)),
)

const SMOKE_IDS = new Set([
  caseId({ target: 'flat', density: 1, relaxation: 0 }),
  caseId({ target: 'ramp', density: 100, relaxation: 0.5 }),
])
export const SMOKE_CASES = Object.freeze(
  FULL_CASES.filter(({ id }) => SMOKE_IDS.has(id)),
)

function parseBoundedInteger(value, fallback, name, minimum, maximum) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a safe integer in [${minimum}, ${maximum}]`)
  }
  return parsed
}

function optionalSet(value, allowed, name, parse = (item) => item) {
  if (value === undefined) return undefined
  const selected = new Set(
    String(value)
      .split(',')
      .filter(Boolean)
      .map(parse),
  )
  for (const item of selected) {
    if (!allowed.includes(item)) {
      throw new Error(`${name} contains unsupported value ${String(item)}`)
    }
  }
  return selected
}

export function resolveRunConfig(input = {}) {
  const mode = input.mode ?? 'smoke'
  if (mode !== 'smoke' && mode !== 'full') {
    throw new Error('mode must be smoke or full')
  }
  if (mode === 'full' && input.confirmFull !== true) {
    throw new Error('full mode requires --confirm-full')
  }
  const defaults = DEFAULTS[mode]
  const warmups = parseBoundedInteger(
    input.warmups,
    defaults.warmups,
    'warmups',
    0,
    LIMITS.warmups,
  )
  const samples = parseBoundedInteger(
    input.samples,
    defaults.samples,
    'samples',
    1,
    LIMITS.samples,
  )
  const shardCount = parseBoundedInteger(
    input.shardCount,
    1,
    'shardCount',
    1,
    1_024,
  )
  const shardIndex = parseBoundedInteger(
    input.shardIndex,
    0,
    'shardIndex',
    0,
    shardCount - 1,
  )
  const targetFilter = optionalSet(input.target, TARGETS, 'target')
  const densityFilter = optionalSet(
    input.density,
    DENSITIES,
    'density',
    Number,
  )
  const relaxationFilter = optionalSet(
    input.relaxation,
    RELAXATIONS,
    'relaxation',
    Number,
  )
  const phaseFilter = optionalSet(input.phase, PHASES, 'phase')
  const caseFilter = optionalSet(
    input.caseId,
    FULL_CASES.map(({ id }) => id),
    'caseId',
  )
  const modeCases = mode === 'smoke' ? SMOKE_CASES : FULL_CASES
  const filteredCases = modeCases.filter(
    (item) =>
      (targetFilter === undefined || targetFilter.has(item.target)) &&
      (densityFilter === undefined || densityFilter.has(item.density)) &&
      (relaxationFilter === undefined ||
        relaxationFilter.has(item.relaxation)) &&
      (caseFilter === undefined || caseFilter.has(item.id)),
  )
  const cases = filteredCases.filter(
    (_, index) => index % shardCount === shardIndex,
  )
  const phases = PHASES.filter(
    (phase) => phaseFilter === undefined || phaseFilter.has(phase),
  )
  if (cases.length === 0) throw new Error('filters selected no benchmark cases')
  if (phases.length === 0) throw new Error('filters selected no benchmark phases')

  const campaign = Object.freeze({
    matrixVersion: MATRIX_VERSION,
    seed: SEED,
    frame: FRAME,
    matrix: Object.freeze({
      targets: TARGETS,
      densities: DENSITIES,
      relaxations: RELAXATIONS,
      phases: PHASES,
    }),
    mode,
    warmups,
    samples,
    shardCount,
    caseIds: Object.freeze(modeCases.map(({ id }) => id)),
    phases: PHASES,
  })
  const selection = Object.freeze({
    shardIndex,
    caseIds: Object.freeze(cases.map(({ id }) => id)),
    phases: Object.freeze(phases),
  })
  return Object.freeze({
    matrixVersion: MATRIX_VERSION,
    seed: SEED,
    frame: FRAME,
    matrix: Object.freeze({
      targets: TARGETS,
      densities: DENSITIES,
      relaxations: RELAXATIONS,
      phases: PHASES,
    }),
    mode,
    warmups,
    samples,
    shardIndex,
    shardCount,
    cases: Object.freeze(cases),
    phases: Object.freeze(phases),
    campaign,
    selection,
    selectedExpectedSampleIds: Object.freeze(
      expectedSampleIds(cases.map(({ id }) => id), phases, samples),
    ),
    campaignExpectedSampleIds: Object.freeze(
      expectedSampleIds(
        modeCases.map(({ id }) => id),
        PHASES,
        samples,
      ),
    ),
  })
}

export function expectedSampleIds(caseIds, phases, samples) {
  return caseIds.flatMap((id) =>
    phases.flatMap((phase) =>
      Array.from(
        { length: samples },
        (_, sampleIndex) => `${id}/${phase}/${sampleIndex}`,
      ),
    ),
  )
}

/** Exact identity required when continuing one output file. */
export function resumeCompatibilityKey(raw) {
  return JSON.stringify({
    environment: raw.environment,
    config: raw.config,
  })
}

/** Shared identity for combining distinct filters and shards. */
export function aggregationCompatibilityKey(raw) {
  return JSON.stringify({
    environment: raw.environment,
    campaign: raw.config.campaign,
  })
}

function assertArtifactSelection(artifact) {
  const { campaign, selection } = artifact.config
  if (campaign === undefined) {
    throw new Error('raw artifact is missing canonical campaign selection')
  }
  if (selection === null) return
  if (selection === undefined) {
    throw new Error('raw artifact is missing canonical campaign selection')
  }
  if (
    !Number.isSafeInteger(selection.shardIndex) ||
    selection.shardIndex < 0 ||
    selection.shardIndex >= campaign.shardCount
  ) {
    throw new Error('raw artifact has an invalid shard selection')
  }
  const campaignCases = new Set(campaign.caseIds)
  const campaignPhases = new Set(campaign.phases)
  if (
    selection.caseIds.some((id) => !campaignCases.has(id)) ||
    selection.phases.some((phase) => !campaignPhases.has(phase))
  ) {
    throw new Error('raw artifact selection is outside its canonical campaign')
  }
}

export function mergeRawArtifacts(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error('at least one raw artifact is required')
  }
  const key = aggregationCompatibilityKey(artifacts[0])
  const sampleById = new Map()
  for (const artifact of artifacts) {
    assertArtifactSelection(artifact)
    if (aggregationCompatibilityKey(artifact) !== key) {
      throw new Error('raw artifacts have incompatible environment or config')
    }
    for (const sample of artifact.samples) {
      if (!sampleById.has(sample.id)) sampleById.set(sample.id, sample)
    }
  }
  const samples = [...sampleById.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  )
  const campaign = artifacts[0].config.campaign
  const canonicalExpectedSampleIds = expectedSampleIds(
    campaign.caseIds,
    campaign.phases,
    campaign.samples,
  )
  const missingSampleIds = canonicalExpectedSampleIds
    .filter((id) => !sampleById.has(id))
    .sort((a, b) => a.localeCompare(b))
  return Object.freeze({
    schemaVersion: 1,
    environment: artifacts[0].environment,
    config: Object.freeze({
      campaign,
      selection: null,
      expectedSampleIds: Object.freeze(canonicalExpectedSampleIds),
    }),
    samples: Object.freeze(samples),
    missingSampleIds: Object.freeze(missingSampleIds),
  })
}

function percentile(values, quantile) {
  if (values.length === 0) return null
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.ceil(quantile * ordered.length) - 1]
}

export function summarizeRaw(merged) {
  const groups = new Map()
  for (const sample of merged.samples) {
    const key = `${sample.caseId}/${sample.phase}`
    const group = groups.get(key) ?? []
    if (sample.status === 'ok') group.push(sample.elapsedMs)
    groups.set(key, group)
  }
  return {
    completedSamples: merged.samples.length,
    missingSamples: merged.missingSampleIds.length,
    results: [...groups.entries()].map(([id, values]) => ({
      id,
      sampleCount: values.length,
      medianMs: percentile(values, 0.5),
      p95Ms: percentile(values, 0.95),
    })),
  }
}
