import { describe, expect, it } from 'vitest'

import { DENSITY_FIXTURES, PHYSICAL_TARGET } from './fixtures.js'
import {
  collectCanvasSubmission,
  collectMachineMetadata,
  collectSceneMetrics,
  sceneChecksum,
  sceneInventory,
  spacingPercentiles,
} from './metrics.js'

const PROFILE = PHYSICAL_TARGET.profile

describe('Grass Hills density fixture manifest', () => {
  it('pins the complete workload request ladder and physical target', () => {
    expect(
      DENSITY_FIXTURES.map(({ id, scale, payload }) => [
        id,
        scale,
        payload.request.hillCount,
        payload.request.bladeCount,
      ]),
    ).toEqual([
      ['historical-baseline-400', 'baseline', 10, 400],
      ['one-hill-5000', 'dense', 1, 5_000],
      ['one-hill-10000', 'dense', 1, 10_000],
      ['full-10000', 'dense', 10, 10_000],
      ['full-25000', 'dense', 10, 25_000],
      ['full-50000', 'dense', 10, 50_000],
    ])
    expect(PHYSICAL_TARGET).toMatchObject({
      profile: {
        width: 200,
        height: 200,
        insets: { top: 10, right: 10, bottom: 10, left: 10 },
      },
      drawableMillimeters: { width: 180, height: 180 },
      millimetersPerSceneUnit: 0.18,
      finelinerMillimeters: 0.3,
      nibWidthSceneUnits: 1.6666666666666667,
    })
    expect(PHYSICAL_TARGET.nibWidthSceneUnits * 0.18).toBeCloseTo(0.3, 14)
    for (const fixture of DENSITY_FIXTURES) {
      expect(fixture.payload).toMatchObject({
        seed: 12345,
        t: 0,
        frame: { width: 1000, height: 1000 },
        profile: PROFILE,
        pen: {
          millimetersPerSceneUnit: 0.18,
          finelinerMillimeters: 0.3,
          nibWidthSceneUnits: 1.6666666666666667,
        },
      })
      expect(Object.keys(fixture.payload.params)).toHaveLength(17)
    }
  })
})

describe('Grass Hills density metric collectors', () => {
  const scene = {
    space: { width: 1000, height: 1000 },
    primitives: [
      {
        points: [[0, 0], [10, 0], [10, 10], [0, 10]],
        closed: true,
        fill: { color: 'white' },
        stroke: { color: 'black', width: 1.6666666666666667 },
      },
      {
        points: [[5, 0], [15, 0], [15, 10], [5, 10]],
        closed: true,
        fill: { color: 'white' },
        stroke: { color: 'black', width: 1.6666666666666667 },
      },
    ],
  }

  it('collects stable source checksums, geometry sizes, and Canvas structure', () => {
    const inventory = sceneInventory(scene)
    expect(inventory).toMatchObject({ primitiveCount: 2, pointCount: 8 })
    expect(inventory.checksum).toBe(sceneChecksum(scene))
    expect(inventory.serializedBytes).toBeGreaterThan(inventory.geometryBytes)

    const canvas = collectCanvasSubmission(scene, {
      pixelWidth: 800,
      pixelHeight: 600,
    })
    expect(canvas).toMatchObject({
      measurement: 'counting-canvas-structural-submission-only',
      scope: 'whole-frame',
      includesRasterization: false,
      pixelWidth: 800,
      pixelHeight: 600,
      calls: {
        save: 1,
        restore: 1,
        beginPath: 2,
        moveTo: 2,
        lineTo: 6,
        closePath: 2,
        fill: 2,
        stroke: 2,
        setTransform: 2,
        fillRect: 1,
      },
    })
  })

  it('collects the complete export pipeline and physical spacing in millimeters', () => {
    const metrics = collectSceneMetrics(scene, { profile: PROFILE })
    expect(metrics.source).toMatchObject({ primitiveCount: 2, pointCount: 8 })
    expect(metrics.hiddenLine.workload.totalWorkUnits).toBeGreaterThan(0)
    expect(metrics.hiddenLine.durationMs).toBeGreaterThanOrEqual(0)
    expect(metrics.boundsClip.durationMs).toBeGreaterThanOrEqual(0)
    expect(metrics.svgSerialization.pathCount).toBeGreaterThan(0)
    expect(metrics.svgSerialization.bytes).toBeGreaterThan(0)
    expect(metrics.plotter.pathCount).toBeGreaterThan(0)
    expect(metrics.plotter.svgBytes).toBeGreaterThan(0)
    expect(metrics.physicalSpacing.millimetersPerSceneUnit).toBe(0.18)
    expect(metrics.physicalSpacing.roots.sampleCount).toBe(2)
    for (const name of ['min', 'p50', 'p95', 'max']) {
      expect(metrics.physicalSpacing.roots[name]).toBeCloseTo(0.9, 14)
    }
  })

  it('uses exact nearest-neighbor percentiles and captures machine identity', () => {
    expect(spacingPercentiles([[0, 0], [3, 4], [9, 4]], 0.1)).toEqual({
      sampleCount: 3,
      min: 0.5,
      p05: 0.5,
      p50: 0.5,
      p95: 0.6000000000000001,
      max: 0.6000000000000001,
    })
    expect(collectMachineMetadata()).toMatchObject({
      hostname: expect.any(String),
      os: { platform: expect.any(String), release: expect.any(String) },
      runtime: { node: process.version, v8: expect.any(String) },
      cpu: { model: expect.any(String), logicalCount: expect.any(Number) },
      memory: { totalBytes: expect.any(Number), freeBytesAtCapture: expect.any(Number) },
    })
  })
})
