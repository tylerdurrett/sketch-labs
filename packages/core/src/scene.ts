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
 * either path, so it stays purely about geometry + style + draw order.
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
}
