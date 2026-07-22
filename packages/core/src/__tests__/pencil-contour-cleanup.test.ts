import { describe, expect, it } from 'vitest'
import { cleanupPencilContourPaths } from '../sketches/pencil-contour/cleanup'
import type {
  EdgeProvenance,
  LocalizedEdgeGraph,
  TracedContourPath,
} from '../sketches/pencil-contour/types'
import type { Point } from '../types'

const LUMINANCE = Object.freeze({ kind: 'luminance' } as const)
const ALPHA_BOUNDARY = Object.freeze({ kind: 'alpha-boundary' } as const)

function graph(
  width = 8,
  height = 8,
  alpha: readonly number[] = Array<number>(width * height).fill(1),
): Readonly<LocalizedEdgeGraph> {
  return Object.freeze({
    width,
    height,
    alpha: Object.freeze([...alpha]),
    positiveSupport: Object.freeze(alpha.map((value) => value > 0)),
    edges: Object.freeze([]),
  })
}

function path(
  points: readonly Readonly<Point>[],
  closed = false,
  provenance: Readonly<EdgeProvenance> = LUMINANCE,
): Readonly<TracedContourPath> {
  return Object.freeze({
    points: Object.freeze(points.map((point) => Object.freeze([...point] as Point))),
    closed,
    provenance,
  })
}

function clean(
  paths: readonly Readonly<TracedContourPath>[],
  sourceGraph = graph(),
  detail = 0.5,
  smoothing = 0.5,
) {
  return cleanupPencilContourPaths({
    paths,
    graph: sourceGraph,
    detail,
    smoothing,
  })
}

function pathLength(points: readonly Readonly<Point>[], closed: boolean): number {
  let length = 0
  const segmentCount = closed ? points.length : points.length - 1
  for (let index = 0; index < segmentCount; index += 1) {
    const start = points[index]!
    const end = points[(index + 1) % points.length]!
    length += Math.hypot(end[0] - start[0], end[1] - start[1])
  }
  return length
}

function bilinearAlpha(
  sourceGraph: Readonly<LocalizedEdgeGraph>,
  point: Readonly<Point>,
): number {
  const left = Math.min(Math.floor(point[0]), sourceGraph.width - 1)
  const top = Math.min(Math.floor(point[1]), sourceGraph.height - 1)
  const right = Math.min(left + 1, sourceGraph.width - 1)
  const bottom = Math.min(top + 1, sourceGraph.height - 1)
  const horizontal = point[0] - left
  const vertical = point[1] - top
  const topValue =
    sourceGraph.alpha[top * sourceGraph.width + left]! * (1 - horizontal) +
    sourceGraph.alpha[top * sourceGraph.width + right]! * horizontal
  const bottomValue =
    sourceGraph.alpha[bottom * sourceGraph.width + left]! *
      (1 - horizontal) +
    sourceGraph.alpha[bottom * sourceGraph.width + right]! * horizontal
  return topValue * (1 - vertical) + bottomValue * vertical
}

function sampledSegments(
  contour: Readonly<TracedContourPath>,
): readonly Readonly<Point>[] {
  const samples: Point[] = []
  const segmentCount = contour.closed
    ? contour.points.length
    : contour.points.length - 1
  for (let index = 0; index < segmentCount; index += 1) {
    const start = contour.points[index]!
    const end = contour.points[(index + 1) % contour.points.length]!
    for (let step = 0; step <= 32; step += 1) {
      const amount = step / 32
      samples.push([
        start[0] + (end[0] - start[0]) * amount,
        start[1] + (end[1] - start[1]) * amount,
      ])
    }
  }
  return samples
}

