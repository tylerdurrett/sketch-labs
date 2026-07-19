import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { CampaignOperationError } from './campaign-runner.js'

const STARTUP_TIMEOUT_MS = 30_000
const ABORT_CLEANUP_TIMEOUT_MS = 2_000

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

async function settleWithin(operation, timeoutMs = ABORT_CLEANUP_TIMEOUT_MS) {
  operation.catch(() => {})
  let timer
  const expired = new Promise((done) => {
    timer = setTimeout(done, timeoutMs)
  })
  await Promise.race([operation, expired])
  clearTimeout(timer)
}

export async function raceOperation(operation, { page, timeoutMs, signal, label }) {
  if (signal?.aborted) {
    operation.catch(() => {})
    await settleWithin(page.evaluate(
      () => globalThis.__PHOTO_SCRIBBLE_EVIDENCE__?.abortActive(),
    ).catch(() => false))
    throw new CampaignOperationError('campaign-aborted', `${label} was aborted`)
  }
  let timer
  let abortListener
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CampaignOperationError(
      'job-timeout', `${label} exceeded the frozen ${timeoutMs} ms timeout`,
    )), timeoutMs)
  })
  const aborted = new Promise((_, reject) => {
    if (signal === undefined) return
    abortListener = () => reject(new CampaignOperationError(
      'campaign-aborted', `${label} was aborted`,
    ))
    signal.addEventListener('abort', abortListener, { once: true })
  })
  try {
    return await Promise.race([operation, timeout, aborted])
  } catch (error) {
    if (error instanceof CampaignOperationError) {
      operation.catch(() => {})
      await settleWithin(
        page.evaluate(() => globalThis.__PHOTO_SCRIBBLE_EVIDENCE__?.abortActive()).catch(() => false),
      )
    }
    throw error
  } finally {
    clearTimeout(timer)
    if (abortListener !== undefined) signal.removeEventListener('abort', abortListener)
  }
}

