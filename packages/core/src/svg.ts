import type { LengthUnit, Polyline } from './types'

/** Options for serializing polylines to SVG */
export interface SVGOptions {
  /** Paper width in cm */
  width: number
  /** Paper height in cm */
  height: number
  /** Output length unit for SVG width/height attributes (default: cm) */
  units?: LengthUnit
  /** Stroke width in cm (default: 0.03) */
  strokeWidth?: number
  /** Stroke color (default: black) */
  strokeColor?: string
}

/** Conversion factors from cm to other units */
const CM_TO: Record<LengthUnit, number> = {
  cm: 1,
  in: 1 / 2.54,
  mm: 10,
}

/** Round a number to 4 decimal places to keep SVG output compact */
function round(n: number): number {
  return Math.round(n * 10000) / 10000
}

/** Escape XML special characters in attribute values */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * Serialize polylines to a physically accurate SVG string.
 *
 * `width` and `height` in options are paper dimensions in **cm**.
 * The SVG `width`/`height` attributes are converted to the target `units`.
 * The `viewBox` always stays in cm so polyline coordinates map 1:1.
 */
export function polylinesToSVG(lines: Polyline[], options: SVGOptions): string {
  const units = options.units ?? 'cm'
  const strokeWidth = options.strokeWidth ?? 0.03
  const strokeColor = options.strokeColor ?? 'black'
  const { width, height } = options

  const factor = CM_TO[units]
  const svgWidth = round(width * factor)
  const svgHeight = round(height * factor)

  const polylineEls = lines
    .filter((line) => line.length >= 2)
    .map((line) => {
      const pts = line.map(([x, y]) => `${round(x)},${round(y)}`).join(' ')
      return `  <polyline points="${pts}" />`
    })
    .join('\n')

  // Convert stroke width to target units for consistent physical rendering
  const svgStrokeWidth = round(strokeWidth * factor)

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}${units}" height="${svgHeight}${units}" viewBox="0 0 ${width} ${height}">`,
    `<g fill="none" stroke="${escapeAttr(strokeColor)}" stroke-width="${svgStrokeWidth}" stroke-linecap="round" stroke-linejoin="round">`,
    polylineEls,
    '</g>',
    '</svg>',
  ].join('\n')
}
