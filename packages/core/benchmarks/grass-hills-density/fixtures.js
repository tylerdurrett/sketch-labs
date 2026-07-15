/**
 * Literal workload requests for the issue #305 density campaign.
 *
 * These are requests, not claims that the current Grass Hills implementation
 * can produce the requested blade counts. Candidate modules decide how a
 * request is represented and must report the resulting structural inventory.
 * Keep every reproducibility input literal: mutable Sketch defaults and paper
 * catalog entries must not move this campaign underneath old results.
 */

export const PHYSICAL_TARGET = deepFreeze({
  profile: {
    width: 200,
    height: 200,
    insets: { top: 10, right: 10, bottom: 10, left: 10 },
    includeFrame: true,
  },
  drawableMillimeters: { width: 180, height: 180 },
  millimetersPerSceneUnit: 0.18,
  finelinerMillimeters: 0.3,
  nibWidthSceneUnits: 1.6666666666666667,
})

const BASE_PARAMS = {
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
}

function fixture(id, scale, hillCount, requestedBladeCount) {
  return {
    id,
    scale,
    payload: {
      seed: 12345,
      t: 0,
      frame: { width: 1000, height: 1000 },
      params: { ...BASE_PARAMS, hillCount },
      profile: {
        width: 200,
        height: 200,
        insets: { top: 10, right: 10, bottom: 10, left: 10 },
        includeFrame: true,
      },
      pen: {
        millimetersPerSceneUnit: 0.18,
        finelinerMillimeters: 0.3,
        nibWidthSceneUnits: 1.6666666666666667,
      },
      request: { hillCount, bladeCount: requestedBladeCount },
    },
  }
}

export const DENSITY_FIXTURES = deepFreeze([
  fixture('historical-baseline-400', 'baseline', 10, 400),
  fixture('one-hill-5000', 'dense', 1, 5_000),
  fixture('one-hill-10000', 'dense', 1, 10_000),
  fixture('full-10000', 'dense', 10, 10_000),
  fixture('full-25000', 'dense', 10, 25_000),
  fixture('full-50000', 'dense', 10, 50_000),
])

export const HISTORICAL_BASELINE = DENSITY_FIXTURES[0]

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}
