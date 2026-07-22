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

import { computeContainFit } from './canvas-fit'
import type { Scene } from './scene'
import { escapeAttr, escapeText, round } from './svgHelpers'

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
 * renderers grow — the `setTransform`, `fillRect`, and `clearRect` members are
 * ADR-0004-sanctioned widenings, added so {@link drawSceneFitted} can establish
 * the caller's contain-fit transform AND paint/clear the opaque background
 * (issue #92) through the same headless port (no `lib.dom` reach).
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
  /** The shape painted at the endpoints of open stroked subpaths. */
  lineCap: 'butt' | 'round' | 'square'
  /** The stroke width, in the Scene's coordinate-space units. */
  lineWidth: number
  /** Replace the current transform with `[a b c d e f]` (a→scaleX, d→scaleY, e/f→translate). */
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  /** Fill the `(x, y, w, h)` rectangle with {@link Canvas2DContext.fillStyle} (the opaque background). */
  fillRect(x: number, y: number, w: number, h: number): void
  /** Clear the `(x, y, w, h)` rectangle to transparent (the `'transparent'` background). */
  clearRect(x: number, y: number, w: number, h: number): void
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
 * present (`strokeStyle` ← `stroke.color`, `lineCap` ←
 * `stroke.lineCap ?? 'butt'`, `lineWidth` ← `stroke.width`, then `stroke()`);
 * both are applied when both are present. The complete draw is
 * bracketed by one `save()`/`restore()` pair so style state does not leak back
 * to the caller. Primitives do not need individual state frames: every style
 * that can affect one of their paint operations is assigned immediately before
 * that operation.
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
  if (scene.primitives.length === 0) return

  // Preserve the caller's drawing state once for the complete Scene. A state
  // frame per Primitive is redundant because every fill/stroke style a
  // Primitive uses is assigned immediately before its paint operation.
  ctx.save()

  for (const primitive of scene.primitives) {
    const { points, closed, fill, stroke } = primitive

    ctx.beginPath()
    const first = points[0]
    if (first !== undefined) {
      ctx.moveTo(first[0], first[1])
      for (let i = 1; i < points.length; i++) {
        const point = points[i]!
        ctx.lineTo(point[0], point[1])
      }
    }
    if (closed) ctx.closePath()

    if (fill) {
      ctx.fillStyle = fill.color
      ctx.fill()
    }
    if (stroke) {
      ctx.strokeStyle = stroke.color
      ctx.lineCap = stroke.lineCap ?? 'butt'
      ctx.lineWidth = stroke.width
      ctx.stroke()
    }
  }

  ctx.restore()
}

/**
 * Draw a {@link Scene} onto a `pixelW × pixelH` surface through the SHARED render
 * pipeline: compute the contain-fit transform, apply it to the injected
 * {@link Canvas2DContext} port, then delegate to {@link renderToCanvas}.
 *
 * This is the ONE mapping every consumer runs — the studio's live canvas (#6) and
 * the Remotion renderer (#11) both call this, so their fit is structurally
 * identical, not coincidentally matched. `computeContainFit` yields a single
 * uniform `scale` plus centering `offsetX`/`offsetY`; those become
 * `ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY)`, so the Scene draws in
 * its own coordinate space (aspect ratio preserved, `Stroke.width` scaled with the
 * geometry) letterboxed into the surface.
 *
 * The background is painted FIRST — under identity, over the FULL pixel surface
 * (letterbox included) — before the fit transform, so it is the bottom of the
 * z-order and every caller inherits a safe opaque backdrop with zero author
 * discipline (issue #92). The default is `'white'`, so a black-stroked Sketch is
 * never black-on-black (the Remotion `.mp4` has no alpha and flattens transparent
 * → black); `'transparent'` clears instead of fills. The paint/clear is
 * UNCONDITIONAL, so it doubles as the per-frame surface clear — no cross-frame
 * ghosting in the Remotion loop, and callers no longer clear themselves.
 *
 * PRECEDENCE (ADR-0009): the painted color is
 * `scene.background?.color ?? background`. A Scene-declared background is PART OF
 * THE IMAGE — produced by `generate` from a param, on the ADR-0002 determinism
 * spine — so when present it WINS unconditionally over the `background`
 * parameter. The parameter remains the caller-side Render Setting SAFETY NET
 * (issue #92) for the common Scene that declares none: it is a fallback backdrop,
 * never an override — a caller cannot repaint a Scene-authored background from
 * outside, for the same reason it cannot recolor a Primitive. The resolved color
 * feeds the SAME paint/clear logic, so a Scene declaring
 * `{ color: 'transparent' }` clears exactly as the parameter form does.
 *
 * It reads NEITHER `devicePixelRatio` NOR the surface's CSS box — DPR and
 * backing-store sizing stay a CALLER concern (the caller passes the already-sized
 * pixel dimensions). `renderToCanvas` itself stays transform-free; this function
 * is the thin background-fit-and-draw layer over it, not a change to it.
 *
 * @param ctx - The Canvas2D port to draw through (must satisfy `setTransform`).
 * @param scene - The Scene to fit and draw, in painter's order.
 * @param pixelW - Surface width in pixels (backing-store width, DPR already applied).
 * @param pixelH - Surface height in pixels (backing-store height, DPR already applied).
 * @param background - FALLBACK backdrop CSS color painted over the full surface
 *   before the scene when the Scene declares no `background` of its own (a
 *   Scene-declared background wins — see the precedence doc above);
 *   `'transparent'` clears instead of fills. Defaults to `'white'`.
 */
