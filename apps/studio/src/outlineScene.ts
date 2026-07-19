import {
  DEFAULT_STROKE,
  frameScene,
  hiddenLinePass,
  type HiddenLineObserver,
  type OutlineTarget,
  type PageFrame,
  type Scene,
} from "@harness/core";

/**
 * Artwork-stroke behavior for cheap Outline finalization.
 *
 * Both variants carry the current physical target so the Harness-owned Page
 * outline can always use the active tool width. Only Sketches that provide an
 * Outline source hook opt into artwork-stroke retargeting; arbitrary legacy
 * Scenes retain their authored widths.
 */
export type OutlineFinalizationStrokePolicy =
  | {
      readonly kind: "legacy-scene";
      readonly target: Readonly<OutlineTarget>;
    }
  | {
      readonly kind: "physical-tool";
      readonly target: Readonly<OutlineTarget>;
    };

function physicalStrokeWidth(target: Readonly<OutlineTarget>): number {
  if (
    !Number.isFinite(target.toolWidthMillimeters) ||
    target.toolWidthMillimeters <= 0
  ) {
    throw new RangeError("toolWidthMillimeters must be finite and positive");
  }
  if (
    !Number.isFinite(target.millimetersPerSceneUnit) ||
    target.millimetersPerSceneUnit <= 0
  ) {
    throw new RangeError(
      "millimetersPerSceneUnit must be finite and positive",
    );
  }
  return target.toolWidthMillimeters / target.millimetersPerSceneUnit;
}

function applyArtworkStrokePolicy(
  scene: Scene,
  policy: OutlineFinalizationStrokePolicy | undefined,
): Scene {
  if (policy?.kind !== "physical-tool") return scene;

  const width = physicalStrokeWidth(policy.target);
  return {
    ...scene,
    primitives: scene.primitives.map((primitive) =>
      primitive.stroke === undefined
        ? primitive
        : {
            ...primitive,
            stroke: { ...primitive.stroke, width },
          },
    ),
  };
}

/**
 * The shared preview == export Outline pipeline (issue #220, feature #4).
 *
 * The outline-mode canvas preview ({@link LiveCanvas}) and the hidden-line SVG
 * export ({@link SketchControls.exportHiddenLineSvg}) must apply the IDENTICAL
 * processing to their input Scene — that is the whole promise of feature #4
 * ("what you see is what you plot"). The expensive, Page-independent stage
 * lives in {@link outlineScene}; the cheap Page-dependent stage lives in
 * {@link finalizeOutlineScene}. Consumers compose those stages in that order.
 *
 * It is a pure `(Scene, tolerance) → Scene` function containing only the
 * expensive Hidden-line pass. Scene sampling deliberately stays caller-owned:
 * LiveCanvas supplies its retained ADR-0012 prepared sample, avoiding a
 * redundant cold `generate`, while one-shot export may generate its Scene cold.
 * The `tolerance` (default 0, i.e. no simplification) is the studio's single
 * knob value forwarded into the pass's final Douglas–Peucker stage; routing it
 * through this one seam keeps preview and export simplified IDENTICALLY.
 *
 * Page framing and the optional authored Page rectangle belong to
 * {@link finalizeOutlineScene}. Keeping that cheap finalization outside this
 * expensive seam lets framing and frame visibility change without repeating
 * Hidden-line work (ADR-0015).
 *
 * On-demand only (feature #4 / issue #219 invariant): the Hidden-line pass is
 * expensive, so this seam is invoked ONLY from the static/on-demand redraw path
 * and the export click handler — NEVER inside LiveCanvas's live rAF fill loop.
 *
 * Slice-local rationale lives here (not an ADR) per ADR-0007.
 */
export function outlineScene(
  scene: Scene,
  tolerance = 0,
  observer?: HiddenLineObserver,
): Scene {
  return hiddenLinePass(
    scene,
    observer === undefined ? { tolerance } : { tolerance, observer },
  );
}

/**
 * Apply committed Page framing, then optionally append its authored outline.
 *
 * This seam is intentionally pure and cheap: callers may toggle the Page
 * rectangle or finalize the same retained Hidden-line result through a new Page
 * Frame without rerunning {@link outlineScene}. With no committed Page Frame,
 * the source Composition coordinate space remains the final Page space.
 *
 * Supplying a stroke policy makes the current physical target explicit. An
 * opt-in physical-tool source has each stroke retargeted before Page framing so
 * clipping uses its current physical footprint; a legacy Scene keeps every
 * authored stroke. In either case the Harness-owned Page outline uses the
 * current physical width. Omitting the policy preserves historical behavior
 * for callers that have not migrated.
 */
export function finalizeOutlineScene(
  base: Scene,
  pageFrame: PageFrame | null,
  includeFrame: boolean,
  strokePolicy?: OutlineFinalizationStrokePolicy,
): Scene {
  const styled = applyArtworkStrokePolicy(base, strokePolicy);
  const finalized = pageFrame === null ? styled : frameScene(styled, pageFrame);
  if (!includeFrame) return finalized;

  const { width, height } = finalized.space;
  const frameStroke =
    strokePolicy === undefined
      ? DEFAULT_STROKE
      : {
          ...DEFAULT_STROKE,
          width: physicalStrokeWidth(strokePolicy.target),
        };
  return {
    ...finalized,
    primitives: [
      ...finalized.primitives,
      {
        points: [
          [0, 0],
          [width, 0],
          [width, height],
          [0, height],
          [0, 0],
        ],
        stroke: frameStroke,
      },
    ],
  };
}
