import { describe, expect, it } from 'vitest'

import { curl } from '../curl'
import { createRandom } from '../random'
import type { Vec2 } from '../types'

/**
 * Numerically estimate the divergence ∂vx/∂x + ∂vy/∂y of the curl field at
 * (x, y) by central finite difference with step `h`.
 *
 * We measure at `h` equal to the curl's own `epsilon`. That is deliberate: the
 * curl is the exact discrete curl of the fbm potential on a stencil of spacing
 * `epsilon`, and the discrete identity div(curl ψ) = 0 holds *exactly* at a
 * matched stencil (the difference operators telescope). So on the field's own
 * grid the divergence is zero to machine precision — regardless of octave count
 * or how much high-frequency content the potential carries — which is a far
 * stronger and less flaky assertion than a mismatched-step truncation estimate.
 */
function divergence(
  field: (x: number, y: number) => Vec2,
  x: number,
  y: number,
  h: number,
): number {
  const [vxPlusX] = field(x + h, y)
  const [vxMinusX] = field(x - h, y)
  const [, vyPlusY] = field(x, y + h)
  const [, vyMinusY] = field(x, y - h)
  const dVxDx = (vxPlusX - vxMinusX) / (2 * h)
  const dVyDy = (vyPlusY - vyMinusY) / (2 * h)
  return dVxDx + dVyDy
}

describe('curl — divergence-free', () => {
  // Absolute tolerance: on a matched stencil the divergence is exactly zero up
  // to floating-point round-off in the difference/division arithmetic.
  const TOL = 1e-6

  it('has ~0 divergence across many sampled points and seeds (2D)', () => {
    const seeds = ['div-a', 'div-b', 42, 7]
    const eps = 1e-3
    // Rich, multi-octave field to show the property is not octave-dependent.
    const opts = { octaves: 6, scale: 0.5, epsilon: eps }
    for (const seed of seeds) {
      const rng = createRandom(seed)
      const field = (x: number, y: number): Vec2 => curl(rng, x, y, opts)
      for (let i = 0; i < 40; i++) {
        const x = i * 0.31 + 0.5
        const y = i * 0.19 - 0.3
        expect(Math.abs(divergence(field, x, y, eps))).toBeLessThan(TOL)
      }
    }
  })

  it('has ~0 divergence on the 3D / z path', () => {
    const rng = createRandom('div-3d')
    const eps = 1e-3
    const z = 2.5
    const opts = { octaves: 5, scale: 0.5, epsilon: eps }
    const field = (x: number, y: number): Vec2 => curl(rng, x, y, z, opts)
    for (let i = 0; i < 40; i++) {
      const x = i * 0.27 + 0.2
      const y = i * 0.23 - 0.4
      expect(Math.abs(divergence(field, x, y, eps))).toBeLessThan(TOL)
    }
  })
})

describe('curl — determinism', () => {
  it('yields identical Vec2 for the same seed, coords, and options (2D)', () => {
    const a = createRandom(42)
    const b = createRandom(42)
    const opts = { octaves: 5, lacunarity: 2.1, gain: 0.45, scale: 1.3, epsilon: 1e-3 }
    expect(curl(a, 1.5, 2.5, opts)).toEqual(curl(b, 1.5, 2.5, opts))
  })

  it('yields identical Vec2 for the same seed, coords, and options (3D)', () => {
    const a = createRandom(42)
    const b = createRandom(42)
    const opts = { octaves: 3, gain: 0.6 }
    expect(curl(a, 1.5, 2.5, 3.5, opts)).toEqual(curl(b, 1.5, 2.5, 3.5, opts))
  })

  it('is repeatable across many coordinates on the same instance', () => {
    const rng = createRandom('repeat')
    for (let i = 0; i < 20; i++) {
      const x = i * 0.37
      const y = i * 0.11
      expect(curl(rng, x, y)).toEqual(curl(rng, x, y))
    }
  })

  it('accepts a bare noise function and matches passing the Random', () => {
    const rng = createRandom('bare-fn')
    // Passing rng.noise2D directly should equal passing the whole Random.
    expect(curl(rng.noise2D, 0.7, 1.9)).toEqual(curl(rng, 0.7, 1.9))
    expect(curl(rng.noise3D, 0.7, 1.9, 2.4)).toEqual(curl(rng, 0.7, 1.9, 2.4))
  })

  it('uses default fbm options when none are supplied (2D and 3D)', () => {
    const rng = createRandom('defaults')
    const explicit2D = curl(rng, 1.4, 2.6, {
      octaves: 4,
      lacunarity: 2,
      gain: 0.5,
      scale: 1,
    })
    expect(curl(rng, 1.4, 2.6)).toEqual(explicit2D)

    const explicit3D = curl(rng, 1.4, 2.6, 3.8, {
      octaves: 4,
      lacunarity: 2,
      gain: 0.5,
      scale: 1,
    })
    expect(curl(rng, 1.4, 2.6, 3.8)).toEqual(explicit3D)
  })
})

describe('curl — seed dependence', () => {
  it('produces a different field for a different seed (2D)', () => {
    const a = createRandom(1)
    const b = createRandom(2)
    const fieldA: Vec2[] = []
    const fieldB: Vec2[] = []
    for (let i = 0; i < 25; i++) {
      const x = i * 0.2
      const y = i * 0.3
      fieldA.push(curl(a, x, y))
      fieldB.push(curl(b, x, y))
    }
    expect(fieldA).not.toEqual(fieldB)
  })

  it('produces a different field for a different seed (3D)', () => {
    const a = createRandom(1)
    const b = createRandom(2)
    expect(curl(a, 1.1, 2.2, 3.3)).not.toEqual(curl(b, 1.1, 2.2, 3.3))
  })
})

describe('curl — 3D / z path', () => {
  it('threads z so the field animates along z', () => {
    const rng = createRandom('z-thread')
    const atZ0 = curl(rng, 1.0, 1.0, 0.0)
    const atZ5 = curl(rng, 1.0, 1.0, 5.0)
    // Same (x, y) but different z must sample a different slice of the field.
    expect(atZ0).not.toEqual(atZ5)
  })
})

describe('curl — shape', () => {
  it('returns a 2-tuple of finite numbers', () => {
    const rng = createRandom('shape')
    const v = curl(rng, 0.4, 0.9)
    expect(v).toHaveLength(2)
    expect(Number.isFinite(v[0])).toBe(true)
    expect(Number.isFinite(v[1])).toBe(true)
  })
})

describe('curl — robustness', () => {
  it('falls back to the default step for an explicit epsilon of 0', () => {
    const rng = createRandom('eps-zero')
    const v = curl(rng, 0.4, 0.9, { epsilon: 0 })
    expect(Number.isFinite(v[0])).toBe(true)
    expect(Number.isFinite(v[1])).toBe(true)
    // A zero epsilon degrades to the scale-derived default step.
    expect(v).toEqual(curl(rng, 0.4, 0.9))
  })

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY] as const) {
    it(`returns a finite Vec2 for a non-finite epsilon (${bad})`, () => {
      const rng = createRandom('eps-nonfinite')
      const v = curl(rng, 0.4, 0.9, { epsilon: bad })
      expect(Number.isFinite(v[0])).toBe(true)
      expect(Number.isFinite(v[1])).toBe(true)
      expect(v).toEqual(curl(rng, 0.4, 0.9))
    })
  }
})
