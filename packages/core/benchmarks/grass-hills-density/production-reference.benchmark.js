import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  PRODUCTION_OUTLINE_TOLERANCE,
  PRODUCTION_PRESET_NAME,
  PRODUCTION_REFERENCE_ID,
  generateProductionReference,
  productionReferenceManifest,
} from './production-reference.js'

const referenceDirectory = new URL(
  '../../src/sketches/grass-hills/reference/',
  import.meta.url,
)

describe('Grass Hills production acceptance reference', () => {
  it('reproduces production Fill, Outline, and the physical plot byte-for-byte', () => {
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
      schemaVersion: 2,
      referenceId: PRODUCTION_REFERENCE_ID,
      status: 'production-acceptance',
      preset: {
        name: PRODUCTION_PRESET_NAME,
        seed: 12345,
        params: { hillCount: 10, bladeDensity: 2 },
      },
      tool: {
        widthMillimeters: 0.3,
        millimetersPerSceneUnit: 0.18,
      },
      outline: {
        tolerance: PRODUCTION_OUTLINE_TOLERANCE,
        includeFrame: true,
        physicalWidthsMillimeters: {
          grassAndRidges: 0.3,
          compositionFrame: 0.18,
        },
      },
      evidence: {
        allocation: [3094, 1928, 1316, 955, 724, 568, 457, 376, 315, 267],
        fillBladeCount: 10_000,
        outlineSelectedBladeCount: 8_179,
        outlineSourceRidgeCount: 10,
        outlineOccluderCount: 10,
        workload: {
          filledPrimitiveCount: 10,
          sourceSegmentCount: 42_195,
          overlappingPairCount: 5_742,
          estimatedSegmentEdgeComparisons: 3_897_390,
          totalWorkUnits: 4_158_122,
        },
      },
      approval: {
        verdict: 'PASS',
        reviewer: '/root/impl_p4/p4_visual_review',
        rubric: {
          fillGrassReading: 'PASS',
          depthAndTerrainBands: 'PASS',
          outlineFidelity: 'PASS',
          physicalPlotLegibility: 'PASS',
        },
        committedLeanRoundtrip: {
          values: [0, 0.25, 0],
          timingRun: {
            longTasksMilliseconds: [410, 383],
          },
          sceneIdentityRun: {
            exactSceneRestoration: true,
            exactCanvasPixelRestoration: false,
          },
        },
      },
    })
    expect(generated.fillSvg).toBe(
      readFileSync(new URL('fill.svg', referenceDirectory), 'utf8'),
    )
    expect(generated.outlineSvg).toBe(
      readFileSync(new URL('outline.svg', referenceDirectory), 'utf8'),
    )
    expect(generated.physicalPlotSvg).toBe(
      readFileSync(new URL('physical-plot.svg', referenceDirectory), 'utf8'),
    )
    expect(sha256(generated.fillSvg)).toBe(manifest.artifacts.fill.sha256)
    expect(sha256(generated.outlineSvg)).toBe(
      manifest.artifacts.outline.sha256,
    )
    expect(sha256(generated.physicalPlotSvg)).toBe(
      manifest.artifacts.physicalPlot.sha256,
    )
  }, 30_000)

  it('reuses the exact processed geometry and preserves physical mark widths', () => {
    const first = generateProductionReference()
    const second = generateProductionReference()
    const outlineSceneHash = sha256(JSON.stringify(first.outlineScene))

    expect(first.fillScene).toEqual(second.fillScene)
    expect(first.outlineSource).toEqual(second.outlineSource)
    expect(first.outlineScene).toEqual(second.outlineScene)
    expect(first.physicalPlotSvg).toBe(second.physicalPlotSvg)
    expect(outlineSceneHash).toBe(
      sha256(JSON.stringify(second.outlineScene)),
    )
    expect(first.evidence.outlineInventory.sha256).toBe(outlineSceneHash)
    expect(first.physicalPlotSvg).toContain('width="200mm" height="200mm"')

    const grassMarks = first.outlineScene.primitives.slice(0, -1)
    expect(grassMarks.length).toBeGreaterThan(7_000)
    expect(
      grassMarks.every(
        ({ stroke }) =>
          stroke?.width * first.mapping.scale ===
          first.target.toolWidthMillimeters,
      ),
    ).toBe(true)
    expect(first.outlineScene.primitives.at(-1)?.stroke?.width).toBe(1)
  }, 30_000)
})

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
