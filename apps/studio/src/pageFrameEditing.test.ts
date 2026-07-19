import {
  computePlotMapping,
  derivePageFramePlotProfile,
  fullCompositionPageFrame,
  plotDrawableRectangle,
  resolvePlotCompositionFrame,
  type PageFrame,
  type PlotProfile,
} from "@harness/core";
import { describe, expect, it } from "vitest";

import {
  createEditHistory,
  redoEdit,
  undoEdit,
  type StudioEditState,
} from "./editHistory";
import {
  applyPageFrameEdit,
  initialPageFrameForEdit,
  resetPageFrame,
  resolveStudioCompositionFrame,
  sameStudioPhysicalScale,
  studioGenerationAspect,
  studioMillimetersPerCompositionUnit,
} from "./pageFrameEditing";

const PROFILE: PlotProfile = {
  width: 220,
  height: 180,
  insets: { top: 10, right: 10, bottom: 10, left: 10 },
  includeFrame: true,
  toolWidthMillimeters: 0.3,
};

function state(profile: PlotProfile = PROFILE): StudioEditState {
  return {
    params: { radius: 10 },
    seed: 7,
    locks: new Set(),
    profile,
    framing: { kind: "unframed" },
    tolerance: 0,
  };
}

function scaleFrame(
  frame: Pick<PageFrame, "width" | "height">,
  values: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
): PageFrame {
  return {
    x: values.x * frame.width,
    y: values.y * frame.height,
    width: values.width * frame.width,
    height: values.height * frame.height,
  };
}

