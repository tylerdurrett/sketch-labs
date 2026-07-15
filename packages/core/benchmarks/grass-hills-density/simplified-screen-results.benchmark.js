import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const report = JSON.parse(
  readFileSync(
    new URL('./results/simplified-screen-2026-07-15.json', import.meta.url),
    'utf8',
  ),
)

describe('simplified Grass Hills screen result', () => {
  it('pins the complete screen policy and its single finalist', () => {
    expect(report.recordedAt).toBe('2026-07-15')
    expect(report.campaign).toMatchObject({
      mode: 'screen',
      policy: {
        timeoutMs: 90_000,
        memoryMiB: 1024,
        samples: { preparation: 3, cold: 3, warm: 12, warmups: 1 },
      },
      resultCount: 8,
      okCount: 8,
      censoredCount: 0,
    })
    expect(report.results).toHaveLength(8)
    expect(report.results.every((result) => result.status === 'ok')).toBe(true)
    expect(report.browser).toMatchObject({
      harness: 'core drawSceneFitted',
      canvas: { width: 1000, height: 1000 },
      redrawsPerScene: 12,
      observationCount: 16,
    })
    expect(report.finalist).toMatchObject({
      representation: 'open six-point blades/stable five-member tufts',
      occluderMode: 'hill-and-clump',
      densityMode: 'plotter-lod',
      selectedCount: 1,
    })
  })

  it('keeps source identity and browser checksum evidence aligned', () => {
    const byFixture = new Map()
    for (const result of report.results) {
      const fixture = result.fixtureId.startsWith('historical-baseline-400')
        ? 'baseline'
        : 'one-hill-5000'
      byFixture.set(fixture, [...(byFixture.get(fixture) ?? []), result])
    }

    for (const variants of byFixture.values()) {
      expect(new Set(variants.map((result) => result.source.checksum)).size).toBe(1)
    }
    for (const result of report.results) {
      expect(result.browser.source.checksum).toBe(result.source.checksum)
      expect(result.browser.processed.checksum).toBe(result.processing.checksum)
      for (const observation of Object.values(result.browser)) {
        expect(observation.loadMs).toBeGreaterThanOrEqual(0)
        expect(observation.firstDrawMs).toBeGreaterThanOrEqual(0)
        expect(observation.redrawMedianMs).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('records the physical-spacing effect and selected 5k artifact', () => {
    const sameDensity = report.results.filter(
      (result) => result.variant.densityMode === 'same-density',
    )
    const plotterLod = report.results.filter(
      (result) => result.variant.densityMode === 'plotter-lod',
    )
    expect(
      sameDensity.every(
        (result) => result.physicalSpacing.rootMinimumMillimeters < 0.3,
      ),
    ).toBe(true)
    expect(
      plotterLod.every(
        (result) => result.physicalSpacing.rootMinimumMillimeters >= 0.3,
      ),
    ).toBe(true)

    const finalist = report.results.find(
      (result) =>
        result.fixtureId.startsWith('one-hill-5000') &&
        result.variant.occluderMode === report.finalist.occluderMode &&
        result.variant.densityMode === report.finalist.densityMode,
    )
    expect(finalist).toMatchObject({
      representation: { bladeCount: 5000, tuftCount: 1000 },
      processing: {
        primitiveCount: 2950,
        pointCount: 14548,
        checksum:
          '5a1fb74ae8d486af03d8878fb07f75011e706cc26272e547cc69993c5194cf97',
      },
    })
  })
})
