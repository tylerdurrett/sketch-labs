import { describe, expect, it } from 'vitest'
import { cleanupPencilContourPaths } from '../sketches/pencil-contour/cleanup'
import { pairedCurveSamplesCoincide } from '../sketches/pencil-contour/curve-refinement'
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

function transparentAlphaHole() {
  const width = 20
  const height = 20
  const alpha = Array<number>(width * height).fill(1)
  for (let y = 5; y <= 14; y += 1) {
    for (let x = 5; x <= 14; x += 1) alpha[y * width + x] = 0
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

function distanceToPolyline(
  point: Readonly<Point>,
  controls: readonly Readonly<Point>[],
  closed: boolean,
): number {
  let minimum = Number.POSITIVE_INFINITY
  const segmentCount = closed ? controls.length : controls.length - 1
  for (let index = 0; index < segmentCount; index += 1) {
    const start = controls[index]!
    const end = controls[(index + 1) % controls.length]!
    const dx = end[0] - start[0]
    const dy = end[1] - start[1]
    const lengthSquared = dx * dx + dy * dy
    const amount = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
      ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) /
        lengthSquared,
    ))
    minimum = Math.min(minimum, Math.hypot(
      point[0] - (start[0] + dx * amount),
      point[1] - (start[1] + dy * amount),
    ))
  }
  return minimum
}

