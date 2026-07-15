import { describe, expect, it } from 'vitest'

import { clipSceneToBounds } from '../clipToBounds'
import { resolveCompositionFrame } from '../compositionFrame'
import { hiddenLinePass } from '../hiddenLine'
import { renderToSVG } from '../renderer'
import type { Scene } from '../scene'
import {
  horizonY,
  layoutHillBands,
  type HillDepthProjection,
} from '../sketches/grass-hills/depth'
import {
  buildRidgeBands,
  ridgeBandAmplitude,
} from '../sketches/grass-hills/ridge-bands'
import { createTerrainField } from '../sketches/grass-hills/terrain'

const FRAME = resolveCompositionFrame(1)
const RIDGE_SAMPLES = 24

function projection(
  overrides: Partial<Omit<HillDepthProjection, 'frame'>> & {
    frame?: HillDepthProjection['frame']
  } = {},
): HillDepthProjection {
  return {
    frame: FRAME,
    horizonHeight: 0.25,
    depthFalloff: 2,
    ...overrides,
  }
}

function geometry(
  settings = projection(),
  hillCount = 8,
  ridgeAmplitude = 0.8,
) {
  const bands = layoutHillBands(hillCount, settings)
  return {
    bands,
    polygons: buildRidgeBands({
      frame: settings.frame,
      bands,
      terrainAt: createTerrainField('ridge-bands', {
        ridgeScale: 3.5,
        terrainDrift: 1.25,
      }),
      ridgeAmplitude,
      ridgeSamples: RIDGE_SAMPLES,
    }),
  }
}

function ridgeline(
  polygon: ReturnType<typeof buildRidgeBands>[number],
): (typeof polygon.points) {
  return polygon.points.slice(0, RIDGE_SAMPLES + 3)
}

