import { describe, expect, it } from 'vitest'
import { clipSceneToBounds } from '../clipToBounds'
import { createScene } from '../scene'
import type { Scene, Primitive, Fill, Stroke } from '../scene'

const space = { width: 10, height: 10 }

/** A Scene wrapping a single Primitive in the standard 10x10 space. */
function sceneOf(...primitives: Primitive[]): Scene {
  return { space, primitives }
}

describe('clipSceneToBounds', () => {
  it('drops a Primitive fully outside the space', () => {
    const scene = sceneOf({
      points: [
        [15, 15],
        [20, 20],
      ],
      stroke: { color: 'black', width: 1 },
    })
    const result = clipSceneToBounds(scene)
    expect(result.primitives).toHaveLength(0)
  })

  it('keeps a Primitive fully inside the space with unchanged points', () => {
    const scene = sceneOf({
      points: [
        [2, 2],
        [8, 8],
      ],
      stroke: { color: 'black', width: 1 },
    })
    const result = clipSceneToBounds(scene)
    expect(result.primitives).toHaveLength(1)
    expect(result.primitives[0].points).toEqual([
      [2, 2],
      [8, 8],
    ])
  })

  it('cuts a crossing Primitive exactly at the boundary', () => {
    const scene = sceneOf({
      points: [
        [5, 5],
        [15, 5],
      ],
      stroke: { color: 'black', width: 1 },
    })
    const result = clipSceneToBounds(scene)
    expect(result.primitives).toHaveLength(1)
    const pts = result.primitives[0].points
    expect(pts[0]).toEqual([5, 5])
    expect(pts[1][0]).toBeCloseTo(10)
    expect(pts[1][1]).toBeCloseTo(5)
  })

  it('emits one output Primitive per surviving segment when a polyline exits and re-enters', () => {
    // Goes right (exits at x=10), down, then back left (re-enters at x=10).
    const scene = sceneOf({
      points: [
        [1, 5],
        [12, 5],
        [12, 8],
        [1, 8],
      ],
      stroke: { color: 'red', width: 2 },
    })
    const result = clipSceneToBounds(scene)
    expect(result.primitives).toHaveLength(2)
    // Each surviving segment carries the source style.
    expect(result.primitives[0].stroke).toEqual({ color: 'red', width: 2 })
    expect(result.primitives[1].stroke).toEqual({ color: 'red', width: 2 })
    expect(result.primitives[0].points[0]).toEqual([1, 5])
    expect(result.primitives[0].points[1][0]).toBeCloseTo(10)
    expect(result.primitives[1].points[1]).toEqual([1, 8])
  })

  it('round-trips stroke, fill and closed through the Scene<->Polyline bridge', () => {
    const stroke: Stroke = { color: '#ff0044', width: 3 }
    const fill: Fill = { color: '#00aa88' }
    const scene = sceneOf({
      points: [
        [3, 3],
        [7, 3],
        [7, 7],
        [3, 7],
      ],
      closed: true,
      fill,
      stroke,
    })
    const result = clipSceneToBounds(scene)
    expect(result.primitives).toHaveLength(1)
    const out = result.primitives[0]
    expect(out.stroke).toEqual(stroke)
    expect(out.fill).toEqual(fill)
    expect(out.closed).toBe(true)
  })

  it('preserves closed/fill on a crossing filled Primitive (chord-closed fill accepted)', () => {
    const scene = sceneOf({
      points: [
        [5, 5],
        [15, 5],
        [15, 8],
        [5, 8],
      ],
      closed: true,
      fill: { color: 'blue' },
    })
    const result = clipSceneToBounds(scene)
    // Geometry is clipped but the source style is carried on every survivor.
    expect(result.primitives.length).toBeGreaterThanOrEqual(1)
    for (const p of result.primitives) {
      expect(p.closed).toBe(true)
      expect(p.fill).toEqual({ color: 'blue' })
      // No emitted point escapes the canvas box.
      for (const [x, y] of p.points) {
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(10)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(10)
      }
    }
  })

  it('does not add fill/stroke/closed fields the source did not carry', () => {
    const scene = sceneOf({
      points: [
        [2, 2],
        [8, 8],
      ],
      stroke: { color: 'black', width: 1 },
    })
    const out = clipSceneToBounds(scene).primitives[0]
    expect('fill' in out).toBe(false)
    expect('closed' in out).toBe(false)
  })

  it('preserves the space and omits background when absent (byte-identical container)', () => {
    const scene = sceneOf({
      points: [
        [2, 2],
        [8, 8],
      ],
      stroke: { color: 'black', width: 1 },
    })
    const result = clipSceneToBounds(scene)
    expect(result.space).toEqual(space)
    expect('background' in result).toBe(false)
  })

  it('carries a Scene background through when present', () => {
    const background: Fill = { color: '#101010' }
    const scene: Scene = {
      space,
      primitives: [
        { points: [[2, 2], [8, 8]], stroke: { color: 'black', width: 1 } },
      ],
      background,
    }
    const result = clipSceneToBounds(scene)
    expect(result.background).toEqual(background)
  })

  it('clips a synthetic overlapping-geometry Scene generically (inside / outside / crossing together)', () => {
    // A synthetic, non-leaf-field Scene: three overlapping paths in one Scene,
    // each exercising a different clip outcome against the same box.
    const scene = createScene(space)
      .addPath(
        [
          [1, 1],
          [9, 9],
        ],
        { stroke: { color: 'black', width: 1 } },
      ) // fully inside
      .addPath(
        [
          [20, 20],
          [25, 25],
        ],
        { stroke: { color: 'green', width: 1 } },
      ) // fully outside
      .addPath(
        [
          [5, 5],
          [20, 5],
        ],
        { stroke: { color: 'purple', width: 2 }, closed: false },
      ) // crossing
      .build()

    const result = clipSceneToBounds(scene)
    // inside survives, outside dropped, crossing cut => 2 primitives, order preserved.
    expect(result.primitives).toHaveLength(2)
    expect(result.primitives[0].points).toEqual([
      [1, 1],
      [9, 9],
    ])
    expect(result.primitives[0].stroke).toEqual({ color: 'black', width: 1 })
    const crossing = result.primitives[1]
    expect(crossing.stroke).toEqual({ color: 'purple', width: 2 })
    expect(crossing.points[0]).toEqual([5, 5])
    expect(crossing.points[1][0]).toBeCloseTo(10)
    expect(crossing.points[1][1]).toBeCloseTo(5)
  })
})
