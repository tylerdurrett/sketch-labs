import { describe, expect, it } from 'vitest'
import { renderToSVG } from '../renderer'
import type { Scene } from '../scene'

/**
 * These assert at the SVG-STRUCTURE level — string/regex on the emitted markup,
 * never pixels. They cover the contract of {@link renderToSVG}: per-Primitive
 * fill and stroke, `fill="none"` when no fill, closed-vs-open `Z`, painter's
 * (document) order, the Scene-space viewBox, and the `< 1`-point guard. Pixel
 * fidelity is not this renderer's concern; faithful serialization is.
 */

const space = { width: 100, height: 100 }

/** All `<path>` lines from the emitted SVG, in document order. */
const paths = (svg: string): string[] => svg.match(/<path\b[^>]*>/g) ?? []

describe('renderToSVG', () => {
  it('emits a per-Primitive fill color when the Primitive has a fill', () => {
    const scene: Scene = {
      space,
      primitives: [
        {
          points: [
            [0, 0],
            [10, 0],
            [10, 10],
          ],
          closed: true,
          fill: { color: '#ff0044' },
        },
      ],
    }

    const svg = renderToSVG(scene)

    expect(svg).toMatch(/<path\b[^>]*\bfill="#ff0044"/)
  })

  it('emits a per-Primitive stroke color and stroke-width when stroked', () => {
    const scene: Scene = {
      space,
      primitives: [
        {
          points: [
            [0, 0],
            [10, 10],
          ],
          stroke: { color: 'blue', width: 2.5 },
        },
      ],
    }

    const svg = renderToSVG(scene)

    expect(svg).toMatch(/<path\b[^>]*\bstroke="blue"/)
    expect(svg).toMatch(/<path\b[^>]*\bstroke-width="2.5"/)
  })

  it('writes stroke-width in unscaled Scene-space units', () => {
    const scene: Scene = {
      space,
      primitives: [
        {
          points: [
            [0, 0],
            [10, 0],
          ],
          stroke: { color: 'black', width: 0.5 },
        },
      ],
    }

    expect(renderToSVG(scene)).toMatch(/stroke-width="0.5"/)
  })

  it('emits fill="none" when the Primitive has no fill', () => {
    const scene: Scene = {
      space,
      primitives: [
        {
          points: [
            [0, 0],
            [10, 10],
          ],
          stroke: { color: 'black', width: 1 },
        },
      ],
    }

    const svg = renderToSVG(scene)

    expect(svg).toMatch(/<path\b[^>]*\bfill="none"/)
  })

  it('emits no stroke attributes when the Primitive has no stroke', () => {
    const scene: Scene = {
      space,
      primitives: [
        {
          points: [
            [0, 0],
            [10, 0],
            [10, 10],
          ],
          closed: true,
          fill: { color: 'red' },
        },
      ],
    }

    const svg = renderToSVG(scene)

    expect(svg).not.toMatch(/stroke=/)
    expect(svg).not.toMatch(/stroke-width=/)
  })

  it('emits both fill and stroke for a filled-and-stroked Primitive', () => {
    const scene: Scene = {
      space,
      primitives: [
        {
          points: [
            [0, 0],
            [10, 0],
            [10, 10],
          ],
          closed: true,
          fill: { color: 'green' },
          stroke: { color: 'black', width: 3 },
        },
      ],
    }

    const svg = renderToSVG(scene)
    const [path] = paths(svg)

    expect(path).toMatch(/\bfill="green"/)
    expect(path).toMatch(/\bstroke="black"/)
    expect(path).toMatch(/\bstroke-width="3"/)
  })

  it('builds the path with M for the first point and L for the rest', () => {
    const scene: Scene = {
      space,
      primitives: [
        {
          points: [
            [0, 0],
            [10, 0],
            [10, 10],
          ],
          stroke: { color: 'black', width: 1 },
        },
      ],
    }

    const svg = renderToSVG(scene)

    expect(svg).toMatch(/d="M0 0 L10 0 L10 10"/)
  })

  it('ends a closed Primitive path with Z', () => {
    const scene: Scene = {
      space,
      primitives: [
        {
          points: [
            [0, 0],
            [10, 0],
          ],
          closed: true,
          stroke: { color: 'black', width: 1 },
        },
      ],
    }

    const [path] = paths(renderToSVG(scene))

    expect(path).toMatch(/d="[^"]*Z"/)
  })

  it('does not append Z to an open Primitive path', () => {
    const scene: Scene = {
      space,
      primitives: [
        {
          points: [
            [0, 0],
            [10, 0],
          ],
          stroke: { color: 'black', width: 1 },
        },
      ],
    }

    const [path] = paths(renderToSVG(scene))

    expect(path).not.toMatch(/Z/)
  })

  it('serializes Primitives in array order (painter’s / document order)', () => {
    const scene: Scene = {
      space,
      primitives: [
        { points: [[0, 0]], stroke: { color: 'first', width: 1 } },
        { points: [[1, 1]], stroke: { color: 'second', width: 1 } },
        { points: [[2, 2]], stroke: { color: 'third', width: 1 } },
      ],
    }

    const strokeColors = paths(renderToSVG(scene)).map(
      (path) => path.match(/stroke="([^"]*)"/)?.[1],
    )

    expect(strokeColors).toEqual(['first', 'second', 'third'])
  })

  it('sets viewBox to the Scene coordinate-space dimensions', () => {
    const scene: Scene = {
      space: { width: 640, height: 480 },
      primitives: [],
    }

    expect(renderToSVG(scene)).toMatch(/viewBox="0 0 640 480"/)
  })

  it('carries the SVG xmlns on the root element', () => {
    const svg = renderToSVG({ space, primitives: [] })

    expect(svg).toMatch(/<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  })

  it('contributes no <path> for a Primitive with fewer than one point', () => {
    const scene: Scene = {
      space,
      primitives: [
        { points: [], fill: { color: 'red' } },
        { points: [[5, 5]], stroke: { color: 'black', width: 1 } },
      ],
    }

    // Only the one-point Primitive yields a path; the empty one is dropped.
    expect(paths(renderToSVG(scene))).toHaveLength(1)
  })

  describe('embedded <metadata> (issue #76)', () => {
    /** The text inside the first <metadata>…</metadata> element, if present. */
    const metaText = (svg: string): string | undefined =>
      svg.match(/<metadata>([\s\S]*?)<\/metadata>/)?.[1]

    it('emits no <metadata> element when no metadata is supplied', () => {
      expect(renderToSVG({ space, primitives: [] })).not.toMatch(/<metadata>/)
    })

    it('embeds the metadata string as a <metadata> element', () => {
      const json = '{"version":1,"sketch":"circles","t":2.5}'
      const svg = renderToSVG({ space, primitives: [] }, json)

      expect(metaText(svg)).toBe(json)
    })

    it('round-trips a JSON reproduction envelope through the <metadata> element', () => {
      const envelope = {
        version: 1,
        sketch: 'waves',
        name: 'waves-seed7-t1.5',
        seed: 7,
        params: { radius: 10 },
        locks: ['radius'],
        t: 1.5,
      }
      const svg = renderToSVG(
        { space, primitives: [] },
        JSON.stringify(envelope),
      )

      const text = metaText(svg)!
      // Un-escape the XML text entities, then parse — equals the original.
      const unescaped = text
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&')
      expect(JSON.parse(unescaped)).toEqual(envelope)
    })

    it('XML-escapes &, <, and > in the metadata text content', () => {
      const svg = renderToSVG(
        { space, primitives: [] },
        '{"a":"x < y & z > 1"}',
      )
      const text = metaText(svg)!
      expect(text).toContain('&lt;')
      expect(text).toContain('&amp;')
      expect(text).toContain('&gt;')
      // No raw, unescaped angle brackets leaked into the element text.
      expect(text).not.toMatch(/[<>]/)
    })

    it('places <metadata> before the <path> elements', () => {
      const scene: Scene = {
        space,
        primitives: [
          { points: [[0, 0]], stroke: { color: 'black', width: 1 } },
        ],
      }
      const svg = renderToSVG(scene, '{}')
      expect(svg.indexOf('<metadata>')).toBeLessThan(svg.indexOf('<path'))
    })
  })
})
