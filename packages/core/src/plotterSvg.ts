/**
 * Physical, path-only SVG serialization for plot output.
 *
 * Unlike the ordinary Scene SVG renderer, this serializer describes the whole
 * physical sheet in millimeters and emits only stroked Scene geometry. The
 * uniform Composition Frame → drawable-paper transform is baked into every
 * coordinate and stroke width so plotter consumers need no SVG transform or
 * styling wrapper. Paper edges, margins, Scene backgrounds, and fills are not
 * plot geometry and are deliberately absent.
 *
 * Clipping and hidden-line removal are caller-owned preprocessing steps. This
 * module preserves the supplied Scene's geometry and order exactly; it neither
 * clips nor otherwise rewrites the source data.
 */

import { computePlotMapping } from './plotMapping'
import type { PlotProfile } from './plotProfile'
import type { Scene } from './scene'
import { escapeAttr, escapeText, round } from './svgHelpers'

/**
 * Serialize a Scene as a physically sized, path-only plotter SVG.
 *
 * The root dimensions and coordinate system describe the Plot Profile's full
 * paper in millimeters. Only stroke-bearing primitives with at least one line
 * segment are emitted. Their Scene-space coordinates and stroke widths are
 * uniformly scaled into the profile's drawable rectangle; open/closed semantics,
 * stroke colors, and array order are retained. Optional reproduction metadata
 * uses the same XML text escaping contract as {@link renderToSVG}.
 *
 * Input validation and aspect matching are delegated to
 * {@link computePlotMapping}. Neither input is mutated.
 */
export function renderPlotterSVG(
  scene: Scene,
  profile: PlotProfile,
  metadata?: string,
): string {
  const { scale, offsetX, offsetY } = computePlotMapping(scene.space, profile)

  const paths = scene.primitives.flatMap((primitive) => {
    const { points, closed, stroke } = primitive
    if (stroke === undefined || points.length < 2) return []

    const d =
      points
        .map(([x, y], index) => {
          const mappedX = offsetX + x * scale
          const mappedY = offsetY + y * scale
          return `${index === 0 ? 'M' : 'L'}${round(mappedX)} ${round(mappedY)}`
        })
        .join(' ') + (closed ? ' Z' : '')

    return [
      `  <path d="${d}" fill="none" stroke="${escapeAttr(stroke.color)}" stroke-width="${round(stroke.width * scale)}" />`,
    ]
  })

  const metadataElement =
    metadata === undefined
      ? undefined
      : `  <metadata>${escapeText(metadata)}</metadata>`

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${profile.width}mm" height="${profile.height}mm" viewBox="0 0 ${profile.width} ${profile.height}">`,
    metadataElement,
    ...paths,
    '</svg>',
  ]
    .filter((line) => line !== undefined)
    .join('\n')
}
