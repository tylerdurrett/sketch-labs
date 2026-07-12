import { describe, expect, it } from 'vitest'
import { DEFAULT_STROKE, hiddenLinePass } from '../hiddenLine'
import { renderToCanvas, renderToSVG } from '../renderer'
import type { Canvas2DContext } from '../renderer'
import type { Primitive, Scene, Stroke } from '../scene'
import type { Point, Polyline } from '../types'

const space = { width: 100, height: 100 }
const stroke: Stroke = { color: 'black', width: 1 }
const fill = { color: 'gray' }

/** A closed, filled square Primitive spanning [x0,y0]..[x1,y1]. */
function filledSquare(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  s: Stroke | undefined = stroke,
): Primitive {
  const points: Polyline = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
  const p: Primitive = { points, closed: true, fill }
  if (s) p.stroke = s
  return p
}

/** True if `p` is strictly inside the axis-aligned box (open interval). */
function strictlyInside(
  p: Point,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  return p[0] > x0 && p[0] < x1 && p[1] > y0 && p[1] < y1
}

describe('hiddenLinePass — occlusion correctness on external geometry', () => {
  it('drops an outline fully behind a nearer fill, keeps the front one intact', () => {
    // A (back, index 0) sits fully inside B (front, index 1) which covers it.
    const back = filledSquare(10, 10, 20, 20)
    const front = filledSquare(0, 0, 30, 30)
    const scene: Scene = { space, primitives: [back, front] }

    const out = hiddenLinePass(scene)

    // Only the front outline survives — the hidden back outline is absent.
    expect(out.primitives).toHaveLength(1)
    // The front is nearest (no occluder after it), so its ring passes through
    // intact, closed back to its first vertex.
    expect(out.primitives[0]!.points).toEqual([
      [0, 0],
      [30, 0],
      [30, 30],
      [0, 30],
      [0, 0],
    ])
  })

  it('clips a partially occluded outline at the fill boundary', () => {
    // A (back) and B (front) overlap in the corner [20,20]..[30,30].
    const back = filledSquare(10, 10, 30, 30)
    const front = filledSquare(20, 20, 40, 40)
    const scene: Scene = { space, primitives: [back, front] }

    const out = hiddenLinePass(scene)

    // Back emits its clipped survivors first, then the intact front ring.
    // Back's ring is broken into two open pieces where it dips into B.
    const backPieces = out.primitives.slice(0, 2)
    const frontPiece = out.primitives[out.primitives.length - 1]!

    expect(out.primitives).toHaveLength(3)

    // No surviving vertex lies strictly inside the nearer fill B.
    for (const prim of out.primitives) {
      for (const pt of prim.points) {
        expect(strictlyInside(pt, 20, 20, 40, 40)).toBe(false)
      }
    }

    // The clip lands exactly on B's boundary edges (x=20 and y=20).
    const backVerts = backPieces.flatMap((p) => p.points)
    const hasBoundaryPoint = (target: Point) =>
      backVerts.some(
        (v) => Math.abs(v[0] - target[0]) < 1e-9 && Math.abs(v[1] - target[1]) < 1e-9,
      )
    expect(hasBoundaryPoint([30, 20])).toBe(true)
    expect(hasBoundaryPoint([20, 30])).toBe(true)

    // The front is intact (its full closed ring).
    expect(frontPiece.points).toEqual([
      [20, 20],
      [40, 20],
      [40, 40],
      [20, 40],
      [20, 20],
    ])
  })

  it('passes an outline fully in front of every other fill through intact', () => {
    // The disjoint back square does not touch the front one; the front, being
    // nearest, is never clipped.
    const back = filledSquare(0, 0, 20, 20)
    const front = filledSquare(60, 60, 80, 80)
    const scene: Scene = { space, primitives: [back, front] }

    const out = hiddenLinePass(scene)

    // Disjoint AABBs ⇒ neither occludes the other; both rings survive whole.
    expect(out.primitives).toHaveLength(2)
    expect(out.primitives[0]!.points).toEqual([
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
      [0, 0],
    ])
    expect(out.primitives[1]!.points).toEqual([
      [60, 60],
      [80, 60],
      [80, 80],
      [60, 80],
      [60, 60],
    ])
  })
})

