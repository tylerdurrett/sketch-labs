import { describe, expect, it } from 'vitest'
import { cleanupPencilContourPaths } from '../sketches/pencil-contour/cleanup'
import { localizePencilContourEdges } from '../sketches/pencil-contour/edges'
import { tracePencilContourEdges } from '../sketches/pencil-contour/tracing'
import type {
  AnalyzedRaster,
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

function perpendicularDistance(
  point: Readonly<Point>,
  start: Readonly<Point>,
  end: Readonly<Point>,
): number {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(point[0] - start[0], point[1] - start[1])
  return (
    Math.abs(dx * (point[1] - start[1]) - dy * (point[0] - start[0])) /
    Math.sqrt(lengthSquared)
  )
}

function jaggedness(contour: Readonly<TracedContourPath>): number {
  if (contour.points.length < 3) return 0
  let result = 0
  const start = contour.closed ? 0 : 1
  const end = contour.closed ? contour.points.length : contour.points.length - 1
  for (let index = start; index < end; index += 1) {
    result += perpendicularDistance(
      contour.points[index]!,
      contour.points[(index - 1 + contour.points.length) % contour.points.length]!,
      contour.points[(index + 1) % contour.points.length]!,
    )
  }
  return result
}

function centeredAlphaRing() {
  const width = 6
  const height = 6
  const alpha = Array<number>(width * height).fill(0)
  for (let y = 2; y <= 3; y += 1) {
    for (let x = 2; x <= 3; x += 1) alpha[y * width + x] = 1
  }
  const positiveSupport = alpha.map((value) => value > 0)
  const raster: Readonly<AnalyzedRaster> = Object.freeze({
    sourceWidth: width,
    sourceHeight: height,
    width,
    height,
    luminance: Object.freeze(Array<number>(width * height).fill(0)),
    alpha: Object.freeze(alpha),
    positiveSupport: Object.freeze(positiveSupport),
  })
  const edgeGraph = localizePencilContourEdges(raster, 0.5)
  const paths = tracePencilContourEdges(edgeGraph)
  return { graph: edgeGraph, paths }
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

  it('keeps open endpoints fixed while simplifying interior vertices', () => {
    const source = path([
      [1, 1],
      [2, 4],
      [3, 1],
    ])

    const result = clean([source], graph(), 1, 1)[0]!

    expect(result.closed).toBe(false)
    expect(result.points[0]).toEqual(source.points[0])
    expect(result.points.at(-1)).toEqual(source.points.at(-1))
    expect(result.points.length).toBeLessThan(source.points.length)
  })

  it('keeps length and point count nonincreasing across a simplification threshold', () => {
    const source = path([
      [0.5, 0.5],
      [1.5, 0.5],
      [1.5, 1.5],
      [1.5, 2.5],
      [2.5, 2.5],
      [2.5, 3],
    ])

    const below = clean([source], graph(4, 4), 1, 0.99)[0]!
    const at = clean([source], graph(4, 4), 1, 1)[0]!

    expect(below.points).toHaveLength(4)
    expect(at.points).toHaveLength(3)
    expect(at.points.length).toBeLessThanOrEqual(below.points.length)
    expect(pathLength(at.points, false)).toBeLessThanOrEqual(
      pathLength(below.points, false),
    )
  })

  it('rejects an intermediate removal that would link identical neighbours', () => {
    const source = path([
      [0, 0],
      [1, 1],
      [0, 0],
      [3, 0],
    ])

    const result = clean([source], graph(), 1, 0.5)[0]!

    expect(result.points).toEqual(source.points)
    for (let index = 1; index < result.points.length; index += 1) {
      expect(result.points[index]).not.toEqual(result.points[index - 1])
    }
  })

  it('does not regress an open path touching the lattice boundary at levels 14→15', () => {
    const source = path([
      [7, 5.5625733165],
      [7, 5.3999329368],
      [6.4940462462, 5.1999704614],
      [6.4269217253, 5.2289650887],
      [7, 6.1887467662],
    ])
    const sourceGraph = graph(8, 8)

    const level14 = clean([source], sourceGraph, 1, 0.14)[0]!
    const level15 = clean([source], sourceGraph, 1, 0.15)[0]!

    expect(level15.points.length).toBeLessThanOrEqual(level14.points.length)
    expect(pathLength(level15.points, false)).toBeLessThanOrEqual(
      pathLength(level14.points, false) + 1e-12,
    )
    expect(jaggedness(level15)).toBeLessThanOrEqual(
      jaggedness(level14) + 1e-12,
    )
    expect(level15.points.every(([x, y]) => x >= 0 && x <= 7 && y >= 0 && y <= 7)).toBe(true)
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

  it('keeps the real centered alpha ring monotonic from level 99→100', () => {
    const fixture = centeredAlphaRing()
    expect(fixture.paths).toHaveLength(1)
    expect(fixture.paths[0]!.closed).toBe(true)

    const level99 = clean(fixture.paths, fixture.graph, 1, 0.99)[0]!
    const level100 = clean(fixture.paths, fixture.graph, 1, 1)[0]!

    expect(level100.points.length).toBeLessThanOrEqual(level99.points.length)
    expect(pathLength(level100.points, true)).toBeLessThanOrEqual(
      pathLength(level99.points, true) + 1e-12,
    )
    expect(jaggedness(level100)).toBeLessThanOrEqual(
      jaggedness(level99) + 1e-12,
    )
    for (const point of level100.points) {
      expect(bilinearAlpha(fixture.graph, point)).toBeCloseTo(0.5, 6)
    }
  })

  it('enforces a monotonic 101-level envelope for representative open and closed paths', () => {
    const openGraph = graph(8, 8)
    const open = path([
      [0.5, 0.5],
      [1.5, 0.5],
      [1.5, 1.5],
      [1.5, 2.5],
      [2.5, 2.5],
      [2.5, 3],
    ])
    const closed = centeredAlphaRing()
    let previousOpen = clean([open], openGraph, 1, 0)[0]!
    let previousClosed = clean(closed.paths, closed.graph, 1, 0)[0]!

    for (let level = 1; level <= 100; level += 1) {
      const nextOpen = clean([open], openGraph, 1, level / 100)[0]!
      const nextClosed = clean(
        closed.paths,
        closed.graph,
        1,
        level / 100,
      )[0]!
      for (const [previous, next] of [
        [previousOpen, nextOpen],
        [previousClosed, nextClosed],
      ] as const) {
        expect(next.points.length).toBeLessThanOrEqual(previous.points.length)
        expect(pathLength(next.points, next.closed)).toBeLessThanOrEqual(
          pathLength(previous.points, previous.closed) + 1e-12,
        )
        expect(jaggedness(next)).toBeLessThanOrEqual(
          jaggedness(previous) + 1e-12,
        )
      }
      previousOpen = nextOpen
      previousClosed = nextClosed
    }
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

  it('keeps simplified alpha-boundary vertices on the fixed half-alpha isovalue', () => {
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

    const result = clean([boundary], sourceGraph, 1, 1)[0]!

    expect(result.provenance).toEqual(ALPHA_BOUNDARY)
    expect(result.points.length).toBeLessThan(boundary.points.length)
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
    expect(result[0]!.provenance).toEqual(LUMINANCE)
    expect(result[0]!.provenance).not.toBe(LUMINANCE)
    expect(Object.isFrozen(result[0]!.provenance)).toBe(true)
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

  it('fails closed for sparse point arrays without throwing', () => {
    const points = Array<Readonly<Point>>(3)
    points[0] = [0, 0]
    points[2] = [2, 0]
    const sparse = {
      points,
      closed: false,
      provenance: LUMINANCE,
    } as Readonly<TracedContourPath>

    expect(() => clean([sparse], graph(), 1, 1)).not.toThrow()
    expect(clean([sparse], graph(), 1, 1)).toEqual([])
  })

  it('isolates output provenance from later caller mutation', () => {
    const callerProvenance: { kind: 'luminance' | 'alpha-boundary' } = {
      kind: 'luminance',
    }
    const source: Readonly<TracedContourPath> = {
      points: [
        [0, 0],
        [3, 0],
      ],
      closed: false,
      provenance: callerProvenance,
    }

    const result = clean([source], graph(), 1, 0)
    callerProvenance.kind = 'alpha-boundary'

    expect(result[0]!.provenance).toEqual({ kind: 'luminance' })
    expect(Object.isFrozen(callerProvenance)).toBe(false)
  })

  it(
    'keeps maximum-lattice serpentine cleanup within a broad work bound',
    () => {
      const width = 256
      const height = 256
      const points: Point[] = []
      for (let y = 0; y < height; y += 1) {
        if (y % 2 === 0) {
          for (let x = 0; x < width; x += 1) points.push([x, y])
        } else {
          for (let x = width - 1; x >= 0; x -= 1) points.push([x, y])
        }
      }
      const started = performance.now()

      const result = clean(
        [path(points)],
        graph(width, height),
        1,
        1,
      )
      const elapsed = performance.now() - started

      expect(result).toHaveLength(1)
      expect(result[0]!.points.length).toBeLessThan(points.length)
      // This is deliberately broad: it catches the former 101 full-path
      // replays (~8 seconds) without treating normal CI variance as failure.
      expect(elapsed).toBeLessThan(4_000)
    },
    5_000,
  )
})
