/**
 * Tiny shared serialization helpers for the two SVG string builders in core —
 * `renderToSVG` (the Scene Renderer in `renderer.ts`) and `polylinesToSVG` (the
 * cm-space plotter serializer in `svg.ts`). Both serializers stay separate; only
 * these two number/string primitives are shared. INTERNAL — not re-exported from
 * the package's public `index.ts`.
 */

/** Round a number to 4 decimal places to keep SVG output compact. */
export function round(n: number): number {
  return Math.round(n * 10000) / 10000
}

/** Escape XML special characters in an attribute value (e.g. a color string). */
export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
