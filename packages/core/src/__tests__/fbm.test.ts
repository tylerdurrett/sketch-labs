import { describe, expect, it } from 'vitest'

import { fbm, prepareFbm3D, type FbmOptions } from '../fbm'
import { createRandom } from '../random'

describe('fbm — determinism', () => {
  it('yields identical values for the same seed, coords, and options (2D)', () => {
    const a = createRandom(42)
    const b = createRandom(42)
    const opts = { octaves: 5, lacunarity: 2.1, gain: 0.45, scale: 1.3 }
    expect(fbm(a, 1.5, 2.5, opts)).toBe(fbm(b, 1.5, 2.5, opts))
  })

  it('yields identical values for the same seed, coords, and options (3D)', () => {
    const a = createRandom(42)
    const b = createRandom(42)
    const opts = { octaves: 3, gain: 0.6 }
    expect(fbm(a, 1.5, 2.5, 3.5, opts)).toBe(fbm(b, 1.5, 2.5, 3.5, opts))
  })

  it('is repeatable across many coordinates on the same instance', () => {
    const rng = createRandom('repeat')
    for (let i = 0; i < 20; i++) {
      const x = i * 0.37
      const y = i * 0.11
      expect(fbm(rng, x, y)).toBe(fbm(rng, x, y))
    }
  })

  it('accepts a bare noise function and matches passing the Random', () => {
    const rng = createRandom('bare-fn')
    // Passing rng.noise2D directly should equal passing the whole Random.
    expect(fbm(rng.noise2D, 0.7, 1.9)).toBe(fbm(rng, 0.7, 1.9))
    expect(fbm(rng.noise3D, 0.7, 1.9, 2.4)).toBe(fbm(rng, 0.7, 1.9, 2.4))
  })
})

describe('prepareFbm3D — exact generic equivalence', () => {
  const optionSets: FbmOptions[] = [
    {},
    { octaves: 1 },
    { octaves: 0, gain: 0.9, scale: 2 },
    { octaves: 3, lacunarity: 2.1, gain: 0.37, scale: 1.3 },
    { octaves: 6, lacunarity: 1.7, gain: 0, scale: 0 },
  ]

  it('matches one-shot fbm bit-for-bit across sources, options, and coordinates', () => {
    for (const seed of ['prepared-a', 'prepared-b', 42] as const) {
      const rng = createRandom(seed)
      for (const source of [rng, rng.noise3D] as const) {
        for (const options of optionSets) {
          const prepared = prepareFbm3D(source, options)
          for (let i = 0; i < 12; i++) {
            const x = i * 0.173 - 0.4
            const y = i * -0.219 + 0.7
            const z = i * 0.127
            expect(prepared(x, y, z)).toBe(fbm(source, x, y, z, options))
          }
        }
      }
    }
  })
})

describe('fbm — octave & gain effect', () => {
  it('adds finer detail as octaves increase (fields diverge)', () => {
    const rng = createRandom('octaves')
    const oneOctave: number[] = []
    const manyOctaves: number[] = []
    for (let i = 0; i < 30; i++) {
      const x = i * 0.05
      const y = i * 0.05
      oneOctave.push(fbm(rng, x, y, { octaves: 1 }))
      manyOctaves.push(fbm(rng, x, y, { octaves: 6 }))
    }
    // More octaves layer in higher-frequency detail, so the sampled field
    // must differ from the single-octave base.
    expect(manyOctaves).not.toEqual(oneOctave)
  })

  it('a single octave equals the raw base-frequency noise sample', () => {
    const rng = createRandom('single-octave')
    // With octaves=1 the normalization divides by amplitude 1, so fbm reduces
    // to the base noise sample at scale.
    expect(fbm(rng, 3.2, 4.8, { octaves: 1, scale: 1 })).toBe(rng.noise2D(3.2, 4.8))
  })

  it('gain shapes the amplitude contribution (different gain => different field)', () => {
    const rng = createRandom('gain')
    const lowGain = fbm(rng, 2.1, 5.3, { octaves: 4, gain: 0.2 })
    const highGain = fbm(rng, 2.1, 5.3, { octaves: 4, gain: 0.8 })
    expect(lowGain).not.toBe(highGain)
  })

  it('stays bounded in roughly [-1, 1] regardless of octave count', () => {
    const rng = createRandom('bounds')
    for (let i = 0; i < 50; i++) {
      const v = fbm(rng, i * 0.13, i * 0.29, { octaves: 8, gain: 0.9 })
      expect(v).toBeGreaterThanOrEqual(-1)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('returns a flat 0 field when octaves is 0', () => {
    const rng = createRandom('zero-octaves')
    expect(fbm(rng, 1, 2, { octaves: 0 })).toBe(0)
  })
})

describe('fbm — seed dependence', () => {
  it('produces a different field for a different seed (2D)', () => {
    const a = createRandom(1)
    const b = createRandom(2)
    const fieldA: number[] = []
    const fieldB: number[] = []
    for (let i = 0; i < 25; i++) {
      const x = i * 0.2
      const y = i * 0.3
      fieldA.push(fbm(a, x, y))
      fieldB.push(fbm(b, x, y))
    }
    expect(fieldA).not.toEqual(fieldB)
  })

  it('produces a different field for a different seed (3D)', () => {
    const a = createRandom(1)
    const b = createRandom(2)
    expect(fbm(a, 1.1, 2.2, 3.3)).not.toBe(fbm(b, 1.1, 2.2, 3.3))
  })
})

describe('fbm — 3D / z path', () => {
  it('threads z so the field animates along z', () => {
    const rng = createRandom('z-thread')
    const atZ0 = fbm(rng, 1.0, 1.0, 0.0)
    const atZ5 = fbm(rng, 1.0, 1.0, 5.0)
    // Same (x, y) but different z must sample a different slice of the field.
    expect(atZ0).not.toBe(atZ5)
  })

  it('stays bounded in roughly [-1, 1] on the 3D path', () => {
    const rng = createRandom('z-bounds')
    for (let i = 0; i < 50; i++) {
      const v = fbm(rng, i * 0.1, i * 0.2, i * 0.15, { octaves: 6 })
      expect(v).toBeGreaterThanOrEqual(-1)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

describe('fbm — defaults', () => {
  it('uses default options when none are supplied (2D and 3D)', () => {
    const rng = createRandom('defaults')
    const explicit2D = fbm(rng, 1.4, 2.6, {
      octaves: 4,
      lacunarity: 2,
      gain: 0.5,
      scale: 1,
    })
    expect(fbm(rng, 1.4, 2.6)).toBe(explicit2D)

    const explicit3D = fbm(rng, 1.4, 2.6, 3.8, {
      octaves: 4,
      lacunarity: 2,
      gain: 0.5,
      scale: 1,
    })
    expect(fbm(rng, 1.4, 2.6, 3.8)).toBe(explicit3D)
  })
})