describe('hiddenLinePass — genericity (synthetic overlapping rectangles)', () => {
  it('handles an overlapping-rectangles Scene with no leaf-domain knowledge', () => {
    // A staircase of three mutually overlapping rectangles, painter's order
    // bottom→top. Nothing leaf-shaped: proves the pass is geometry-only.
    const r0 = filledSquare(0, 0, 40, 40)
    const r1 = filledSquare(20, 20, 60, 60)
    const r2 = filledSquare(40, 40, 80, 80)
    const scene: Scene = { space, primitives: [r0, r1, r2] }

    const out = hiddenLinePass(scene)

    // Something survives (not everything is hidden) and the topmost rectangle's
    // ring is present intact (nearest, never clipped).
    expect(out.primitives.length).toBeGreaterThan(0)
    const topRing: Polyline = [
      [40, 40],
      [80, 40],
      [80, 80],
      [40, 80],
      [40, 40],
    ]
    expect(out.primitives.some((p) => JSON.stringify(p.points) === JSON.stringify(topRing))).toBe(
      true,
    )
    // No survivor vertex sits strictly inside a NEARER fill than its own layer:
    // r0's strokes must avoid r1's and r2's interiors, etc. Spot-check that no
    // vertex is strictly inside the topmost rectangle except the top ring itself.
    for (const prim of out.primitives) {
      if (JSON.stringify(prim.points) === JSON.stringify(topRing)) continue
      for (const pt of prim.points) {
        expect(strictlyInside(pt, 40, 40, 80, 80)).toBe(false)
      }
    }
  })
})

describe('hiddenLinePass — output is stroke-only, fill-free, open polylines', () => {
  it('emits only stroke-carrying, fill-free, non-closed Primitives', () => {
    const scene: Scene = {
      space,
      primitives: [filledSquare(10, 10, 30, 30), filledSquare(20, 20, 40, 40)],
    }

    const out = hiddenLinePass(scene)

    expect(out.primitives.length).toBeGreaterThan(0)
    for (const prim of out.primitives) {
      expect(prim.stroke).toBeDefined()
      expect(prim.fill).toBeUndefined()
      expect(prim.closed).toBeFalsy()
    }
  })

  it('emits black strokes while preserving authored widths and the default width', () => {
    const authored: Stroke = { color: '#ff0044', width: 3 }
    const withStroke = filledSquare(0, 0, 20, 20, authored)
    const noStroke = filledSquare(60, 60, 80, 80, undefined)
    const scene: Scene = { space, primitives: [withStroke, noStroke] }

    const out = hiddenLinePass(scene)

    expect(out.primitives[0]!.stroke).toEqual({ color: 'black', width: 3 })
    expect(out.primitives[1]!.stroke).toEqual(DEFAULT_STROKE)
  })
})

describe('hiddenLinePass — Scene wiring decisions', () => {
  it('ignores stroke-only inputs: neither drawn nor treated as occluders', () => {
    // A stroke-only "line" laid over where a filled square's outline runs. If it
    // were an occluder it would clip the square; if it passed through it would
    // appear in the output. Neither happens.
    const strokeOnly: Primitive = {
      points: [
        [0, 15],
        [40, 15],
      ],
      stroke: { color: 'red', width: 2 },
    }
    const square = filledSquare(10, 10, 30, 30)
    const scene: Scene = { space, primitives: [strokeOnly, square] }

    const out = hiddenLinePass(scene)

    // Exactly the square's outline survives — the stroke-only input is gone and
    // did not clip the square (its full ring is present).
    expect(out.primitives).toHaveLength(1)
    expect(out.primitives[0]!.points).toEqual([
      [10, 10],
      [30, 10],
      [30, 30],
      [10, 30],
      [10, 10],
    ])
  })

  it('drops the input Scene background and omits the field when absent', () => {
    const bg = { color: 'papayawhip' }
    const withBg: Scene = {
      space,
      primitives: [filledSquare(0, 0, 20, 20)],
      background: bg,
    }
    const withoutBg: Scene = { space, primitives: [filledSquare(0, 0, 20, 20)] }

    expect('background' in hiddenLinePass(withBg)).toBe(false)
    expect('background' in hiddenLinePass(withoutBg)).toBe(false)
  })

  it('shares the input Scene coordinate space', () => {
    const scene: Scene = { space, primitives: [filledSquare(0, 0, 20, 20)] }
    expect(hiddenLinePass(scene).space).toBe(space)
  })
})

