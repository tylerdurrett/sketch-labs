import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STROKE,
  HIDDEN_LINE_WORK_WEIGHTS,
  analyzeHiddenLineWorkload,
  hiddenLinePass,
} from '../hiddenLine'
import { renderToCanvas, renderToSVG } from '../renderer'
import type { Canvas2DContext } from '../renderer'
import { createScene } from '../scene'
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

describe('analyzeHiddenLineWorkload', () => {
  it('distinguishes open outlines from implicit and explicitly repeated closure', () => {
    const triangle: Polyline = [
      [0, 0],
      [20, 0],
      [10, 20],
    ]
    const workloadFor = (primitive: Primitive) =>
      analyzeHiddenLineWorkload({ space, primitives: [primitive] })

    const open = workloadFor({ points: triangle, fill })
    const implicitlyClosed = workloadFor({ points: triangle, closed: true, fill })
    const explicitlyClosed = workloadFor({
      points: [...triangle, [0, 0]],
      closed: true,
      fill,
    })

    expect(open.sourceSegmentCount).toBe(2)
    expect(implicitlyClosed.sourceSegmentCount).toBe(3)
    expect(explicitlyClosed.sourceSegmentCount).toBe(3)
  })

  it('counts accepted fills, implicit closure segments, overlap pairs, and comparisons', () => {
    const openBack: Primitive = {
      points: [
        [0, 0],
        [20, 0],
        [20, 20],
      ],
      fill,
    }
    const closedMiddle = filledSquare(10, 10, 30, 30)
    const disjointFront = filledSquare(60, 60, 80, 80)
    const strokeOnly: Primitive = {
      points: [
        [0, 0],
        [100, 100],
      ],
      stroke,
    }
    const emptyFill: Primitive = { points: [], fill }
    const scene: Scene = {
      space,
      primitives: [openBack, strokeOnly, closedMiddle, emptyFill, disjointFront],
    }

    const workload = analyzeHiddenLineWorkload(scene)

    // 3 accepted fills. Segment counts: open triangle 2 + each closed square 4.
    // Only openBack→closedMiddle overlaps: 2 source segments × 4 polygon edges.
    expect(workload).toEqual({
      filledPrimitiveCount: 3,
      sourceSegmentCount: 10,
      overlappingPairCount: 1,
      estimatedSegmentEdgeComparisons: 8,
      totalWorkUnits:
        3 * HIDDEN_LINE_WORK_WEIGHTS.filledPrimitive +
        10 * HIDDEN_LINE_WORK_WEIGHTS.sourceSegment +
        HIDDEN_LINE_WORK_WEIGHTS.overlappingPair +
        8 * HIDDEN_LINE_WORK_WEIGHTS.segmentEdgeComparison,
    })
  })

  it('multiplies source segments by every prepared edge of a many-vertex occluder', () => {
    const back = filledSquare(0, 0, 40, 40)
    const front: Primitive = {
      points: [
        [10, 10],
        [30, 10],
        [40, 20],
        [30, 30],
        [10, 30],
        [0, 20],
      ],
      closed: true,
      fill,
    }

    const workload = analyzeHiddenLineWorkload({
      space,
      primitives: [back, front],
    })

    expect(workload).toEqual({
      filledPrimitiveCount: 2,
      sourceSegmentCount: 10,
      overlappingPairCount: 1,
      estimatedSegmentEdgeComparisons: 4 * 6,
      totalWorkUnits:
        2 * HIDDEN_LINE_WORK_WEIGHTS.filledPrimitive +
        10 * HIDDEN_LINE_WORK_WEIGHTS.sourceSegment +
        HIDDEN_LINE_WORK_WEIGHTS.overlappingPair +
        24 * HIDDEN_LINE_WORK_WEIGHTS.segmentEdgeComparison,
    })
  })

  it('uses painter order when assigning the source side of an overlapping pair', () => {
    const twoSegmentBack: Primitive = {
      points: [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      fill,
    }
    const closedFront = filledSquare(0, 0, 20, 20)

    const forward = analyzeHiddenLineWorkload({
      space,
      primitives: [twoSegmentBack, closedFront],
    })
    const reversed = analyzeHiddenLineWorkload({
      space,
      primitives: [closedFront, twoSegmentBack],
    })

    expect(forward.overlappingPairCount).toBe(1)
    expect(reversed.overlappingPairCount).toBe(1)
    expect(forward.estimatedSegmentEdgeComparisons).toBe(2 * 4)
    expect(reversed.estimatedSegmentEdgeComparisons).toBe(4 * 3)
  })

  it('is deterministic, immutable, integer-safe, and does not mutate the Scene', () => {
    const scene: Scene = {
      space,
      primitives: [filledSquare(0, 0, 20, 20), filledSquare(10, 10, 30, 30)],
    }
    const before = structuredClone(scene)

    const first = analyzeHiddenLineWorkload(scene)
    const second = analyzeHiddenLineWorkload(scene)

    expect(first).toEqual(second)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(HIDDEN_LINE_WORK_WEIGHTS)).toBe(true)
    for (const value of Object.values(first)) {
      expect(Number.isSafeInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
    }
    expect(scene).toEqual(before)
  })
})

describe('hiddenLinePass — progress observation', () => {
  function progressScene(): Scene {
    return {
      space,
      primitives: [
        filledSquare(0, 0, 40, 40),
        filledSquare(20, 20, 60, 60),
        filledSquare(70, 70, 90, 90),
      ],
    }
  }

  it.each([0, 1])(
    'preserves the exact output with an observer at tolerance %s',
    (tolerance) => {
      const scene = progressScene()
      const snapshots: unknown[] = []

      const unobserved = hiddenLinePass(scene, { tolerance })
      const observed = hiddenLinePass(scene, {
        tolerance,
        observer: (snapshot) => snapshots.push(snapshot),
      })

      expect(observed).toEqual(unobserved)
      expect(snapshots.length).toBeGreaterThan(0)
    },
  )

  it('reports immutable, monotonic, bounded progress against one stable total', () => {
    const scene = progressScene()
    const before = structuredClone(scene)
    const workload = analyzeHiddenLineWorkload(scene)
    const snapshots: Array<{
      readonly completedWorkUnits: number
      readonly totalWorkUnits: number
      readonly terminal: boolean
    }> = []

    hiddenLinePass(scene, {
      observer: (snapshot) => snapshots.push(snapshot),
    })

    expect(snapshots).toHaveLength(workload.filledPrimitiveCount)
    expect(snapshots.every(Object.isFrozen)).toBe(true)
    expect(new Set(snapshots.map((snapshot) => snapshot.totalWorkUnits))).toEqual(
      new Set([workload.totalWorkUnits]),
    )
    for (let i = 0; i < snapshots.length; i++) {
      const snapshot = snapshots[i]!
      expect(snapshot.completedWorkUnits).toBeGreaterThan(0)
      expect(snapshot.completedWorkUnits).toBeLessThanOrEqual(
        snapshot.totalWorkUnits,
      )
      if (i > 0) {
        expect(snapshot.completedWorkUnits).toBeGreaterThan(
          snapshots[i - 1]!.completedWorkUnits,
        )
      }
      expect(snapshot.terminal).toBe(i === snapshots.length - 1)
    }
    expect(snapshots.at(-1)).toEqual({
      completedWorkUnits: workload.totalWorkUnits,
      totalWorkUnits: workload.totalWorkUnits,
      terminal: true,
    })
    expect(scene).toEqual(before)
  })

  it('reports terminal zero work for a Scene with no accepted fills', () => {
    const snapshots: unknown[] = []
    const scene: Scene = {
      space,
      primitives: [
        { points: [], fill },
        {
          points: [
            [0, 0],
            [10, 10],
          ],
          stroke,
        },
      ],
    }

    const out = hiddenLinePass(scene, {
      observer: (snapshot) => snapshots.push(snapshot),
    })

    expect(out).toEqual({ space, primitives: [] })
    expect(snapshots).toEqual([
      { completedWorkUnits: 0, totalWorkUnits: 0, terminal: true },
    ])
    expect(Object.isFrozen(snapshots[0])).toBe(true)
  })

  it('accounts for a degenerate fill without emitting degenerate output', () => {
    const scene: Scene = {
      space,
      primitives: [
        filledSquare(0, 0, 20, 20),
        { points: [[10, 10]], fill, stroke },
      ],
    }
    const snapshots: Array<{
      readonly completedWorkUnits: number
      readonly totalWorkUnits: number
      readonly terminal: boolean
    }> = []
    const totalWorkUnits = analyzeHiddenLineWorkload(scene).totalWorkUnits

    const out = hiddenLinePass(scene, {
      observer: (snapshot) => snapshots.push(snapshot),
    })

    expect(out.primitives).toEqual([
      {
        points: [
          [0, 0],
          [20, 0],
          [20, 20],
          [0, 20],
          [0, 0],
        ],
        stroke,
      },
    ])
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0]!.terminal).toBe(false)
    expect(snapshots[1]).toEqual({
      completedWorkUnits: totalWorkUnits,
      totalWorkUnits,
      terminal: true,
    })
  })

  it('keeps omitted options and the existing tolerance-only option compatible', () => {
    const scene = progressScene()

    expect(hiddenLinePass(scene)).toEqual(hiddenLinePass(scene, {}))
    expect(hiddenLinePass(scene, { tolerance: 1 })).toEqual(
      hiddenLinePass(scene, { tolerance: 1, observer: undefined }),
    )
  })
})

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

