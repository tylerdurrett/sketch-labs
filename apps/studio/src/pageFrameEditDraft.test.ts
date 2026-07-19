import {
  derivePageFramePlotProfile,
  fixedPageCompositionScale,
  resolveCompositionFrame,
  type PageFrame,
  type PlotProfile,
} from "@harness/core";
import { describe, expect, it } from "vitest";

import {
  openPageFrameEditDraft,
  pageFrameEditDraftProfile,
  panFixedPageFrame,
  resetFixedPageFrame,
  resizeScalePreservingPageFrame,
  setFixedPageCompositionScale,
  setPageFrameEditMode,
  setScalePreservingPageFrame,
  validatePageFrameEditDraft,
  type FixedPageFrameEditDraft,
  type PageFrameEditEntry,
  type ScalePreservingPageFrameEditDraft,
} from "./pageFrameEditDraft";

const PROFILE: PlotProfile = {
  width: 220,
  height: 180,
  insets: { top: 10, right: 10, bottom: 10, left: 10 },
  includeFrame: true,
  toolWidthMillimeters: 0.3,
};
const REPRESENTED_FRAME: PageFrame = {
  x: 40,
  y: 10,
  width: 1_000,
  height: 800,
};
const GENERATION_ASPECT = 16 / 9;
const COMPOSITION_FRAME = resolveCompositionFrame(GENERATION_ASPECT);
const ENTRY: PageFrameEditEntry = {
  profile: PROFILE,
  representedFrame: REPRESENTED_FRAME,
  compositionFrame: COMPOSITION_FRAME,
  generationAspect: GENERATION_ASPECT,
};

function fixed(
  draft: ScalePreservingPageFrameEditDraft,
): FixedPageFrameEditDraft {
  const next = setPageFrameEditMode(draft, "fixed-page");
  if (next.mode !== "fixed-page") throw new Error("expected fixed-page draft");
  return next;
}

function ordinary(
  draft: FixedPageFrameEditDraft,
): ScalePreservingPageFrameEditDraft {
  const next = setPageFrameEditMode(draft, "scale-preserving");
  if (next.mode !== "scale-preserving") {
    throw new Error("expected scale-preserving draft");
  }
  return next;
}

function translate(frame: PageFrame, x: number, y: number): PageFrame {
  return { ...frame, x: frame.x + x, y: frame.y + y };
}

function center(frame: PageFrame): { x: number; y: number } {
  return {
    x: frame.x + frame.width / 2,
    y: frame.y + frame.height / 2,
  };
}

