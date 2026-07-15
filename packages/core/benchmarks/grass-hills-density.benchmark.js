import { describe, expect, it } from 'vitest'

import { analyzeHiddenLineWorkload, hiddenLinePass } from '../src/hiddenLine'
import { grassHills } from '../src/sketches/grass-hills'

// This historical maximum-density fixture is deliberately literal. In
// particular, do not derive its params or frame from mutable application
// defaults: this smoke benchmark must keep measuring the workload recorded at
// the start of issue #305 even when Grass Hills evolves.
const BASELINE_SEED = 12345
const BASELINE_TIME = 0
const BASELINE_FRAME = Object.freeze({ width: 1000, height: 1000 })
const BASELINE_PARAMS = Object.freeze({
  hillCount: 10,
  horizonHeight: 0.25,
  depthFalloff: 2,
  ridgeScale: 3.5,
  ridgeAmplitude: 0.8,
  terrainDrift: 1.25,
  bladeDensity: 2,
  bladeLength: 28,
  bladeLengthVariance: 8,
  bladeWidth: 3,
  stiffnessVariance: 0.25,
  windLean: 0,
  backgroundColor: '#ffffff',
  hillColor: '#ffffff',
  hillStrokeColor: '#000000',
  bladeColor: '#ffffff',
  bladeStrokeColor: '#000000',
})

const EXPECTED_HILLS = 10
const EXPECTED_BLADES = 400
const EXPECTED_PRIMITIVES = 410
const EXPECTED_POINTS = 14_540
const EXPECTED_CURRENT_HIDDEN_LINE_WORK_UNITS = 11_584_278
const ISSUE_RECORDED_HIDDEN_LINE_WORK_UNITS = 11_372_294

function sceneCounts(scene) {
  let points = 0
  let hills = 0
  let blades = 0

  for (const primitive of scene.primitives) {
    points += primitive.points.length
    if (primitive.closed === true) blades += 1
    else hills += 1
  }

  return {
    hills,
    blades,
    primitives: scene.primitives.length,
    points,
  }
}

describe('Grass Hills historical density baseline', () => {
  it('smoke-checks the pinned geometry and hidden-line workload once', () => {
    const coldStart = performance.now()
    const scene = grassHills.generate(
      BASELINE_PARAMS,
      BASELINE_SEED,
      BASELINE_TIME,
      BASELINE_FRAME,
    )
    const coldMs = performance.now() - coldStart
    const counts = sceneCounts(scene)
    const workload = analyzeHiddenLineWorkload(scene)

    const hiddenLineStart = performance.now()
    const outline = hiddenLinePass(scene, { tolerance: 0 })
    const hiddenLineMs = performance.now() - hiddenLineStart

    expect(counts).toEqual({
      hills: EXPECTED_HILLS,
      blades: EXPECTED_BLADES,
      primitives: EXPECTED_PRIMITIVES,
      points: EXPECTED_POINTS,
    })
    expect(workload.totalWorkUnits).toBe(
      EXPECTED_CURRENT_HIDDEN_LINE_WORK_UNITS,
    )
    expect(outline.primitives.length).toBeGreaterThan(0)

    console.log('\nGrass Hills density baseline (smoke-only)')
    console.log(`runtime                           ${process.version} ${process.platform}/${process.arch}`)
    console.log(`seed / time                       ${BASELINE_SEED} / ${BASELINE_TIME}`)
    console.log(`frame                             ${BASELINE_FRAME.width} × ${BASELINE_FRAME.height}`)
    console.log(`scene                             ${counts.hills} hills, ${counts.blades} blades, ${counts.primitives} primitives, ${counts.points} points`)
    console.log(`hidden-line work                  ${workload.totalWorkUnits} units`)
    console.log(`issue #305 historical work       ${ISSUE_RECORDED_HIDDEN_LINE_WORK_UNITS} units; fixture metadata unavailable`)
    console.log(`cold generation (one smoke run)  ${coldMs.toFixed(2)} ms`)
    console.log(`hidden-line (one smoke run)       ${hiddenLineMs.toFixed(2)} ms`)
    console.log('historical observations           ~248 ms cold, ~44 ms hidden-line; non-SLA')
  })
})