export function drawSceneFitted(
  ctx: Canvas2DContext,
  scene: Scene,
  pixelW: number,
  pixelH: number,
  background = 'white',
): void {
  // Resolve the backdrop: the Scene-declared background (part of the image,
  // ADR-0009) wins over the caller's fallback Render Setting (issue #92).
  const bg = scene.background?.color ?? background

  // Paint (or clear) the FULL pixel surface under identity, before the fit
  // transform — the background sits at the bottom of the z-order and the
  // unconditional clear/fill subsumes the per-frame surface clear.
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  if (bg === 'transparent') {
    ctx.clearRect(0, 0, pixelW, pixelH)
  } else {
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, pixelW, pixelH)
  }

  const { scale, offsetX, offsetY } = computeContainFit(
    scene.space.width,
    scene.space.height,
    pixelW,
    pixelH,
  )
  ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY)
  renderToCanvas(ctx, scene)
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
 * `stroke-width="<stroke.width>"` plus an authored `stroke-linecap` when present,
 * and no stroke attrs at all when absent. `stroke.width` is written in
 * Scene-space units, unscaled —
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
 * The background is emitted as a full-`viewBox` `<rect>` FIRST (before metadata
 * and paths), so it sits at the bottom of the z-order — the SVG mirror of the
 * canvas's opaque backdrop (issue #92), keeping SVG == raster. The emitted color
 * follows the SAME precedence as {@link drawSceneFitted} (ADR-0009):
 * `scene.background?.color ?? background` — a Scene-declared background is part
 * of the image and WINS over the `background` parameter, which stays the
 * caller-side fallback for Scenes that declare none. It defaults to `'white'`; a
 * resolved `'transparent'` emits NO rect (matching the canvas's `clearRect`).
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
 * @param background - FALLBACK backdrop CSS color emitted as a full-viewBox
 *   `<rect>` below everything when the Scene declares no `background` of its own
 *   (a Scene-declared background wins); a resolved `'transparent'` emits no rect.
 *   Defaults to `'white'`.
 * @returns A complete, standalone SVG document string.
 */
export function renderToSVG(scene: Scene, metadata?: string, background = 'white'): string {
  const { width, height } = scene.space

  // Same resolution as drawSceneFitted (ADR-0009): the Scene-declared background
  // (part of the image) wins over the caller's fallback Render Setting.
  const bg = scene.background?.color ?? background

  const backgroundEl =
    bg === 'transparent'
      ? undefined
      : `  <rect x="0" y="0" width="${width}" height="${height}" fill="${escapeAttr(bg)}" />`

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
        ? ` stroke="${escapeAttr(stroke.color)}" stroke-width="${round(stroke.width)}"${stroke.lineCap === undefined ? '' : ` stroke-linecap="${stroke.lineCap}"`}`
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
    backgroundEl,
    metadataEl,
    paths,
    '</svg>',
  ]
    // Drop the transparent-background rect and absent metadata (`undefined`) plus
    // an empty `paths` segment (an empty / all-filtered Scene) so none emit a
    // blank line.
    .filter((line) => line)
    .join('\n')
}