describe('hiddenLinePass — explicit source and occluder roles', () => {
  function strokeSource(y = 20): Primitive {
    return {
      points: [
        [0, y],
        [50, y],
      ],
      stroke: { color: '#338833', width: 2 },
      hiddenLineRole: 'source',
    }
  }

  function mask(): Primitive {
    return {
      ...filledSquare(20, 10, 30, 30),
      hiddenLineRole: 'occluder',
    }
  }

  it('clips a stroke source exactly and does not emit the filled occluder', () => {
    const source = strokeSource()
    const occluder = mask()
    const scene: Scene = { space, primitives: [source, occluder] }
    const before = structuredClone(scene)

    const out = hiddenLinePass(scene)

    expect(out).toEqual({
      space,
      primitives: [
        {
          points: [
            [0, 20],
            [20, 20],
          ],
          stroke: { color: 'black', width: 2 },
        },
        {
          points: [
            [30, 20],
            [50, 20],
          ],
          stroke: { color: 'black', width: 2 },
        },
      ],
    })
    expect(out.primitives).not.toContainEqual(
      expect.objectContaining({ points: occluder.points }),
    )
    expect(scene).toEqual(before)
  })

  it('accepts roles through the generic Scene builder', () => {
    const scene = createScene(space)
      .addPath(strokeSource().points, {
        stroke: { color: '#338833', width: 2 },
        hiddenLineRole: 'source',
      })
      .addPath(mask().points, {
        closed: true,
        fill,
        hiddenLineRole: 'occluder',
      })
      .build()

    expect(hiddenLinePass(scene).primitives.map(({ points }) => points)).toEqual([
      [
        [0, 20],
        [20, 20],
      ],
      [
        [30, 20],
        [50, 20],
      ],
    ])
  })

  it('preserves painter order: an earlier occluder cannot hide a later source', () => {
    const source = strokeSource()

    expect(
      hiddenLinePass({ space, primitives: [mask(), source] }).primitives,
    ).toEqual([
      {
        points: source.points,
        stroke: { color: 'black', width: 2 },
      },
    ])
  })

  it('clips interleaved sources only by their own nearer occluders', () => {
    const fartherSource = strokeSource(20)
    const firstMask: Primitive = {
      ...filledSquare(10, 10, 20, 30),
      hiddenLineRole: 'occluder',
    }
    const nearerSource = strokeSource(40)
    const secondMask: Primitive = {
      ...filledSquare(30, 10, 40, 50),
      hiddenLineRole: 'occluder',
    }

    const out = hiddenLinePass({
      space,
      primitives: [fartherSource, firstMask, nearerSource, secondMask],
    })

    expect(out.primitives.map(({ points }) => points)).toEqual([
      [
        [0, 20],
        [10, 20],
      ],
      [
        [20, 20],
        [30, 20],
      ],
      [
        [40, 20],
        [50, 20],
      ],
      [
        [0, 40],
        [30, 40],
      ],
      [
        [40, 40],
        [50, 40],
      ],
    ])
  })

  it('lets source-only fills emit without occluding geometry behind them', () => {
    const back = strokeSource(15)
    const sourceOnlyFill: Primitive = {
      ...filledSquare(10, 10, 40, 20),
      hiddenLineRole: 'source',
    }

    const out = hiddenLinePass({
      space,
      primitives: [back, sourceOnlyFill],
    })

    expect(out.primitives[0]).toEqual({
      points: back.points,
      stroke: { color: 'black', width: 2 },
    })
    expect(out.primitives[1]!.points).toEqual([
      [10, 10],
      [40, 10],
      [40, 20],
      [10, 20],
      [10, 10],
    ])
  })

  it('keeps legacy defaults byte-compatible with explicit both roles', () => {
    const legacy: Scene = {
      space,
      primitives: [
        filledSquare(0, 0, 30, 30),
        filledSquare(20, 20, 50, 50),
      ],
    }
    const explicit: Scene = {
      space,
      primitives: legacy.primitives.map((primitive) => ({
        ...primitive,
        hiddenLineRole: 'both',
      })),
    }

    expect(hiddenLinePass(explicit)).toEqual(hiddenLinePass(legacy))
    expect(analyzeHiddenLineWorkload(explicit)).toEqual(
      analyzeHiddenLineWorkload(legacy),
    )
  })

  it('accounts for source, mask, pair, comparisons, and progress exactly', () => {
    const scene: Scene = { space, primitives: [strokeSource(), mask()] }
    const snapshots: Array<{
      readonly completedWorkUnits: number
      readonly totalWorkUnits: number
      readonly terminal: boolean
    }> = []
    const expected = {
      filledPrimitiveCount: 1,
      sourceSegmentCount: 1,
      overlappingPairCount: 1,
      estimatedSegmentEdgeComparisons: 4,
      totalWorkUnits:
        HIDDEN_LINE_WORK_WEIGHTS.filledPrimitive +
        HIDDEN_LINE_WORK_WEIGHTS.sourceSegment +
        HIDDEN_LINE_WORK_WEIGHTS.overlappingPair +
        4 * HIDDEN_LINE_WORK_WEIGHTS.segmentEdgeComparison,
    }

    expect(analyzeHiddenLineWorkload(scene)).toEqual(expected)
    hiddenLinePass(scene, {
      observer: (snapshot) => snapshots.push(snapshot),
    })
    expect(snapshots).toEqual([
      {
        completedWorkUnits:
          HIDDEN_LINE_WORK_WEIGHTS.sourceSegment +
          HIDDEN_LINE_WORK_WEIGHTS.overlappingPair +
          4 * HIDDEN_LINE_WORK_WEIGHTS.segmentEdgeComparison,
        totalWorkUnits: expected.totalWorkUnits,
        terminal: false,
      },
      {
        completedWorkUnits: expected.totalWorkUnits,
        totalWorkUnits: expected.totalWorkUnits,
        terminal: true,
      },
    ])
    expect(snapshots.every(Object.isFrozen)).toBe(true)
  })

  it('reports filled mask preparation even when no source is emitted', () => {
    const snapshots: unknown[] = []
    const scene: Scene = { space, primitives: [mask()] }

    expect(analyzeHiddenLineWorkload(scene)).toEqual({
      filledPrimitiveCount: 1,
      sourceSegmentCount: 0,
      overlappingPairCount: 0,
      estimatedSegmentEdgeComparisons: 0,
      totalWorkUnits: HIDDEN_LINE_WORK_WEIGHTS.filledPrimitive,
    })
    expect(
      hiddenLinePass(scene, {
        observer: (snapshot) => snapshots.push(snapshot),
      }),
    ).toEqual({ space, primitives: [] })
    expect(snapshots).toEqual([
      {
        completedWorkUnits: HIDDEN_LINE_WORK_WEIGHTS.filledPrimitive,
        totalWorkUnits: HIDDEN_LINE_WORK_WEIGHTS.filledPrimitive,
        terminal: true,
      },
    ])
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

  it('reuses one hybrid processed Scene for Canvas and SVG', () => {
    const processed = hiddenLinePass({
      space,
      primitives: [
        {
          points: [
            [0, 20],
            [50, 20],
          ],
          stroke,
          hiddenLineRole: 'source',
        },
        {
          ...filledSquare(20, 10, 30, 30),
          hiddenLineRole: 'occluder',
        },
      ],
    })
    const before = structuredClone(processed)
    const ctx = createRecordingContext()

    renderToCanvas(ctx, processed)
    const svg = renderToSVG(processed)

    expect(ctx.calls.filter((call) => call === 'stroke')).toHaveLength(2)
    expect(svg.match(/<path /g)).toHaveLength(2)
    expect(processed).toEqual(before)
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
