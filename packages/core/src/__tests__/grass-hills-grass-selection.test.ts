import { describe, expect, it } from 'vitest'

import { createRandom } from '../random'
import {
  grassScaleAtDepth,
  layoutHillBands,
} from '../sketches/grass-hills/depth'
import {
  scatterGrassRoots,
  type GrassRootCandidate,
} from '../sketches/grass-hills/grass-scatter'
import {
  canonicalScale,
  hillCap,
  selectGrassRoots,
} from '../sketches/grass-hills/grass-selection'

function root(
  rootKey: string,
  ordinal: number,
  u: number,
  v: number,
): GrassRootCandidate {
  return { rootKey, ordinal, u, v }
}

function selectedKeys(
  seed: string,
  depth: number,
  bladeDensity: number,
  candidates: readonly GrassRootCandidate[],
): string[] {
  return selectGrassRoots({ seed, depth, bladeDensity, candidates }).map(
    ({ rootKey }) => rootKey,
  )
}

describe('grass-hills selection cap', () => {
  it('keeps at least forty blades on every default-layout hill at maximum density', () => {
    const bands = layoutHillBands(10, {
      frame: { height: 1_000 },
      horizonHeight: 0.25,
      depthFalloff: 2,
    })

    for (const band of bands) {
      const candidates = scatterGrassRoots({
        seed: 'maximum-density-regression',
        hillKey: band.hillKey,
        bladeDensity: 2,
      })
      expect(candidates.length).toBeGreaterThanOrEqual(40)
      const selected = selectGrassRoots({
        seed: 'maximum-density-regression',
        depth: band.depth,
        bladeDensity: 2,
        candidates,
      })

      expect(selected.length).toBeGreaterThanOrEqual(40)
    }
  })

  it('uses the existing continuous perspective scale as its canonical scale', () => {
    for (const depth of [-1, 0, 0.125, 0.5, 0.9, 1, 2, Number.NaN]) {
      expect(canonicalScale(depth)).toBe(grassScaleAtDepth(depth))
    }
  })

  it.each([
    { depth: 0, scale: 1, caps: [5, 20, 40] },
    { depth: 0.5, scale: 0.6, caps: [8, 33, 40] },
    { depth: 0.75, scale: 0.4, caps: [13, 40, 40] },
    { depth: 0.9, scale: 0.28, caps: [18, 40, 40] },
    { depth: 0.98, scale: 0.216, caps: [23, 40, 40] },
  ])(
    'pins depth $depth / scale $scale to density caps $caps',
    ({ depth, scale, caps }) => {
      expect(canonicalScale(depth)).toBeCloseTo(scale, 12)
      expect([0.25, 1, 2].map((density) => hillCap(depth, density))).toEqual(
        caps,
      )
    },
  )

  it('uses JavaScript positive-half rounding before clamping', () => {
    // 20 * 0.275 / canonicalScale(0) = exactly 5.5.
    expect(hillCap(0, 0.275)).toBe(6)
    expect(Math.round(5.5)).toBe(6)
  })

  it('is monotonic in both depth and supported density', () => {
    const depths = Array.from({ length: 101 }, (_, index) => index / 100)
    const densities = Array.from(
      { length: 101 },
      (_, index) => 0.25 + (1.75 * index) / 100,
    )

    for (const density of [0.25, 0.5, 1, 1.5, 2]) {
      const caps = depths.map((depth) => hillCap(depth, density))
      for (let index = 1; index < caps.length; index++) {
        expect(caps[index]).toBeGreaterThanOrEqual(caps[index - 1]!)
      }
    }
    for (const depth of [0, 0.25, 0.5, 0.75, 1]) {
      const caps = densities.map((density) => hillCap(depth, density))
      for (let index = 1; index < caps.length; index++) {
        expect(caps[index]).toBeGreaterThanOrEqual(caps[index - 1]!)
      }
    }
  })

  it('gives a shared reduced-depth hill the same cap at 3 and 7 hills', () => {
    const projection = {
      frame: { height: 1_000 },
      horizonHeight: 0.25,
      depthFalloff: 2,
    }
    const sharedAtThree = layoutHillBands(3, projection).find(
      ({ hillKey }) => hillKey === '1/2',
    )!
    const sharedAtSeven = layoutHillBands(7, projection).find(
      ({ hillKey }) => hillKey === '1/2',
    )!

    expect(sharedAtThree.depth).toBe(0.5)
    expect(sharedAtSeven.depth).toBe(0.5)
    expect(hillCap(sharedAtThree.depth, 1)).toBe(
      hillCap(sharedAtSeven.depth, 1),
    )
  })

  it('keeps every supported hill count within the 10,240-root hard bound', () => {
    for (let hillCount = 1; hillCount <= 256; hillCount++) {
      const total = Array.from({ length: hillCount }, (_, index) => {
        const depth = (hillCount - index) / (hillCount + 1)
        return hillCap(depth, 2)
      }).reduce((sum, cap) => sum + cap, 0)

      expect(total).toBeLessThanOrEqual(10_240)
    }
  })

  it('has enough canonical candidates to meet every maximum-density cap', () => {
    const hills = [
      { hillKey: '0/1', depth: 0 },
      { hillKey: '1/2', depth: 0.5 },
      { hillKey: '3/4', depth: 0.75 },
      { hillKey: '9/10', depth: 0.9 },
      { hillKey: '49/50', depth: 0.98 },
      { hillKey: '1/1', depth: 1 },
    ] as const

    for (const { hillKey, depth } of hills) {
      const bladeDensity = 2
      const candidates = scatterGrassRoots({
        seed: 'selection-cap-sufficiency',
        hillKey,
        bladeDensity,
      })
      expect(candidates.length).toBeGreaterThanOrEqual(
        hillCap(depth, bladeDensity),
      )
    }
  })

  it('shrinks raw horizontal spacing without a depth-normalized step', () => {
    const nearDepth = 0.25
    const farDepth = 0.5
    const nearRawSpacing = 1 / hillCap(nearDepth, 1)
    const farRawSpacing = 1 / hillCap(farDepth, 1)
    const nearNormalized = nearRawSpacing / canonicalScale(nearDepth)
    const farNormalized = farRawSpacing / canonicalScale(farDepth)

    expect(farRawSpacing).toBeLessThan(nearRawSpacing)
    expect(farNormalized / nearNormalized).toBeGreaterThan(0.8)
    expect(farNormalized / nearNormalized).toBeLessThan(1.2)
  })
})

