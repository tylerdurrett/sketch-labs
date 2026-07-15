import { DENSITY_FIXTURES } from './fixtures.js'

// Must match the bundled candidate without importing its TypeScript source
// graph into the plain-Node orchestration process.
const SIMPLIFIED_CANDIDATE_ID = 'simplified-stroke-tufts'

const moduleUrl = process.env.GRASS_HILLS_SIMPLIFIED_BUNDLE_URL
if (!moduleUrl) {
  throw new Error('GRASS_HILLS_SIMPLIFIED_BUNDLE_URL is required')
}

const SCREEN_FIXTURES = [DENSITY_FIXTURES[0], DENSITY_FIXTURES[1]]
const VARIANTS = [
  { occluderMode: 'hill-only', densityMode: 'same-density' },
  { occluderMode: 'hill-only', densityMode: 'plotter-lod' },
  { occluderMode: 'hill-and-clump', densityMode: 'same-density' },
  { occluderMode: 'hill-and-clump', densityMode: 'plotter-lod' },
]

export const jobs = VARIANTS.flatMap((variant) =>
  SCREEN_FIXTURES.map((fixture) => ({
    candidate: {
      id: SIMPLIFIED_CANDIDATE_ID,
      moduleUrl,
      complexity: 'linear',
    },
    fixture: {
      id: `${fixture.id}--${variant.occluderMode}--${variant.densityMode}`,
      scale: fixture.scale,
      payload: {
        ...fixture.payload,
        simplified: variant,
      },
    },
  })),
)
