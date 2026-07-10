import { describe, expect, it } from 'vitest'
import { simplifyPath } from '../simplifyPath'
import type { Polyline } from '../types'

describe('simplifyPath', () => {
  it('reduces redundant near-collinear vertices at a given tolerance', () => {
    // Six points that lie (almost) along a straight line from (0,0) to (5,0).
    const path: Polyline = [
      [0, 0],
      [1, 0.01],
      [2, -0.01],
      [3, 0.01],
      [4, -0.01],
      [5, 0],
    ]
    const result = simplifyPath(path, 0.5)
    expect(result.length).toBeLessThan(path.length)
    // The two endpoints survive.
    expect(result[0]).toEqual([0, 0])
    expect(result[result.length - 1]).toEqual([5, 0])
  })

  it('collapses a straight run to just its endpoints', () => {
    const path: Polyline = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
    ]
    const result = simplifyPath(path, 0.1)
    expect(result).toEqual([
      [0, 0],
      [4, 0],
    ])
  })

  it('leaves the path unchanged at tolerance 0 (identity)', () => {
    const path: Polyline = [
      [0, 0],
      [1, 5],
      [2, -3],
      [4, 0],
    ]
    const result = simplifyPath(path, 0)
    // Same reference — a genuine no-op.
    expect(result).toBe(path)
    // Vertex-for-vertex identical.
    expect(result).toEqual(path)
  })

  it('preserves endpoints and a sharp corner at a moderate tolerance', () => {
    // A leaf-tip-like spike: a vertex well off the base chord, flanked by
    // near-collinear runs that should collapse.
    const path: Polyline = [
      [0, 0],
      [1, 0.02],
      [2, 0],
      [3, 10], // sharp corner / leaf tip, far off the chord
      [4, 0],
      [5, -0.02],
      [6, 0],
    ]
    const result = simplifyPath(path, 1)
    // Endpoints survive.
    expect(result[0]).toEqual([0, 0])
    expect(result[result.length - 1]).toEqual([6, 0])
    // The sharp corner survives.
    expect(result).toContainEqual([3, 10])
    // The near-collinear filler vertices are dropped.
    expect(result).not.toContainEqual([1, 0.02])
    expect(result).not.toContainEqual([5, -0.02])
  })

  it('handles a zero-length (degenerate) segment where endpoints coincide', () => {
    // First and last points coincide; the off-chord vertex must be kept.
    const path: Polyline = [
      [0, 0],
      [5, 5],
      [0, 0],
    ]
    const result = simplifyPath(path, 1)
    expect(result).toContainEqual([5, 5])
  })

  it('passes degenerate inputs (0, 1, 2 points) through unchanged', () => {
    const empty: Polyline = []
    const single: Polyline = [[1, 1]]
    const pair: Polyline = [
      [0, 0],
      [10, 10],
    ]
    expect(simplifyPath(empty, 0.5)).toBe(empty)
    expect(simplifyPath(single, 0.5)).toBe(single)
    expect(simplifyPath(pair, 0.5)).toBe(pair)
  })

  it('does not mutate the input array or its point tuples', () => {
    const path: Polyline = [
      [0, 0],
      [1, 0.01],
      [2, 0],
      [3, 10],
      [4, 0],
      [5, 0],
    ]
    const snapshot = path.map((p) => [p[0], p[1]] as const)
    simplifyPath(path, 1)
    expect(path).toHaveLength(snapshot.length)
    path.forEach((p, i) => {
      expect(p[0]).toBe(snapshot[i]![0])
      expect(p[1]).toBe(snapshot[i]![1])
    })
  })
})
