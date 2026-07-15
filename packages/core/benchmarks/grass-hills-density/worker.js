import { performance } from 'node:perf_hooks'

import { PROTOCOL_VERSION } from './protocol.js'

const MAX_REASON_LENGTH = 4_000

process.once('message', async (request) => {
  try {
    const result = await executeRequest(request)
    sendAndExit(result)
  } catch (error) {
    sendAndExit({
      protocolVersion: PROTOCOL_VERSION,
      type: 'worker-error',
      reason: errorReason(error),
    })
  }
})

async function executeRequest(request) {
  if (
    request?.protocolVersion !== PROTOCOL_VERSION ||
    request?.type !== 'run'
  ) {
    throw new Error('worker received an incompatible benchmark request')
  }
  if (typeof globalThis.gc !== 'function') {
    throw new Error('worker must be launched with --expose-gc')
  }

  const imported = await import(request.job.candidate.moduleUrl)
  const candidate = imported.benchmarkCandidate ?? imported.default
  validateCandidate(candidate, request.job.candidate)

  const { fixture } = request.job
  const { samples } = request.policy
  const preparation = measurePreparation(
    candidate,
    fixture.payload,
    samples.preparation,
    samples.warmups,
  )
  const cold = measureCold(
    candidate,
    fixture.payload,
    samples.cold,
    samples.warmups,
  )
  const warm = measureWarm(
    candidate,
    fixture.payload,
    samples.warm,
    samples.warmups,
  )

  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'result',
    status: 'ok',
    mode: request.mode,
    policy: request.policy,
    candidateId: request.job.candidate.id,
    fixtureId: fixture.id,
    runtime: {
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    phases: { preparation, cold, warm },
  }
}

function validateCandidate(candidate, descriptor) {
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('candidate module must export benchmarkCandidate')
  }
  if (candidate.id !== descriptor.id) {
    throw new Error(
      `candidate module id ${String(candidate.id)} does not match ${descriptor.id}`,
    )
  }
  if (candidate.complexity !== descriptor.complexity) {
    throw new Error(
      `candidate module complexity ${String(candidate.complexity)} does not match ${descriptor.complexity}`,
    )
  }
  for (const operation of ['prepare', 'generate', 'guard']) {
    if (typeof candidate[operation] !== 'function') {
      throw new Error(`candidate ${descriptor.id} must implement ${operation}()`)
    }
  }
}

function measurePreparation(candidate, payload, sampleCount, warmups) {
  for (let index = 0; index < warmups; index++) {
    requireSampler(candidate.prepare(payload))
  }
  return measureSamples(sampleCount, () => {
    requireSampler(candidate.prepare(payload))
    return 1
  })
}

function measureCold(candidate, payload, sampleCount, warmups) {
  for (let index = 0; index < warmups; index++) {
    guard(candidate, candidate.generate(payload, 0))
  }
  return measureSamples(sampleCount, () =>
    guard(candidate, candidate.generate(payload, 0)),
  )
}

function measureWarm(candidate, payload, sampleCount, warmups) {
  const sample = requireSampler(candidate.prepare(payload))
  for (let index = 0; index < warmups; index++) {
    guard(candidate, sample(varyingTime(index)))
  }
  return measureSamples(sampleCount, (index) =>
    guard(candidate, sample(varyingTime(index + warmups))),
  )
}

function measureSamples(sampleCount, operation) {
  const measured = []
  let guardTotal = 0

  for (let index = 0; index < sampleCount; index++) {
    globalThis.gc()
    const before = memorySnapshot()
    const start = performance.now()
    const value = operation(index)
    const durationMs = performance.now() - start
    const after = memorySnapshot()
    guardTotal += value
    measured.push({
      durationMs,
      memory: {
        before,
        after,
        heapUsedDeltaBytes: after.heapUsedBytes - before.heapUsedBytes,
        rssDeltaBytes: after.rssBytes - before.rssBytes,
        maxRssDeltaBytes: after.maxRssBytes - before.maxRssBytes,
      },
    })
  }

  if (!Number.isFinite(guardTotal) || guardTotal === 0) {
    throw new Error(`benchmark work guard failed: ${guardTotal}`)
  }
  return { samples: measured, guard: guardTotal }
}

function memorySnapshot() {
  const memory = process.memoryUsage()
  // Node reports resourceUsage().maxRSS in KiB on supported platforms.
  const maxRssBytes = process.resourceUsage().maxRSS * 1_024
  return {
    heapUsedBytes: memory.heapUsed,
    rssBytes: memory.rss,
    maxRssBytes,
  }
}

function requireSampler(value) {
  if (typeof value !== 'function') {
    throw new Error('candidate prepare() must return a varying-time sampler')
  }
  return value
}

function guard(candidate, value) {
  const guarded = candidate.guard(value)
  if (!Number.isFinite(guarded) || guarded === 0) {
    throw new Error('candidate guard() must return a finite non-zero number')
  }
  return guarded
}

function varyingTime(index) {
  // Prime-step traversal over a fixed two-second, 60 fps loop.
  return ((index * 37) % 120) / 60
}

function errorReason(error) {
  const stack =
    error instanceof Error ? error.stack ?? error.message : String(error)
  return stack.slice(0, MAX_REASON_LENGTH)
}

function sendAndExit(message) {
  if (typeof process.send !== 'function') process.exit(1)
  process.send(message, () => {
    process.disconnect()
  })
}
