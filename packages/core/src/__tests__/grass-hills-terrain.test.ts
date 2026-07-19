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

describe('grass-hills terrain shaping', () => {
  const SHAPING_DEFAULTS = {
    ...SETTINGS,
    terrainOctaves: 4,
    terrainRoughness: 0.5,
    terrainContrast: 1,
    terrainSharpness: 0,
  }

  const SWEEP: Array<[number, number]> = []
  for (let x = 0; x <= 1; x += 0.05) {
    for (let depth = 0; depth <= 1; depth += 0.25) {
      SWEEP.push([x, depth])
    }
  }

  it('keeps explicit shaping defaults bit-identical to the option-free field', () => {
    const bare = createTerrainField('shaping-defaults', SETTINGS)
    const explicit = createTerrainField('shaping-defaults', SHAPING_DEFAULTS)

    for (const [x, depth] of SWEEP) {
      expect(explicit(x, depth)).toBe(bare(x, depth))
    }
  })

  it('folds the field into clamped 1 - 2|fbm| at full sharpness', () => {
    const seed = 'sharp-landscape'
    const terrainAt = createTerrainField(seed, {
      ...SHAPING_DEFAULTS,
      terrainSharpness: 1,
    })
    const noise2D = createRandom(seed).noise2D

    for (const [x, depth] of SWEEP) {
      const height = fbm(
        noise2D,
        x * SETTINGS.ridgeScale,
        depth * SETTINGS.terrainDrift,
      )
      const ridged = 1 - 2 * Math.abs(height)
      // Exact expectation mirrors the blend h + s * (ridged - h) at s = 1,
      // which floating point does not simplify bit-for-bit to `ridged`.
      expect(terrainAt(x, depth)).toBe(
        Math.max(-1, Math.min(1, height + (ridged - height))),
      )
      expect(terrainAt(x, depth)).toBeCloseTo(
        Math.max(-1, Math.min(1, ridged)),
        12,
      )
    }
  })

  it('applies a sign-preserving monotone power curve that fixes 0 and ±1', () => {
    const seed = 'contrast-landscape'
    const base = createTerrainField(seed, SETTINGS)
    const sharpened = createTerrainField(seed, {
      ...SHAPING_DEFAULTS,
      terrainContrast: 4,
    })
    const softened = createTerrainField(seed, {
      ...SHAPING_DEFAULTS,
      terrainContrast: 0.25,
    })

    for (const [x, depth] of SWEEP) {
      const height = base(x, depth)
      const sharp = sharpened(x, depth)
      const soft = softened(x, depth)

      // sign(h) * |h| ** c fixes 0 and ±1; between them contrast above one
      // compresses magnitudes toward 0 and contrast below one expands them.
      expect(sharp).toBe(Math.sign(height) * Math.abs(height) ** 4)
      expect(soft).toBe(Math.sign(height) * Math.abs(height) ** 0.25)
      expect(Math.abs(sharp)).toBeLessThanOrEqual(Math.abs(height))
      expect(Math.abs(soft)).toBeGreaterThanOrEqual(Math.abs(height))
    }
  })

  it('collapses to the raw single-octave noise sample at one octave', () => {
    const seed = 'single-octave-landscape'
    const terrainAt = createTerrainField(seed, {
      ...SHAPING_DEFAULTS,
      terrainOctaves: 1,
    })
    const noise2D = createRandom(seed).noise2D

    for (const [x, depth] of SWEEP) {
      const sample = noise2D(
        x * SETTINGS.ridgeScale,
        depth * SETTINGS.terrainDrift,
      )
      expect(terrainAt(x, depth)).toBe(Math.max(-1, Math.min(1, sample)))
    }
  })

  it('changes the field when roughness changes', () => {
    const sample = (terrainRoughness: number) => {
      const terrainAt = createTerrainField('rough-landscape', {
        ...SHAPING_DEFAULTS,
        terrainRoughness,
      })
      return SWEEP.map(([x, depth]) => terrainAt(x, depth))
    }

    expect(sample(0.9)).not.toEqual(sample(0.5))
  })

  it('stays deterministic and bounded with every shaping option active', () => {
    const settings = {
      ...SETTINGS,
      terrainOctaves: 8,
      terrainRoughness: 0.9,
      terrainContrast: 2.5,
      terrainSharpness: 0.7,
    }
    const first = createTerrainField('shaped-landscape', settings)
    const second = createTerrainField('shaped-landscape', settings)

    for (const [x, depth] of SWEEP) {
      const height = first(x, depth)
      expect(Number.isFinite(height)).toBe(true)
      expect(height).toBeGreaterThanOrEqual(-1)
      expect(height).toBeLessThanOrEqual(1)
      expect(second(x, depth)).toBe(height)
    }
  })
})
