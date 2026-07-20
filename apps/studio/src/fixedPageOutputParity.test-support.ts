import {
  createShadingMask,
  createToneField,
  resolvePlotCompositionFrame,
  type PageFrame,
  type PlotProfile,
  type Scene,
  type ToneSource,
} from "@harness/core";

/**
 * One asymmetric fixed-page fixture shared by the Studio output-parity tests.
 *
 * The drawable is 265 × 159 mm (5:3), but every physical inset differs. The
 * represented Page is a 2× zoom with left padding and a vertically cropped
 * origin. Those choices make an axis swap, centering fallback, non-uniform
 * scale, or lost Page origin visible in the resulting pixels and SVG paths.
 */
export const FIXED_PAGE_PARITY_PROFILE: PlotProfile = {
  width: 323,
  height: 217,
  insets: { top: 19, right: 41, bottom: 39, left: 17 },
  includeFrame: true,
  toolWidthMillimeters: 0.37,
};

export const FIXED_PAGE_PARITY_COMPOSITION = resolvePlotCompositionFrame(
  FIXED_PAGE_PARITY_PROFILE,
);

export const FIXED_PAGE_PARITY_FRAME: PageFrame = {
  x: FIXED_PAGE_PARITY_COMPOSITION.width * -0.1,
  y: FIXED_PAGE_PARITY_COMPOSITION.height * 0.25,
  width: FIXED_PAGE_PARITY_COMPOSITION.width * 0.5,
  height: FIXED_PAGE_PARITY_COMPOSITION.height * 0.5,
};

export function fixedPageParityScene(): Scene {
  const { width, height } = FIXED_PAGE_PARITY_COMPOSITION;
  return {
    space: { width, height },
    background: { color: "#f4efe6" },
    primitives: [
      {
        points: [
          [0, height * 0.3],
          [width * 0.4, height * 0.7],
        ],
        stroke: { color: "#123456", width: 2 },
        hiddenLineRole: "source",
      },
    ],
  };
}

/** Tone makes sampled Composition coordinates directly observable as bytes. */
export function fixedPageParityToneSource(): ToneSource {
  const { width, height } = FIXED_PAGE_PARITY_COMPOSITION;
  return {
    toneField: createToneField(([x, y]) =>
      Math.min(1, Math.max(0, x / width / 2 + y / height / 2)),
    ),
    shadingMask: createShadingMask(() => 1),
  };
}
