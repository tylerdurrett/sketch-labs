import { describe, expect, it } from 'vitest'

import { hiddenLinePass } from '../hiddenLine'
import type { Primitive, Scene } from '../scene'
import type { Point } from '../types'
import { grassHills } from '../sketches/grass-hills'
import { GRASS_HILLS_FIDELITY_FIXTURES } from './grassHillsFidelityFixtures'
import { compareVisibleContours } from './visibleContourOracle'

type PrimitiveKind = 'blade' | 'hill'

function kindOf(primitive: Primitive): PrimitiveKind {
  return primitive.points.length === 7 ? 'blade' : 'hill'
}

function boundsOf(
  primitive: Primitive,
): readonly [number, number, number, number] {
  const xs = primitive.points.map(([x]) => x)
  const ys = primitive.points.map(([, y]) => y)
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

function overlaps(left: Primitive, right: Primitive): boolean {
  const [leftMinX, leftMinY, leftMaxX, leftMaxY] = boundsOf(left)
  const [rightMinX, rightMinY, rightMaxX, rightMaxY] = boundsOf(right)
  return (
    leftMinX < rightMaxX &&
    leftMaxX > rightMinX &&
    leftMinY < rightMaxY &&
    leftMaxY > rightMinY
  )
}

function painterPairInventory(scene: Scene): ReadonlySet<string> {
  const inventory = new Set<string>()
  for (let farther = 0; farther < scene.primitives.length; farther++) {
    const fartherPrimitive = scene.primitives[farther]!
    if (fartherPrimitive.fill === undefined) continue
    for (let nearer = farther + 1; nearer < scene.primitives.length; nearer++) {
      const nearerPrimitive = scene.primitives[nearer]!
      if (nearerPrimitive.fill === undefined) continue
      if (overlaps(fartherPrimitive, nearerPrimitive)) {
        inventory.add(`${kindOf(fartherPrimitive)}/${kindOf(nearerPrimitive)}`)
      }
    }
  }
  return inventory
}

/**
 * Reconstruct issue #305's six root-to-tip spine from one seven-point Fill
 * silhouette without importing the production spine helper. The symmetric
 * t=.5 flanks recover the bend exponent; the shared apex recovers total lean.
 */
function reconstructIssue305Centerline(blade: Primitive): Point[] {
  if (blade.points.length !== 7) {
    throw new Error('issue-305 reconstruction requires a seven-point blade')
  }
  const root = blade.points[0]!
  const rightHalf = blade.points[1]!
  const tip = blade.points[3]!
  const leftHalf = blade.points[5]!
  const halfCenterX = (rightHalf[0] + leftHalf[0]) / 2
  const tipOffset = tip[0] - root[0]
  const halfOffset = halfCenterX - root[0]
  const exponent =
    Math.abs(tipOffset) < 1e-12 || Math.abs(halfOffset) < 1e-12
      ? 2
      : Math.log(halfOffset / tipOffset) / Math.log(0.5)

  return Array.from({ length: 6 }, (_, index): Point => {
    const t = index / 5
    return [
      root[0] + tipOffset * t ** exponent,
      root[1] + (tip[1] - root[1]) * t,
    ]
  })
}

function reconstructedIssue305Source(fill: Scene): Scene {
  return {
    space: fill.space,
    primitives: fill.primitives
      .filter((primitive) => kindOf(primitive) === 'blade')
      .map((primitive) => ({
        points: reconstructIssue305Centerline(primitive),
        stroke: { color: 'black', width: 1 },
        hiddenLineRole: 'source',
      })),
  }
}

function invokePublicFixture(
  fixture: typeof GRASS_HILLS_FIDELITY_FIXTURES.bounded,
): { fill: Scene; source: Scene; outline: Scene } {
  const fill = grassHills.generate(
    fixture.params,
    fixture.seed,
    fixture.time,
    fixture.frame,
  )
  const source = grassHills.generateOutlineSource!(
    fixture.params,
    fixture.seed,
    fixture.time,
    fixture.frame,
    fixture.target,
  )
  return { fill, source, outline: hiddenLinePass(source) }
}

describe('Grass Hills real-call-site visible-contour fidelity', () => {
  it('covers representative painter visibility in the bounded exact fixture', () => {
    const fixture = GRASS_HILLS_FIDELITY_FIXTURES.bounded
    const fill = grassHills.generate(
      fixture.params,
      fixture.seed,
      fixture.time,
      fixture.frame,
    )
    const faithfulOutline = hiddenLinePass(fill)

    expect(
      fill.primitives.filter(({ points }) => points.length === 7),
    ).toHaveLength(fixture.expectedBladeCount)
    expect(painterPairInventory(fill)).toEqual(
      new Set(['hill/blade', 'hill/hill', 'blade/blade', 'blade/hill']),
    )
    expect(compareVisibleContours(fill, faithfulOutline)).toEqual({
      matches: true,
      missing: [],
      extra: [],
    })
  })

  it('rejects issue #305 centerlines bidirectionally even before root LOD', () => {
    const fixture = GRASS_HILLS_FIDELITY_FIXTURES.bounded
    const fill = grassHills.generate(
      fixture.params,
      fixture.seed,
      fixture.time,
      fixture.frame,
    )
    const reconstructed = reconstructedIssue305Source(fill)
    const comparison = compareVisibleContours(
      fill,
      hiddenLinePass(reconstructed),
    )

    expect(reconstructed.primitives).toHaveLength(fixture.expectedBladeCount)
    expect(comparison.matches).toBe(false)
    expect(comparison.missing.length).toBeGreaterThan(0)
    expect(comparison.extra.length).toBeGreaterThan(0)
  })

  it('characterizes the current public #305 Outline path as unfaithful', () => {
    const fixture = GRASS_HILLS_FIDELITY_FIXTURES.bounded
    const { fill, source, outline } = invokePublicFixture(fixture)
    const fillBladeRoots = new Set(
      fill.primitives
        .filter(({ points }) => points.length === 7)
        .map(({ points }) => points[0]!.join(':')),
    )
    const spines = source.primitives.filter(({ points }) => points.length === 6)
    const reconstructedByRoot = new Map(
      fill.primitives
        .filter(({ points }) => points.length === 7)
        .map((blade) => [
          blade.points[0]!.join(':'),
          reconstructIssue305Centerline(blade),
        ]),
    )
    const comparison = compareVisibleContours(fill, outline)

    // CHARACTERIZATION SEAM: block E must flip this verdict when the public
    // call site stops returning #305 centerlines and represents Fill exactly.
    expect(comparison.matches).toBe(false)
    expect(comparison.missing.length).toBeGreaterThan(0)
    expect(comparison.extra.length).toBeGreaterThan(0)
    expect(spines.length).toBeGreaterThan(0)
    expect(
      spines.every(({ points }) => fillBladeRoots.has(points[0]!.join(':'))),
    ).toBe(true)
    for (const spine of spines) {
      const reconstructed = reconstructedByRoot.get(spine.points[0]!.join(':'))!
      expect(reconstructed).toHaveLength(6)
      for (let index = 0; index < 6; index++) {
        expect(spine.points[index]![0]).toBeCloseTo(
          reconstructed[index]![0],
          10,
        )
        expect(spine.points[index]![1]).toBeCloseTo(
          reconstructed[index]![1],
          10,
        )
      }
    }
  })

  it('exposes #305 physical-tool root rejection as a completeness failure', () => {
    const fixture = GRASS_HILLS_FIDELITY_FIXTURES.bounded
    const fill = grassHills.generate(
      fixture.params,
      fixture.seed,
      fixture.time,
      fixture.frame,
    )
    const source = grassHills.generateOutlineSource!(
      fixture.params,
      fixture.seed,
      fixture.time,
      fixture.frame,
      { ...fixture.target, millimetersPerSceneUnit: 0.003 },
    )
    const selectedSpines = source.primitives.filter(
      ({ points }) => points.length === 6,
    )
    const comparison = compareVisibleContours(fill, hiddenLinePass(source))

    expect(selectedSpines.length).toBeGreaterThan(0)
    expect(selectedSpines.length).toBeLessThan(fixture.expectedBladeCount)
    expect(comparison.matches).toBe(false)
    expect(comparison.missing.length).toBeGreaterThan(0)
  })

  it('pins adopted and ceiling envelopes for scalable fidelity campaigns', () => {
    const { bounded, adopted10k, ceiling50k } = GRASS_HILLS_FIDELITY_FIXTURES

    expect(bounded.oraclePolicy).toBe('exact-now')
    expect(
      [adopted10k, ceiling50k].map((fixture) => ({
        density: fixture.params.bladeDensity,
        expectedBladeCount: fixture.expectedBladeCount,
        oraclePolicy: fixture.oraclePolicy,
      })),
    ).toEqual([
      {
        density: 2,
        expectedBladeCount: 10_000,
        oraclePolicy: 'scalable-campaign',
      },
      {
        density: 10,
        expectedBladeCount: 50_000,
        oraclePolicy: 'scalable-campaign',
      },
    ])
  })
})
