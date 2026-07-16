import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  ADOPTED_BLADE_DENSITY,
  CEILING_BLADE_DENSITY,
  PRODUCTION_OUTLINE_TOLERANCE,
  PRODUCTION_REFERENCE_ID,
  generateProductionReference,
  productionReferenceManifest,
} from './production-reference.js'

const referenceDirectory = new URL(
  '../../src/sketches/grass-hills/reference/',
  import.meta.url,
)

describe('Grass Hills faithful production evidence', () => {
  it('reproduces the committed 10k vectors and bounded 50k review pair', () => {
    const manifestBytes = readFileSync(
      new URL('manifest.json', referenceDirectory),
      'utf8',
    )
    const manifest = JSON.parse(manifestBytes)
    const generated = generateProductionReference()
    const regeneratedManifest = productionReferenceManifest(generated)

    expect(`${JSON.stringify(regeneratedManifest, null, 2)}\n`).toBe(
      manifestBytes,
    )
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      referenceId: PRODUCTION_REFERENCE_ID,
      status: 'awaiting-independent-paired-fidelity-review',
      qualityFallbackPolicy: { allowed: false },
      scenarios: {
        adopted10k: {
          preset: { params: { bladeDensity: ADOPTED_BLADE_DENSITY } },
          outlineTolerance: PRODUCTION_OUTLINE_TOLERANCE,
          fidelity: {
            expectedBladeCount: 10_000,
            fillBladeCount: 10_000,
            outlineSourceBladeCount: 10_000,
            rejectedPrimitiveCount: 0,
            sixPointCenterlineCount: 0,
            exactGeometryIdentity: true,
            physicalToolRootRejection: false,
            representationFallbackDetected: false,
          },
          review: { verdict: 'PENDING-INDEPENDENT-REVIEW' },
        },
        supportedCeiling50k: {
          preset: { params: { bladeDensity: CEILING_BLADE_DENSITY } },
          fidelity: {
            expectedBladeCount: 50_000,
            fillBladeCount: 50_000,
            outlineSourceBladeCount: 50_000,
            rejectedPrimitiveCount: 0,
            sixPointCenterlineCount: 0,
            exactGeometryIdentity: true,
            physicalToolRootRejection: false,
            representationFallbackDetected: false,
          },
          review: { verdict: 'PENDING-INDEPENDENT-REVIEW' },
        },
      },
      review: { verdict: 'PENDING-INDEPENDENT-REVIEW', reviewer: null },
    })

    const committed = {
      fillSvg: readFileSync(new URL('fill.svg', referenceDirectory), 'utf8'),
      outlineSvg: readFileSync(
        new URL('outline.svg', referenceDirectory),
        'utf8',
      ),
      physicalPlotSvg: readFileSync(
        new URL('physical-plot.svg', referenceDirectory),
        'utf8',
      ),
    }
    expect(generated.adopted.fullArtifacts).toMatchObject(committed)
    expect(sha256(committed.fillSvg)).toBe(
      manifest.scenarios.adopted10k.artifacts.fillSvg.sha256,
    )
    expect(sha256(committed.outlineSvg)).toBe(
      manifest.scenarios.adopted10k.artifacts.outlineSvg.sha256,
    )
    expect(sha256(committed.physicalPlotSvg)).toBe(
      manifest.scenarios.adopted10k.artifacts.physicalPlotSvg.sha256,
    )

    for (const key of [
      'fillReviewPng',
      'outlineReviewPng',
      'contactSheetPng',
    ]) {
      const artifact = manifest.scenarios.supportedCeiling50k.artifacts[key]
      const bytes = readFileSync(new URL(artifact.file, referenceDirectory))
      expect(sha256(bytes)).toBe(artifact.sha256)
      expect(bytes.byteLength).toBe(artifact.bytes)
    }
  })

  it('pins indexed-plan evidence without treating observations as time limits', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('manifest.json', referenceDirectory), 'utf8'),
    )
    const observations = JSON.parse(
      readFileSync(new URL('observations.json', referenceDirectory), 'utf8'),
    )

    for (const scenario of Object.values(manifest.scenarios)) {
      expect(scenario.hiddenLinePlan.broadPhase).toMatchObject({
        queriedSourceCount: scenario.fidelity.fillPrimitiveCount,
        occluderCount: scenario.fidelity.fillPrimitiveCount,
        trueOverlappingPairCount:
          scenario.hiddenLinePlan.workload.overlappingPairCount,
        index: {
          entryCount: scenario.fidelity.fillPrimitiveCount,
          unsafeEntryCount: 0,
        },
      })
      expect(
        scenario.hiddenLinePlan.broadPhase.index.indexedEntryCount +
          scenario.hiddenLinePlan.broadPhase.index.overflowEntryCount,
      ).toBe(scenario.hiddenLinePlan.broadPhase.index.entryCount)
      expect(
        scenario.hiddenLinePlan.broadPhase.index.cellEntryCount,
      ).toBeGreaterThan(0)
      expect(
        scenario.hiddenLinePlan.broadPhase.enumeratedCandidatePairCount,
      ).toBeLessThan(
        scenario.hiddenLinePlan.broadPhase.eligiblePainterPairCount,
      )
    }

    expect(observations.warning).toMatch(/not SLAs and not test limits/)
    for (const scenario of Object.values(observations.scenarios)) {
      expect(scenario.contract).toMatch(/never pass\/fail limits or SLAs/)
      expect(scenario.durationsMs.total).toBeGreaterThan(0)
      expect(scenario.memory.peakObservedRssBytes).toBeGreaterThan(0)
      expect(scenario.memory.processLifetimeMaxRssBytes).toBeGreaterThan(0)
    }
  })
})

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
