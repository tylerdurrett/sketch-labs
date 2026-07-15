import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { grassScaleAtY } from '../../src/sketches/grass-hills/depth.ts'
import { bundleCandidate } from './candidate-bundle.js'
import { DENSITY_FIXTURES } from './fixtures.js'
import {
  SIMPLIFIED_BLADE_POINT_COUNT,
  SIMPLIFIED_CANDIDATE_ID,
  SIMPLIFIED_TUFT_SIZE,
  allocateBladeCounts,
  benchmarkCandidate,
  buildNestedTuftRoots,
  prepareSimplifiedCandidate,
  simplifiedBladePoints,
} from './simplified-candidate.js'

function payload({ bladeCount = 13, hillCount = 1, windLean = 0 } = {}) {
  const value = structuredClone(DENSITY_FIXTURES[0].payload)
  value.params.hillCount = hillCount
  value.params.windLean = windLean
  value.request = { hillCount, bladeCount }
  return value
}

function byRootKey(blades) {
  return new Map(blades.map((blade) => [blade.identity.rootKey, blade]))
}

describe('simplified dense-grass candidate', () => {
  it('implements the bundle/runner interface and survives the candidate boundary', async () => {
    expect(benchmarkCandidate).toMatchObject({
      id: SIMPLIFIED_CANDIDATE_ID,
      complexity: 'linear',
    })
    for (const operation of ['prepare', 'generate', 'guard', 'inspect']) {
      expect(benchmarkCandidate[operation]).toBeTypeOf('function')
    }

    const fixture = payload({ bladeCount: 4 })
    const sampler = benchmarkCandidate.prepare(fixture)
    const generated = sampler(0)
    expect(benchmarkCandidate.guard(generated)).toBeGreaterThan(0)
    expect(benchmarkCandidate.generate(fixture, 0).scene).toEqual(
      generated.scene,
    )

    const metrics = benchmarkCandidate.inspect({
      phase: 'warm',
      value: generated,
      payload: fixture,
    })
    expect(metrics.representation).toEqual({
      kind: 'open-centerline-blades/stable-tuft-metadata',
      bladeCount: 4,
      tuftCount: 1,
      tuftMemberCount: 4,
      pointsPerBlade: 6,
      occluderMode: 'hill-only',
      densityMode: 'same-density',
      hillOccluderCount: 1,
      clumpOccluderCount: 0,
      processedRootCount: 4,
      previewExportShareProcessedScene: true,
    })
    expect(metrics.processing).toMatchObject({
      kind: 'supplied',
      processed: { primitiveCount: 4, pointCount: 24 },
    })

    const directory = mkdtempSync(join(tmpdir(), 'grass-hills-simplified-'))
    const outputPath = join(directory, 'candidate.mjs')
    try {
      await bundleCandidate({
        entryPath: fileURLToPath(
          new URL('./simplified-candidate.js', import.meta.url),
        ),
        outputPath,
      })
      const bundled = await import(
        `${pathToFileURL(outputPath).href}?test=${Date.now()}`
      )
      expect(bundled.benchmarkCandidate).toMatchObject({
        id: SIMPLIFIED_CANDIDATE_ID,
        complexity: 'linear',
      })
      expect(
        bundled.benchmarkCandidate.guard(
          bundled.benchmarkCandidate.generate(fixture, 0),
        ),
      ).toBeGreaterThan(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('is byte-deterministic and emits exact finite open six-point strokes', () => {
    const fixture = payload({ bladeCount: 17, hillCount: 2 })
    const first = benchmarkCandidate.generate(fixture, 0)
    const second = benchmarkCandidate.generate(fixture, 0)

    expect(second.scene).toEqual(first.scene)
    expect(second.processing.scene).toEqual(first.processing.scene)
    expect(second.processing.evidence).toEqual(first.processing.evidence)
    expect(second.roots).toEqual(first.roots)
    expect(second.blades).toEqual(first.blades)
    expect(second.tufts).toEqual(first.tufts)
    expect(first.scene.primitives).toHaveLength(17)
    expect(first.blades).toHaveLength(17)
    expect(first.roots).toHaveLength(17)
    expect(first.tufts.flatMap((tuft) => tuft.members)).toHaveLength(17)

    for (const primitive of first.scene.primitives) {
      expect(primitive).toMatchObject({
        closed: false,
        stroke: { color: '#000000' },
      })
      expect(primitive.fill).toBeUndefined()
      expect(primitive.points).toHaveLength(SIMPLIFIED_BLADE_POINT_COUNT)
      expect(primitive.stroke.width).toBeGreaterThan(0)
      for (const point of primitive.points) {
        expect(point).toHaveLength(2)
        expect(point.every(Number.isFinite)).toBe(true)
      }
    }
  })

  it('keeps canonical roots prefix-nested and tuft membership stable', () => {
    const smallerRoots = buildNestedTuftRoots(12345, '1/2', 7)
    const largerRoots = buildNestedTuftRoots(12345, '1/2', 12)
    expect(largerRoots.slice(0, smallerRoots.length)).toEqual(smallerRoots)
    expect(new Set(largerRoots.map((root) => root.rootKey)).size).toBe(12)
    expect(
      largerRoots.every(
        (root) =>
          root.tuftOrdinal ===
            Math.floor(root.ordinal / SIMPLIFIED_TUFT_SIZE) &&
          root.memberOrdinal === root.ordinal % SIMPLIFIED_TUFT_SIZE,
      ),
    ).toBe(true)

    const smaller = benchmarkCandidate.generate(payload({ bladeCount: 7 }), 0)
    const larger = benchmarkCandidate.generate(payload({ bladeCount: 12 }), 0)
    const largerBlades = byRootKey(larger.blades)
    expect(smaller.tufts.map((tuft) => tuft.members.length)).toEqual([5, 2])
    expect(larger.tufts.map((tuft) => tuft.members.length)).toEqual([5, 5, 2])

    for (const blade of smaller.blades) {
      const retained = largerBlades.get(blade.identity.rootKey)
      expect(retained.canonical).toEqual(blade.canonical)
      expect(retained.rolls).toEqual(blade.rolls)
      expect(retained.shape).toEqual(blade.shape)
      expect(retained.identity.tuftKey).toBe(blade.identity.tuftKey)
    }
  })

  it('allocates exact totals by continuous depth scale', () => {
    const prepared = prepareSimplifiedCandidate(
      payload({ bladeCount: 60, hillCount: 3 }),
    )
    const counts = allocateBladeCounts(
      60,
      prepared.hills.map((hill) => hill.band),
    )
    expect(counts).toEqual([36, 16, 8])
    expect(counts.reduce((total, count) => total + count, 0)).toBe(60)
    expect(counts[0]).toBeGreaterThan(counts[1])
    expect(counts[1]).toBeGreaterThan(counts[2])

    const scales = []
    const fixture = payload({ bladeCount: 60, hillCount: 3 })
    for (const hill of prepared.hills) {
      const projection = {
        frame: fixture.frame,
        horizonHeight: fixture.params.horizonHeight,
        depthFalloff: fixture.params.depthFalloff,
      }
      for (const blade of hill.blades) {
        const unscaledLength = Math.max(
          1,
          Math.min(
            120,
            fixture.params.bladeLength +
              (2 * blade.rolls.length - 1) *
                fixture.params.bladeLengthVariance,
          ),
        )
        const expectedScale = grassScaleAtY(blade.projected[1], projection)
        expect(blade.shape.length / unscaledLength).toBeCloseTo(
          expectedScale,
          14,
        )
        scales.push(expectedScale)
      }
    }
    expect(new Set(scales.map((scale) => scale.toFixed(6))).size).toBeGreaterThan(
      20,
    )
  })

  it('keeps every multi-hill root nested as the global count increases', () => {
    let previous = benchmarkCandidate.generate(
      payload({ bladeCount: 1, hillCount: 4 }),
      0,
    )
    let count26
    let count27

    for (let bladeCount = 2; bladeCount <= 80; bladeCount++) {
      const current = benchmarkCandidate.generate(
        payload({ bladeCount, hillCount: 4 }),
        0,
      )
      const currentKeys = new Set(
        current.blades.map((blade) => blade.identity.rootKey),
      )

      expect(current.blades).toHaveLength(bladeCount)
      for (const blade of previous.blades) {
        expect(currentKeys.has(blade.identity.rootKey)).toBe(true)
      }
      if (bladeCount === 26) count26 = current
      if (bladeCount === 27) count27 = current
      previous = current
    }

    const hillCounts = (result) =>
      ['4/5', '3/5', '2/5', '1/5'].map(
        (hillKey) =>
          result.blades.filter((blade) => blade.identity.hillKey === hillKey)
            .length,
      )
    // Largest remainder drops the nearest hill from three roots to two here.
    // Highest averages instead adds one root while retaining every member.
    expect(hillCounts(count26)).toEqual([14, 6, 4, 2])
    expect(hillCounts(count27)).toEqual([14, 7, 4, 2])
  })

  it('reprojects shared roots when hill count changes without changing identity or rolls', () => {
    const oneHill = benchmarkCandidate.generate(
      payload({ bladeCount: 12, hillCount: 1 }),
      0,
    )
    const threeHills = benchmarkCandidate.generate(
      payload({ bladeCount: 60, hillCount: 3 }),
      0,
    )
    const shared = byRootKey(threeHills.blades)
    let reprojected = 0

    for (const blade of oneHill.blades) {
      const retained = shared.get(blade.identity.rootKey)
      expect(retained).toBeDefined()
      expect(retained.identity).toEqual(blade.identity)
      expect(retained.canonical).toEqual(blade.canonical)
      expect(retained.rolls).toEqual(blade.rolls)
      expect(retained.projected[0]).toBe(blade.projected[0])
      if (retained.projected[1] !== blade.projected[1]) reprojected += 1
    }
    expect(reprojected).toBeGreaterThan(0)
  })

  it('preserves static lean direction at the sampling-time seam', () => {
    const positive = benchmarkCandidate.generate(
      payload({ bladeCount: 1, windLean: 0.75 }),
      0,
    ).blades[0]
    const negative = benchmarkCandidate.generate(
      payload({ bladeCount: 1, windLean: -0.75 }),
      0,
    ).blades[0]
    const vertical = benchmarkCandidate.generate(
      payload({ bladeCount: 1, windLean: 0 }),
      0,
    ).blades[0]

    expect(positive.rolls).toEqual(negative.rolls)
    expect(positive.rolls).toEqual(vertical.rolls)
    expect(positive.shape.length).toBe(negative.shape.length)
    const positivePoints = simplifiedBladePoints(positive, 0)
    const laterPoints = simplifiedBladePoints(positive, 1.5)
    const negativePoints = simplifiedBladePoints(negative, 0)
    const verticalPoints = simplifiedBladePoints(vertical, 0)

    expect(laterPoints).toEqual(positivePoints)
    expect(positivePoints.at(-1)[0]).toBeGreaterThan(positive.projected[0])
    expect(negativePoints.at(-1)[0]).toBeLessThan(negative.projected[0])
    expect(verticalPoints.at(-1)[0]).toBe(vertical.projected[0])
  })
})
