import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import protocol from './protocol.json'

const here = dirname(new URL(import.meta.url).pathname)
const root = resolve(here, '../../../..')
const campaignId = 'issue-336-20260719T001328Z'
const campaignRoot = resolve(here, 'results', campaignId)
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const adoptedTuple = {
  maxAcceptedSegments: 1_000_000,
  maxPolylines: 16_000,
  maxStagnations: 32_000,
  maxRestarts: 16_000,
}

const checkpoint = readJson(resolve(campaignRoot, 'campaign-checkpoint.json'))
const records = checkpoint.completed.map((entry) =>
  readJson(resolve(here, 'results', entry.rawRecord)),
)

function expectOnePassProduction(run, equivalence) {
  expect(run.profile).toEqual({ kind: 'production' })
  expect(run.fullTuple).toBeNull()
  expect(run.telemetry).toMatchObject({
    profile: { kind: 'production' },
    resolvedProductionLimits: null,
    effectiveLimits: null,
    productionResolverSelectedEffectiveTuple: null,
    preparationCount: 1,
    solverPassCount: 1,
  })
  expect(run.telemetry.execution).toBeNull()
  expect(run.identityHash).toBe(equivalence.production.identityHash)
  expect(run.result.sceneHash).toBe(equivalence.injectedResolvedTuple.result.sceneHash)
  expect(run.result.diagnosticsHash).toBe(
    equivalence.injectedResolvedTuple.result.diagnosticsHash,
  )
  expect(run.protocolBoundary).toEqual({
    invalidMessageCount: 0,
    allCoordinatorMessagesValid: true,
  })

  const timing = run.measurement
  expect(run.telemetry.workerDurationMs).toBeLessThanOrEqual(
    timing.coordinatorComputeTimeMs + 1,
  )
  expect(timing.coordinatorComputeTimeMs).toBeLessThanOrEqual(
    timing.coordinatorResultDurationMs,
  )
  expect(timing.coordinatorResultDurationMs).toBeLessThanOrEqual(
    timing.mainWallDurationMs,
  )
  expect(timing.mainWallDurationMs).toBeLessThan(protocol.thresholds.jobTimeoutMs)
  expect(timing.responseReadyToMainReceiptEpochProxyMs).toBeGreaterThanOrEqual(0)
  expect(timing.heartbeat.terminalProgressCount).toBe(1)

  for (const sample of [timing.memory.before, timing.memory.after]) {
    expect(sample.usedJSHeapSize).toBeLessThan(sample.jsHeapSizeLimit)
    expect(sample.totalJSHeapSize).toBeLessThan(sample.jsHeapSizeLimit)
  }

  expect(run.presentation).toMatchObject({
    fillCanvas: { width: 1000, height: 1000, validState: true },
    outlineCanvas: { width: 1000, height: 1000, validState: true },
    geometryAndExportParity: true,
    exportGeometry: {
      ordinarySvgMatchesAuthoritativeScene: true,
      plotterSvgMatchesOutlineScene: true,
    },
  })
  expect(run.presentation.exports.png.sha256).toBe(run.presentation.fillCanvas.sha256)
  expect(run.presentation.exportGeometry.ordinaryAuthoritativeHash).toBe(
    run.presentation.exportGeometry.ordinaryExportHash,
  )
  expect(run.presentation.exportGeometry.plotterAuthoritativeHash).toBe(
    run.presentation.exportGeometry.plotterExportHash,
  )
  for (const svg of [
    run.presentation.exports.ordinarySvg,
    run.presentation.exports.outlinePlotterSvg,
  ]) {
    expect(svg.containsRasterImage).toBe(false)
    expect(svg.containsDiagnosticMarker).toBe(false)
    expect(svg.pathCount).toBeGreaterThan(0)
  }
  expect(run.presentation.terminalProgressToDisplayMs).toBeLessThan(
    protocol.thresholds.maxTerminalProgressToDisplayMs,
  )
  expect(run.cancellation).toMatchObject({
    scope: 'direct-coordinator-cancel-after-progress',
    startedAfterNonTerminalProgress: true,
    coordinatorAcknowledged: true,
    outcome: 'cancelled',
    lateReplacementObserved: false,
  })
  expect(run.cancellation.roundtripMs).toBeLessThanOrEqual(
    protocol.thresholds.maxCancellationRoundtripMs,
  )
}