function evidenceAssertion(condition, message) {
  if (!condition) {
    throw new CampaignOperationError(
      'invalid-evidence-response',
      `Rejected malformed, stale, or mismatched page evidence: ${message}`,
    )
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hashesAreCanonical(run) {
  const hash = /^[0-9a-f]{64}$/
  return hash.test(run.identityHash ?? '') &&
    hash.test(run.result?.sceneHash ?? '') &&
    hash.test(run.result?.diagnosticsHash ?? '')
}

function sameTuple(actual, expected) {
  return isRecord(actual) && [
    'maxAcceptedSegments',
    'maxPolylines',
    'maxStagnations',
    'maxRestarts',
  ].every((key) => Number.isSafeInteger(actual[key]) && actual[key] === expected[key])
}

function decodePngDataUrl(value, label) {
  evidenceAssertion(typeof value === 'string' &&
    value.startsWith('data:image/png;base64,'), `${label} PNG payload is missing`)
  const bytes = Buffer.from(value.slice('data:image/png;base64,'.length), 'base64')
  evidenceAssertion(bytes.length > 0, `${label} PNG payload is empty`)
  return bytes
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function validateRun(run, expected) {
  const expectedPreparationCount =
    expected.profile.kind === 'production' && expected.purpose === 'equivalence-proof'
      ? 2
      : 1
  evidenceAssertion(isRecord(run), `${expected.label} is not an object`)
  evidenceAssertion(run.schemaVersion === 1, `${expected.label} schemaVersion is not 1`)
  evidenceAssertion(run.campaignId === expected.campaignId,
    `${expected.label} campaign identity does not match`)
  evidenceAssertion(run.hostRunId === expected.hostRunId,
    `${expected.label} host run identity does not match`)
  evidenceAssertion(typeof run.runId === 'string' &&
    run.runId.startsWith(`${expected.hostRunId}-`),
  `${expected.label} page run identity does not match`)
  evidenceAssertion(run.scenarioId === expected.scenarioId,
    `${expected.label} scenario does not match`)
  evidenceAssertion(run.purpose === expected.purpose,
    `${expected.label} purpose does not match`)
  evidenceAssertion(hashesAreCanonical(run),
    `${expected.label} canonical identity/Scene/diagnostics hashes are missing`)
  evidenceAssertion(isRecord(run.result) && isRecord(run.result.diagnostics) &&
    (run.result.diagnostics.termination === 'completed' ||
      run.result.diagnostics.termination === 'budget-exhausted') &&
    Number.isFinite(run.result.diagnostics.residualError) &&
    Number.isFinite(run.result.diagnostics.pathLength) &&
    Number.isSafeInteger(run.result.diagnostics.polylineCount) &&
    Number.isSafeInteger(run.result.diagnostics.penLiftCount) &&
    Number.isSafeInteger(run.result.primitiveCount) && run.result.primitiveCount >= 0 &&
    Number.isSafeInteger(run.result.smoothedPointCount) && run.result.smoothedPointCount >= 0 &&
    Number.isSafeInteger(run.result.serializedResultBytes) && run.result.serializedResultBytes > 0,
  `${expected.label} result counters or diagnostics are malformed`)
  evidenceAssertion(isRecord(run.telemetry) && run.telemetry.schemaVersion === 1 &&
    run.telemetry.runId === run.runId && run.telemetry.purpose === expected.purpose &&
    run.telemetry.sketchId === 'photo-scribble' &&
    run.telemetry.imageAssetId === expected.imageAssetId &&
    Number.isSafeInteger(run.telemetry.smoothedEmittedPoints) &&
    run.telemetry.smoothedEmittedPoints === run.result.smoothedPointCount &&
    Number.isSafeInteger(run.telemetry.smoothedEmittedPolylines) &&
    run.telemetry.smoothedEmittedPolylines === run.result.primitiveCount &&
    Number.isSafeInteger(run.telemetry.serializedArtworkBytes) &&
    run.telemetry.serializedArtworkBytes > 0 &&
    Number.isFinite(run.telemetry.responseReadyEpochMs) &&
    run.telemetry.preparationCount === expectedPreparationCount &&
    run.telemetry.solverPassCount === 1,
  `${expected.label} telemetry identity does not match`)
  evidenceAssertion(isRecord(run.protocolBoundary) &&
    run.protocolBoundary.invalidMessageCount === 0 &&
    run.protocolBoundary.allCoordinatorMessagesValid === true,
  `${expected.label} crossed an invalid product-protocol boundary`)

  if (expected.profile.kind === 'production') {
    evidenceAssertion(run.profile?.kind === 'production' &&
      run.telemetry.profile?.kind === 'production',
    `${expected.label} is not the production profile`)
  } else {
    evidenceAssertion(run.profile?.kind === 'injected' &&
      run.profile.candidateId === expected.profile.candidateId &&
      sameTuple(run.profile.limits, expected.profile.limits),
    `${expected.label} injected profile does not match`)
    evidenceAssertion(run.telemetry.profile?.kind === 'injected' &&
      run.telemetry.profile.candidateId === expected.profile.candidateId &&
      sameTuple(run.telemetry.profile.limits, expected.profile.limits),
    `${expected.label} telemetry profile does not match`)
  }
  if (expected.measuredProduction === true) {
    evidenceAssertion(
      run.fullTuple === null &&
        run.telemetry.resolvedProductionLimits === null &&
        run.telemetry.effectiveLimits === null &&
        run.telemetry.productionResolverSelectedEffectiveTuple === null,
      `${expected.label} must not repeat preparation to discover its tuple`,
    )
  } else {
    evidenceAssertion(sameTuple(run.fullTuple, expected.tuple),
      `${expected.label} full four-limit tuple does not match`)
    evidenceAssertion(sameTuple(run.telemetry.effectiveLimits, expected.tuple),
      `${expected.label} telemetry tuple does not match`)
    evidenceAssertion(
      sameTuple(
        run.telemetry.resolvedProductionLimits,
        run.telemetry.resolvedProductionLimits,
      ) &&
        typeof run.telemetry.productionResolverSelectedEffectiveTuple === 'boolean',
      `${expected.label} resolved production tuple telemetry is malformed`,
    )
  }
  if (expected.purpose === 'measurement') {
    evidenceAssertion(isRecord(run.measurement) &&
      Number.isFinite(run.measurement.coordinatorComputeTimeMs) &&
      Number.isFinite(run.measurement.coordinatorResultDurationMs) &&
      Number.isFinite(run.measurement.mainWallDurationMs) &&
      isRecord(run.measurement.heartbeat) &&
      Array.isArray(run.measurement.heartbeat.progressReceiptTimesMs) &&
      Number.isFinite(run.measurement.heartbeat.maximumGapMs),
    `${expected.label} required measurement/heartbeat telemetry is missing`)
    evidenceAssertion(Number.isFinite(run.telemetry.workerDurationMs),
      `${expected.label} measured Worker duration is missing`)
    if (expected.measuredProduction === true) {
      evidenceAssertion(
        run.telemetry.execution === null &&
          run.telemetry.rawAcceptedSegments === null &&
          run.telemetry.targetHash === null,
        `${expected.label} must remain an uninstrumented one-pass production run`,
      )
    } else {
      evidenceAssertion(isRecord(run.telemetry.execution) &&
        (run.telemetry.execution.stopCause === 'threshold-reached' ||
          run.telemetry.execution.stopCause === 'budget-reached') &&
        isRecord(run.telemetry.execution.counters) &&
        ['acceptedSegments', 'emittedPolylines', 'stagnations', 'restarts'].every(
          (key) => Number.isSafeInteger(run.telemetry.execution.counters[key]) &&
            run.telemetry.execution.counters[key] >= 0,
        ) &&
        Number.isSafeInteger(run.telemetry.rawAcceptedSegments) &&
        run.telemetry.rawAcceptedSegments ===
          run.telemetry.execution.counters.acceptedSegments,
      `${expected.label} required raw injected solver telemetry is missing`)
      evidenceAssertion(/^[0-9a-f]{64}$/.test(run.telemetry.targetHash ?? ''),
        `${expected.label} canonical target hash is missing`)
    }
    evidenceAssertion(isRecord(run.presentation) &&
      /^[0-9a-f]{64}$/.test(run.presentation.tone?.sha256 ?? '') &&
      run.presentation.tone.byteLength > 0 &&
      run.presentation.fillCanvas?.validState === true &&
      run.presentation.outlineCanvas?.validState === true &&
      run.presentation.geometryAndExportParity === true &&
      run.presentation.exportGeometry?.ordinarySvgMatchesAuthoritativeScene === true &&
      run.presentation.exportGeometry?.plotterSvgMatchesOutlineScene === true &&
      Number.isFinite(run.presentation.terminalProgressToDisplayMs) &&
      run.presentation.exports?.png?.byteLength > 0 &&
      run.presentation.exports?.ordinarySvg?.byteLength > 0 &&
      run.presentation.exports?.outlinePlotterSvg?.byteLength > 0 &&
      run.presentation.exports.ordinarySvg.containsRasterImage === false &&
      run.presentation.exports.ordinarySvg.containsDiagnosticMarker === false &&
      run.presentation.exports.outlinePlotterSvg.containsRasterImage === false &&
      run.presentation.exports.outlinePlotterSvg.containsDiagnosticMarker === false,
    `${expected.label} Canvas/export presentation evidence is missing or invalid`)
    evidenceAssertion(
      typeof run.presentation.capturePayloads?.tonePngDataUrl === 'string' &&
        typeof run.presentation.capturePayloads?.fillPngDataUrl === 'string' &&
        typeof run.presentation.capturePayloads?.outlinePngDataUrl === 'string',
      `${expected.label} exact Canvas PNG payloads are missing`,
    )
    evidenceAssertion(isRecord(run.cancellation) &&
      run.cancellation.scope === 'direct-coordinator-cancel-after-progress' &&
      run.cancellation.exercisesSupersedingControlEdit === false &&
      run.cancellation.startedAfterNonTerminalProgress === true &&
      run.cancellation.coordinatorAcknowledged === true &&
      run.cancellation.outcome === 'cancelled' &&
      Number.isFinite(run.cancellation.roundtripMs) &&
      run.cancellation.lateReplacementObserved === false,
    `${expected.label} cancellation/latest-result evidence is missing or invalid`)
  } else {
    evidenceAssertion(run.measurement === null,
      `${expected.label} equivalence proof must be unmeasured`)
    evidenceAssertion(run.telemetry.workerDurationMs === null,
      `${expected.label} equivalence Worker duration must be unmeasured`)
    evidenceAssertion(/^[0-9a-f]{64}$/.test(run.telemetry.targetHash ?? ''),
      `${expected.label} canonical target hash is missing`)
  }
}

export function validateEquivalenceResponse(value, expected) {
  evidenceAssertion(isRecord(value) && value.scenarioId === expected.scenarioId,
    'equivalence wrapper scenario does not match')
  // The production run is authoritative. The wrapper tuple and booleans are
  // checked only after every nested fact has independently agreed.
  const tuple = value.production?.fullTuple
  validateRun(value.production, {
    ...expected,
    label: 'equivalence production run',
    purpose: 'equivalence-proof',
    profile: { kind: 'production' },
    tuple,
  })
  validateRun(value.injectedResolvedTuple, {
    ...expected,
    label: 'equivalence injected run',
    purpose: 'equivalence-proof',
    profile: {
      kind: 'injected',
      candidateId: 'resolved-production-tuple-equivalence',
      limits: tuple,
    },
    tuple,
  })
  const production = value.production
  const injected = value.injectedResolvedTuple
  const identityMatches = production.identityHash === injected.identityHash
  const sceneMatches = production.result.sceneHash === injected.result.sceneHash
  const diagnosticsMatches =
    production.result.diagnosticsHash === injected.result.diagnosticsHash
  const productionTupleMatches =
    sameTuple(tuple, value.resolvedTuple) &&
    sameTuple(tuple, production.fullTuple) &&
    sameTuple(tuple, production.telemetry.resolvedProductionLimits) &&
    sameTuple(tuple, production.telemetry.effectiveLimits)
  const injectedTupleMatches =
    sameTuple(tuple, injected.fullTuple) &&
    sameTuple(tuple, injected.telemetry.resolvedProductionLimits) &&
    sameTuple(tuple, injected.telemetry.effectiveLimits)
  const productionResolverComputed = sameTuple(
    production.telemetry.resolvedProductionLimits,
    production.telemetry.effectiveLimits,
  )
  const injectedResolverComputed = sameTuple(
    injected.telemetry.resolvedProductionLimits,
    injected.telemetry.effectiveLimits,
  )

  evidenceAssertion(production.runId !== injected.runId,
    'equivalence run identities are stale or inconsistent')
  evidenceAssertion(identityMatches,
    'nested production and injected identity hashes do not match')
  evidenceAssertion(sceneMatches,
    'nested production and injected Scene hashes do not match')
  evidenceAssertion(diagnosticsMatches,
    'nested production and injected diagnostics hashes do not match')
  if (expected.expectedTargetHash !== undefined) {
    evidenceAssertion(
      production.telemetry.targetHash === expected.expectedTargetHash &&
        injected.telemetry.targetHash === expected.expectedTargetHash,
      'centered production target hash changed from the frozen fixture oracle',
    )
  }
  evidenceAssertion(productionTupleMatches && injectedTupleMatches,
    'nested resolved/effective complete tuples do not match')
  evidenceAssertion(
    production.telemetry.productionResolverSelectedEffectiveTuple ===
      productionResolverComputed &&
      productionResolverComputed === true &&
      injected.telemetry.productionResolverSelectedEffectiveTuple ===
        injectedResolverComputed &&
      injectedResolverComputed === true,
    'nested production resolver attribution is inconsistent with tuple equality',
  )
  evidenceAssertion(
    value.identityHashMatches === identityMatches &&
      value.sceneHashMatches === sceneMatches &&
      value.diagnosticsHashMatches === diagnosticsMatches &&
      value.productionResolverSelectedTuple === productionResolverComputed,
    'equivalence wrapper assertions contradict nested evidence',
  )
  return value
}

export function validateCandidateResponse(value, expected) {
  validateRun(value, {
    ...expected,
    label: 'candidate measurement',
    purpose: 'measurement',
    profile: {
      kind: 'injected',
      candidateId: expected.candidateId,
      limits: expected.tuple,
    },
    tuple: expected.tuple,
  })
  evidenceAssertion(value.identityHash === expected.identityHash,
    'candidate identity hash does not match its equivalence preflight')
  return value
}

export function validateProductionResponse(value, expected) {
  validateRun(value, {
    ...expected,
    label: expected.label,
    purpose: 'measurement',
    profile: { kind: 'production' },
    tuple: null,
    measuredProduction: true,
  })
  evidenceAssertion(value.identityHash === expected.identityHash,
    `${expected.label} identity hash does not match its equivalence preflight`)
  evidenceAssertion(value.result.sceneHash === expected.sceneHash,
    `${expected.label} Scene hash does not match the injected equivalence path`)
  evidenceAssertion(value.result.diagnosticsHash === expected.diagnosticsHash,
    `${expected.label} diagnostics hash does not match the injected equivalence path`)
  return value
}

function throwIfAborted(signal, label) {
  if (signal?.aborted) {
    throw new CampaignOperationError('campaign-aborted', `${label} was aborted`)
  }
}

export function createBrowserBoundary({
  serverFactory,
  browserFactory,
  url,
  fetchImpl = fetch,
  captureRoot,
  projectRoot,
}) {
  let server = null
  let browser = null

  async function startBrowser() {
    browser = await browserFactory()
  }

  async function closeBrowser() {
    const current = browser
    browser = null
    if (current === null) return
    const close = Promise.resolve().then(() => current.close()).catch(() => {})
    await settleWithin(close)
    if (current.isConnected?.() !== false) current.process?.()?.kill('SIGKILL')
  }

  function forceClose() {
    const currentBrowser = browser
    const currentServer = server
    browser = null
    server = null
    try {
      currentBrowser?.process?.()?.kill('SIGKILL')
    } catch {
      // Continue to the independently owned server process.
    }
    try {
      if (currentServer?.exitCode === null) currentServer.kill('SIGKILL')
    } catch {
      // The host watchdog must never await or throw from emergency cleanup.
    }
  }

  return {
    async start() {
      server = await serverFactory()
      const deadline = Date.now() + STARTUP_TIMEOUT_MS
      while (Date.now() < deadline) {
        if (server.exitCode !== null) {
          throw new Error(`Studio Vite server exited ${server.exitCode}`)
        }
        try {
          const response = await fetchImpl(url)
          if (response.ok) break
        } catch {
          // The fixed startup deadline owns reporting.
        }
        await delay(100)
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the Studio evidence page')
      await startBrowser()
    },

    async runJob({ job, campaignId, timeoutMs, reviewEnvironment, signal }) {
      throwIfAborted(signal, 'Candidate job setup')
      if (browser === null || browser.isConnected?.() === false) {
        throw new CampaignOperationError('browser-lost', 'Browser is unavailable before job start')
      }
      const page = await browser.newPage()
      const partial = {}
      try {
        const jobHostId = `${campaignId}-${String(job.ordinal).padStart(4, '0')}-${crypto.randomUUID()}`
        const equivalenceHostRunId = `${jobHostId}-equivalence`
        const candidateHostRunId = `${jobHostId}-candidate`
        await page.setViewport({
          width: reviewEnvironment.viewportWidth,
          height: reviewEnvironment.viewportHeight,
          deviceScaleFactor: reviewEnvironment.deviceScaleFactor,
        })
        throwIfAborted(signal, 'Candidate job setup')
        page.setDefaultTimeout(timeoutMs)
        await page.goto(url, { waitUntil: 'networkidle0' })
        throwIfAborted(signal, 'Candidate job setup')
        await page.waitForFunction(
          () => globalThis.__PHOTO_SCRIBBLE_EVIDENCE__ !== undefined,
        )
        throwIfAborted(signal, 'Candidate job setup')
        partial.runtime = await page.evaluate(() => ({
          userAgent: navigator.userAgent,
          platform: navigator.platform,
        }))
        partial.equivalence = await raceOperation(
          page.evaluate(
            ({ scenarioId, campaignId: campaign, hostRunId }) =>
              globalThis.__PHOTO_SCRIBBLE_EVIDENCE__.runExactEquivalence(
                scenarioId, {
                  campaignId: campaign,
                  hostRunId,
                },
              ),
            {
              scenarioId: job.scenarioId,
              campaignId,
              hostRunId: equivalenceHostRunId,
            },
          ),
          { page, timeoutMs, signal, label: 'Production tuple equivalence proof' },
        )
        partial.equivalence = validateEquivalenceResponse(partial.equivalence, {
          campaignId,
          hostRunId: equivalenceHostRunId,
          scenarioId: job.scenarioId,
          imageAssetId: job.imageAssetId,
          ...(job.expectedTargetHash === null
            ? {}
            : { expectedTargetHash: job.expectedTargetHash }),
        })
        if (job.productionMeasurement) {
          const productionMeasurement = async (hostRunId, label) => {
            const value = await raceOperation(
              page.evaluate(
                ({ scenarioId, campaignId: campaign, hostRunId: host }) =>
                  globalThis.__PHOTO_SCRIBBLE_EVIDENCE__.runProduction(
                    scenarioId, { campaignId: campaign, hostRunId: host },
                  ),
                { scenarioId: job.scenarioId, campaignId, hostRunId },
              ),
              { page, timeoutMs, signal, label },
            )
            return validateProductionResponse(value, {
              campaignId,
              hostRunId,
              scenarioId: job.scenarioId,
              imageAssetId: job.imageAssetId,
              identityHash: partial.equivalence.production.identityHash,
              sceneHash: partial.equivalence.injectedResolvedTuple.result.sceneHash,
              diagnosticsHash:
                partial.equivalence.injectedResolvedTuple.result.diagnosticsHash,
              label,
            })
          }
          partial.observation = await productionMeasurement(
            candidateHostRunId,
            'Adopted production measurement',
          )
          const repeatHostRunId = `${jobHostId}-production-repeat`
          partial.repeatObservation = await productionMeasurement(
            repeatHostRunId,
            'Repeated adopted production measurement',
          )
          delete partial.repeatObservation.presentation.capturePayloads
        } else {
          partial.observation = await raceOperation(
            page.evaluate(
              ({ scenarioId, candidateId, campaignId: campaign, hostRunId }) =>
                globalThis.__PHOTO_SCRIBBLE_EVIDENCE__.runCandidate(
                  scenarioId, candidateId, {
                    campaignId: campaign,
                    hostRunId,
                  },
                ),
              {
                scenarioId: job.scenarioId,
                candidateId: job.candidateId,
                campaignId,
                hostRunId: candidateHostRunId,
              },
            ),
            { page, timeoutMs, signal, label: 'Candidate measurement' },
          )
          partial.observation = validateCandidateResponse(partial.observation, {
            campaignId,
            hostRunId: candidateHostRunId,
            scenarioId: job.scenarioId,
            imageAssetId: job.imageAssetId,
            candidateId: job.candidateId,
            tuple: job.tuple,
            identityHash: partial.equivalence.production.identityHash,
          })
        }
        if (captureRoot !== undefined) {
          const directory = resolve(
            captureRoot,
            campaignId,
            job.scenarioId,
            `${job.candidateId}--${job.tupleToken}`,
          )
          mkdirSync(directory, { recursive: true })
          const captures = [
            ['tonePngDataUrl', 'tone-authored.png', partial.observation.presentation.tone.sha256],
            ['fillPngDataUrl', 'fill-primary.png', partial.observation.presentation.fillCanvas.sha256],
            ['outlinePngDataUrl', 'outline.png', partial.observation.presentation.outlineCanvas.sha256],
          ]
          partial.artifacts = []
          for (const [payloadKey, suffix, measuredSha256] of captures) {
            const bytes = decodePngDataUrl(
              partial.observation.presentation.capturePayloads?.[payloadKey],
              suffix,
            )
            const contentSha256 = sha256(bytes)
            evidenceAssertion(contentSha256 === measuredSha256,
              `capture ${suffix} does not match its measured full-resolution Canvas hash`)
            const path = resolve(
              directory,
              `${job.captureStem}--${job.candidateId}--${job.tupleToken}--${suffix}`,
            )
            if (existsSync(path)) {
              evidenceAssertion(sha256(readFileSync(path)) === contentSha256,
                `existing immutable capture ${suffix} differs`)
            } else {
              writeFileSync(path, bytes, { flag: 'wx' })
            }
            partial.artifacts.push({
              kind: suffix,
              path: relative(projectRoot ?? captureRoot, path),
              byteLength: bytes.length,
              sha256: contentSha256,
              measuredCanvasSha256: measuredSha256,
              pixelDimensions: { width: 1000, height: 1000 },
            })
          }
          delete partial.observation.presentation.capturePayloads
        }
        return partial
      } catch (error) {
        if (error instanceof CampaignOperationError && Object.keys(error.partial).length === 0) {
          throw new CampaignOperationError(error.kind, error.message, partial)
        }
        if (!(error instanceof CampaignOperationError) &&
          error !== null && typeof error === 'object') {
          error.partial = partial
        }
        throw error
      } finally {
        await settleWithin(
          page.evaluate(() => globalThis.__PHOTO_SCRIBBLE_EVIDENCE__?.abortActive())
            .catch(() => false),
        )
        await settleWithin(page.close().catch(() => {}))
      }
    },

    async restartBrowser() {
      await closeBrowser()
      await startBrowser()
    },

    async close() {
      await closeBrowser()
      const currentServer = server
      if (currentServer?.exitCode === null) {
        const exited = new Promise((done) => currentServer.once('exit', done))
        currentServer.kill('SIGTERM')
        await settleWithin(exited)
        if (currentServer.exitCode === null) currentServer.kill('SIGKILL')
      }
      server = null
    },

    forceClose,
  }
}

export async function createDefaultBrowserBoundary(root, captureRoot, port = 4318) {
  const vite = resolve(root, 'apps/studio/node_modules/.bin/vite')
  if (!existsSync(vite)) throw new Error('Use the existing locked Studio install')
  const puppeteerEntry = resolve(
    process.env.PUPPETEER_MODULE ??
      '.claude/skills/chrome-devtools/scripts/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js',
  )
  if (!existsSync(puppeteerEntry)) {
    throw new Error('Set PUPPETEER_MODULE to an existing Puppeteer entry')
  }
  const puppeteer = (await import(pathToFileURL(puppeteerEntry).href)).default
  const url = `http://127.0.0.1:${port}/photo-scribble-evidence.html`
  return createBrowserBoundary({
    url,
    captureRoot,
    projectRoot: root,
    serverFactory: async () => spawn(vite, [
      '--config',
      resolve(root, 'packages/core/benchmarks/photo-scribble/studio-worker.vite.config.ts'),
      '--host', '127.0.0.1', '--port', String(port), '--strictPort',
    ], {
      cwd: resolve(root, 'apps/studio'),
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    browserFactory: () => puppeteer.launch({
      headless: true,
      ...(process.env.PUPPETEER_EXECUTABLE_PATH === undefined
        ? {}
        : { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }),
      args: ['--enable-precise-memory-info', '--disable-dev-shm-usage'],
    }),
  })
}
