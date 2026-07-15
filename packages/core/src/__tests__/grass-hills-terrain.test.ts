import { describe, expect, it } from 'vitest'

import { fbm } from '../fbm'
import { createRandom } from '../random'
import { createTerrainField } from '../sketches/grass-hills/terrain'

const SETTINGS = {
  ridgeScale: 3.5,
  terrainDrift: 1.25,
}

const SAMPLE_COORDINATES = [
  [0, 0],
  [0.125, 0.2],
  [0.5, 0.5],
  [0.875, 0.8],
  [1, 1],
] as const

function sampleField(seed: string, settings = SETTINGS): number[] {
  const terrainAt = createTerrainField(seed, settings)
  return SAMPLE_COORDINATES.map(([x, depth]) => terrainAt(x, depth))
}

describe('grass-hills terrain field', () => {
  it('returns exactly the same field for the same seed and settings', () => {
    expect(sampleField('same-landscape')).toEqual(sampleField('same-landscape'))
  })

  it('changes the field when the seed changes', () => {
    expect(sampleField('landscape-a')).not.toEqual(sampleField('landscape-b'))
  })

  it('maps normalized x and depth through ridge scale and terrain drift', () => {
    const seed = 'normalized-landscape'
    const terrainAt = createTerrainField(seed, SETTINGS)
    const normalizedX = 0.4
    const normalizedDepth = 0.6

    expect(terrainAt(normalizedX, normalizedDepth)).toBe(
      fbm(
        createRandom(seed).noise2D,
        normalizedX * SETTINGS.ridgeScale,
        normalizedDepth * SETTINGS.terrainDrift,
      ),
    )
  })

  it('uses one identical horizontal profile at every depth when drift is zero', () => {
    const terrainAt = createTerrainField('coherent-landscape', {
      ...SETTINGS,
      terrainDrift: 0,
    })

    for (const x of [0, 0.2, 0.5, 0.8, 1]) {
      expect(terrainAt(x, 0)).toBe(terrainAt(x, 0.5))
      expect(terrainAt(x, 0)).toBe(terrainAt(x, 1))
    }
  })

  it('separates depth profiles deterministically when drift is high', () => {
    const a = createTerrainField('drifting-landscape', {
      ...SETTINGS,
      terrainDrift: 8,
    })
    const b = createTerrainField('drifting-landscape', {
      ...SETTINGS,
      terrainDrift: 8,
    })
    const nearA = [0.15, 0.35, 0.55, 0.75].map((x) => a(x, 0))
    const farA = [0.15, 0.35, 0.55, 0.75].map((x) => a(x, 1))
    const nearB = [0.15, 0.35, 0.55, 0.75].map((x) => b(x, 0))
    const farB = [0.15, 0.35, 0.55, 0.75].map((x) => b(x, 1))

    expect(farA).not.toEqual(nearA)
    expect(nearB).toEqual(nearA)
    expect(farB).toEqual(farA)
  })

  it('keeps every sampled height finite and in [-1, 1]', () => {
    const terrainAt = createTerrainField('bounded-landscape', SETTINGS)

    for (let x = 0; x <= 1; x += 0.025) {
      for (let depth = 0; depth <= 1; depth += 0.05) {
        const height = terrainAt(x, depth)
        expect(Number.isFinite(height)).toBe(true)
        expect(height).toBeGreaterThanOrEqual(-1)
        expect(height).toBeLessThanOrEqual(1)
      }
    }
  })
})
