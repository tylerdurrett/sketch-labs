import { describe, expect, it } from 'vitest'
import { polylinesToSVG } from '../svg'
import type { Polyline } from '../types'

const letterCm = { width: 21.59, height: 27.94 }

describe('polylinesToSVG', () => {
  it('produces valid SVG with xmlns attribute', () => {
    const svg = polylinesToSVG([], letterCm)
    expect(svg).toMatch(/^<svg /)
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toMatch(/<\/svg>$/)
  })

  it('sets width and height attributes with cm units by default', () => {
    const svg = polylinesToSVG([], { width: 21.0, height: 29.7 })
    expect(svg).toContain('width="21cm"')
    expect(svg).toContain('height="29.7cm"')
  })

  it('sets viewBox matching paper dimensions in cm', () => {
    const svg = polylinesToSVG([], letterCm)
    expect(svg).toContain('viewBox="0 0 21.59 27.94"')
  })

  it('converts dimensions to inches when units is "in"', () => {
    const svg = polylinesToSVG([], { ...letterCm, units: 'in' })
    // 21.59 / 2.54 = 8.5, 27.94 / 2.54 = 11
    expect(svg).toContain('width="8.5in"')
    expect(svg).toContain('height="11in"')
  })

  it('converts dimensions to mm when units is "mm"', () => {
    const svg = polylinesToSVG([], { width: 21.0, height: 29.7, units: 'mm' })
    expect(svg).toContain('width="210mm"')
    expect(svg).toContain('height="297mm"')
  })

  it('keeps viewBox in cm regardless of output units', () => {
    const svg = polylinesToSVG([], { ...letterCm, units: 'in' })
    expect(svg).toContain('viewBox="0 0 21.59 27.94"')
  })

  it('renders correct number of polyline elements', () => {
    const lines: Polyline[] = [
      [
        [0, 0],
        [1, 1],
      ],
      [
        [2, 2],
        [3, 3],
      ],
      [
        [4, 4],
        [5, 5],
        [6, 6],
      ],
    ]
    const svg = polylinesToSVG(lines, letterCm)
    const matches = svg.match(/<polyline /g)
    expect(matches).toHaveLength(3)
  })

  it('serializes a single line as points="x1,y1 x2,y2"', () => {
    const lines: Polyline[] = [
      [
        [0, 0],
        [1, 1],
      ],
    ]
    const svg = polylinesToSVG(lines, letterCm)
    expect(svg).toContain('points="0,0 1,1"')
  })

  it('produces no polyline elements for empty input', () => {
    const svg = polylinesToSVG([], letterCm)
    expect(svg).not.toContain('<polyline')
  })

  it('skips polylines with fewer than 2 points', () => {
    const lines: Polyline[] = [
      [[5, 5]], // 1 point — skipped
      [
        [0, 0],
        [1, 1],
      ], // 2 points — kept
      [], // 0 points — skipped
    ]
    const svg = polylinesToSVG(lines, letterCm)
    const matches = svg.match(/<polyline /g)
    expect(matches).toHaveLength(1)
    expect(svg).toContain('points="0,0 1,1"')
  })

  it('applies custom stroke width and color', () => {
    const svg = polylinesToSVG([], {
      ...letterCm,
      strokeWidth: 0.05,
      strokeColor: 'red',
    })
    expect(svg).toContain('stroke="red"')
    expect(svg).toContain('stroke-width="0.05"')
  })

  it('uses default stroke attributes when not specified', () => {
    const svg = polylinesToSVG([], letterCm)
    expect(svg).toContain('stroke="black"')
    expect(svg).toContain('stroke-width="0.03"')
    expect(svg).toContain('stroke-linecap="round"')
    expect(svg).toContain('stroke-linejoin="round"')
    expect(svg).toContain('fill="none"')
  })

  it('rounds point coordinates to 4 decimal places', () => {
    const lines: Polyline[] = [
      [
        [1.23456789, 2.98765432],
        [3.00001, 4.99999],
      ],
    ]
    const svg = polylinesToSVG(lines, letterCm)
    expect(svg).toContain('points="1.2346,2.9877 3,5"')
  })

  it('converts stroke width to target units', () => {
    const svg = polylinesToSVG([], {
      ...letterCm,
      units: 'mm',
      strokeWidth: 0.03,
    })
    // 0.03 cm * 10 = 0.3 mm
    expect(svg).toContain('stroke-width="0.3"')
  })

  it('escapes special characters in stroke color', () => {
    const svg = polylinesToSVG([], {
      ...letterCm,
      strokeColor: 'url("foo&bar")',
    })
    expect(svg).toContain('stroke="url(&quot;foo&amp;bar&quot;)"')
  })
})
