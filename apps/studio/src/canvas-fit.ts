/**
 * Caller-side coordinate-space → pixel mapping for a Scene Renderer (ADR-0004).
 *
 * The Canvas2D Scene Renderer (`renderToCanvas` in `@harness/core`) draws in the
 * Scene's OWN coordinate space and establishes NO transform of its own — fit,
 * letterbox, and devicePixelRatio are deliberately a CALLER concern layered over
 * it. This module owns that mapping as a pure function so the (aspect-ratio
 * sensitive) math is unit-testable without a DOM: the {@link LiveCanvas}
 * component applies the returned transform to the real `CanvasRenderingContext2D`
 * and then calls `renderToCanvas`.
 */

/**
 * The contain-fit transform mapping a Scene's coordinate space onto a pixel
 * surface: a single UNIFORM `scale` plus a centering translate.
 *
 * A uniform scale (identical on both axes) is load-bearing: it preserves the
 * Scene's declared aspect ratio (no distortion) AND makes `Stroke.width` — which
 * the renderer reads in Scene-space units — scale by the same factor as the
 * geometry for free. The unused axis is letterboxed by `offsetX`/`offsetY`,
 * centering the scaled Scene in the surface.
 */
export interface ContainFit {
  /** Uniform scale factor applied to both axes (Scene units → pixels). */
  scale: number;
  /** Horizontal pixel offset that centers the scaled Scene (left letterbox). */
  offsetX: number;
  /** Vertical pixel offset that centers the scaled Scene (top letterbox). */
  offsetY: number;
}

/**
 * Compute the contain-fit transform that maps a `spaceW × spaceH` coordinate
 * space onto a `pixelW × pixelH` surface, preserving aspect ratio and centering.
 *
 * The scale is `min(pixelW / spaceW, pixelH / spaceH)` so the whole Scene fits
 * inside the surface (contain, never crop); the axis with slack is letterboxed by
 * splitting the leftover pixels evenly into the centering offset. Applied as
 * `ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY)` before
 * `renderToCanvas`.
 *
 * A DEGENERATE surface or space (any dimension zero or non-finite — e.g. a
 * pre-layout canvas whose box hasn't been measured yet, giving a `0 × 0` backing
 * store) would otherwise make `scale` NaN or 0 and yield a transform that paints
 * nothing or, worse, a NaN transform the browser silently rejects. Such a frame
 * is returned as a safe no-op fit (`scale`/offsets all 0): it draws nothing
 * harmlessly, and the next call once the box has real dimensions repaints
 * correctly (the caller re-fits and redraws on resize).
 *
 * @param spaceW - Scene coordinate-space width (`scene.space.width`).
 * @param spaceH - Scene coordinate-space height (`scene.space.height`).
 * @param pixelW - Surface width in pixels (canvas backing-store width).
 * @param pixelH - Surface height in pixels (canvas backing-store height).
 */
export function computeContainFit(
  spaceW: number,
  spaceH: number,
  pixelW: number,
  pixelH: number,
): ContainFit {
  // A zero (or non-finite) dimension on either the space or the surface makes
  // min(pixelW/spaceW, pixelH/spaceH) NaN or 0 — a transform that paints nothing
  // or that the browser rejects. Return a no-op fit so a degenerate frame is a
  // harmless no-paint and the next real-sized frame repaints correctly.
  const finitePositive = (n: number) => Number.isFinite(n) && n > 0;
  if (
    !finitePositive(spaceW) ||
    !finitePositive(spaceH) ||
    !finitePositive(pixelW) ||
    !finitePositive(pixelH)
  ) {
    return { scale: 0, offsetX: 0, offsetY: 0 };
  }

  const scale = Math.min(pixelW / spaceW, pixelH / spaceH);
  const offsetX = (pixelW - spaceW * scale) / 2;
  const offsetY = (pixelH - spaceH * scale) / 2;
  return { scale, offsetX, offsetY };
}
