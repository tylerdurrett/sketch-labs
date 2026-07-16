import { describe, expect, it } from 'vitest'
import type { Primitive, Scene } from '../scene'
import type { Point } from '../types'
import {
  compareVisibleContours,
  deriveOutlineContours,
  deriveVisibleFillContours,
  type ContourInterval,
} from './visibleContourOracle'

const space = { width: 10, height: 10 }
const fill = { color: 'black' }
const stroke = { color: 'black', width: 1 }

function polygon(points: Point[]): Primitive {
  return { points, closed: true, fill }
}

function fillScene(...primitives: Primitive[]): Scene {
  return { space, primitives }
}

function outlineScene(...intervals: ContourInterval[]): Scene {
  return {
    space,
    primitives: intervals.map(([start, end]) => ({
      points: [start, end],
      stroke,
    })),
  }
}

describe('visible-contour fidelity oracle', () => {
  it('uses painter order to remove overlapped portions of farther boundaries', () => {
    const scene = fillScene(
      polygon([[1, 1], [7, 1], [7, 9], [1, 9]]),
      polygon([[4, 3], [9, 3], [9, 7], [4, 7]]),
    )
    const expected: ContourInterval[] = [
      [[1, 1], [7, 1]],
      [[1, 1], [1, 9]],
      [[1, 9], [7, 9]],
      [[7, 1], [7, 3]],
      [[7, 7], [7, 9]],
      [[4, 3], [9, 3]],
      [[9, 3], [9, 7]],
      [[4, 7], [9, 7]],
      [[4, 3], [4, 7]],
    ]

    expect(compareVisibleContours(scene, outlineScene(...expected))).toEqual({
      matches: true,
      missing: [],
      extra: [],
    })
  })

  it('classifies split intervals correctly against a concave nearer polygon', () => {
    const scene = fillScene(
      polygon([[0, 4], [10, 4], [10, 6], [0, 6]]),
      polygon([[2, 2], [8, 2], [8, 8], [6, 8], [6, 4], [4, 4], [4, 8], [2, 8]]),
    )
    const contours = deriveVisibleFillContours(scene)

    // The concavity leaves the farther rectangle's top edge visible only in
    // the notch; both arms still cover their respective intervals.
    expect(contours).toContainEqual([[4, 4], [6, 4]])
    expect(contours).not.toContainEqual([[2, 4], [4, 4]])
    expect(contours).not.toContainEqual([[6, 4], [8, 4]])
  })

  it('handles touching polygons without losing or duplicating their shared edge', () => {
    const scene = fillScene(
      polygon([[1, 1], [5, 1], [5, 5], [1, 5]]),
      polygon([[5, 1], [9, 1], [9, 5], [5, 5]]),
    )
    const shared: ContourInterval = [[5, 1], [5, 5]]

    expect(
      deriveVisibleFillContours(scene).filter(
        (interval) => JSON.stringify(interval) === JSON.stringify(shared),
      ),
    ).toHaveLength(1)
  })

  it('clips authored boundaries to the frame without inventing frame-edge closures', () => {
    const scene = fillScene(
      polygon([[-5, 2], [5, 2], [5, 8], [-5, 8]]),
    )
    const expected: Scene = {
      space,
      primitives: [{
        points: [[-5, 2], [5, 2], [5, 8], [-5, 8]],
        closed: true,
        stroke,
      }],
    }
    expected.primitives.push({
      points: [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      stroke,
    })

    expect(compareVisibleContours(scene, expected, {
      excludeCompositionFrame: true,
    })).toEqual({
      matches: true,
      missing: [],
      extra: [],
    })
    expect(deriveVisibleFillContours(scene)).not.toContainEqual([[0, 2], [0, 8]])
  })

  it('clips crossing Outline paths and closures to the frame before comparison', () => {
    const scene = fillScene(
      polygon([[-4, 3], [6, 3], [6, 7], [-4, 7]]),
    )
    const crossingOutline: Scene = {
      space,
      primitives: [{
        points: [[-4, 3], [6, 3], [6, 7], [-4, 7]],
        closed: true,
        stroke,
      }],
    }

    expect(compareVisibleContours(scene, crossingOutline).matches).toBe(true)
    expect(deriveOutlineContours(crossingOutline)).not.toContainEqual([
      [0, 3],
      [0, 7],
    ])
  })

  it('uses roundoff-scale equality for slanted decimal intersections', () => {
    const scene = fillScene(
      polygon([[0.1, 0.1], [0.9, 0.7], [0.1, 0.7]]),
      polygon([[0.5, 0], [1, 0], [1, 1], [0.5, 1]]),
    )
    const outline = outlineScene(
      [[0.1, 0.1], [0.1 + 0.2, 1 / 4]],
      [[3 / 10, 0.25], [1 / 2, 2 / 5]],
      [[0.1, 0.7], [0.5, 0.7]],
      [[0.1, 0.1], [0.1, 0.7]],
      [[0.5, 0], [1, 0]],
      [[1, 0], [1, 1]],
      [[0.5, 1], [1, 1]],
      [[0.5, 0], [0.5, 1]],
    )
    outline.space = { width: 1, height: 1 }
    const decimalFill: Scene = { ...scene, space: { width: 1, height: 1 } }

    expect(compareVisibleContours(decimalFill, outline)).toEqual({
      matches: true,
      missing: [],
      extra: [],
    })
  })

  it('excludes only an explicitly requested exact final Composition Frame', () => {
    const scene = fillScene(polygon([[2, 2], [8, 2], [8, 8], [2, 8]]))
    const boundary = outlineScene(
      [[2, 2], [8, 2]],
      [[8, 2], [8, 8]],
      [[2, 8], [8, 8]],
      [[2, 2], [2, 8]],
    )
    const frame: Primitive = {
      points: [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      stroke,
    }
    boundary.primitives.push(frame)

    expect(compareVisibleContours(scene, boundary).matches).toBe(false)
    expect(compareVisibleContours(scene, boundary, {
      excludeCompositionFrame: true,
    }).matches).toBe(true)

    // A frame-shaped primitive before the final path remains real geometry.
    boundary.primitives.splice(boundary.primitives.length - 1, 0, frame)
    expect(compareVisibleContours(scene, boundary, {
      excludeCompositionFrame: true,
    }).matches).toBe(false)

    const notExact = outlineScene(
      [[2, 2], [8, 2]],
      [[8, 2], [8, 8]],
      [[2, 8], [8, 8]],
      [[2, 2], [2, 8]],
    )
    notExact.primitives.push({
      points: [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0], [5, 5]],
      stroke,
    })
    expect(compareVisibleContours(scene, notExact, {
      excludeCompositionFrame: true,
    }).matches).toBe(false)
  })

  it('normalizes repeated closure and drops zero-length intervals', () => {
    const scene = fillScene(
      polygon([[2, 2], [8, 2], [8, 8], [2, 8], [2, 2], [2, 2]]),
    )
    const outline: Scene = {
      space,
      primitives: [{
        points: [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2], [2, 2]],
        stroke,
      }],
    }

    expect(deriveVisibleFillContours(scene)).toHaveLength(4)
    expect(deriveOutlineContours(outline)).toHaveLength(4)
    expect(compareVisibleContours(scene, outline).matches).toBe(true)
  })

  it('accepts reversed and differently fragmented intervals', () => {
    const scene = fillScene(polygon([[2, 2], [8, 2], [8, 8], [2, 8]]))
    const outline = outlineScene(
      [[5, 2], [2, 2]],
      [[8, 2], [5, 2]],
      [[8, 8], [8, 2]],
      [[2, 8], [8, 8]],
      [[2, 2], [2, 8]],
    )

    expect(compareVisibleContours(scene, outline).matches).toBe(true)
  })

  it('reports missing and extra interval coverage independently', () => {
    const scene = fillScene(polygon([[2, 2], [8, 2], [8, 8], [2, 8]]))
    const comparison = compareVisibleContours(
      scene,
      outlineScene(
        [[2, 2], [8, 2]],
        [[8, 2], [8, 8]],
        [[2, 8], [8, 8]],
        [[3, 3], [7, 7]],
      ),
    )

    expect(comparison.matches).toBe(false)
    expect(comparison.missing).toEqual([[[2, 2], [2, 8]]])
    expect(comparison.extra).toEqual([[[3, 3], [7, 7]]])
  })

  it('rejects centerline and interior-chord substitutes for a filled blade', () => {
    const blade = fillScene(
      polygon([[4, 9], [4.5, 3], [5, 1], [5.5, 3], [6, 9]]),
    )
    const substitute = outlineScene(
      [[5, 1], [5, 9]],
      [[4.25, 6], [5.75, 6]],
    )
    const comparison = compareVisibleContours(blade, substitute)

    expect(comparison.matches).toBe(false)
    expect(comparison.missing.length).toBeGreaterThan(0)
    expect(comparison.extra).toEqual([
      [[4.25, 6], [5.75, 6]],
      [[5, 1], [5, 9]],
    ])
  })
})