describe('issue #336 adopted production policy confirmation', () => {
  it('passes both immutable production jobs without crossing a hard machine boundary', () => {
    expect(checkpoint).toMatchObject({
      campaignId,
      nextJobKey: null,
      campaignFailures: [],
    })
    expect(records).toHaveLength(2)
    expect(records.map((record) => record.job.scenarioId)).toEqual([
      'flowers-opaque-fine',
      'pinecone-dark-alpha-fine',
    ])

    for (const record of records) {
      expect(record).toMatchObject({
        phase: 'confirmation',
        status: 'completed',
        failure: null,
        job: {
          candidateId: 'adopted-production',
          tuple: adoptedTuple,
          productionMeasurement: true,
        },
      })
      expect(Date.parse(record.finishedAt) - Date.parse(record.startedAt)).toBeLessThan(
        protocol.thresholds.jobTimeoutMs,
      )
    }
  })

  it('proves the adopted resolver, centered targets, and injected path are exact', () => {
    for (const record of records) {
      const expectedTarget =
        protocol.adoptedPolicyConfirmation.centeredTargetHashes[record.job.scenarioId]
      expect(record.equivalence).toMatchObject({
        resolvedTuple: adoptedTuple,
        identityHashMatches: true,
        productionResolverSelectedTuple: true,
        sceneHashMatches: true,
        diagnosticsHashMatches: true,
      })
      for (const [run, preparationCount] of [
        [record.equivalence.production, 2],
        [record.equivalence.injectedResolvedTuple, 1],
      ]) {
        expect(run.fullTuple).toEqual(adoptedTuple)
        expect(run.telemetry).toMatchObject({
          resolvedProductionLimits: adoptedTuple,
          effectiveLimits: adoptedTuple,
          productionResolverSelectedEffectiveTuple: true,
          targetHash: expectedTarget,
          preparationCount,
          solverPassCount: 1,
        })
      }
    }
    expect(protocol.adoptedPolicyConfirmation.toneGammaExponentRange).toEqual([0.5, 2])
  })

  it('repeats production deterministically with complete presentation evidence', () => {
    for (const record of records) {
      expectOnePassProduction(record.observation, record.equivalence)
      expectOnePassProduction(record.repeatObservation, record.equivalence)
      expect(record.repeatObservation.identityHash).toBe(record.observation.identityHash)
      expect(record.repeatObservation.result.sceneHash).toBe(
        record.observation.result.sceneHash,
      )
      expect(record.repeatObservation.result.diagnosticsHash).toBe(
        record.observation.result.diagnosticsHash,
      )
      expect(record.repeatObservation.presentation.tone.sha256).toBe(
        record.observation.presentation.tone.sha256,
      )
      expect(record.repeatObservation.presentation.fillCanvas.sha256).toBe(
        record.observation.presentation.fillCanvas.sha256,
      )
      expect(record.repeatObservation.presentation.outlineCanvas.sha256).toBe(
        record.observation.presentation.outlineCanvas.sha256,
      )
      expect(record.repeatObservation.presentation.exports.ordinarySvg.sha256).toBe(
        record.observation.presentation.exports.ordinarySvg.sha256,
      )
      expect(record.repeatObservation.presentation.exports.outlinePlotterSvg.sha256).toBe(
        record.observation.presentation.exports.outlinePlotterSvg.sha256,
      )

      expect(record.artifacts).toHaveLength(3)
      for (const artifact of record.artifacts) {
        const path = resolve(root, artifact.path)
        expect(existsSync(path)).toBe(true)
        expect(sha256(readFileSync(path))).toBe(artifact.sha256)
        expect(artifact.sha256).toBe(artifact.measuredCanvasSha256)
        expect(artifact.pixelDimensions).toEqual({ width: 1000, height: 1000 })
      }
    }
  })

  it('leaves the externally backed-up Image Assets and Presets byte-exact', () => {
    const cleanup = readJson(resolve(campaignRoot, 'cleanup-attestation.json'))
    expect(cleanup).toMatchObject({
      campaignId,
      externalByteBackupCreatedBeforeHarnessWrites: true,
      externalByteBackupRetained: true,
      preRunGitStatus: [],
      postRunMatchesBackupExactly: true,
      newTrialAssets: [],
      newTrialPresets: [],
      unexpectedAssetOrPresetGitStatus: [],
    })
    for (const entry of cleanup.assetAndPresetInventory) {
      const bytes = readFileSync(resolve(root, entry.path))
      expect(bytes.byteLength).toBe(entry.byteLength)
      expect(sha256(bytes)).toBe(entry.sha256)
    }
    for (const directory of [
      'assets/image-assets',
      'packages/core/src/sketches/photo-scribble/presets',
    ]) {
      expect(
        readdirSync(resolve(root, directory)).filter((name) =>
          name.startsWith(protocol.artifactPrefix),
        ),
      ).toEqual([])
    }
  })
})
