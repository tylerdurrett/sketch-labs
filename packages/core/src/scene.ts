/**
 * The Scene IR — the renderer-agnostic intermediate representation a vector
 * Sketch bakes itself into (CONTEXT.md "Scene").
 *
 * A Scene is a coordinate space plus a draw-ordered (painter's-order) collection
 * of {@link Primitive}s. It is deliberately NOT domain-aware: a Scene is not
 * leaf-aware, knows nothing about the Sketch that produced it, and carries no
 * nesting or transforms (it is not a scene graph). Every Scene Renderer
 * (Canvas2D preview, SVG, plotter) consumes this one shape — that is what lets a
 * single renderer serve every vector Sketch.
 *
 * ADR-0002/0003: a stateless Sketch's `generate(params, seed, t)` and a future
 * stateful Sketch's `draw(state)` both return a Scene. This IR must not foreclose
 * either path, so it stays purely about geometry + style + draw order (plus one
 * optional whole-surface style: the Sketch-declared {@link Scene.background},
 * ADR-0009).
 *
 * Record-shape choice (CONTEXT.md "Deliberately deferred" lists the Primitive
 * record shape as intentionally unfrozen): a {@link Primitive} is modeled as a
 * single SVG-path-style record carrying OPTIONAL `fill` and `stroke`, rather than
 * a tagged union of "filled" vs "stroked" variants. Rationale: one piece of
 * geometry can be both filled and stroked at once (the common case for a closed
 * polygon), which an either/or tagged union cannot express without duplication.
 * The shape is kept minimal — only what the brief requires ("polygon/polyline,
 * filled and/or stroked, with a draw order") — and can widen, never rework, as
 * layering/source-tagging needs emerge.
 */

import type { Point, Polyline } from './types'

/**
 * A fill style for a {@link Primitive}'s interior.
 *
 * Minimal by design: a CSS-style color string is all the early Scene Renderers
 * need. Kept as its own type (rather than a bare `string`) so it can widen to
 * carry opacity, rule, or gradient later without reworking call sites.
 */
export interface Fill {
  /** CSS-style color string, e.g. `'black'` or `'#ff0044'`. */
  color: string
}

/**
 * A stroke style for a {@link Primitive}'s outline.
 *
 * `width` is in the Scene's coordinate-space units (see {@link Scene.space}), so
 * a renderer reads it in the same space as the geometry it strokes.
 */
export interface Stroke {
  /** CSS-style color string, e.g. `'black'` or `'#ff0044'`. */
  color: string
  /** Stroke width, in the Scene's coordinate-space units. */
  width: number
}

/**
 * A Primitive's role in generic Hidden-line processing.
 *
 * The role is optional so existing Scenes retain their original contract:
 * filled Primitives are both emitted outline sources and occluders, while
 * stroke-only Primitives are ignored. An explicit role lets a Sketch author a
 * different plot representation without making the Hidden-line pass aware of
 * that Sketch's domain:
 *
 * - `source` emits the Primitive's path after nearer occluders are subtracted.
 * - `occluder` uses a filled Primitive as a clipping polygon but emits no path.
 * - `both` opts into both behaviours explicitly.
 *
 * Occlusion still requires a fill. Consequently `occluder` on a Primitive
 * without `fill` has no effect, while `source` works for either filled or
 * stroke-only geometry.
 */
export type HiddenLineRole = 'source' | 'occluder' | 'both'

/**
 * The coordinate space a {@link Scene}'s geometry lives in.
 *
 * A Scene's Primitives are expressed in this space; a Scene Renderer maps it onto
 * its own output surface (pixels, an SVG viewBox, plotter paper). The origin is
 * the top-left `(0, 0)`; `width`/`height` give the extent in the same units the
 * geometry uses. Kept to just the extent for now — no offset/unit/transform — per
 * the deferred Scene-container shape.
 */
export interface CoordinateSpace {
  /** Width of the drawable extent, in coordinate-space units. */
  width: number
  /** Height of the drawable extent, in coordinate-space units. */
  height: number
}

/**
 * The atomic drawable unit of a {@link Scene}: one styled piece of vector
 * geometry — a polygon or polyline, filled and/or stroked.
 *
 * The geometry is a {@link Polyline} (an ordered list of {@link Point}s) reused
 * from `./types`. `closed` distinguishes a polygon (the path closes back to its
 * first point) from an open polyline; a renderer closes the path when `closed` is
 * true. `fill` and `stroke` are both OPTIONAL — at least one is expected, and
 * both may be present for a filled-and-stroked polygon. A Primitive's position in
 * the Scene's `primitives` array IS its draw order (painter's order), so no
 * explicit z-index is carried.
 */
