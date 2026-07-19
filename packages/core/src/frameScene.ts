/**
 * Commit a Page Frame to completed Scene geometry (ADR-0015).
 *
 * This is a pure, renderer-agnostic post-process. The Page Frame is expressed
 * in the source Scene's Composition coordinates; the result is clipped to that
 * rectangle, translated so its top-left is `(0, 0)`, and given the Page
 * Frame's extent as its output coordinate space. Nothing is scaled and the
 * source Scene is never mutated.
 *
 * Fill and stroke need separate treatment at a crop boundary. A clipped fill
 * must acquire Page-boundary edges so that it still covers the viewport-visible
 * intersection. Those edges are not authored perimeter, however, and must
 * never be stroked. Partially clipped fill-and-stroke Primitives are therefore
 * emitted as one fill-only polygon followed by zero or more open stroke-only
 * survivors. Keeping those records adjacent, with fill first, preserves the
 * source Primitive's paint operation and painter-order group.
 */

import { clipPolylinesToBox } from './clip'
import type { BBox } from './clip'
import { pageFrameClipBounds, rebasePointToPageFrame } from './pageFrame'
import type { PageFrame } from './pageFrame'
import type { Primitive, Scene } from './scene'
import type { Point, Polyline } from './types'

type Boundary = {
  inside(point: Point): boolean
  intersection(start: Point, end: Point): Point
}

function samePoint(a: Point, b: Point): boolean {
  return a[0] === b[0] && a[1] === b[1]
}

function appendDistinct(points: Polyline, point: Point): void {
  const previous = points.at(-1)
  if (previous === undefined || !samePoint(previous, point)) points.push(point)
}

/**
 * Intersect a filled path with an axis-aligned box using Sutherland-Hodgman.
 * Scene renderers fill open paths as implicitly closed paths, so `points` is
 * always treated as a polygon ring regardless of the Primitive's `closed`
 * stroke flag.
 */
function clipFillToBox(points: Polyline, bounds: BBox): Polyline {
  if (points.length < 3) return []

  const [minX, minY, maxX, maxY] = bounds
  const verticalIntersection = (x: number, start: Point, end: Point): Point => {
    const t = (x - start[0]) / (end[0] - start[0])
    return [x, start[1] + (end[1] - start[1]) * t]
  }
  const horizontalIntersection = (
    y: number,
    start: Point,
    end: Point,
  ): Point => {
    const t = (y - start[1]) / (end[1] - start[1])
    return [start[0] + (end[0] - start[0]) * t, y]
  }
  const boundaries: Boundary[] = [
    {
      inside: ([x]) => x >= minX,
      intersection: (start, end) => verticalIntersection(minX, start, end),
    },
    {
      inside: ([x]) => x <= maxX,
      intersection: (start, end) => verticalIntersection(maxX, start, end),
    },
    {
      inside: ([, y]) => y >= minY,
      intersection: (start, end) => horizontalIntersection(minY, start, end),
    },
    {
      inside: ([, y]) => y <= maxY,
      intersection: (start, end) => horizontalIntersection(maxY, start, end),
    },
  ]

  let output = points.map(([x, y]) => [x, y] as Point)
  if (output.length > 1 && samePoint(output[0]!, output.at(-1)!)) {
    output.pop()
  }

  for (const boundary of boundaries) {
    if (output.length === 0) break
    const input = output
    output = []
    let start = input.at(-1)!
    let startInside = boundary.inside(start)

    for (const end of input) {
      const endInside = boundary.inside(end)
      if (endInside) {
        if (!startInside) {
          appendDistinct(output, boundary.intersection(start, end))
        }
        appendDistinct(output, end)
      } else if (startInside) {
        appendDistinct(output, boundary.intersection(start, end))
      }
      start = end
      startInside = endInside
    }

    if (output.length > 1 && samePoint(output[0]!, output.at(-1)!)) {
      output.pop()
    }
  }

  return output.length >= 3 ? output : []
}

function pointInsideBounds([x, y]: Point, bounds: BBox): boolean {
  return x >= bounds[0] && x <= bounds[2] && y >= bounds[1] && y <= bounds[3]
}

function rebased(points: Polyline, frame: PageFrame): Polyline {
  return points.map((point) => rebasePointToPageFrame(point, frame))
}

function carryClosed(
  source: Primitive,
  target: Primitive,
  closed?: boolean,
): void {
  if (source.closed !== undefined) target.closed = closed ?? source.closed
}

function carryRole(source: Primitive, target: Primitive): void {
  if (source.hiddenLineRole !== undefined) {
    target.hiddenLineRole = source.hiddenLineRole
  }
}

function copyRebasedPrimitive(source: Primitive, frame: PageFrame): Primitive {
  const target: Primitive = { points: rebased(source.points, frame) }
  carryClosed(source, target)
  if (source.fill !== undefined) target.fill = source.fill
  if (source.stroke !== undefined) target.stroke = source.stroke
  carryRole(source, target)
  return target
}

function strokePath(source: Primitive, bounds: BBox): Polyline {
  const points = source.points
  if (source.closed !== true || points.length < 2) return points

  // A closed ring has no authored start/end cap. When it crosses the frame,
  // begin clipping at an outside vertex so lineclip cannot split one visible
  // survivor at the arbitrary first point and turn its join into two caps.
  const ring = [...points]
  if (samePoint(ring[0]!, ring.at(-1)!)) ring.pop()
  const outsideIndex = ring.findIndex(
    (point) => !pointInsideBounds(point, bounds),
  )
  const start = outsideIndex < 0 ? 0 : outsideIndex
  const rotated = [...ring.slice(start), ...ring.slice(0, start)]
  return rotated.length > 0 ? [...rotated, rotated[0]!] : []
}

/**
 * Clip and top-left-rebase a completed Scene through a committed Page Frame.
 *
 * Padding is represented only by the larger output `space`: it invents no
 * geometry. A Scene-authored background is retained so renderers paint the
 * whole padded Page, while a Scene with no background still omits that field so
 * the caller's Page ground remains authoritative (ADR-0009).
 */
export function frameScene(scene: Scene, frame: PageFrame): Scene {
  const bounds = pageFrameClipBounds(frame)
  const primitives: Primitive[] = []

  for (const source of scene.primitives) {
    if (source.points.every((point) => pointInsideBounds(point, bounds))) {
      primitives.push(copyRebasedPrimitive(source, frame))
      continue
    }

    if (source.fill !== undefined) {
      const polygon = clipFillToBox(source.points, bounds)
      if (polygon.length > 0) {
        const fill: Primitive = {
          points: rebased(polygon, frame),
          fill: source.fill,
        }
        carryClosed(source, fill)
        carryRole(source, fill)
        primitives.push(fill)
      }
    }

    if (source.stroke !== undefined || source.fill === undefined) {
      const segments = clipPolylinesToBox([strokePath(source, bounds)], bounds)
      for (const segment of segments) {
        if (segment.length < 2) continue
        const stroke: Primitive = { points: rebased(segment, frame) }
        // A clipped survivor is always open. Preserve explicit optional-field
        // presence while preventing a source closure from drawing a crop chord.
        carryClosed(source, stroke, false)
        if (source.stroke !== undefined) stroke.stroke = source.stroke
        carryRole(source, stroke)
        primitives.push(stroke)
      }
    }
  }

  const space = { width: frame.width, height: frame.height }
  return scene.background === undefined
    ? { space, primitives }
    : { space, primitives, background: scene.background }
}
