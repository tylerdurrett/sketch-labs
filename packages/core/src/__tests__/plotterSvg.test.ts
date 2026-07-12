import { describe, expect, it } from 'vitest'
import type { PlotProfile } from '../plotProfile'
import { renderPlotterSVG } from '../plotterSvg'
import type { Scene } from '../scene'

const profile: PlotProfile = {
  width: 240,
  height: 160,
  insets: { top: 20, right: 30, bottom: 40, left: 10 },
  includeFrame: false,
}

const scene: Scene = {
  space: { width: 400, height: 200 },
  primitives: [
    {
      points: [
        [0, 0],
        [400, 200],
      ],
      stroke: { color: 'black', width: 2 },
    },
  ],
}

const paths = (svg: string): string[] => svg.match(/<path\b[^>]*>/g) ?? []

describe('renderPlotterSVG', () => {
  it('declares the exact non-square paper size in millimeters and as its viewBox', () => {
    const svg = renderPlotterSVG(scene, profile)

    expect(svg).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="240mm" height="160mm" viewBox="0 0 240 160">/,
    )
  })

  it('bakes asymmetric drawable placement into path coordinates', () => {
    // Drawable is 200 × 100 mm at (10, 20), so the Scene maps at 0.5 mm/unit.
    expect(renderPlotterSVG(scene, profile)).toContain(
      'd="M10 20 L210 120"',
    )
  })

  it('bakes ULP-tolerant centering into the serialized coordinates', () => {
    const buffer = new ArrayBuffer(8)
    const view = new DataView(buffer)
    view.setFloat64(0, 2 / 3)
    view.setBigUint64(0, view.getBigUint64(0) + 1n)
    const drawableWidth = view.getFloat64(0)
    const noisyProfile: PlotProfile = {
      width: drawableWidth + 0.2,
      height: 1.4,
      insets: { top: 0.2, right: 0.1, bottom: 0.2, left: 0.1 },
      includeFrame: false,
    }
    const noisyScene: Scene = {
      space: { width: 2 / 3, height: 1 },
      primitives: [
        {
          points: [
            [0, 0],
            [2 / 3, 1],
          ],
          stroke: { color: 'black', width: 0.01 },
        },
      ],
    }

    const svg = renderPlotterSVG(noisyScene, noisyProfile)
    expect(svg).toContain('d="M0.1 0.2 L0.7667 1.2"')
  })

  it('scales geometry and Scene stroke widths by the same uniform factor', () => {
    const [path] = paths(renderPlotterSVG(scene, profile))

    expect(path).toContain('d="M10 20 L210 120"')
    expect(path).toContain('stroke-width="1"')
  })

  it('leaves clipping to the caller', () => {
    const unclipped: Scene = {
      space: scene.space,
      primitives: [
        {
          points: [
            [-20, 100],
            [420, 100],
          ],
          stroke: { color: 'black', width: 1 },
        },
      ],
    }

    // The mapped drawable bounds are x=10..210. Both outside endpoints remain.
    expect(renderPlotterSVG(unclipped, profile)).toContain(
      'd="M0 70 L220 70"',
    )
  })

  it('preserves open paths without adding a return segment', () => {
    const svg = renderPlotterSVG(scene, profile)

    expect(svg).toContain('d="M10 20 L210 120"')
    expect(svg).not.toMatch(/\bZ\b/)
  })

  it('closes contours with an explicit line to the mapped first point', () => {
    const closed: Scene = {
      space: scene.space,
      primitives: [
        {
          points: [
            [0, 0],
            [400, 0],
            [400, 200],
          ],
          closed: true,
          stroke: { color: 'black', width: 1 },
        },
      ],
    }

    const svg = renderPlotterSVG(closed, profile)
    expect(svg).toContain('d="M10 20 L210 20 L210 120 L10 20"')
    expect(svg).not.toMatch(/\bZ\b/)
  })

  it('does not duplicate an existing explicit return to the first point', () => {
    const alreadyClosed: Scene = {
      space: scene.space,
      primitives: [
        {
          points: [
            [0, 0],
            [400, 0],
            [0, 0],
          ],
          closed: true,
          stroke: { color: 'black', width: 1 },
        },
      ],
    }

    const [path] = paths(renderPlotterSVG(alreadyClosed, profile))
    expect(path).toContain('d="M10 20 L210 20 L10 20"')
    expect(path?.match(/L10 20/g)).toHaveLength(1)
    expect(path).not.toMatch(/\bZ\b/)
  })

  it('preserves stroke color and primitive order', () => {
    const ordered: Scene = {
      space: scene.space,
      primitives: [
        {
          points: [
            [0, 0],
            [1, 1],
          ],
          stroke: { color: 'first&color', width: 1 },
        },
        {
          points: [
            [2, 2],
            [3, 3],
          ],
          closed: true,
          stroke: { color: 'second', width: 1 },
        },
      ],
    }

    const [first, second] = paths(renderPlotterSVG(ordered, profile))
    expect(first).toContain('stroke="first&amp;color"')
    expect(second).toContain('stroke="second"')
    expect(second).toContain('d="M11 21 L11.5 21.5 L11 21"')
  })

  it('emits only drawable, stroke-bearing paths with fill="none"', () => {
    const filtered: Scene = {
      space: scene.space,
      background: { color: 'paper-preview' },
      primitives: [
        {
          points: [
            [0, 0],
            [10, 10],
          ],
          fill: { color: 'fill-only' },
        },
        {
          points: [[20, 20]],
          stroke: { color: 'point-only', width: 1 },
        },
        {
          points: [
            [30, 30],
            [40, 40],
          ],
          fill: { color: 'ignored-fill' },
          stroke: { color: 'kept-stroke', width: 1 },
        },
      ],
    }

    const svg = renderPlotterSVG(filtered, profile)
    expect(paths(svg)).toHaveLength(1)
    expect(paths(svg)[0]).toContain('fill="none"')
    expect(svg).toContain('kept-stroke')
    expect(svg).not.toMatch(/paper-preview|fill-only|point-only|ignored-fill/)
    expect(svg).not.toMatch(/<(?:rect|polygon|polyline|line|g|clipPath)\b/)
    expect(svg).not.toMatch(/\bZ\b/)
  })

  it('embeds escaped reproduction metadata before paths and round-trips its profile', () => {
    const envelope = {
      version: 1,
      outputProfile: profile,
      note: 'x < y & y > z',
    }
    const svg = renderPlotterSVG(scene, profile, JSON.stringify(envelope))
    const metadata = svg.match(/<metadata>([\s\S]*?)<\/metadata>/)?.[1]

    expect(svg.indexOf('<metadata>')).toBeLessThan(svg.indexOf('<path'))
    expect(metadata).not.toMatch(/[<>]/)
    const unescaped = metadata!
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&')
    expect(JSON.parse(unescaped)).toEqual(envelope)
  })

  it('omits metadata cleanly when none is supplied', () => {
    const svg = renderPlotterSVG({ ...scene, primitives: [] }, profile)
    expect(svg).not.toContain('<metadata>')
    expect(svg).not.toContain('\n\n')
  })

  it('rejects invalid profiles, invalid Scene spaces, and material aspect mismatches', () => {
    const invalidProfile: PlotProfile = {
      ...profile,
      insets: { ...profile.insets, left: -1 },
    }
    expect(() => renderPlotterSVG(scene, invalidProfile)).toThrow(
      'validatePlotProfile',
    )
    expect(() =>
      renderPlotterSVG({ ...scene, space: { width: 0, height: 200 } }, profile),
    ).toThrow(/space width must be a finite positive number/)
    expect(() =>
      renderPlotterSVG({ ...scene, space: { width: 200, height: 200 } }, profile),
    ).toThrow(/does not match drawable aspect/)
  })

  it('is deterministic and does not mutate the Scene or Plot Profile', () => {
    const mutableScene = structuredClone(scene)
    const mutableProfile = structuredClone(profile)
    const originalScene = structuredClone(mutableScene)
    const originalProfile = structuredClone(mutableProfile)

    const first = renderPlotterSVG(mutableScene, mutableProfile, '{}')
    const second = renderPlotterSVG(mutableScene, mutableProfile, '{}')

    expect(first).toBe(second)
    expect(mutableScene).toEqual(originalScene)
    expect(mutableProfile).toEqual(originalProfile)
  })
})
