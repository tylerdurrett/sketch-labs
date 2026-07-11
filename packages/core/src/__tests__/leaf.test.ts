import { describe, expect, it } from 'vitest'

import * as core from '../index'
import { createRandom } from '../random'
import { leaf, type LeafShape } from '../sketches/single-leaf/leaf'
import type { Polyline } from '../types'

const baseShape: LeafShape = {
  length: 100,
  width: 40,
  curl: 0,
  wobble: 0,
  tipSharpness: 0.5,
}

interface Bounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
  width: number
  height: number
  centroidX: number
}

function bounds(poly: Polyline): Bounds {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let sumX = 0
  for (const [x, y] of poly) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    sumX += x
  }
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    centroidX: sumX / poly.length,
  }
}

describe('leaf', () => {
  it('returns a closed Polyline (Point tuples, last === first)', () => {
    const poly = leaf(baseShape, createRandom(1))
    expect(poly.length).toBeGreaterThan(3)
    for (const p of poly) {
      expect(Array.isArray(p)).toBe(true)
      expect(p).toHaveLength(2)
      expect(typeof p[0]).toBe('number')
      expect(typeof p[1]).toBe('number')
    }
    const first = poly[0]!
    const last = poly[poly.length - 1]!
    expect(last[0]).toBe(first[0])
    expect(last[1]).toBe(first[1])
  })

  it('is deterministic for the same shape and an equivalently-seeded Random', () => {
    const a = leaf(baseShape, createRandom(42))
    const b = leaf(baseShape, createRandom(42))
    expect(a).toEqual(b)
  })

  it('produces a wobbled outline when wobble > 0, still closed', () => {
    const poly = leaf({ ...baseShape, wobble: 3 }, createRandom(7))
    const first = poly[0]!
    const last = poly[poly.length - 1]!
    expect(last).toEqual(first)
  })

  it('makes visible wobble broad and correlated instead of vertex-scale jaggies', () => {
    const smooth = leaf({ ...baseShape, wobble: 0 }, createRandom(7))
    const rough = leaf({ ...baseShape, wobble: 6 }, createRandom(7))
    const displacement = rough.map(([x, y], i) => [
      x - smooth[i]![0],
      y - smooth[i]![1],
    ] as const)

    let displacementEnergy = 0
    let highFrequencyEnergy = 0
    for (let i = 2; i < displacement.length - 2; i++) {
      const [px, py] = displacement[i - 1]!
      const [x, y] = displacement[i]!
      const [nx, ny] = displacement[i + 1]!
      displacementEnergy += Math.hypot(x, y)
      highFrequencyEnergy += Math.hypot(nx - 2 * x + px, ny - 2 * y + py)
    }

    // The roughness remains clearly visible, but neighboring vertices move as
    // one broad contour feature instead of receiving unrelated offsets.
    expect(displacementEnergy / displacement.length).toBeGreaterThan(1)
    expect(highFrequencyEnergy / displacementEnergy).toBeLessThan(0.35)
  })

  describe('knob response', () => {
    it('wider width => larger x-extent', () => {
      const narrow = bounds(leaf({ ...baseShape, width: 20 }, createRandom(1)))
      const wide = bounds(leaf({ ...baseShape, width: 80 }, createRandom(1)))
      expect(wide.width).toBeGreaterThan(narrow.width)
    })

    it('longer length => larger y-extent', () => {
      const short = bounds(leaf({ ...baseShape, length: 50 }, createRandom(1)))
      const tall = bounds(leaf({ ...baseShape, length: 200 }, createRandom(1)))
      expect(tall.height).toBeGreaterThan(short.height)
    })

    it('curl shifts the spine / centroid sideways', () => {
      const straight = bounds(leaf({ ...baseShape, curl: 0 }, createRandom(1)))
      const curled = bounds(leaf({ ...baseShape, curl: 0.5 }, createRandom(1)))
      expect(curled.centroidX).toBeGreaterThan(straight.centroidX)
      // A positive curl pushes the outline further toward +x.
      expect(curled.maxX).toBeGreaterThan(straight.maxX)
    })

    it('changing wobble shifts vertex positions', () => {
      const smooth = leaf({ ...baseShape, wobble: 0 }, createRandom(1))
      const rough = leaf({ ...baseShape, wobble: 5 }, createRandom(1))
      expect(rough).not.toEqual(smooth)
    })
  })

  it('does not leak the leaf generator or a leaf domain type across the public barrel', () => {
    // The leaf module (`single-leaf/leaf.ts`) is module-private: Leaf Field
    // imports it via a relative path, but the leaf DOMAIN surface (`leaf`
    // generator, `LeafShape` type) must never appear in packages/core's public
    // barrel (index.ts). `LeafShape` is a type and erases at runtime, so the
    // enforceable runtime guard is the absence of the `leaf`/`LeafShape` value
    // exports.
    //
    // `leaf.ts` is deliberately NOT barrel-exported — nothing in index.ts
    // re-exports it, so it is reached only via relative import by leaf-field.
    // The guard checks for the private domain names exactly rather than any
    // substring containing "leaf".
    const surface = core as Record<string, unknown>
    expect(surface).not.toHaveProperty('leaf')
    expect(surface).not.toHaveProperty('LeafShape')
  })

  it('re-seeding varies wobble but gross proportions (bbox) stay within tolerance', () => {
    const shape: LeafShape = { ...baseShape, wobble: 2 }
    const a = leaf(shape, createRandom(1))
    const b = leaf(shape, createRandom(2))

    // Different seeds => the jittered outline differs vertex-for-vertex.
    expect(a).not.toEqual(b)

    // ...but the overall bounding box barely moves.
    const ba = bounds(a)
    const bb = bounds(b)
    const tol = shape.wobble * 6
    expect(Math.abs(ba.width - bb.width)).toBeLessThan(tol)
    expect(Math.abs(ba.height - bb.height)).toBeLessThan(tol)
  })
})