describe("Page Frame editing commands", () => {
  it("initializes first edit to the exact full Composition and applies it visually inert", () => {
    const initial = state();
    const history = createEditHistory(initial);
    const initialComposition = resolvePlotCompositionFrame(PROFILE);
    const fullFrame = initialPageFrameForEdit(initial);

    expect(fullFrame).toEqual(fullCompositionPageFrame(initialComposition));

    const applied = applyPageFrameEdit(history, fullFrame);
    expect(applied.present.profile).toBe(PROFILE);
    expect(applied.present.framing).toEqual({
      kind: "framed",
      pageFrame: fullFrame,
      generationAspect:
        plotDrawableRectangle(PROFILE).width /
        plotDrawableRectangle(PROFILE).height,
    });
    expect(resolveStudioCompositionFrame(applied.present)).toEqual(
      initialComposition,
    );
    expect(applied.past).toEqual([initial]);
  });

  it("freezes the original profile-derived aspect on a non-identity first Apply", () => {
    const initial = state();
    const originalComposition = resolveStudioCompositionFrame(initial);
    const crop = scaleFrame(originalComposition, {
      x: 0.1,
      y: 0.2,
      width: 0.5,
      height: 0.7,
    });

    const applied = applyPageFrameEdit(createEditHistory(initial), crop);
    const expectedProfile = derivePageFramePlotProfile(
      PROFILE,
      fullCompositionPageFrame(originalComposition),
      crop,
    );

    expect(applied.present.profile).toEqual(expectedProfile);
    expect(studioGenerationAspect(applied.present)).toBe(200 / 160);
    expect(resolveStudioCompositionFrame(applied.present)).toEqual(
      originalComposition,
    );
    expect(resolvePlotCompositionFrame(applied.present.profile)).not.toEqual(
      originalComposition,
    );

    const undone = undoEdit(applied);
    expect(undone.present).toBe(initial);
    expect(undone.present.framing).toEqual({ kind: "unframed" });
    expect(undone.present.profile).toBe(PROFILE);

    const redone = redoEdit(undone);
    expect(redone.present).toBe(applied.present);
    expect(redone.present.framing).toBe(applied.present.framing);
    expect(redone.present.profile).toBe(applied.present.profile);
  });

  it("re-edits from the committed frame while retaining the first frozen basis", () => {
    const initial = state();
    const composition = resolveStudioCompositionFrame(initial);
    const crop = scaleFrame(composition, {
      x: 0.1,
      y: 0.1,
      width: 0.6,
      height: 0.8,
    });
    const padding = scaleFrame(composition, {
      x: -0.2,
      y: -0.1,
      width: 1.4,
      height: 1.1,
    });
    const first = applyPageFrameEdit(createEditHistory(initial), crop);
    const second = applyPageFrameEdit(first, padding);

    expect(initialPageFrameForEdit(first.present)).toEqual(crop);
    expect(second.present.profile).toEqual(
      derivePageFramePlotProfile(first.present.profile, crop, padding),
    );
    expect(second.present.framing).toEqual({
      kind: "framed",
      pageFrame: padding,
      generationAspect: 200 / 160,
    });
    expect(resolveStudioCompositionFrame(second.present)).toEqual(composition);
  });

  it("derives framed physical scale from the represented Page extent and retains it across frame-only edits", () => {
    const initial = state();
    const composition = resolveStudioCompositionFrame(initial);
    const originalScale = studioMillimetersPerCompositionUnit(initial);
    const tallCrop = scaleFrame(composition, {
      x: 0.2,
      y: 0.1,
      width: 0.4,
      height: 0.8,
    });
    const first = applyPageFrameEdit(
      createEditHistory(initial),
      tallCrop,
    ).present;
    const widePadding = scaleFrame(composition, {
      x: -0.1,
      y: 0.2,
      width: 1.2,
      height: 0.5,
    });
    const second = applyPageFrameEdit(
      createEditHistory(first),
      widePadding,
    ).present;

    // These profiles materially mismatch the frozen Composition aspect, so the
    // ordinary whole-Composition plot mapper would reject them.
    expect(resolvePlotCompositionFrame(first.profile)).not.toEqual(composition);
    expect(() => computePlotMapping(composition, first.profile)).toThrow(
      /does not match drawable aspect/,
    );
    expect(studioMillimetersPerCompositionUnit(first)).toBeCloseTo(
      originalScale,
      14,
    );
    expect(studioMillimetersPerCompositionUnit(second)).toBeCloseTo(
      originalScale,
      14,
    );
    expect(sameStudioPhysicalScale(initial, first)).toBe(true);
    expect(sameStudioPhysicalScale(first, second)).toBe(true);
  });

  it("Reset derives the full-Composition profile at current scale before atomically clearing framing", () => {
    const initial = state();
    const composition = resolveStudioCompositionFrame(initial);
    const crop = scaleFrame(composition, {
      x: 0.2,
      y: 0.1,
      width: 0.6,
      height: 0.75,
    });
    const applied = applyPageFrameEdit(createEditHistory(initial), crop);
    const reset = resetPageFrame(applied);
    const expectedProfile = derivePageFramePlotProfile(
      applied.present.profile,
      crop,
      fullCompositionPageFrame(composition),
    );

    expect(reset.present.profile).toEqual(expectedProfile);
    expect(reset.present.framing).toEqual({ kind: "unframed" });
    expect(resolveStudioCompositionFrame(reset.present)).toEqual(composition);
    expect(reset.past).toHaveLength(2);

    const undone = undoEdit(reset);
    expect(undone.present).toBe(applied.present);
    expect(undone.present.framing).toEqual(applied.present.framing);
    expect(undone.present.profile).toBe(applied.present.profile);

    const redone = redoEdit(undone);
    expect(redone.present).toBe(reset.present);
    expect(redone.present.framing).toEqual({ kind: "unframed" });
    expect(redone.present.profile).toBe(reset.present.profile);
  });

  it("keeps drafts and Cancel outside history until Apply", () => {
    const initial = state();
    const history = createEditHistory(initial);
    const draft = {
      ...initialPageFrameForEdit(initial),
      x: 123,
      width: 456,
    };

    // Cancel is discarding this caller-owned value; no history command runs.
    expect(draft).not.toEqual(initialPageFrameForEdit(initial));
    expect(history).toEqual(createEditHistory(initial));
    expect(history.present).toBe(initial);
  });

  it("keeps unframed composition behavior exact and makes Reset a no-op", () => {
    const initial = state();
    const history = createEditHistory(initial);

    expect(resolveStudioCompositionFrame(initial)).toEqual(
      resolvePlotCompositionFrame(initial.profile),
    );
    expect(resetPageFrame(history)).toBe(history);
  });
});
