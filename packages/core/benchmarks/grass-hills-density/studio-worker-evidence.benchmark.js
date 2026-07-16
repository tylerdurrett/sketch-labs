import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const referenceDirectory = new URL(
  '../../src/sketches/grass-hills/reference/',
  import.meta.url,
)

describe('Grass Hills real Studio Worker evidence record', () => {
  it('pins validated structured-clone, terminal progress, cache, and export reuse observations', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('manifest.json', referenceDirectory), 'utf8'),
    )
    const bytes = readFileSync(
      new URL(manifest.browserWorkerEvidence.observationsFile, referenceDirectory),
      'utf8',
    )
    const evidence = JSON.parse(bytes)

    expect(sha256(bytes)).toBe(manifest.browserWorkerEvidence.sha256)
    expect(evidence.warning).toMatch(/not SLAs and not test limits/)
    expect(evidence.scenarios.map(({ id }) => id)).toEqual([
      'adopted-10k',
      'supported-ceiling-50k',
    ])

    for (const scenario of evidence.scenarios) {
      expect(scenario.contract).toMatch(/never pass\/fail limits or SLAs/)
      expect(scenario.preview.terminalProgressCount).toBe(1)
      expect(scenario.preview.responseValidation.invalidMessageCount).toBe(0)
      expect(scenario.preview.structuredClone).toEqual({
        responseIdentityReferenceDiffers: true,
        responseIdentityValueMatches: true,
        coordinatorSceneIsWorkerResponseScene: true,
      })
      expect(scenario.cacheAndPhysicalExportReuse).toMatchObject({
        matchingReusableOutlineCaptured: true,
        previewCacheIsCoordinatorScene: true,
        snapshotCopyReferenceDiffers: true,
        workerResponseCopyReferenceDiffers: true,
        coordinatorSceneIsWorkerResponseScene: true,
        settledCacheCopyReferenceDiffers: true,
        previewDerivationCount: 1,
        exportDerivationCount: 0,
        exportDerivationProgressMessageCount: 0,
        finalizingMessageCount: 1,
        completedSceneMatchesPreviewHash: true,
        responseValidation: { invalidMessageCount: 0 },
      })
      expect(scenario.cacheAndPhysicalExportReuse.completedScene).toEqual(
        scenario.preview.scene,
      )
      expect(scenario.noFallback).toEqual({
        specializedSketchIdentity: true,
        legacySourceSceneAbsent: true,
        previewStatus: 'success',
        exportStatus: 'success',
      })
    }
  })
})

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
