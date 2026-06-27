import alea from 'alea'
import { createNoise2D, createNoise3D } from 'simplex-noise'

import type { Random, Vec2 } from './types'

/**
 * Create a seeded random number generator conforming to the Random interface.
 * Each instance is fully independent — no shared global state.
 */
export function createRandom(seed: string | number): Random {
  const prng = alea(seed)

  // Separate alea instances for noise so drawing noise values
  // doesn't advance the main PRNG sequence (and vice versa).
  const noise2D = createNoise2D(alea(`${seed}-noise2d`))
  const noise3D = createNoise3D(alea(`${seed}-noise3d`))

  function value(): number {
    return prng()
  }

  function range(min: number, max: number): number {
    return min + value() * (max - min)
  }

  function rangeFloor(min: number, max: number): number {
    return Math.floor(range(min, max))
  }

  function gaussian(mean = 0, std = 1): number {
    // Box-Muller transform: convert two uniform samples to a normal sample.
    // Guard against u1=0 which would produce log(0)=-Infinity.
    let u1 = value()
    if (u1 === 0) u1 = Number.EPSILON
    const u2 = value()
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    return mean + z * std
  }

  function boolean(): boolean {
    return value() < 0.5
  }

  function pick<T>(array: readonly T[]): T {
    if (array.length === 0) throw new Error('Cannot pick from an empty array')
    return array[rangeFloor(0, array.length)]
  }

  function shuffle<T>(array: readonly T[]): T[] {
    // Fisher-Yates on a copy — does not mutate the input
    const result = [...array]
    for (let i = result.length - 1; i > 0; i--) {
      const j = rangeFloor(0, i + 1)
      const tmp = result[i]
      result[i] = result[j]
      result[j] = tmp
    }
    return result
  }

  function onCircle(radius = 1): Vec2 {
    const angle = value() * 2 * Math.PI
    return [Math.cos(angle) * radius, Math.sin(angle) * radius]
  }

  function insideCircle(radius = 1): Vec2 {
    // Use sqrt distribution for uniform area coverage
    const angle = value() * 2 * Math.PI
    const r = Math.sqrt(value()) * radius
    return [Math.cos(angle) * r, Math.sin(angle) * r]
  }

  return {
    value,
    range,
    rangeFloor,
    gaussian,
    boolean,
    pick,
    shuffle,
    onCircle,
    insideCircle,
    noise2D,
    noise3D,
  }
}