describe('Pencil Contour path cleanup', () => {
  it('removes short noise but retains meaningful open and closed geometry', () => {
    const paths = [
      path([
        [0, 0],
        [1, 0],
      ]),
      path([
        [0, 2],
        [3, 2],
      ]),
      path(
        [
          [4, 0],
          [5, 0],
          [5, 1],
        ],
        true,
      ),
      path(
        [
          [6, 6],
          [6.2, 6],
          [6.1, 6.1],
        ],
        true,
      ),
    ]

    const result = clean(paths, graph(), 0, 0)

    expect(result).toHaveLength(2)
    expect(result.map(({ closed }) => closed)).toEqual([false, true])
    // The triangle survives only when its explicit closing segment is counted.
    expect(pathLength(result[1]!.points, true)).toBeGreaterThan(2.5)
  })

  it('keeps open endpoints fixed while smoothing retained interior vertices', () => {
    const source = path([
      [1, 1],
      [2, 4],
      [3, 1],
    ])

    const result = clean([source], graph(), 1, 1)[0]!

    expect(result.closed).toBe(false)
    expect(result.points[0]).toEqual(source.points[0])
    expect(result.points.at(-1)).toEqual(source.points.at(-1))
    expect(result.points[1]![1]).toBeLessThan(source.points[1]![1])
  })

  it('simplifies closed rings as wrapped rings without losing closure', () => {
    const ring = path(
      [
        [1, 1],
        [2, 0.8],
        [3, 1],
        [4, 0.8],
        [5, 1],
        [5.2, 3],
        [5, 5],
        [3, 5.2],
        [1, 5],
        [0.8, 3],
      ],
      true,
    )

    const minimum = clean([ring], graph(), 1, 0)[0]!
    const normal = clean([ring], graph(), 1, 0.5)[0]!
    const maximum = clean([ring], graph(), 1, 1)[0]!

    for (const contour of [minimum, normal, maximum]) {
      expect(contour.closed).toBe(true)
      expect(contour.points.length).toBeGreaterThanOrEqual(3)
      expect(contour.points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true)
      expect(contour.points.at(-1)).not.toEqual(contour.points[0])
    }
    expect(normal.points.length).toBeLessThanOrEqual(minimum.points.length)
    expect(maximum.points.length).toBeLessThanOrEqual(normal.points.length)
    expect(pathLength(normal.points, true)).toBeLessThanOrEqual(
      pathLength(minimum.points, true),
    )
    expect(pathLength(maximum.points, true)).toBeLessThanOrEqual(
      pathLength(normal.points, true),
    )
  })

  it('rejects simplification shortcuts through exact-zero support', () => {
    const alpha = Array<number>(25).fill(1)
    alpha[2 + 2 * 5] = 0
    const sourceGraph = graph(5, 5, alpha)
    const aroundHole = path([
      [0, 2],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 2],
    ])

    const result = clean([aroundHole], sourceGraph, 1, 1)[0]!

    expect(result.points.length).toBeGreaterThan(2)
    for (const point of sampledSegments(result)) {
      expect(bilinearAlpha(sourceGraph, point)).toBeGreaterThan(0)
    }
  })

  it('reprojects smoothed alpha-boundary vertices to the fixed half-alpha isovalue', () => {
    const width = 5
    const height = 5
    const alpha = Array.from(
      { length: width * height },
      (_, index) =>
        ((index % width) * Math.floor(index / width)) / 16,
    )
    const sourceGraph = graph(width, height, alpha)
    const boundary = path(
      [
        [2, 4],
        [8 / 3, 3],
        [4, 2],
      ],
      false,
      ALPHA_BOUNDARY,
    )

    const result = clean([boundary], sourceGraph, 1, 0.2)[0]!

    expect(result.provenance).toBe(ALPHA_BOUNDARY)
    expect(result.points[1]).not.toEqual(boundary.points[1])
    for (const point of result.points) {
      expect(bilinearAlpha(sourceGraph, point)).toBeCloseTo(0.5, 6)
    }
    for (const point of sampledSegments(result)) {
      expect(bilinearAlpha(sourceGraph, point)).toBeGreaterThan(0)
    }
  })

  it('retains provenance, freezes output, and never mutates input paths or metadata', () => {
    const sourceGraph = graph()
    const source = path([
      [1, 2],
      [2, 2.2],
      [3, 2],
      [4, 2.2],
      [5, 2],
    ])
    const beforePath = structuredClone(source)
    const beforeGraph = structuredClone(sourceGraph)

    const result = clean([source], sourceGraph, 1, 1)

    expect(source).toEqual(beforePath)
    expect(sourceGraph).toEqual(beforeGraph)
    expect(result[0]!.provenance).toBe(LUMINANCE)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result[0])).toBe(true)
    expect(Object.isFrozen(result[0]!.points)).toBe(true)
    expect(result[0]!.points.every(Object.isFrozen)).toBe(true)
  })

  it('fails closed for malformed metadata and removes degenerate outputs', () => {
    const valid = graph(2, 2)
    const degenerate = path([
      [0, 0],
      [0, 0],
      [0, 0],
    ])

    expect(clean([degenerate], valid, 1, 1)).toEqual([])
    expect(
      cleanupPencilContourPaths({
        paths: [path([[0, 0], [1, 1]])],
        graph: { ...valid, alpha: [1, 1, 1] },
        detail: 1,
        smoothing: 1,
      }),
    ).toEqual([])
  })
})
