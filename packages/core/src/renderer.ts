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
