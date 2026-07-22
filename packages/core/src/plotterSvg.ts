/**
 * Physical, path-only SVG serialization for plot output.
 *
 * Unlike the ordinary Scene SVG renderer, this serializer describes the whole
 * physical sheet in millimeters and emits only round-capped stroked Scene
 * geometry. The uniform Composition Frame → drawable-paper transform is baked
 * into every coordinate and stroke width so plotter consumers need no SVG
 * transform or styling wrapper. Paper edges, margins, Scene backgrounds, and
 * fills are not plot geometry and are deliberately absent.
 *
 * Closed primitives return to their mapped first point with an explicit line
 * segment. Plotter output never relies on SVG's `Z` close-path command.
 *
 * Clipping and hidden-line removal are caller-owned preprocessing steps. This
 * module preserves the supplied Scene's geometry and order exactly; it neither
 * clips nor otherwise rewrites the source data.
 */

import { computePlotMapping } from './plotMapping'
import { plotDrawableRectangle, type PlotProfile } from './plotProfile'
import type { Scene } from './scene'
import { escapeAttr, escapeText, round } from './svgHelpers'

export interface PlotterSVGOptions {
  /** Whether the SVG root describes the full paper instead of its drawable area. */
  includePaperMargins?: boolean
}

function normalizeExtentDimension(dimension: number): number {
  const rounded = round(dimension)
  return rounded > 0 ? rounded : dimension
}

/**
 * Serialize a Scene as a physically sized, path-only plotter SVG.
 *
 * By default, the root dimensions and coordinate system describe the Plot
 * Profile's full paper in millimeters. When paper margins are excluded, they
 * instead describe the drawable rectangle and mapped coordinates are rebased to
 * its origin. Only stroke-bearing primitives with at least one line segment are
 * emitted. Their Scene-space coordinates and stroke widths are uniformly scaled
 * into the profile's drawable rectangle; open/closed semantics, stroke colors,
 * and array order are retained. Optional reproduction metadata uses the same XML
 * text escaping contract as {@link renderToSVG}.
 *
 * Input validation and aspect matching are delegated to
 * {@link computePlotMapping}. Neither input is mutated.
 */
export function renderPlotterSVG(
  scene: Scene,
  profile: PlotProfile,
  metadata?: string,
  options?: PlotterSVGOptions,
): string {
  const { scale, offsetX, offsetY } = computePlotMapping(scene.space, profile)
  const includePaperMargins = options?.includePaperMargins !== false
  let extent = { width: profile.width, height: profile.height }
  if (!includePaperMargins) {
    const drawable = plotDrawableRectangle(profile)
    extent = {
      width: normalizeExtentDimension(drawable.width),
      height: normalizeExtentDimension(drawable.height),
    }
  }
  const originX = includePaperMargins ? 0 : profile.insets.left
  const originY = includePaperMargins ? 0 : profile.insets.top

  const paths = scene.primitives.flatMap((primitive) => {
    const { points, closed, stroke } = primitive
    if (stroke === undefined || points.length < 2) return []

    const mappedPoints: [number, number][] = points.map(([x, y]) => [
      round(offsetX + x * scale - originX),
      round(offsetY + y * scale - originY),
    ])
    const firstPoint = mappedPoints[0]!
    const lastPoint = mappedPoints.at(-1)!
    const pathPoints =
      closed &&
      (lastPoint[0] !== firstPoint[0] || lastPoint[1] !== firstPoint[1])
        ? [...mappedPoints, firstPoint]
        : mappedPoints
    const d = pathPoints
      .map(
        ([x, y], index) => `${index === 0 ? 'M' : 'L'}${x} ${y}`,
      )
      .join(' ')

    return [
      `  <path d="${d}" fill="none" stroke="${escapeAttr(stroke.color)}" stroke-width="${round(stroke.width * scale)}" stroke-linecap="round" />`,
    ]
  })

  const metadataElement =
    metadata === undefined
      ? undefined
      : `  <metadata>${escapeText(metadata)}</metadata>`

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${extent.width}mm" height="${extent.height}mm" viewBox="0 0 ${extent.width} ${extent.height}" data-paper-extent="${includePaperMargins ? 'paper' : 'drawable'}">`,
    metadataElement,
    ...paths,
    '</svg>',
  ]
    .filter((line) => line !== undefined)
    .join('\n')
}
