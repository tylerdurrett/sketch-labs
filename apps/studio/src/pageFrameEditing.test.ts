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
  recomposePageToProfile,
  resetPageFrame,
  resolveStudioCompositionFrame,
  sameStudioPhysicalScale,
  studioGenerationAspect,
  studioMillimetersPerCompositionUnit,
  setPageAspectLocked,
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
      aspectLocked: true,
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
      aspectLocked: true,
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

  it("detects a real physical-scale change at microscopic magnitudes", () => {
    const pageFrame: PageFrame = {
      x: 0,
      y: 0,
      width: 1_000,
      height: 1_000,
    };
    const atScale = (millimetersPerUnit: number): StudioEditState => ({
      ...state({
        width: millimetersPerUnit * pageFrame.width,
        height: millimetersPerUnit * pageFrame.height,
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
        includeFrame: true,
        toolWidthMillimeters: 0.3,
      }),
      framing: {
        kind: "framed",
        pageFrame,
        generationAspect: 1,
        aspectLocked: true,
      },
    });
    const microscopic = atScale(1e-20);
    const doubled = atScale(2e-20);

    expect(studioMillimetersPerCompositionUnit(microscopic)).toBe(1e-20);
    expect(studioMillimetersPerCompositionUnit(doubled)).toBe(2e-20);
    expect(sameStudioPhysicalScale(microscopic, doubled)).toBe(false);
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

  it("locks every Apply and re-Apply, even after an explicit unlock", () => {
    const initial = state();
    const composition = resolveStudioCompositionFrame(initial);
    const crop = scaleFrame(composition, {
      x: 0.1,
      y: 0.1,
      width: 0.8,
      height: 0.8,
    });
    const applied = applyPageFrameEdit(createEditHistory(initial), crop);

    expect(applied.present.framing).toMatchObject({
      kind: "framed",
      aspectLocked: true,
    });

    const unlocked = setPageAspectLocked(applied, false);
    expect(unlocked.present.framing).toMatchObject({
      kind: "framed",
      aspectLocked: false,
    });
    expect(unlocked.present.profile).toBe(applied.present.profile);
    expect(unlocked.present.params).toBe(applied.present.params);
    expect(unlocked.present.seed).toBe(applied.present.seed);

    const reapplied = applyPageFrameEdit(unlocked, crop);
    expect(reapplied.present.framing).toMatchObject({
      kind: "framed",
      aspectLocked: true,
    });
    expect(reapplied.past).toHaveLength(3);
  });

  it("changes only a framed lock and suppresses unframed or equal commands", () => {
    const initialHistory = createEditHistory(state());
    expect(setPageAspectLocked(initialHistory, false)).toBe(initialHistory);
    expect(setPageAspectLocked(initialHistory, true)).toBe(initialHistory);

    const applied = applyPageFrameEdit(
      initialHistory,
      initialPageFrameForEdit(initialHistory.present),
    );
    expect(setPageAspectLocked(applied, true)).toBe(applied);

    const unlocked = setPageAspectLocked(applied, false);
    expect(unlocked.present).toEqual({
      ...applied.present,
      framing: { ...applied.present.framing, aspectLocked: false },
    });
    expect(unlocked.past).toEqual([...applied.past, applied.present]);

    const relocked = setPageAspectLocked(unlocked, true);
    expect(undoEdit(relocked).present).toBe(unlocked.present);
    expect(redoEdit(undoEdit(relocked)).present).toBe(relocked.present);
  });

  it("atomically recomposes to a validated profile and clears all framing state", () => {
    const initial = state();
    const applied = applyPageFrameEdit(
      createEditHistory(initial),
      scaleFrame(resolveStudioCompositionFrame(initial), {
        x: 0.1,
        y: 0.2,
        width: 0.7,
        height: 0.6,
      }),
    );
    const unlocked = setPageAspectLocked(applied, false);
    const profile: PlotProfile = {
      ...PROFILE,
      width: 300,
      height: 200,
    };

    const recomposed = recomposePageToProfile(unlocked, profile);
    expect(recomposed.present).toEqual({
      ...unlocked.present,
      profile,
      framing: { kind: "unframed" },
    });
    expect(recomposed.past).toEqual([...unlocked.past, unlocked.present]);

    const undone = undoEdit(recomposed);
    expect(undone.present).toBe(unlocked.present);
    expect(redoEdit(undone).present).toBe(recomposed.present);

    expect(() =>
      recomposePageToProfile(recomposed, { ...profile, width: 0 }),
    ).toThrow(/validatePlotProfile/);
  });

  it("suppresses an already-unframed recompose to an equal profile", () => {
    const history = createEditHistory(state());
    expect(
      recomposePageToProfile(history, {
        ...PROFILE,
        insets: { ...PROFILE.insets },
      }),
    ).toBe(history);
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
