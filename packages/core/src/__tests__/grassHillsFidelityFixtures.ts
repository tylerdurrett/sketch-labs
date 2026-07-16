import type { CoordinateSpace } from '../scene'
import { defaultParams, type Params, type Seed } from '../sketch'
import { grassHills } from '../sketches/grass-hills'
import { GRASS_HILLS_TOOL_WIDTH_MILLIMETERS } from '../sketches/grass-hills/outline'

export interface GrassHillsFidelityFixture {
  readonly seed: Seed
  readonly time: number
  readonly frame: CoordinateSpace
  readonly params: Params
  readonly target: {
    readonly toolWidthMillimeters: number
    readonly millimetersPerSceneUnit: number
  }
  readonly expectedBladeCount: number
  /** Dense fixtures are declarations for the indexed campaign, not oracle inputs. */
  readonly oraclePolicy: 'exact-now' | 'scalable-campaign'
}

const FRAME = Object.freeze({ width: 1_000, height: 1_000 })
const TARGET = Object.freeze({
  toolWidthMillimeters: GRASS_HILLS_TOOL_WIDTH_MILLIMETERS,
  millimetersPerSceneUnit: 180 / FRAME.width,
})
const DEFAULTS = defaultParams(grassHills.schema)

function fixture(
  seed: Seed,
  overrides: Readonly<Params>,
  expectedBladeCount: number,
  oraclePolicy: GrassHillsFidelityFixture['oraclePolicy'],
): GrassHillsFidelityFixture {
  return Object.freeze({
    seed,
    time: 0,
    frame: FRAME,
    params: Object.freeze({ ...DEFAULTS, ...overrides }),
    target: TARGET,
    expectedBladeCount,
    oraclePolicy,
  })
}

/**
 * Deterministic issue-309 fidelity envelopes.
 *
 * Only `bounded` belongs in the independent quadratic oracle. `adopted10k` and
 * `ceiling50k` pin the exact public-call inputs that the scalable indexed
 * campaign must exercise later; declaring them here prevents a smaller proxy
 * from silently becoming the density acceptance fixture.
 */
export const GRASS_HILLS_FIDELITY_FIXTURES = Object.freeze({
  bounded: fixture(
    'issue-309-bounded-painter-order',
    {
      hillCount: 3,
      ridgeAmplitude: 0,
      bladeDensity: 0.01,
      bladeLength: 80,
      bladeLengthVariance: 0,
      bladeWidth: 12,
      windLean: 0.45,
    },
    50,
    'exact-now',
  ),
  adopted10k: fixture(12345, { bladeDensity: 2 }, 10_000, 'scalable-campaign'),
  ceiling50k: fixture(
    'issue-309-supported-density-ceiling',
    { bladeDensity: 10 },
    50_000,
    'scalable-campaign',
  ),
})