describe("Page Frame edit draft", () => {
  it("opens ordinary framing from the exact committed entry", () => {
    const draft = openPageFrameEditDraft(ENTRY);

    expect(draft).toMatchObject({ mode: "scale-preserving" });
    expect(draft.profile).toBe(PROFILE);
    expect(draft.representedFrame).toBe(REPRESENTED_FRAME);
    expect(draft.frame).toBe(REPRESENTED_FRAME);
    expect(draft.compositionFrame).toBe(COMPOSITION_FRAME);
    expect(draft.generationAspect).toBe(GENERATION_ASPECT);
    expect(pageFrameEditDraftProfile(draft)).toBe(PROFILE);
  });

  it("uses one exact basis for same-session physical width then height edits", () => {
    const opened = openPageFrameEditDraft(ENTRY);
    const widthEdited = resizeScalePreservingPageFrame(
      opened,
      "width",
      170,
    );
    const bothEdited = resizeScalePreservingPageFrame(
      widthEdited,
      "height",
      110,
    );

    expect(widthEdited.profile).toBe(PROFILE);
    expect(widthEdited.representedFrame).toBe(REPRESENTED_FRAME);
    expect(bothEdited.profile).toBe(PROFILE);
    expect(bothEdited.representedFrame).toBe(REPRESENTED_FRAME);
    expect(bothEdited.frame).toEqual({
      x: 40,
      y: 10,
      width: 750,
      height: 450,
    });
    expect(pageFrameEditDraftProfile(bothEdited)).toEqual({
      ...PROFILE,
      width: 170,
      height: 110,
      insets: { ...PROFILE.insets },
    });
  });

  it("keeps ordinary frame edits on their entry basis", () => {
    const opened = openPageFrameEditDraft(ENTRY);
    const frame = { x: -50, y: 80, width: 600, height: 500 };
    const edited = setScalePreservingPageFrame(opened, frame);

    expect(edited.frame).toBe(frame);
    expect(edited.profile).toBe(PROFILE);
    expect(edited.representedFrame).toBe(REPRESENTED_FRAME);
    expect(pageFrameEditDraftProfile(edited)).toEqual(
      derivePageFramePlotProfile(PROFILE, REPRESENTED_FRAME, frame),
    );
  });

  it("enters fixed-page mode with the exact transient profile and no visual jump", () => {
    const ordinaryDraft = setScalePreservingPageFrame(
      openPageFrameEditDraft(ENTRY),
      { x: -50, y: 80, width: 750, height: 450 },
    );
    const transientProfile = pageFrameEditDraftProfile(ordinaryDraft);
    const draft = fixed(ordinaryDraft);

    expect(draft.profile).toEqual(transientProfile);
    expect(draft.frame).toBe(ordinaryDraft.frame);
    expect(draft.center).toEqual(center(ordinaryDraft.frame));
    expect(draft.compositionScale).toBe(
      fixedPageCompositionScale(
        draft.profile,
        draft.fitFrame,
        draft.frame,
      ),
    );
    expect(draft.fitFrame.width / draft.fitFrame.height).toBe(
      ordinaryDraft.frame.width / ordinaryDraft.frame.height,
    );
  });

  it("returns to ordinary mode by rebasing on the exact fixed profile and frame", () => {
    const fixedDraft = fixed(openPageFrameEditDraft(ENTRY));
    const scaled = setFixedPageCompositionScale(fixedDraft, 2.75);
    const panned = panFixedPageFrame(scaled, translate(scaled.frame, 31, -47));
    const draft = ordinary(panned);

    expect(draft.profile).toBe(panned.profile);
    expect(draft.representedFrame).toBe(panned.frame);
    expect(draft.frame).toBe(panned.frame);
    expect(pageFrameEditDraftProfile(draft)).toBe(panned.profile);
  });

  it("does not drift across repeated no-op mode switches", () => {
    let draft = fixed(
      setScalePreservingPageFrame(openPageFrameEditDraft(ENTRY), {
        x: -83,
        y: 127,
        width: 625,
        height: 500,
      }),
    );
    const profile = draft.profile;
    const frame = draft.frame;
    const scale = draft.compositionScale;

    for (let index = 0; index < 500; index += 1) {
      draft = fixed(ordinary(draft));
    }

    expect(draft.profile).toBe(profile);
    expect(draft.frame).toBe(frame);
    expect(draft.frame).toEqual(frame);
    expect(draft.compositionScale).toBe(scale);
    expect(draft.center).toEqual(center(frame));
  });

  it("applies absolute scale around one stable center without cumulative drift", () => {
    const opened = fixed(openPageFrameEditDraft(ENTRY));
    const panned = panFixedPageFrame(
      opened,
      translate(opened.frame, 37.25, -19.5),
    );
    const anchor = panned.center;
    const first = setFixedPageCompositionScale(panned, 1.7);
    let repeated = first;

    for (let index = 0; index < 500; index += 1) {
      repeated = setFixedPageCompositionScale(repeated, 0.73);
      repeated = setFixedPageCompositionScale(repeated, 1.7);
    }

    expect(repeated.frame).toEqual(first.frame);
    expect(repeated.compositionScale).toBe(first.compositionScale);
    expect(repeated.center).toBe(anchor);
    expect(center(repeated.frame).x).toBeCloseTo(anchor.x, 13);
    expect(center(repeated.frame).y).toBeCloseTo(anchor.y, 13);
    expect(repeated.profile).toBe(PROFILE);
  });

  it("updates frame and center together when panning", () => {
    const draft = setFixedPageCompositionScale(
      fixed(openPageFrameEditDraft(ENTRY)),
      2,
    );
    const frame = translate(draft.frame, -125, 88);
    const panned = panFixedPageFrame(draft, frame);

    expect(panned.frame).toBe(frame);
    expect(panned.center).toEqual(center(frame));
    expect(panned.compositionScale).toBe(draft.compositionScale);
    expect(panned.profile).toBe(draft.profile);
    expect(() =>
      panFixedPageFrame(draft, { ...frame, width: frame.width + 1 }),
    ).toThrow(/must not change.*extents/);
  });

  it("produces the same anchor whether a pan occurs before or after scale", () => {
    const opened = fixed(openPageFrameEditDraft(ENTRY));

    const scaledFirst = setFixedPageCompositionScale(opened, 2.5);
    const scaleThenPan = panFixedPageFrame(
      scaledFirst,
      translate(scaledFirst.frame, 73, -51),
    );

    const pannedFirst = panFixedPageFrame(
      opened,
      translate(opened.frame, 73, -51),
    );
    const panThenScale = setFixedPageCompositionScale(pannedFirst, 2.5);

    expect(scaleThenPan.frame.x).toBeCloseTo(panThenScale.frame.x, 13);
    expect(scaleThenPan.frame.y).toBeCloseTo(panThenScale.frame.y, 13);
    expect(scaleThenPan.frame.width).toBe(panThenScale.frame.width);
    expect(scaleThenPan.frame.height).toBe(panThenScale.frame.height);
    expect(scaleThenPan.center.x).toBeCloseTo(panThenScale.center.x, 13);
    expect(scaleThenPan.center.y).toBeCloseTo(panThenScale.center.y, 13);
  });

  it("fits and recenters only when Reset is explicitly requested", () => {
    const opened = fixed(
      setScalePreservingPageFrame(openPageFrameEditDraft(ENTRY), {
        x: 170,
        y: -220,
        width: 500,
        height: 400,
      }),
    );

    expect(opened.frame).not.toEqual(opened.fitFrame);
    expect(opened.center).toEqual({ x: 420, y: -20 });

    const roundTrip = fixed(ordinary(opened));
    expect(roundTrip.frame).toBe(opened.frame);
    expect(roundTrip.center).toEqual(opened.center);

    const reset = resetFixedPageFrame(roundTrip);
    expect(reset.profile).toBe(roundTrip.profile);
    expect(reset.frame).toBe(roundTrip.fitFrame);
    expect(reset.compositionScale).toBe(1);
    expect(reset.center).toEqual(center(roundTrip.fitFrame));
    expect(resetFixedPageFrame(reset)).toBe(reset);
  });

  it("validates entry and discriminated-state invariants", () => {
    expect(() =>
      openPageFrameEditDraft({ ...ENTRY, generationAspect: 0 }),
    ).toThrow(/generationAspect must be a finite positive/);
    expect(() =>
      openPageFrameEditDraft({ ...ENTRY, generationAspect: 4 / 3 }),
    ).toThrow(/must match the frozen Composition Frame aspect/);
    expect(() =>
      openPageFrameEditDraft({
        ...ENTRY,
        representedFrame: { ...REPRESENTED_FRAME, height: 700 },
      }),
    ).toThrow(/equivalent physical scales/);

    const valid = fixed(openPageFrameEditDraft(ENTRY));
    expect(() =>
      validatePageFrameEditDraft({
        ...valid,
        compositionScale: valid.compositionScale * 2,
      }),
    ).toThrow(/compositionScale must match/);
    expect(() =>
      validatePageFrameEditDraft({
        ...valid,
        center: { x: valid.center.x + 1, y: valid.center.y },
      }),
    ).toThrow(/center must match/);
    expect(() =>
      validatePageFrameEditDraft({
        ...valid,
        fitFrame: { ...valid.fitFrame, x: valid.fitFrame.x + 1 },
      }),
    ).toThrow(/fitFrame must be the centered/);
  });
});
