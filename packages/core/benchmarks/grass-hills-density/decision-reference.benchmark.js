import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  DECISION_FIXTURE_ID,
  DECISION_REFERENCE_ID,
  generateDecisionReference,
} from './decision-reference.js'

const referenceDirectory = new URL(
  '../../src/sketches/grass-hills/reference/',
  import.meta.url,
)

describe('Grass Hills architecture-decision reference', () => {
  it('reproduces the checksum-pinned Fill, Outline, and physical plot', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('manifest.json', referenceDirectory), 'utf8'),
    )
    const generated = generateDecisionReference()

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      candidateId: DECISION_REFERENCE_ID,
      fixtureId: DECISION_FIXTURE_ID,
      request: { hillCount: 10, bladeCount: 10_000 },
      tool: { widthMillimeters: 0.3 },
      evidence: {
        bladeCount: 10_000,
        selectedRootCount: 9_298,
        outlinePathCount: 8_939,
      },
    })
    expect(generated.fillSvg).toBe(
      readFileSync(new URL('fill.svg', referenceDirectory), 'utf8'),
    )
    expect(generated.outlineSvg).toBe(
      readFileSync(new URL('outline.svg', referenceDirectory), 'utf8'),
    )
    expect(sha256(generated.fillSvg)).toBe(manifest.artifacts.fill.sha256)
    expect(sha256(generated.outlineSvg)).toBe(manifest.artifacts.outline.sha256)
    expect(sha256(generated.plotterSvg)).toBe(
      manifest.artifacts.physicalPlot.sha256,
    )
    expect(manifest.artifacts.physicalPlot.sceneSha256).toBe(
      manifest.artifacts.outline.scene.sha256,
    )
  })

  it('keeps source identities nested and Outline/export on one processed Scene', () => {
    const first = generateDecisionReference()
    const second = generateDecisionReference()

    expect(first.evidence.rootKeys).toEqual(second.evidence.rootKeys)
    expect(first.evidence.selectedRootKeys).toEqual(
      second.evidence.selectedRootKeys,
    )
    expect(first.fillScene).toEqual(second.fillScene)
    expect(first.outlineScene).toEqual(second.outlineScene)
    expect(first.plotterSvg).toContain('width="200mm" height="200mm"')
  })
})

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
