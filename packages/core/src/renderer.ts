/**
 * The Canvas2D Scene Renderer — a pure, context-injected function that draws a
 * {@link Scene}'s {@link Primitive}s onto a 2D drawing surface in painter's order.
 *
 * ADR-0004 ("Scene Renderers live in core, injected via a core-defined Canvas2D
 * port"): a Scene Renderer lives in `packages/core` because one renderer serves
 * every vector Sketch and every consumer (studio #6, Remotion #11, SVG export
 * #9). To stay headless, core's tsconfig is deliberately `lib: ["ES2022"]` with
 * NO `"DOM"` — that type-level guardrail underwrites the determinism proof
 * (#27/#30). So instead of reaching for the global `CanvasRenderingContext2D`,
 * core declares the minimal structural {@link Canvas2DContext} port below, naming
 * only the canvas methods this renderer calls. The real browser context is
 * structurally assignable to it, so the studio and Remotion pass
 * `canvas.getContext('2d')` directly with no adapter, while core's lib stays free
 * of `"DOM"`. Reaching for `CanvasRenderingContext2D` or any `lib.dom` global in
 * core is the exact anti-pattern this ADR exists to prevent.
 *
 * The renderer draws in the Scene's OWN coordinate space and establishes NO
 * transform: the coordinate-space → pixel mapping (fit/letterbox/DPR) is a caller
 * concern layered over this function (a later task, #34), not baked into it.
 */

import type { Scene } from './scene'
import { escapeAttr, round } from './svgHelpers'

/**
 * The minimal structural Canvas2D port the {@link renderToCanvas} renderer draws
 * through (ADR-0004).
 *
 * This interface names ONLY the canvas API surface the renderer touches — the
 * path-building/painting methods plus the mutable style properties — and
 * deliberately does NOT reference the global `CanvasRenderingContext2D` or any
 * `lib.dom` type, so core's tsconfig can stay `lib: ["ES2022"]` with no `"DOM"`.
 * The real browser `CanvasRenderingContext2D` is structurally assignable to this
 * port, so callers pass `canvas.getContext('2d')` directly with no adapter; a
 * node test passes a recording stub. The port can widen (never rework) as
 * renderers grow.
 */
export interface Canvas2DContext {
  /** Push the current drawing state (style, transform) onto the state stack. */
  save(): void
  /** Restore the most recently saved drawing state. */
  restore(): void
  /** Start a new path, discarding any current sub-paths. */
  beginPath(): void
  /** Move the path's pen to `(x, y)` without drawing, starting a sub-path. */
  moveTo(x: number, y: number): void
  /** Add a straight line from the current pen position to `(x, y)`. */
  lineTo(x: number, y: number): void
  /** Close the current sub-path back to its starting point. */
  closePath(): void
  /** Fill the current path using {@link Canvas2DContext.fillStyle}. */
  fill(): void
  /** Stroke the current path using `strokeStyle`/`lineWidth`. */
  stroke(): void
  /** The CSS color used by {@link Canvas2DContext.fill}. */
  fillStyle: string
  /** The CSS color used by {@link Canvas2DContext.stroke}. */
  strokeStyle: string
  /** The stroke width, in the Scene's coordinate-space units. */
  lineWidth: number
}

/**
 * Draw a {@link Scene}'s {@link Primitive}s onto a 2D surface via the injected
 * {@link Canvas2DContext} port.
 *
 * Primitives are drawn in STRICT array order — `scene.primitives[0]` first
 * (bottom), the last element last (top): the array order IS the painter's
 * (z-)order. Each Primitive is built as a polyline path (`moveTo` the first
 * point, `lineTo` the rest); if `closed` is true the path is closed
 * (`closePath`). A Primitive's `fill` is applied only when present
 * (`fillStyle` ← `fill.color`, then `fill()`), and its `stroke` only when
 * present (`strokeStyle` ← `stroke.color`, `lineWidth` ← `stroke.width`, then
 * `stroke()`); both are applied when both are present. Every Primitive's style
 * mutation is bracketed by `save()`/`restore()` so style state does not leak
 * between Primitives.
 *
 * The renderer draws in the Scene's own coordinate space and establishes NO
 * transform of its own; `stroke.width` is read in Scene-space units, so a
 * uniform-scale transform applied by the caller (#34) scales it correctly. A
 * Primitive with fewer than one point contributes no path geometry.
 *
 * @param ctx - The Canvas2D port to draw through (browser context, `node-canvas`
 *   context, or a recording stub — all structurally assignable).
 * @param scene - The Scene whose Primitives to draw, in painter's order.
 */
