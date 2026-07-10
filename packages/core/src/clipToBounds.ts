import { clipPolylinesToBox } from './clip'
import type { BBox } from './clip'
import type { Scene, Primitive } from './scene'

/**
 * The Clip-to-canvas-bounds pass: a pure `Scene → Scene` transform that clips
 * every Primitive's geometry to the Scene's own `space` rectangle
 * `[0, 0, space.width, space.height]`, so no drawn geometry falls outside the
 * canvas (CONTEXT.md "Scene", issue #218/#236).
 *
 * It is NOT a Scene Renderer: it consumes a Scene and emits ANOTHER Scene, which
 * the existing Canvas2D/SVG/plotter renderers then draw unchanged. This is the
 * same framing as the Hidden-line pass ({@link ./hiddenLine}) — a pure geometry
 * transform between two Scenes — so it can be tested as pure geometry with no
 * serializer/canvas in the loop, and export and preview render the SAME clipped
 * Scene through the same renderers.
 *
 * Scene↔Polyline bridge
 * ---------------------
 * The real content of this pass is the bridge between the Scene IR and the
 * rectangular polyline clipper. For each source Primitive:
 *   1. Its `points` polyline is run through {@link clipPolylinesToBox} against
 *      the canvas box — the existing Cohen–Sutherland clipper (`clip.ts`,
 *      `lineclip`). NO new rectangular-clip algorithm is introduced here.
 *   2. Each surviving segment is re-wrapped as a NEW Primitive that PRESERVES the
 *      source Primitive's style (`stroke`, `fill`, `closed`) — only the geometry
 *      is replaced by the clipped segment. Output style fields are carried
 *      through only when the source carried them (no explicit `undefined`), so a
 *      Primitive that never had a `fill`/`stroke`/`closed` field stays that way.
 *
 * A source Primitive fully OUTSIDE the box yields zero segments and is therefore
 * absent from the output. One fully INSIDE survives intact (a single segment with
 * unchanged points). A CROSSING one is cut exactly at the boundary — and because
 * a polyline may exit and re-enter the box, the clipper can yield MULTIPLE
 * segments, so one source Primitive can produce several output Primitives, each
 * carrying the source style. Draw order (painter's order) is preserved: segments
 * are emitted in source-Primitive order, and in the clipper's segment order
 * within each Primitive.
 *
 * The Scene container is preserved: output `space` equals input `space`, and the
 * input's `background` is carried through only when present (no explicit
 * `undefined` field — matching `createScene`/`hiddenLinePass` byte-identical
 * discipline, so a background-less Scene stays byte-identical). Clipping never
 * touches the surface style; it only clips geometry.
 *
 * The pass is ON-DEMAND ONLY. The core invariant (CONTEXT.md) keeps expensive,
 * export-only work out of the live `generate → draw → painter's render` loop, so
 * nothing in that loop calls this — export (issue #237) invokes it explicitly.
 * It must NEVER run in the live fill loop, matching the #205/hiddenLine
 * on-export discipline.
 *
 * Local decisions (per ADR-0007 these are pass-local rationale, not an ADR)
 * -----------------------------------------------------------------------
 * (a) CHORD-CLOSED FILLS — a Primitive can be `closed` + `fill`ed, but
 *     {@link clipPolylinesToBox} reuses `lineclip`'s OPEN `clipPolyline`. A
 *     closed/filled Primitive that crosses the canvas edge is therefore cut into
 *     open segment(s) that the renderer re-closes with a straight chord, so its
 *     fill is approximated by that chord rather than following the box boundary.
 *     Because the canvas box is CONVEX, the chord stays INSIDE it — no geometry
 *     escapes the canvas, so the "no geometry outside canvas" acceptance
 *     criterion still holds. The accepted tradeoff for this pass is to ACCEPT
 *     chord-closed fills: we do NOT special-case closed/filled Primitives and do
 *     NOT introduce a polygon clip here. `closed`/`fill` are preserved on the
 *     output Primitives as-is; only the geometry is clipped. (A boundary-following
 *     fill clip would need a polygon clipper — e.g. the #209 arbitrary-polygon
 *     clip the Hidden-line pass uses — and is deliberately out of scope here.)
 */
export function clipSceneToBounds(scene: Scene): Scene {
  const bounds: BBox = [0, 0, scene.space.width, scene.space.height]

  const primitives: Primitive[] = []
  for (const source of scene.primitives) {
    const segments = clipPolylinesToBox([source.points], bounds)
    for (const segment of segments) {
      const clipped: Primitive = { points: segment }
      if (source.closed !== undefined) clipped.closed = source.closed
      if (source.fill !== undefined) clipped.fill = source.fill
      if (source.stroke !== undefined) clipped.stroke = source.stroke
      primitives.push(clipped)
    }
  }

  return scene.background === undefined
    ? { space: scene.space, primitives }
    : { space: scene.space, primitives, background: scene.background }
}
