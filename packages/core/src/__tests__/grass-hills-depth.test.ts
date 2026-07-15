import { describe, expect, it } from 'vitest'

import {
  depthToY,
  horizonY,
  layoutHillBands,
  yToDepth,
  type HillDepthProjection,
} from '../sketches/grass-hills/depth'
import { resolveCompositionFrame } from '../compositionFrame'

const SQUARE = resolveCompositionFrame(1)

function projection(
  overrides: Partial<Omit<HillDepthProjection, 'frame'>> & {
    frame?: HillDepthProjection['frame']
  } = {},
): HillDepthProjection {
  return {
    frame: SQUARE,
    horizonHeight: 0.25,
    depthFalloff: 2,
    ...overrides,
  }
}

describe('grass-hills depth projection', () => {
  it('maps the foreground and horizon to exact frame endpoints', () => {
    const settings = projection()

    expect(depthToY(0, settings)).toBe(settings.frame.height)
    expect(depthToY(1, settings)).toBe(horizonY(settings))
    expect(yToDepth(settings.frame.height, settings)).toBe(0)
    expect(yToDepth(horizonY(settings), settings)).toBe(1)
  })

  it('round-trips representative depths through screen y', () => {
    const settings = projection({ horizonHeight: 0.37, depthFalloff: 2.75 })

    for (const depth of [0, 0.01, 0.2, 0.5, 0.83, 0.99, 1]) {
      expect(yToDepth(depthToY(depth, settings), settings)).toBeCloseTo(depth, 12)
    }
  })

  it('depends on normalized height, not frame aspect ratio', () => {
    const frames = [resolveCompositionFrame(1), resolveCompositionFrame(16 / 9)]
    const depth = 0.63

    const normalized = frames.map((frame) => {
      const settings = projection({ frame, horizonHeight: 0.31, depthFalloff: 1.8 })
      return depthToY(depth, settings) / frame.height
    })

    expect(normalized[1]).toBeCloseTo(normalized[0]!, 14)
  })
})

describe('grass-hills ridge baselines', () => {
  it('returns strictly monotonic baselines inside the horizon and bottom', () => {
    const settings = projection()
    const bands = layoutHillBands(12, settings)

    expect(bands).toHaveLength(12)
    expect(bands[0]!.baselineY).toBeGreaterThan(horizonY(settings))
    expect(bands.at(-1)!.baselineY).toBeLessThan(settings.frame.height)

    for (let index = 1; index < bands.length; index++) {
      expect(bands[index]!.depth).toBeLessThan(bands[index - 1]!.depth)
      expect(bands[index]!.baselineY).toBeGreaterThan(bands[index - 1]!.baselineY)
    }
  })

  it('recovers even horizon-to-bottom spacing when falloff is 1', () => {
    const settings = projection({ horizonHeight: 0.2, depthFalloff: 1 })
    const bands = layoutHillBands(7, settings)
    const expectedSpacing =
      (settings.frame.height - horizonY(settings)) / (bands.length + 1)

    for (const band of bands) {
      expect(band.upperClearance).toBeCloseTo(expectedSpacing, 12)
      expect(band.lowerClearance).toBeCloseTo(expectedSpacing, 12)
      expect(band.localBandHeight).toBe(band.lowerClearance)
    }
  })

  it('compresses distant spacing more as falloff rises', () => {
    const linear = layoutHillBands(8, projection({ depthFalloff: 1 }))
    const compressed = layoutHillBands(8, projection({ depthFalloff: 3 }))

    expect(compressed[0]!.upperClearance).toBeLessThan(linear[0]!.upperClearance)
    expect(compressed[0]!.upperClearance).toBeLessThan(
      compressed.at(-1)!.lowerClearance,
    )
  })

  it('keeps clearances and local band heights positive at supported extremes', () => {
    // These broad bounds cover the intended schema envelope for later blocks:
    // 1-128 hills, a top-edge-to-low horizon, and gentle-to-strong falloff.
    const hillCounts = [1, 128]
    const horizonHeights = [0, 0.9]
    const depthFalloffs = [0.25, 4]
    const frames = [resolveCompositionFrame(1 / 3), resolveCompositionFrame(3)]

    for (const frame of frames) {
      for (const hillCount of hillCounts) {
        for (const horizonHeight of horizonHeights) {
          for (const depthFalloff of depthFalloffs) {
            const settings = projection({ frame, horizonHeight, depthFalloff })
            const bands = layoutHillBands(hillCount, settings)

            expect(bands).toHaveLength(hillCount)
            for (const band of bands) {
              expect(band.upperClearance).toBeGreaterThan(0)
              expect(band.lowerClearance).toBeGreaterThan(0)
              expect(band.localBandHeight).toBe(band.lowerClearance)
              expect(band.localBandHeight).toBeGreaterThan(0)
            }
          }
        }
      }
    }
  })
})