export function renderToCanvas(ctx: Canvas2DContext, scene: Scene): void {
  for (const primitive of scene.primitives) {
    const { points, closed, fill, stroke } = primitive

    ctx.save()

    ctx.beginPath()
    points.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    if (closed) ctx.closePath()

    if (fill) {
      ctx.fillStyle = fill.color
      ctx.fill()
    }
    if (stroke) {
      ctx.strokeStyle = stroke.color
      ctx.lineWidth = stroke.width
      ctx.stroke()
    }

    ctx.restore()
  }
}

/**
 * Escape XML special characters for TEXT content (between tags). Unlike
 * {@link escapeAttr} it need not escape `"` (no surrounding quotes) but MUST
 * escape `>` as well — a `]]>`-free JSON payload is safe inline, but escaping `&`,
 * `<`, and `>` keeps the document well-formed for any payload without resorting to
 * a CDATA section.
 */
function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * The SVG Scene Renderer — a pure, headless serializer that turns a {@link Scene}
 * into a standalone SVG string (the sibling of {@link renderToCanvas}, the
 * second Scene Renderer per slice #9 / ADR-0004).
 *
 * It mirrors {@link renderToCanvas} exactly in geometry and ordering, but emits
 * markup instead of driving a context: each {@link Primitive} becomes one
 * `<path>`, built by pure string assembly. There are NO DOM types — core's
 * tsconfig stays `lib: ["ES2022"]` — so this never reaches for `XMLSerializer`,
 * `document`, or any `lib.dom` global; it is the same headless guardrail the
 * Canvas2D port upholds, expressed here as plain string building.
 *
 * Primitives are serialized in STRICT array order — `scene.primitives[0]` first
 * (bottom), the last element last (top): the document order IS the painter's
 * (z-)order, so a later path paints over an earlier one. Each path's geometry is
 * `M` to the first point then `L` to the rest; a `closed` Primitive appends `Z`
 * (an open polyline omits it, staying open). Style is emitted PER ELEMENT, never
 * via a global `<g>` wrapper: `fill="<fill.color>"` when a fill is present and
 * `fill="none"` when absent; `stroke="<stroke.color>"` plus
 * `stroke-width="<stroke.width>"` when a stroke is present and no stroke attrs at
 * all when absent. `stroke.width` is written in Scene-space units, unscaled —
 * the `viewBox` puts user space in the Scene's own coordinate space, so the width
 * renders at the right size with no conversion (contrast `polylinesToSVG`, the
 * plotter serializer in `svg.ts`, which is cm-space and single-pen — deliberately
 * NOT reused here).
 *
 * The root `<svg>` carries `viewBox="0 0 {space.width} {space.height}"` in the
 * Scene's own coordinate space (top-left origin), so geometry maps 1:1 with no
 * transform. A Primitive with fewer than one point contributes no `<path>` (it
 * has no geometry to draw — the same guard spirit as the renderer and
 * `svg.ts`).
 *
 * When `metadata` is supplied, it is embedded as a `<metadata>` element (the SVG
 * leg of issue #76, "self-describing exports") so the file traces back to the
 * exact frame that produced it. The injection lives HERE — core-level, testable —
 * rather than as a string post-process in the Studio, consistent with ADR-0004
 * (Scene Renderers live in core). The string is XML-escaped as text content
 * (`&`, `<`, `>`); a JSON payload is safe inline with no CDATA section. An omitted
 * `metadata` emits no `<metadata>` element (the unchanged plain-SVG path).
 *
 * @param scene - The Scene whose Primitives to serialize, in painter's order.
 * @param metadata - Optional metadata string (e.g. the reproduction JSON from
 *   `buildReproMetadata`) embedded as a `<metadata>` element.
 * @returns A complete, standalone SVG document string.
 */
export function renderToSVG(scene: Scene, metadata?: string): string {
  const { width, height } = scene.space

  const paths = scene.primitives
    .filter((primitive) => primitive.points.length >= 1)
    .map((primitive) => {
      const { points, closed, fill, stroke } = primitive

      const d =
        points
          .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${round(x)} ${round(y)}`)
          .join(' ') + (closed ? ' Z' : '')

      const fillAttr = `fill="${fill ? escapeAttr(fill.color) : 'none'}"`
      const strokeAttr = stroke
        ? ` stroke="${escapeAttr(stroke.color)}" stroke-width="${round(stroke.width)}"`
        : ''

      return `  <path d="${d}" ${fillAttr}${strokeAttr} />`
    })
    .join('\n')

  const metadataEl =
    metadata === undefined
      ? undefined
      : `  <metadata>${escapeText(metadata)}</metadata>`

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">`,
    metadataEl,
    paths,
    '</svg>',
  ]
    .filter((line) => line !== undefined)
    .join('\n')
}
