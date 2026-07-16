import { clipSceneToBounds } from '../../src/clipToBounds.ts'
import { renderToSVG } from '../../src/renderer.ts'
import { createExactBenchmarkCandidate } from './exact-common.js'
import { exactSpatialHiddenLinePass } from './exact-spatial-hidden-line.js'

export const benchmarkCandidate = createExactBenchmarkCandidate({
  id: 'exact-stratified-7',
  rootStrategy: 'stratified',
  bladeGeometry: 'simple-7',
})

/** Deterministically regenerate the finalist fill/Outline decision artifacts. */
export function generateExactStratified7Artifacts(payload, t = payload.t ?? 0) {
  const value = benchmarkCandidate.generate(payload, t)
  const processed = exactSpatialHiddenLinePass(value.scene)
  const fillScene = clipSceneToBounds(value.scene)
  const outlineScene = clipSceneToBounds(processed.scene)
  return {
    fillSvg: renderToSVG(fillScene),
    outlineSvg: renderToSVG(outlineScene),
    sourceScene: value.scene,
    fillScene,
    outlineScene,
    processing: processed,
  }
}