/** A recording {@link Canvas2DContext} stub — logs method calls, no real DOM. */
function createRecordingContext(): Canvas2DContext & { calls: string[] } {
  const calls: string[] = []
  const record = (m: string) => () => {
    calls.push(m)
  }
  return {
    calls,
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    closePath: record('closePath'),
    fill: record('fill'),
    stroke: record('stroke'),
    setTransform: record('setTransform'),
    fillRect: record('fillRect'),
    clearRect: record('clearRect'),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
  }
}

describe('hiddenLinePass — output is consumable unchanged by the renderers', () => {
  const scene: Scene = {
    space,
    primitives: [filledSquare(10, 10, 30, 30), filledSquare(20, 20, 40, 40)],
  }

  it('renderToSVG draws the stroke-only output without error', () => {
    const out = hiddenLinePass(scene)
    const svg = renderToSVG(out)
    expect(typeof svg).toBe('string')
    expect(svg).toContain('<svg')
    // Stroke-only output ⇒ the SVG carries stroke paint but no fill geometry
    // beyond the background rect.
    expect(svg).toContain('stroke')
  })

  it('renderToCanvas strokes the output and never fills it (fill-free Primitives)', () => {
    const out = hiddenLinePass(scene)
    const ctx = createRecordingContext()
    renderToCanvas(ctx, out)
    expect(ctx.calls).toContain('stroke')
    expect(ctx.calls).not.toContain('fill')
  })
})

describe('hiddenLinePass — final-stage Douglas–Peucker simplification (issue #232)', () => {
  // A single filled Primitive with no occluder: its outline ring survives whole
  // as one open stroke. The interior vertices [30,0] and [30,40] sit dead on the
  // top and bottom edges (perpendicular distance 0 from their neighbours), so a
  // positive tolerance drops them while tolerance 0 keeps every vertex.
  function redundantVertexScene(): Scene {
    const points: Polyline = [
      [0, 0],
      [30, 0], // redundant: collinear on the top edge
      [60, 0],
      [60, 40],
      [30, 40], // redundant: collinear on the bottom edge
      [0, 40],
    ]
    return {
      space,
      primitives: [{ points, closed: true, fill, stroke }],
    }
  }

  it('tolerance > 0 drops redundant near-collinear vertices from a survivor stroke', () => {
    const scene = redundantVertexScene()
    const baseline = hiddenLinePass(scene)
    const simplified = hiddenLinePass(scene, { tolerance: 1 })

    expect(simplified.primitives).toHaveLength(baseline.primitives.length)
    const before = baseline.primitives[0]!.points
    const after = simplified.primitives[0]!.points
    // Simplification removed vertices…
    expect(after.length).toBeLessThan(before.length)
    // …specifically the two exactly-collinear interior points.
    expect(after).not.toContainEqual([30, 0])
    expect(after).not.toContainEqual([30, 40])
    // Corners survive.
    expect(after).toContainEqual([0, 0])
    expect(after).toContainEqual([60, 0])
    expect(after).toContainEqual([60, 40])
    expect(after).toContainEqual([0, 40])
  })

  it('tolerance 0 (and omitted opts) leave the pass output unchanged', () => {
    const scene = redundantVertexScene()
    const omitted = hiddenLinePass(scene)
    const zero = hiddenLinePass(scene, { tolerance: 0 })
    const emptyOpts = hiddenLinePass(scene, {})

    // Byte-identical geometry to today's un-simplified pass in all three forms.
    expect(zero.primitives.map((p) => p.points)).toEqual(
      omitted.primitives.map((p) => p.points),
    )
    expect(emptyOpts.primitives.map((p) => p.points)).toEqual(
      omitted.primitives.map((p) => p.points),
    )
    // The redundant interior vertices are still present at tolerance 0.
    expect(zero.primitives[0]!.points).toContainEqual([30, 0])
    expect(zero.primitives[0]!.points).toContainEqual([30, 40])
  })
})
