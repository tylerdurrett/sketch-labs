import { describe, expect, it } from 'vitest'
import {
  lerp,
  inverseLerp,
  clamp,
  mapRange,
  fract,
  mod,
  degToRad,
  radToDeg,
  smoothstep,
} from '../math'

describe('lerp', () => {
  it('returns a when t=0', () => {
    expect(lerp(0, 10, 0)).toBe(0)
  })

  it('returns b when t=1', () => {
    expect(lerp(0, 10, 1)).toBe(10)
  })

  it('returns midpoint when t=0.5', () => {
    expect(lerp(0, 10, 0.5)).toBe(5)
  })

  it('works with negative ranges', () => {
    expect(lerp(-10, 10, 0.5)).toBe(0)
  })

  it('extrapolates beyond t=1', () => {
    expect(lerp(0, 10, 2)).toBe(20)
  })

  it('extrapolates below t=0', () => {
    expect(lerp(0, 10, -1)).toBe(-10)
  })
})

describe('inverseLerp', () => {
  it('returns 0 when v equals a', () => {
    expect(inverseLerp(0, 10, 0)).toBe(0)
  })

  it('returns 1 when v equals b', () => {
    expect(inverseLerp(0, 10, 10)).toBe(1)
  })

  it('returns 0.5 at midpoint', () => {
    expect(inverseLerp(0, 10, 5)).toBe(0.5)
  })

  it('works with negative ranges', () => {
    expect(inverseLerp(-10, 10, 0)).toBe(0.5)
  })

  it('returns 0 when a equals b (degenerate)', () => {
    expect(inverseLerp(5, 5, 5)).toBe(0)
  })
})

describe('clamp', () => {
  it('returns value when in range', () => {
    expect(clamp(5, 0, 10)).toBe(5)
  })

  it('clamps to min', () => {
    expect(clamp(-5, 0, 10)).toBe(0)
  })

  it('clamps to max', () => {
    expect(clamp(15, 0, 10)).toBe(10)
  })

  it('returns min when value equals min', () => {
    expect(clamp(0, 0, 10)).toBe(0)
  })

  it('returns max when value equals max', () => {
    expect(clamp(10, 0, 10)).toBe(10)
  })
})

describe('mapRange', () => {
  it('maps midpoint correctly', () => {
    expect(mapRange(5, 0, 10, 0, 100)).toBe(50)
  })

  it('maps start of range', () => {
    expect(mapRange(0, 0, 10, 20, 40)).toBe(20)
  })

  it('maps end of range', () => {
    expect(mapRange(10, 0, 10, 20, 40)).toBe(40)
  })

  it('maps to inverted range', () => {
    expect(mapRange(0, 0, 10, 100, 0)).toBe(100)
  })

  it('extrapolates beyond input range', () => {
    expect(mapRange(20, 0, 10, 0, 100)).toBe(200)
  })
})

describe('fract', () => {
  it('returns fractional part of positive number', () => {
    expect(fract(3.7)).toBeCloseTo(0.7)
  })

  it('returns 0 for integer', () => {
    expect(fract(3)).toBe(0)
  })

  it('handles negative numbers (GLSL convention)', () => {
    expect(fract(-0.3)).toBeCloseTo(0.7)
  })

  it('returns 0 for zero', () => {
    expect(fract(0)).toBe(0)
  })
})

describe('mod', () => {
  it('positive mod positive', () => {
    expect(mod(7, 3)).toBe(1)
  })

  it('negative mod positive (differs from JS %)', () => {
    expect(mod(-1, 3)).toBe(2)
  })

  it('zero mod positive', () => {
    expect(mod(0, 5)).toBe(0)
  })

  it('positive mod equals divisor', () => {
    expect(mod(6, 3)).toBe(0)
  })

  it('handles floating-point modulo', () => {
    expect(mod(1.5, 1)).toBeCloseTo(0.5)
  })
})

describe('degToRad', () => {
  it('converts 0 degrees', () => {
    expect(degToRad(0)).toBe(0)
  })

  it('converts 180 degrees', () => {
    expect(degToRad(180)).toBeCloseTo(Math.PI)
  })

  it('converts 90 degrees', () => {
    expect(degToRad(90)).toBeCloseTo(Math.PI / 2)
  })

  it('converts 360 degrees', () => {
    expect(degToRad(360)).toBeCloseTo(Math.PI * 2)
  })

  it('converts negative degrees', () => {
    expect(degToRad(-90)).toBeCloseTo(-Math.PI / 2)
  })
})

describe('radToDeg', () => {
  it('converts 0 radians', () => {
    expect(radToDeg(0)).toBe(0)
  })

  it('converts PI radians', () => {
    expect(radToDeg(Math.PI)).toBeCloseTo(180)
  })

  it('converts PI/2 radians', () => {
    expect(radToDeg(Math.PI / 2)).toBeCloseTo(90)
  })

  it('converts 2*PI radians', () => {
    expect(radToDeg(Math.PI * 2)).toBeCloseTo(360)
  })

  it('round-trips with degToRad', () => {
    expect(radToDeg(degToRad(45))).toBeCloseTo(45)
  })
})

describe('smoothstep', () => {
  it('returns 0 below edge0', () => {
    expect(smoothstep(0, 1, -1)).toBe(0)
  })

  it('returns 1 above edge1', () => {
    expect(smoothstep(0, 1, 2)).toBe(1)
  })

  it('returns 0 at edge0', () => {
    expect(smoothstep(0, 1, 0)).toBe(0)
  })

  it('returns 1 at edge1', () => {
    expect(smoothstep(0, 1, 1)).toBe(1)
  })

  it('returns 0.5 at midpoint', () => {
    expect(smoothstep(0, 1, 0.5)).toBe(0.5)
  })

  it('follows Hermite polynomial at t=0.25', () => {
    // t=0.25: 0.25^2 * (3 - 2*0.25) = 0.0625 * 2.5 = 0.15625
    expect(smoothstep(0, 1, 0.25)).toBeCloseTo(0.15625)
  })

  it('works with non-0-1 edges', () => {
    expect(smoothstep(10, 20, 15)).toBe(0.5)
  })

  it('returns 0 when edge0 equals edge1 (degenerate)', () => {
    expect(smoothstep(5, 5, 5)).toBe(0)
  })
})
