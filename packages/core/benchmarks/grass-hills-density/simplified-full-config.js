import { DENSITY_FIXTURES } from './fixtures.js'

// Must match the generated bundle without importing the candidate's TypeScript
// graph into the plain-Node orchestration process.
const SIMPLIFIED_CANDIDATE_ID = 'simplified-stroke-tufts'
const FINALIST = Object.freeze({
  occluderMode: 'hill-and-clump',
  densityMode: 'plotter-lod',
})

const moduleUrl = process.env.GRASS_HILLS_SIMPLIFIED_BUNDLE_URL
if (!moduleUrl) {
  throw new Error('GRASS_HILLS_SIMPLIFIED_BUNDLE_URL is required')
}

export const jobs = DENSITY_FIXTURES.slice(1).map((fixture) => ({
  candidate: {
    id: SIMPLIFIED_CANDIDATE_ID,
    moduleUrl,
    complexity: 'linear',
  },
  fixture: {
    id: fixture.id,
    scale: fixture.scale,
    payload: {
      ...fixture.payload,
      simplified: FINALIST,
    },
  },
}))