describe('Pencil Contour path cleanup', () => {
  it('does not deduplicate a closed seam across different baseline arms', () => {
    const sharedHybrid: Point = [Math.SQRT1_2, Math.SQRT1_2]

    expect(pairedCurveSamplesCoincide(
      sharedHybrid,
      [-0.5, 0],
      sharedHybrid,
      [0, 0.5],
    )).toBe(false)
    expect(pairedCurveSamplesCoincide(
      sharedHybrid,
      [0, 0],
      sharedHybrid,
      [0, 0],
    )).toBe(true)
  })

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

  it('admits split branches by total component inventory while removing isolated noise', () => {
    const base = graph(6, 6)
    const componentGraph: Readonly<LocalizedEdgeGraph> = Object.freeze({
      ...base,
      edges: Object.freeze([
        { start: [0, 0], end: [1, 0], provenance: LUMINANCE },
        { start: [1, 0], end: [2, 0], provenance: LUMINANCE },
        { start: [1, 0], end: [1, 1], provenance: LUMINANCE },
        { start: [4, 4], end: [5, 4], provenance: LUMINANCE },
      ]),
    })
    const branches = [
      path([[0, 0], [1, 0]]),
      path([[1, 0], [2, 0]]),
      path([[1, 0], [1, 1]]),
      path([[4, 4], [5, 4]]),
    ]

    const result = clean(branches, componentGraph, 0, 0)

    expect(result).toHaveLength(3)
    expect(result.map(({ points }) => points)).not.toContainEqual(branches[3]!.points)
  })

  it('curves a three-point bend while preserving its open endpoints', () => {
    const source = path([
      [1, 1],
      [2, 4],
      [3, 1],
    ])

    const result = clean([source], graph(), 1, 1)[0]!

    expect(result.closed).toBe(false)
    expect(result.points[0]).toEqual(source.points[0])
    expect(result.points.at(-1)).toEqual(source.points.at(-1))
    expect(result.points.length).toBeGreaterThan(source.points.length)
    expect(result.points.length).toBeLessThanOrEqual(
      (source.points.length - 1) * 16 + 1,
    )
  })

  it('preserves open endpoints across a high smoothing threshold', () => {
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

    for (const contour of [below, at]) {
      expect(contour.points[0]).toEqual(source.points[0])
      expect(contour.points.at(-1)).toEqual(source.points.at(-1))
      expect(contour.points.length).toBeLessThanOrEqual(
        (source.points.length - 1) * 16 + 1,
      )
    }
  })

  it('rejects an intermediate removal that would link identical neighbours', () => {
    const source = path([
      [0, 0],
      [1, 1],
      [0, 0],
      [3, 0],
    ])

    const result = clean([source], graph(), 1, 0.5)[0]!

    expect(result.points.length).toBeLessThanOrEqual(
      (source.points.length - 1) * 16 + 1,
    )
    expect(result.points[0]).toEqual(source.points[0])
    expect(result.points.at(-1)).toEqual(source.points.at(-1))
    for (let index = 1; index < result.points.length; index += 1) {
      expect(result.points[index]).not.toEqual(result.points[index - 1])
    }
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
    expect(normal.points.length).toBeLessThanOrEqual(ring.points.length * 16)
    expect(maximum.points.length).toBeLessThanOrEqual(ring.points.length * 16)
  })

  it('smooths the real centered alpha ring deterministically with support', () => {
    const fixture = centeredAlphaRing()
    expect(fixture.paths).toHaveLength(1)
    expect(fixture.paths[0]!.closed).toBe(true)

    const level100 = clean(fixture.paths, fixture.graph, 1, 1)[0]!
    const repeated = clean(fixture.paths, fixture.graph, 1, 1)[0]!

    expect(level100).toEqual(repeated)
    expect(level100.closed).toBe(true)
    expect(level100.points.at(-1)).not.toEqual(level100.points[0])
    expect(level100.points.length).toBeLessThanOrEqual(
      fixture.paths[0]!.points.length * 16,
    )
    for (const point of sampledSegments(level100)) {
      expect(bilinearAlpha(fixture.graph, point)).toBeGreaterThan(0)
    }
  })

  it('keeps smoothing zero exact and refinement bounded across control levels', () => {
    const source = path([
      [0.5, 0.5],
      [1.5, 3.5],
      [2.5, 1],
      [3.5, 4],
      [4.5, 0.75],
      [5.5, 3.75],
      [6.5, 1.25],
      [7.5, 3.5],
      [8.5, 0.5],
    ])
    const sourceGraph = graph(10, 6)
    expect(clean([source], sourceGraph, 1, 0)[0]!.points).toEqual(source.points)
    for (let level = 0; level <= 100; level += 1) {
      const count = clean([source], sourceGraph, 1, level / 100)[0]!.points
        .length
      expect(count).toBeLessThanOrEqual((source.points.length - 1) * 16 + 1)
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

  it('refines alpha boundaries off the control isovalue without losing support', () => {
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
    expect(result.closed).toBe(false)
    expect(result.points[0]).toEqual(boundary.points[0])
    expect(result.points.at(-1)).toEqual(boundary.points.at(-1))
    expect(result.points.length).toBeGreaterThan(boundary.points.length)
    expect(result.points.length).toBeLessThanOrEqual(
      (boundary.points.length - 1) * 16 + 1,
    )
    for (const point of sampledSegments(result)) {
      expect(bilinearAlpha(sourceGraph, point)).toBeGreaterThan(0)
    }
  })

  it('keeps a refined long alpha corner inside a one-pixel control tube', () => {
    const controls: readonly Readonly<Point>[] = [
      [2, 2],
      [22, 2],
      [22, 22],
      [2, 22],
    ]
    const sourceGraph = graph(25, 25, Array<number>(25 * 25).fill(0.5))
    const source = path(controls, true, ALPHA_BOUNDARY)

    const result = clean([source], sourceGraph, 1, 1)[0]!

    expect(result.closed).toBe(true)
    expect(result.provenance).toEqual(ALPHA_BOUNDARY)
    expect(result.points.length).toBeLessThanOrEqual(controls.length * 16)
    expect(Math.max(...sampledSegments(result).map((point) =>
      distanceToPolyline(point, controls, true),
    ))).toBeLessThanOrEqual(1 + 1e-12)
  })

  it('rejects an alpha simplification fallback outside the control tube', () => {
    const controls: readonly Readonly<Point>[] = [
      [1, 1],
      [1, 10],
      [10, 10],
      [10, 1],
    ]
    const sourceGraph = graph(12, 12, Array<number>(12 * 12).fill(0.5))
    const source = path(controls, false, ALPHA_BOUNDARY)

    const result = clean([source], sourceGraph, 1, 1)[0]!

    expect(result.points[0]).toEqual(controls[0])
    expect(result.points.at(-1)).toEqual(controls.at(-1))
    expect(Math.max(...sampledSegments(result).map((point) =>
      distanceToPolyline(point, controls, false),
    ))).toBeLessThanOrEqual(1 + 1e-12)
  })

  it('enforces the refinement tube between quarter-point samples', () => {
    const controls: readonly Readonly<Point>[] = [
      [0, 120],
      [242.65722753945738, 129.73475436214358],
      [213.25658278539777, 1.15819729515351],
    ]
    const sourceGraph = graph(256, 132, Array<number>(256 * 132).fill(0.5))
    const source = path(controls, false, ALPHA_BOUNDARY)

    const result = clean([source], sourceGraph, 1, 1)[0]!

    expect(Math.max(...sampledSegments(result).map((point) =>
      distanceToPolyline(point, controls, false),
    ))).toBeLessThanOrEqual(1 + 1e-12)
  })

  it('never rounds an alpha boundary into a transparent hole', () => {
    const fixture = transparentAlphaHole()
    expect(fixture.paths).toHaveLength(1)
    expect(fixture.paths[0]!.provenance).toEqual(ALPHA_BOUNDARY)

    const result = clean(fixture.paths, fixture.graph, 1, 1)
    const repeated = clean(fixture.paths, fixture.graph, 1, 1)

    expect(result).toEqual(repeated)
    expect(result).toHaveLength(1)
    for (const point of sampledSegments(result[0]!)) {
      expect(bilinearAlpha(fixture.graph, point)).toBeGreaterThan(0)
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
    'keeps a representative alpha loop refinement within its work bound',
    () => {
      const width = 256
      const height = 256
      const center = (width - 1) / 2
      const alpha = Array.from({ length: width * height }, (_, index) => {
        const x = index % width
        const y = Math.floor(index / width)
        return Math.hypot(x - center, y - center) <= 80 ? 1 : 0
      })
      const raster: Readonly<AnalyzedRaster> = Object.freeze({
        sourceWidth: width,
        sourceHeight: height,
        width,
        height,
        luminance: Object.freeze(Array<number>(width * height).fill(0)),
        alpha: Object.freeze(alpha),
        positiveSupport: Object.freeze(alpha.map((value) => value > 0)),
      })
      const edgeGraph = localizePencilContourEdges(raster, 0.5)
      const paths = tracePencilContourEdges(edgeGraph)
      expect(paths).toHaveLength(1)
      expect(paths[0]!.points.length).toBeGreaterThan(500)
      const started = performance.now()

      const result = clean(paths, edgeGraph, 1, 1)
      const elapsed = performance.now() - started

      expect(result).toHaveLength(1)
      expect(result[0]!.closed).toBe(true)
      expect(elapsed).toBeLessThan(300)
    },
    2_000,
  )

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
      expect(result[0]!.points.length).toBeLessThanOrEqual(points.length * 16)
      expect(elapsed).toBeLessThan(500)
    },
    2_000,
  )
})
