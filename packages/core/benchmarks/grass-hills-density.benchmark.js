import { describe, expect, it } from 'vitest'

import { analyzeHiddenLineWorkload, hiddenLinePass } from '../src/hiddenLine'
import { HISTORICAL_BASELINE } from './grass-hills-density/fixtures.js'
import {
  HISTORICAL_BASELINE_INVENTORY,
  replayHistoricalBaselineFill,
  replayHistoricalBaselineOutline,
} from './grass-hills-density/historical-baseline.js'

// This historical maximum-density fixture is deliberately literal. In
// particular, do not derive its params or frame from mutable application
// defaults: this smoke benchmark must keep measuring the workload recorded at
// the start of issue #305 even when Grass Hills evolves.
const {
  seed: BASELINE_SEED,
  t: BASELINE_TIME,
  frame: BASELINE_FRAME,
  params: BASELINE_PARAMS,
} = HISTORICAL_BASELINE.payload

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
    const replayStart = performance.now()
    const scene = replayHistoricalBaselineFill()
    const replayMs = performance.now() - replayStart
    const counts = sceneCounts(scene)
    const workload = analyzeHiddenLineWorkload(scene)

    const hiddenLineStart = performance.now()
    const outline = hiddenLinePass(scene, { tolerance: 0 })
    const hiddenLineMs = performance.now() - hiddenLineStart

    expect(counts).toEqual({
      hills: HISTORICAL_BASELINE_INVENTORY.hills,
      blades: HISTORICAL_BASELINE_INVENTORY.blades,
      primitives: HISTORICAL_BASELINE_INVENTORY.primitives,
      points: HISTORICAL_BASELINE_INVENTORY.points,
    })
    expect(workload.totalWorkUnits).toBe(
      HISTORICAL_BASELINE_INVENTORY.hiddenLineWorkUnits,
    )
    expect(outline).toEqual(replayHistoricalBaselineOutline())

    console.log('\nGrass Hills density baseline (smoke-only)')
    console.log(`runtime                           ${process.version} ${process.platform}/${process.arch}`)
    console.log(`seed / time                       ${BASELINE_SEED} / ${BASELINE_TIME}`)
    console.log(`frame                             ${BASELINE_FRAME.width} × ${BASELINE_FRAME.height}`)
    console.log(`scene                             ${counts.hills} hills, ${counts.blades} blades, ${counts.primitives} primitives, ${counts.points} points`)
    console.log(`hidden-line work                  ${workload.totalWorkUnits} units`)
    console.log(`issue #305 historical work       ${HISTORICAL_BASELINE_INVENTORY.issueRecordedHiddenLineWorkUnits} units; fixture metadata unavailable`)
    console.log(`snapshot replay (one smoke run)   ${replayMs.toFixed(2)} ms`)
    console.log(`hidden-line (one smoke run)       ${hiddenLineMs.toFixed(2)} ms`)
    console.log('issue-start observations          ~248 ms cold, ~44 ms hidden-line; non-SLA')
  })
})