describe('grass-hills deterministic root selection', () => {
  it('starts at lowest priority, then follows max-min distance with priority ties', () => {
    const candidates = [
      root('p0', 0, 1, 0),
      root('p1', 1, 0, 1),
      root('p2', 2, 1, 1),
      root('p3', 3, 0, 0),
      root('p4', 4, 0.5, 0.5),
    ]

    // p3 has the lowest seeded priority. p2 is then farthest. p0 and p1
    // tie at distance 1, so p0's lower seeded priority wins before p1.
    expect(selectedKeys('selection', 0, 1, candidates).slice(0, 4)).toEqual([
      'p3',
      'p2',
      'p0',
      'p1',
    ])
  })

  it('uses ordinal as the final tie-break and ignores candidate array order', () => {
    const higherOrdinal = root('same-key', 8, 1, 1)
    const lowerOrdinal = root('same-key', 2, 0, 0)

    expect(
      selectGrassRoots({
        seed: 'ordinal-tie',
        depth: 0,
        bladeDensity: 1,
        candidates: [higherOrdinal, lowerOrdinal],
      }),
    ).toEqual([lowerOrdinal, higherOrdinal])
  })

  it('spreads a real selected set across the canonical hill instead of clustering', () => {
    const candidates = scatterGrassRoots({
      seed: 'selection-coverage',
      hillKey: '9/10',
      bladeDensity: 2,
    })
    const selected = selectGrassRoots({
      seed: 'selection-coverage',
      depth: 0.9,
      bladeDensity: 2,
      candidates,
    })

    expect(selected).toHaveLength(40)
    expect(
      Math.max(...selected.map(({ u }) => u)) -
        Math.min(...selected.map(({ u }) => u)),
    ).toBeGreaterThan(0.75)
    expect(
      Math.max(...selected.map(({ v }) => v)) -
        Math.min(...selected.map(({ v }) => v)),
    ).toBeGreaterThan(0.75)
    for (const [uSide, vSide] of [
      [(u: number) => u < 0.5, (v: number) => v < 0.5],
      [(u: number) => u >= 0.5, (v: number) => v < 0.5],
      [(u: number) => u < 0.5, (v: number) => v >= 0.5],
      [(u: number) => u >= 0.5, (v: number) => v >= 0.5],
    ] as const) {
      expect(selected.some(({ u, v }) => uSide(u) && vSide(v))).toBe(true)
    }
  })

  it('keeps hill selection independent of work performed for another hill', () => {
    const hillA = scatterGrassRoots({
      seed: 'cross-hill',
      hillKey: '1/2',
      bladeDensity: 1,
    })
    const hillB = scatterGrassRoots({
      seed: 'cross-hill',
      hillKey: '3/4',
      bladeDensity: 1,
    })
    const optionsA = {
      seed: 'cross-hill',
      depth: 0.5,
      bladeDensity: 1,
      candidates: hillA,
    } as const

    const before = selectGrassRoots(optionsA)
    selectGrassRoots({
      seed: 'cross-hill',
      depth: 0.75,
      bladeDensity: 1,
      candidates: hillB,
    })
    expect(selectGrassRoots(optionsA)).toEqual(before)
  })

  it('preserves shared selected root keys between 3 and 7 hills', () => {
    const projection = {
      frame: { height: 1_000 },
      horizonHeight: 0.25,
      depthFalloff: 2,
    }
    const depthAtThree = layoutHillBands(3, projection).find(
      ({ hillKey }) => hillKey === '1/2',
    )!.depth
    const depthAtSeven = layoutHillBands(7, projection).find(
      ({ hillKey }) => hillKey === '1/2',
    )!.depth
    const candidates = scatterGrassRoots({
      seed: 'count-stability',
      hillKey: '1/2',
      bladeDensity: 1,
    })

    expect(selectedKeys('count-stability', depthAtThree, 1, candidates)).toEqual(
      selectedKeys('count-stability', depthAtSeven, 1, candidates),
    )
  })

  it('returns frozen selection order without mutating or replacing identities', () => {
    const candidates = scatterGrassRoots({
      seed: 'immutable-selection',
      hillKey: '1/2',
      bladeDensity: 1,
    })
    const originalOrder = [...candidates]
    const selected = selectGrassRoots({
      seed: 'immutable-selection',
      depth: 0.5,
      bladeDensity: 1,
      candidates,
    })

    expect(Object.isFrozen(selected)).toBe(true)
    expect(candidates).toEqual(originalOrder)
    expect(selected.every((candidate) => candidates.includes(candidate))).toBe(
      true,
    )
  })

  it('uses the pinned root-local priority seed', () => {
    const candidates = [
      root('1/2:0', 0, 0, 0),
      root('1/2:1', 1, 1, 0),
      root('1/2:2', 2, 0, 1),
      root('1/2:3', 3, 1, 1),
    ]
    const priorities = candidates.map(({ rootKey, ordinal }) => ({
      ordinal,
      priority: createRandom(`priority-seed-grass-priority-${rootKey}`).value(),
    }))
    const expectedFirst = priorities.sort(
      (a, b) => a.priority - b.priority || a.ordinal - b.ordinal,
    )[0]!.ordinal

    expect(
      selectGrassRoots({
        seed: 'priority-seed',
        depth: 0,
        bladeDensity: 1,
        candidates,
      })[0]!.ordinal,
    ).toBe(expectedFirst)
  })
})
