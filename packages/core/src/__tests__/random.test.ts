import { describe, expect, it } from 'vitest'

import { createRandom } from '../random'

describe('createRandom', () => {
  it('returns an object with all Random interface methods', () => {
    const rng = createRandom(42)
    expect(typeof rng.value).toBe('function')
    expect(typeof rng.range).toBe('function')
    expect(typeof rng.rangeFloor).toBe('function')
    expect(typeof rng.gaussian).toBe('function')
    expect(typeof rng.boolean).toBe('function')
    expect(typeof rng.pick).toBe('function')
    expect(typeof rng.shuffle).toBe('function')
    expect(typeof rng.onCircle).toBe('function')
    expect(typeof rng.insideCircle).toBe('function')
    expect(typeof rng.noise2D).toBe('function')
    expect(typeof rng.noise3D).toBe('function')
  })
})

describe('value', () => {
  it('produces deterministic sequences for the same seed', () => {
    const a = createRandom(42)
    const b = createRandom(42)
    const seqA = Array.from({ length: 100 }, () => a.value())
    const seqB = Array.from({ length: 100 }, () => b.value())
    expect(seqA).toEqual(seqB)
  })

  it('produces different sequences for different seeds', () => {
    const a = createRandom(42)
    const b = createRandom(99)
    const seqA = Array.from({ length: 20 }, () => a.value())
    const seqB = Array.from({ length: 20 }, () => b.value())
    expect(seqA).not.toEqual(seqB)
  })

  it('returns values in [0, 1)', () => {
    const rng = createRandom('bounds-test')
    for (let i = 0; i < 1000; i++) {
      const v = rng.value()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('range', () => {
  it('returns values in [min, max)', () => {
    const rng = createRandom('range-test')
    for (let i = 0; i < 1000; i++) {
      const v = rng.range(5, 10)
      expect(v).toBeGreaterThanOrEqual(5)
      expect(v).toBeLessThan(10)
    }
  })

  it('works with negative ranges', () => {
    const rng = createRandom('neg-range')
    for (let i = 0; i < 100; i++) {
      const v = rng.range(-10, -5)
      expect(v).toBeGreaterThanOrEqual(-10)
      expect(v).toBeLessThan(-5)
    }
  })
})

describe('rangeFloor', () => {
  it('returns only integers in [min, max)', () => {
    const rng = createRandom('floor-test')
    const seen = new Set<number>()
    for (let i = 0; i < 1000; i++) {
      const v = rng.rangeFloor(0, 3)
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(3)
      seen.add(v)
    }
    // Over 1000 trials, should see all values 0, 1, 2
    expect(seen).toEqual(new Set([0, 1, 2]))
  })
})

describe('gaussian', () => {
  it('approximates expected mean and std over many samples', () => {
    const rng = createRandom('gaussian-test')
    const n = 10_000
    const samples = Array.from({ length: n }, () => rng.gaussian(5, 2))

    const mean = samples.reduce((a, b) => a + b, 0) / n
    const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)
    const std = Math.sqrt(variance)

    // With 10k samples, mean should be within ~0.1 of target
    expect(mean).toBeCloseTo(5, 0)
    expect(std).toBeCloseTo(2, 0)
  })

  it('defaults to mean=0, std=1', () => {
    const rng = createRandom('gaussian-defaults')
    const n = 5000
    const samples = Array.from({ length: n }, () => rng.gaussian())

    const mean = samples.reduce((a, b) => a + b, 0) / n
    expect(mean).toBeCloseTo(0, 0)
  })

  it('never produces Infinity', () => {
    const rng = createRandom('gaussian-finite')
    for (let i = 0; i < 10_000; i++) {
      const v = rng.gaussian()
      expect(Number.isFinite(v)).toBe(true)
    }
  })
})

describe('boolean', () => {
  it('returns only true or false', () => {
    const rng = createRandom('bool-test')
    for (let i = 0; i < 100; i++) {
      const v = rng.boolean()
      expect(typeof v).toBe('boolean')
    }
  })

  it('returns both true and false over many calls', () => {
    const rng = createRandom('bool-coverage')
    const results = Array.from({ length: 100 }, () => rng.boolean())
    expect(results).toContain(true)
    expect(results).toContain(false)
  })
})

describe('pick', () => {
  it('returns an element from the array', () => {
    const rng = createRandom('pick-test')
    const items = ['a', 'b', 'c', 'd']
    for (let i = 0; i < 100; i++) {
      expect(items).toContain(rng.pick(items))
    }
  })

  it('can pick all elements over many calls', () => {
    const rng = createRandom('pick-coverage')
    const items = [1, 2, 3]
    const seen = new Set<number>()
    for (let i = 0; i < 200; i++) {
      seen.add(rng.pick(items))
    }
    expect(seen).toEqual(new Set([1, 2, 3]))
  })

  it('throws on empty array', () => {
    const rng = createRandom('pick-empty')
    expect(() => rng.pick([])).toThrow('Cannot pick from an empty array')
  })
})

describe('shuffle', () => {
  it('returns a new array (not the same reference)', () => {
    const rng = createRandom('shuffle-ref')
    const input = [1, 2, 3, 4, 5]
    const result = rng.shuffle(input)
    expect(result).not.toBe(input)
  })

  it('does not mutate the input array', () => {
    const rng = createRandom('shuffle-immut')
    const input = [1, 2, 3, 4, 5]
    const copy = [...input]
    rng.shuffle(input)
    expect(input).toEqual(copy)
  })

  it('contains the same elements as the input', () => {
    const rng = createRandom('shuffle-elements')
    const input = [1, 2, 3, 4, 5]
    const result = rng.shuffle(input)
    expect(result.sort()).toEqual([...input].sort())
  })

  it('produces deterministic results for the same seed', () => {
    const a = createRandom(42)
    const b = createRandom(42)
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(a.shuffle(input)).toEqual(b.shuffle(input))
  })
})

describe('onCircle', () => {
  it('returns points at the correct distance from origin', () => {
    const rng = createRandom('circle-test')
    for (let i = 0; i < 100; i++) {
      const [x, y] = rng.onCircle(5)
      const dist = Math.sqrt(x * x + y * y)
      expect(dist).toBeCloseTo(5)
    }
  })

  it('defaults to radius 1', () => {
    const rng = createRandom('circle-default')
    const [x, y] = rng.onCircle()
    const dist = Math.sqrt(x * x + y * y)
    expect(dist).toBeCloseTo(1)
  })

  it('returns Vec2 tuples', () => {
    const rng = createRandom('circle-type')
    const point = rng.onCircle()
    expect(point).toHaveLength(2)
    expect(typeof point[0]).toBe('number')
    expect(typeof point[1]).toBe('number')
  })
})

describe('insideCircle', () => {
  it('returns points within the given radius', () => {
    const rng = createRandom('inside-test')
    for (let i = 0; i < 1000; i++) {
      const [x, y] = rng.insideCircle(3)
      const dist = Math.sqrt(x * x + y * y)
      expect(dist).toBeLessThanOrEqual(3)
    }
  })

  it('defaults to radius 1', () => {
    const rng = createRandom('inside-default')
    for (let i = 0; i < 100; i++) {
      const [x, y] = rng.insideCircle()
      const dist = Math.sqrt(x * x + y * y)
      expect(dist).toBeLessThanOrEqual(1)
    }
  })

  it('returns Vec2 tuples', () => {
    const rng = createRandom('inside-type')
    const point = rng.insideCircle()
    expect(point).toHaveLength(2)
  })
})

describe('noise2D', () => {
  it('returns consistent values for the same seed and coordinates', () => {
    const a = createRandom(42)
    const b = createRandom(42)
    expect(a.noise2D(1.5, 2.5)).toBe(b.noise2D(1.5, 2.5))
  })

  it('returns values in [-1, 1]', () => {
    const rng = createRandom('noise2d-bounds')
    for (let x = 0; x < 10; x++) {
      for (let y = 0; y < 10; y++) {
        const v = rng.noise2D(x * 0.1, y * 0.1)
        expect(v).toBeGreaterThanOrEqual(-1)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })

  it('varies spatially', () => {
    const rng = createRandom('noise2d-spatial')
    const v1 = rng.noise2D(0, 0)
    const v2 = rng.noise2D(10, 10)
    // Simplex noise at different coordinates should differ
    expect(v1).not.toBe(v2)
  })
})

describe('noise3D', () => {
  it('returns consistent values for the same seed and coordinates', () => {
    const a = createRandom(42)
    const b = createRandom(42)
    expect(a.noise3D(1.5, 2.5, 3.5)).toBe(b.noise3D(1.5, 2.5, 3.5))
  })

  it('returns values in [-1, 1]', () => {
    const rng = createRandom('noise3d-bounds')
    for (let i = 0; i < 100; i++) {
      const v = rng.noise3D(i * 0.1, i * 0.2, i * 0.3)
      expect(v).toBeGreaterThanOrEqual(-1)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

describe('independence', () => {
  it('two instances with different seeds do not interfere', () => {
    const a = createRandom(1)
    const b = createRandom(2)

    // Advance b's state
    for (let i = 0; i < 50; i++) b.value()

    // a's sequence should still match a fresh instance with seed 1
    const fresh = createRandom(1)
    const seqA = Array.from({ length: 20 }, () => a.value())
    const seqFresh = Array.from({ length: 20 }, () => fresh.value())
    expect(seqA).toEqual(seqFresh)
  })

  it('noise calls do not affect the main value() sequence', () => {
    const a = createRandom(42)
    const b = createRandom(42)

    // Call noise on a but not b
    a.noise2D(1, 2)
    a.noise3D(3, 4, 5)

    // value() sequences should still match because noise uses separate PRNGs
    const seqA = Array.from({ length: 20 }, () => a.value())
    const seqB = Array.from({ length: 20 }, () => b.value())
    expect(seqA).toEqual(seqB)
  })
})
