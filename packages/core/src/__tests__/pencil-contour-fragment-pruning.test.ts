import { describe, expect, it } from 'vitest'

import {
  classifyPencilContourFragments,
  pencilContourFragmentMasks,
  prunePencilContourGraph,
} from '../sketches/pencil-contour/fragment-pruning'
import type {
  LocalizedEdge,
  LocalizedEdgeGraph,
  LocalizedLuminanceEdgeEvidence,
} from '../sketches/pencil-contour/types'
import type { Point } from '../types'

const LUMINANCE = Object.freeze({ kind: 'luminance' } as const)
const ALPHA = Object.freeze({ kind: 'alpha-boundary' } as const)

function evidence(
  id: string,
  start: Point,
  end: Point,
  adjacentEdgeIds: readonly string[],
  strength = 0.1,
): Readonly<LocalizedLuminanceEdgeEvidence> {
  return Object.freeze({
    id,
    start: Object.freeze(start),
    end: Object.freeze(end),
    strength,
    adjacentEdgeIds: Object.freeze([...adjacentEdgeIds]),
  })
}

function fixture(): Readonly<LocalizedEdgeGraph> {
  const universe = Object.freeze([
    // The paired horizontal trail passes straight through the junction.
    evidence('through-a', [0, 0], [1, 0], ['through-b']),
    evidence('through-b', [1, 0], [2, 0], ['through-a']),
    // This terminal arm is not shielded by the three-unit component total.
    evidence('spur', [1, 0], [1, 1], []),
    evidence('isolated-a', [4, 0], [5, 0], ['isolated-b']),
    evidence('isolated-b', [5, 0], [6, 0], ['isolated-a']),
    evidence('cycle-a', [8, 0], [9, 0], ['cycle-b', 'cycle-c']),
    evidence('cycle-b', [9, 0], [8.5, 1], ['cycle-a', 'cycle-c']),
    evidence('cycle-c', [8.5, 1], [8, 0], ['cycle-a', 'cycle-b']),
    // A short but strong terminal arm must remain protected.
    evidence('strong-through-a', [0, 3], [1, 3], ['strong-through-b']),
    evidence('strong-through-b', [1, 3], [2, 3], ['strong-through-a']),
    evidence('strong-spur', [1, 3], [1, 4], [], 0.29),
  ])
  const luminanceEdges: readonly Readonly<LocalizedEdge>[] = universe.map(
    ({ start, end }) => Object.freeze({ start, end, provenance: LUMINANCE }),
  )
  return Object.freeze({
    width: 12,
    height: 6,
    alpha: Object.freeze(Array<number>(72).fill(1)),
    positiveSupport: Object.freeze(Array<boolean>(72).fill(true)),
    luminanceEvidence: universe,
    selectedLuminanceEdgeIds: Object.freeze(universe.map(({ id }) => id)),
    edges: Object.freeze([
      ...luminanceEdges,
      Object.freeze({ start: [10, 4] as Point, end: [11, 4] as Point, provenance: ALPHA }),
    ]),
  })
}

describe('Pencil Contour immutable fragment pruning', () => {
  it('partitions every evidence ID with protected-precedence trail semantics', () => {
    const classification = classifyPencilContourFragments(fixture())
    const allIds = classification.trails.flatMap(({ edgeIds }) => edgeIds)
    const disposition = (id: string) =>
      classification.trails.find(({ edgeIds }) => edgeIds.includes(id))!
        .disposition

    expect(allIds).toHaveLength(new Set(allIds).size)
    expect(new Set(allIds)).toEqual(
      new Set(fixture().luminanceEvidence!.map(({ id }) => id)),
    )
    expect(disposition('cycle-a')).toBe('protected-cycle')
    expect(disposition('through-a')).toBe('protected-through')
    expect(disposition('spur')).toBe('removable-spur')
    expect(disposition('isolated-a')).toBe('removable-isolated')
    expect(disposition('strong-spur')).toBe('protected')
    expect(
      [...classification.protectedEdgeIds].some((id) =>
        classification.removableEdgeIds.has(id),
      ),
    ).toBe(false)
  })

  it('is independent of evidence order, authored detail, and smoothing', () => {
    const source = fixture()
    const reordered: Readonly<LocalizedEdgeGraph> = Object.freeze({
      ...source,
      luminanceEvidence: Object.freeze(
        [...source.luminanceEvidence!].reverse().map((item) => Object.freeze({
          ...item,
          adjacentEdgeIds: Object.freeze([...item.adjacentEdgeIds].reverse()),
        })),
      ),
    })

    expect(classifyPencilContourFragments(reordered).trails).toEqual(
      classifyPencilContourFragments(source).trails,
    )
    const low = pencilContourFragmentMasks(source, 0, 0.75)
    const high = pencilContourFragmentMasks(source, 1, 0.75)
    expect(high.additionalRemovalEdgeIds).toEqual(
      low.additionalRemovalEdgeIds,
    )
  })

  it('uses an empty-at-zero bounded monotonic prefix and never removes protected IDs', () => {
    const source = fixture()
    const protectedIds = classifyPencilContourFragments(source).protectedEdgeIds
    let previous = new Set(source.selectedLuminanceEdgeIds)

    expect(
      pencilContourFragmentMasks(source, 0.5, 0).additionalRemovalEdgeIds,
    ).toEqual(new Set())
    for (let level = 0; level <= 100; level += 1) {
      const pruned = prunePencilContourGraph(source, 0.5, level / 100)
      const current = new Set(pruned.selectedLuminanceEdgeIds)
      for (const id of current) expect(previous.has(id)).toBe(true)
      for (const id of protectedIds) expect(current.has(id)).toBe(true)
      previous = current
    }
    expect(previous.has('spur')).toBe(false)
    expect(previous.has('strong-spur')).toBe(true)
    expect(previous.has('through-a')).toBe(true)
    expect(previous.has('cycle-a')).toBe(true)
  })

  it('keeps detail admission edge-nested at representative smoothing levels', () => {
    const source = fixture()
    for (const smoothing of [0, 0.5, 1]) {
      let previous = new Set<string>()
      for (let level = 0; level <= 100; level += 1) {
        const count = Math.floor(
          (source.selectedLuminanceEdgeIds!.length * level) / 100,
        )
        const selectedIds = source.selectedLuminanceEdgeIds!.slice(0, count)
        const graph: Readonly<LocalizedEdgeGraph> = Object.freeze({
          ...source,
          selectedLuminanceEdgeIds: Object.freeze(selectedIds),
          edges: Object.freeze([
            ...source.edges.slice(0, count),
            ...source.edges.filter(
              ({ provenance }) => provenance.kind === 'alpha-boundary',
            ),
          ]),
        })
        const current = new Set(
          prunePencilContourGraph(graph, level / 100, smoothing)
            .selectedLuminanceEdgeIds,
        )
        for (const id of previous) expect(current.has(id)).toBe(true)
        previous = current
      }
    }
  })

  it('keeps alpha edges and removes a qualified spur despite component total length', () => {
    const source = fixture()
    const maximum = prunePencilContourGraph(source, 1, 1)

    expect(maximum.selectedLuminanceEdgeIds).not.toContain('spur')
    expect(maximum.selectedLuminanceEdgeIds).toContain('through-a')
    expect(
      maximum.edges.filter(({ provenance }) =>
        provenance.kind === 'alpha-boundary',
      ),
    ).toEqual(
      source.edges.filter(({ provenance }) =>
        provenance.kind === 'alpha-boundary',
      ),
    )
  })
})
