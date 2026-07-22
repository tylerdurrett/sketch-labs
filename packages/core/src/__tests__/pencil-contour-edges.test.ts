import { describe, expect, it } from 'vitest'
import { localizePencilContourEdges } from '../sketches/pencil-contour/edges'
import type {
  AnalyzedRaster,
  LocalizedEdge,
} from '../sketches/pencil-contour/types'

function analyzedRaster(
  width: number,
  height: number,
  luminance: readonly number[],
  alpha: readonly number[] = Array<number>(width * height).fill(1),
  positiveSupport: readonly boolean[] = alpha.map((value) => value > 0),
): Readonly<AnalyzedRaster> {
  return Object.freeze({
    sourceWidth: width,
    sourceHeight: height,
    width,
    height,
    luminance: Object.freeze([...luminance]),
    alpha: Object.freeze([...alpha]),
    positiveSupport: Object.freeze([...positiveSupport]),
  })
}

function withProvenance(
  edges: readonly Readonly<LocalizedEdge>[],
  kind: 'luminance' | 'alpha-boundary',
): readonly Readonly<LocalizedEdge>[] {
  return edges.filter((edge) => edge.provenance.kind === kind)
}

describe('Pencil Contour edge localization', () => {
  it('localizes vertical and horizontal luminance transitions in lattice coordinates', () => {
    const vertical = localizePencilContourEdges(
      analyzedRaster(
        4,
        3,
        [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1],
      ),
      0,
    )
    const horizontal = localizePencilContourEdges(
      analyzedRaster(
        3,
        4,
        [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1],
      ),
      0,
    )

    const verticalEdges = withProvenance(vertical.edges, 'luminance')
    const horizontalEdges = withProvenance(horizontal.edges, 'luminance')
    expect(verticalEdges).toHaveLength(3)
    expect(verticalEdges.every((edge) => edge.start[0] === 1.5)).toBe(true)
    expect(verticalEdges.every((edge) => edge.end[0] === 1.5)).toBe(true)
    expect(horizontalEdges).toHaveLength(3)
    expect(horizontalEdges.every((edge) => edge.start[1] === 1.5)).toBe(true)
    expect(horizontalEdges.every((edge) => edge.end[1] === 1.5)).toBe(true)
  })

  it('marches an alpha-only silhouette at one fixed interpolated isovalue', () => {
    const raster = analyzedRaster(
      3,
      3,
      Array<number>(9).fill(0.25),
      [0, 0, 0, 0, 0.75, 0, 0, 0, 0],
    )

    const graph = localizePencilContourEdges(raster, 0.5)
    const alphaEdges = withProvenance(graph.edges, 'alpha-boundary')

    expect(alphaEdges).toHaveLength(4)
    expect(withProvenance(graph.edges, 'luminance')).toHaveLength(0)
    const coordinates = alphaEdges.flatMap((edge) => [
      edge.start[0],
      edge.start[1],
      edge.end[0],
      edge.end[1],
    ])
    expect(
      coordinates.some(
        (coordinate) => Math.abs(coordinate - 2 / 3) < 1e-12,
      ),
    ).toBe(true)
    expect(graph.alpha).toBe(raster.alpha)
    expect(graph.positiveSupport).toBe(raster.positiveSupport)
  })

  it('monotonically admits a weaker secondary luminance transition with detail', () => {
    const row = [0, 0, 1, 1, 0.85, 0.85]
    const raster = analyzedRaster(6, 3, [...row, ...row, ...row])

    const lowDetail = withProvenance(
      localizePencilContourEdges(raster, 0).edges,
      'luminance',
    )
    const highDetail = withProvenance(
      localizePencilContourEdges(raster, 1).edges,
      'luminance',
    )

    expect(lowDetail).toHaveLength(3)
    expect(highDetail).toHaveLength(6)
    expect(highDetail).toEqual(expect.arrayContaining(lowDetail))
    expect(lowDetail.every((edge) => edge.start[0] === 1.5)).toBe(true)
    expect(highDetail.some((edge) => edge.start[0] === 3.5)).toBe(true)
  })

  it('never seeds luminance edges from hidden RGB or across zero-alpha samples', () => {
    const hidden = analyzedRaster(
      4,
      3,
      [0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1],
      Array<number>(12).fill(0),
    )
    const separated = analyzedRaster(
      3,
      2,
      [0, 1, 0, 0, 1, 0],
      [1, 0, 1, 1, 0, 1],
    )

    expect(
      withProvenance(localizePencilContourEdges(hidden, 1).edges, 'luminance'),
    ).toHaveLength(0)
    expect(
      withProvenance(
        localizePencilContourEdges(separated, 1).edges,
        'luminance',
      ),
    ).toHaveLength(0)
  })

  it('does not fit an invented perimeter around a flat opaque raster', () => {
    const flat = analyzedRaster(5, 4, Array<number>(20).fill(0.4))

    expect(localizePencilContourEdges(flat, 1).edges).toEqual([])
  })

  it('uses fixed row-major ambiguity resolution for diagonal alpha cases', () => {
    const raster = analyzedRaster(2, 2, [0, 0, 0, 0], [1, 0, 0, 1])

    const first = localizePencilContourEdges(raster, 0.5)
    const second = localizePencilContourEdges(raster, 0.5)

    expect(first).toEqual(second)
    expect(first.edges).toEqual([
      {
        start: [0, 0.5],
        end: [0.5, 0],
        provenance: { kind: 'alpha-boundary' },
      },
      {
        start: [1, 0.5],
        end: [0.5, 1],
        provenance: { kind: 'alpha-boundary' },
      },
    ])
  })

  it('rejects an alpha segment collapsed onto an exact isovalue vertex', () => {
    const collapsed = analyzedRaster(2, 2, [0, 0, 0, 0], [0.5, 0, 0, 0])
    const mixed = analyzedRaster(
      3,
      2,
      [0, 0, 0, 0, 0, 0],
      [0.5, 0, 1, 0, 0, 1],
    )

    expect(localizePencilContourEdges(collapsed, 0.5).edges).toEqual([])
    expect(localizePencilContourEdges(mixed, 0.5).edges).toEqual([
      {
        start: [1.5, 0],
        end: [1.5, 1],
        provenance: { kind: 'alpha-boundary' },
      },
    ])
  })

  it('gives adjacent cells single stable ownership of shared isovalue edges', () => {
    const raster = analyzedRaster(
      3,
      3,
      Array<number>(9).fill(0),
      [0, 0, 0, 0.5, 0.5, 0.5, 0, 0, 0],
    )

    const first = localizePencilContourEdges(raster, 0.5)
    const second = localizePencilContourEdges(raster, 0.5)

    expect(first).toEqual(second)
    expect(first.edges).toEqual([
      {
        start: [0, 1],
        end: [1, 1],
        provenance: { kind: 'alpha-boundary' },
      },
      {
        start: [1, 1],
        end: [2, 1],
        provenance: { kind: 'alpha-boundary' },
      },
    ])
  })

  it('does not emit collapsed luminance edges from one-dimensional lattices', () => {
    const horizontal = analyzedRaster(4, 1, [0, 0, 1, 1])
    const vertical = analyzedRaster(1, 4, [0, 0, 1, 1])

    expect(localizePencilContourEdges(horizontal, 1).edges).toEqual([])
    expect(localizePencilContourEdges(vertical, 1).edges).toEqual([])
  })

  it('bounds deterministic luminance selection on noisy input', () => {
    const width = 8
    const height = 8
    const luminance = Array.from(
      { length: width * height },
      (_, index) => ((index * 37 + 11) % 101) / 100,
    )
    const raster = analyzedRaster(width, height, luminance)

    const first = localizePencilContourEdges(raster, 1)
    const second = localizePencilContourEdges(raster, 1)
    const luminanceEdges = withProvenance(first.edges, 'luminance')

    expect(first).toEqual(second)
    expect(luminanceEdges.length).toBeLessThanOrEqual(
      Math.ceil(width * height * 0.5),
    )
  })
})