describe('grass-hills ridge-band geometry', () => {
  it('is byte-exact for identical inputs and emits far-to-near closed primitives', () => {
    const settings = projection()
    const a = geometry(settings)
    const b = geometry(settings)

    expect(a).toEqual(b)
    expect(a.polygons).toHaveLength(a.bands.length)
    for (const polygon of a.polygons) {
      expect(polygon).toEqual({
        points: expect.any(Array),
        closed: false,
      })
    }
  })

  it('compresses nominal ridge relief with distance under the default projection', () => {
    const { bands } = geometry()
    const amplitudes = bands.map((band) => ridgeBandAmplitude(band, 0.8))

    expect(amplitudes[0]).toBeLessThan(amplitudes.at(-1)!)
    for (let index = 1; index < amplitudes.length; index++) {
      expect(amplitudes[index]).toBeGreaterThan(amplitudes[index - 1]!)
    }
  })

  it('collapses every ridgeline to its baseline at zero amplitude', () => {
    const { bands, polygons } = geometry(projection(), 8, 0)

    polygons.forEach((polygon, index) => {
      for (const [, y] of ridgeline(polygon)) {
        expect(y).toBe(bands[index]!.baselineY)
      }
    })
  })

  it('stays finite and inside the sky and bottom boundaries at supported extremes', () => {
    const hillCounts = [1, 64]
    const horizonHeights = [0, 0.9]
    const depthFalloffs = [0.25, 4]
    const frames = [resolveCompositionFrame(1 / 3), resolveCompositionFrame(3)]

    for (const frame of frames) {
      for (const hillCount of hillCounts) {
        for (const horizonHeight of horizonHeights) {
          for (const depthFalloff of depthFalloffs) {
            const settings = projection({ frame, horizonHeight, depthFalloff })
            const { polygons } = geometry(settings, hillCount, 1)

            for (const polygon of polygons) {
              for (const [x, y] of ridgeline(polygon)) {
                expect(Number.isFinite(x)).toBe(true)
                expect(Number.isFinite(y)).toBe(true)
                expect(y).toBeGreaterThan(horizonY(settings))
                expect(y).toBeLessThan(frame.height)
              }
            }
          }
        }
      }
    }
  })

  it('keeps adjacent ridges strictly ordered under alternating worst-case relief', () => {
    const settings = projection({ horizonHeight: 0.1, depthFalloff: 3 })
    const bands = layoutHillBands(16, settings)
    const depthIndex = new Map(bands.map((band, index) => [band.depth, index]))
    const polygons = buildRidgeBands({
      frame: settings.frame,
      bands,
      terrainAt: (_x, depth) => (depthIndex.get(depth)! % 2 === 0 ? -1 : 1),
      ridgeAmplitude: 1,
      ridgeSamples: RIDGE_SAMPLES,
    })

    for (let bandIndex = 1; bandIndex < polygons.length; bandIndex++) {
      const far = ridgeline(polygons[bandIndex - 1]!)
      const near = ridgeline(polygons[bandIndex]!)
      for (let sample = 0; sample < far.length; sample++) {
        expect(far[sample]![1]).toBeLessThan(near[sample]![1])
      }
    }
  })

  it('clamps out-of-range terrain before applying symmetric safe relief', () => {
    const settings = projection()
    const bands = layoutHillBands(1, settings)
    const high = buildRidgeBands({
      frame: settings.frame,
      bands,
      terrainAt: () => 100,
      ridgeAmplitude: 1,
      ridgeSamples: RIDGE_SAMPLES,
    })
    const low = buildRidgeBands({
      frame: settings.frame,
      bands,
      terrainAt: () => -100,
      ridgeAmplitude: 1,
      ridgeSamples: RIDGE_SAMPLES,
    })
    const amplitude = ridgeBandAmplitude(bands[0]!, 1)

    expect(ridgeline(high[0]!)[0]![1]).toBe(bands[0]!.baselineY - amplitude)
    expect(ridgeline(low[0]!)[0]![1]).toBe(bands[0]!.baselineY + amplitude)
  })

  it('puts sampled endpoints, vertical sides, and the bottom closure off-frame', () => {
    const { polygons } = geometry()

    for (const polygon of polygons) {
      const ridge = ridgeline(polygon)
      const first = ridge[0]!
      const last = ridge.at(-1)!
      const rightBottom = polygon.points.at(-3)!
      const leftBottom = polygon.points.at(-2)!
      const closingPoint = polygon.points.at(-1)!

      expect(first[0]).toBeLessThan(0)
      expect(last[0]).toBeGreaterThan(FRAME.width)
      expect(rightBottom[0]).toBe(last[0])
      expect(leftBottom[0]).toBe(first[0])
      expect(rightBottom[1]).toBeGreaterThan(FRAME.height)
      expect(leftBottom[1]).toBe(rightBottom[1])
      expect(closingPoint).toEqual(first)
    }
  })

  it('keeps source fill closed while clipped SVG strokes only the ridgeline', () => {
    const settings = projection()
    const [geometry] = buildRidgeBands({
      frame: settings.frame,
      bands: layoutHillBands(1, settings),
      terrainAt: (x) => Math.sin(x * Math.PI * 2),
      ridgeAmplitude: 0.8,
      ridgeSamples: RIDGE_SAMPLES,
    })
    const styled = {
      ...geometry!,
      fill: { color: '#55aa33' },
      stroke: { color: '#112211', width: 2 },
    }
    const source: Scene = { space: settings.frame, primitives: [styled] }

    // An explicitly repeated ring closes the source polygon for fill without
    // setting Primitive.closed, so fill preview stays complete while later
    // polyline clipping cannot synthesize a visible stroke chord.
    expect(styled.points.at(-1)).toEqual(styled.points[0])
    expect(styled.closed).toBe(false)
    const [sourcePath] = renderToSVG(
      source,
      undefined,
      'transparent',
    ).match(/<path\b[^>]*>/g)!
    expect(sourcePath).toContain('fill="#55aa33"')
    expect(sourcePath).not.toMatch(/ Z(?=")/)

    const clipped = clipSceneToBounds(source)
    expect(clipped.primitives).toHaveLength(1)
    const [clippedRidge] = clipped.primitives
    expect(clippedRidge!.closed).toBe(false)
    expect(clippedRidge!.points[0]![0]).toBe(0)
    expect(clippedRidge!.points.at(-1)![0]).toBe(settings.frame.width)
    expect(clippedRidge!.points.every(([, y]) => y < settings.frame.height)).toBe(
      true,
    )

    const [clippedPath] = renderToSVG(
      clipped,
      undefined,
      'transparent',
    ).match(/<path\b[^>]*>/g)!
    expect(clippedPath).not.toMatch(/ Z(?=")/)

    // The Outline path uses the same explicit source ring as its fill boundary,
    // then reaches the renderer as one fill-free open ridgeline as intended.
    const outline = clipSceneToBounds(hiddenLinePass(source))
    expect(outline.primitives).toHaveLength(1)
    expect(outline.primitives[0]!.fill).toBeUndefined()
    expect(outline.primitives[0]!.closed).toBeUndefined()
    expect(renderToSVG(outline, undefined, 'transparent')).not.toMatch(
      /<path\b[^>]*d="[^"]* Z"/,
    )
  })
})