export interface Primitive {
  /** The vector geometry: an ordered list of points. */
  points: Polyline
  /**
   * Whether the path closes back to its first point (a polygon). Open polylines
   * leave this `false`/absent. Affects both fill and the stroked outline.
   */
  closed?: boolean
  /** Interior fill, if the geometry should be filled. */
  fill?: Fill
  /** Outline stroke, if the geometry should be stroked. */
  stroke?: Stroke
  /**
   * Optional source/occluder intent for the Hidden-line pass.
   *
   * Omitted preserves the legacy role inferred from `fill`; see
   * {@link HiddenLineRole}.
   */
  hiddenLineRole?: HiddenLineRole
}

/**
 * The Scene IR: a coordinate space plus a draw-ordered collection of
 * {@link Primitive}s.
 *
 * `primitives` is in painter's order — index 0 is drawn first (bottom), the last
 * element drawn last (top). A Scene is renderer-agnostic and domain-agnostic; it
 * is the single bake target every vector Sketch produces and every Scene Renderer
 * consumes.
 */
export interface Scene {
  /** The coordinate space the Primitives' geometry is expressed in. */
  space: CoordinateSpace
  /** Primitives in painter's draw order (first = bottom, last = top). */
  primitives: Primitive[]
  /**
   * The Sketch-declared background for the WHOLE output surface — letterbox
   * included — painted below every Primitive (ADR-0009).
   *
   * Optional and usually absent: for most Scenes the backdrop is a caller-side
   * Render Setting (the `background` param on `drawSceneFitted` / `renderToSVG`,
   * issue #92) and no field is carried here. A Sketch declares one when the
   * background is PART OF THE IMAGE — produced by `generate` from a param, so it
   * rides the ADR-0002 determinism spine and round-trips through Presets via the
   * params that feed it. When present it WINS over the caller's fallback (see
   * the renderers' precedence docs); it never affects geometry or draw order.
   */
  background?: Fill
}

/**
 * A draw-friendly builder for assembling a {@link Scene} in painter's order.
 *
 * This is the construction path a Sketch's `draw` (or stateless `generate`) reaches
 * for instead of hand-assembling the `{ space, primitives }` container: call
 * {@link createScene} with the coordinate space, append Primitives in the order
 * they should be drawn (first appended = bottom), then {@link build} the finished
 * Scene. Each `add` returns the same builder so calls chain.
 *
 * The builder is a thin convenience over the IR — it adds no semantics the Scene
 * itself does not already carry; the append order simply IS the draw order.
 */
export interface SceneBuilder {
  /**
   * Append one Primitive on top of those added so far (painter's order).
   *
   * @returns this builder, for chaining.
   */
  add(primitive: Primitive): SceneBuilder
  /**
   * Append a fully-styled polyline/polygon without hand-building the
   * {@link Primitive} record. `closed` makes it a polygon.
   *
   * @returns this builder, for chaining.
   */
  addPath(
    points: Polyline,
    style: {
      fill?: Fill
      stroke?: Stroke
      closed?: boolean
      hiddenLineRole?: HiddenLineRole
    },
  ): SceneBuilder
  /** Finalize and return the assembled Scene. */
  build(): Scene
}

/**
 * Start building a {@link Scene} for the given coordinate space.
 *
 * The returned {@link SceneBuilder} collects Primitives in the order they are
 * appended (painter's order) and hands back the finished Scene from
 * {@link SceneBuilder.build}.
 *
 * @param space - The coordinate space the Scene's geometry is expressed in.
 * @param background - Optional Sketch-declared background for the whole output
 *   surface (see {@link Scene.background}). Absent ⇒ the built Scene carries NO
 *   `background` field (not an explicit `undefined`), so a background-less Scene
 *   stays byte-identical to one built before the field existed.
 */
export function createScene(
  space: CoordinateSpace,
  background?: Fill,
): SceneBuilder {
  const primitives: Primitive[] = []

  const builder: SceneBuilder = {
    add(primitive) {
      primitives.push(primitive)
      return builder
    },
    addPath(points, style) {
      const primitive: Primitive = { points }
      if (style.closed !== undefined) primitive.closed = style.closed
      if (style.fill !== undefined) primitive.fill = style.fill
      if (style.stroke !== undefined) primitive.stroke = style.stroke
      if (style.hiddenLineRole !== undefined) {
        primitive.hiddenLineRole = style.hiddenLineRole
      }
      primitives.push(primitive)
      return builder
    },
    build() {
      // Give the built Scene its own coordinate-space value rather than
      // aliasing the caller-owned frame. With the Composition Frame contract,
      // callers pass a frame they own — often the shared
      // `DEFAULT_COMPOSITION_FRAME` singleton — so returning `space` directly
      // would make every Scene built from that frame share one object. A fresh
      // literal (structurally equal, so existing `toEqual` assertions hold)
      // keeps the boundary clean.
      const builtSpace: CoordinateSpace = {
        width: space.width,
        height: space.height,
      }
      return background === undefined
        ? { space: builtSpace, primitives }
        : { space: builtSpace, primitives, background }
    },
  }

  return builder
}
