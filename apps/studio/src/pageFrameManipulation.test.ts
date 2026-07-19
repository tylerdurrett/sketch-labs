import { describe, expect, it } from "vitest";
import type { PageFrame } from "@harness/core";

import {
  MIN_PAGE_FRAME_EXTENT,
  beginPageFrameManipulation,
  cancelPageFrameManipulation,
  finishPageFrameManipulation,
  updatePageFrameManipulation,
  type PageFrameAspectConstraint,
  type PageFrameManipulationState,
  type PageFrameResizeHandle,
} from "./pageFrameManipulation";

const FREE: PageFrameAspectConstraint = { kind: "free" };
const START = Object.freeze({ x: 10, y: 20, width: 100, height: 80 });
const POINTER = Object.freeze({ x: 200, y: 300 });

function begin(
  handle: PageFrameResizeHandle,
  options: {
    readonly frame?: PageFrame;
    readonly constraint?: PageFrameAspectConstraint;
    readonly shiftKey?: boolean;
  } = {},
): PageFrameManipulationState {
  return beginPageFrameManipulation({
    frame: options.frame ?? START,
    target: { kind: "resize", handle },
    pointer: POINTER,
    constraint: options.constraint ?? FREE,
    shiftKey: options.shiftKey ?? false,
  });
}

describe("free Page Frame resize", () => {
  it.each<readonly [PageFrameResizeHandle, object]>([
    ["top-left", { x: 20, y: 25, width: 90, height: 75 }],
    ["top", { x: 10, y: 25, width: 100, height: 75 }],
    ["top-right", { x: 10, y: 25, width: 110, height: 75 }],
    ["right", { x: 10, y: 20, width: 110, height: 80 }],
    ["bottom-right", { x: 10, y: 20, width: 110, height: 85 }],
    ["bottom", { x: 10, y: 20, width: 100, height: 85 }],
    ["bottom-left", { x: 20, y: 20, width: 90, height: 85 }],
    ["left", { x: 20, y: 20, width: 90, height: 80 }],
  ])("moves the %s handle in its expected directions", (handle, expected) => {
    const state = updatePageFrameManipulation(
      begin(handle),
      { x: POINTER.x + 10, y: POINTER.y + 5 },
      false,
    );

    expect(state.frame).toEqual(expected);
  });

  it.each<readonly [PageFrameResizeHandle, readonly [number, number]]>([
    ["top-left", [110, 100]],
    ["top-right", [10, 100]],
    ["bottom-right", [10, 20]],
    ["bottom-left", [110, 20]],
  ])("keeps the opposite corner fixed for %s", (handle, anchor) => {
    const state = updatePageFrameManipulation(
      begin(handle),
      { x: POINTER.x - 23, y: POINTER.y + 17 },
      false,
    );
    const movingRight = handle.endsWith("right");
    const movingBottom = handle.startsWith("bottom");
    const oppositeX = movingRight
      ? state.frame.x
      : state.frame.x + state.frame.width;
    const oppositeY = movingBottom
      ? state.frame.y
      : state.frame.y + state.frame.height;

    expect([oppositeX, oppositeY]).toEqual(anchor);
  });

  it("clamps moving edges before they cross their fixed opposites", () => {
    const left = updatePageFrameManipulation(
      begin("left"),
      { x: POINTER.x + 1_000, y: POINTER.y },
      false,
    ).frame;
    const bottomRight = updatePageFrameManipulation(
      begin("bottom-right"),
      { x: POINTER.x - 1_000, y: POINTER.y - 1_000 },
      false,
    ).frame;

    expect(left.x + left.width).toBe(110);
    expect(left.width).toBeCloseTo(MIN_PAGE_FRAME_EXTENT, 12);
    expect(bottomRight.x).toBe(10);
    expect(bottomRight.y).toBe(20);
    expect(bottomRight.width).toBeCloseTo(MIN_PAGE_FRAME_EXTENT, 12);
    expect(bottomRight.height).toBeCloseTo(MIN_PAGE_FRAME_EXTENT, 12);
  });

  it("lets a pre-existing sub-floor frame grow outward without snapping", () => {
    const tiny = Object.freeze({ x: -4, y: 7, width: 1e-9, height: 2e-9 });
    const grown = updatePageFrameManipulation(
      begin("bottom-right", { frame: tiny }),
      { x: POINTER.x + 2, y: POINTER.y + 3 },
      false,
    ).frame;
    const crossed = updatePageFrameManipulation(
      begin("top-left", { frame: tiny }),
      { x: POINTER.x + 50, y: POINTER.y + 50 },
      false,
    ).frame;

    expect(grown).toEqual({
      x: -4,
      y: 7,
      width: 2.000000001,
      height: 3.000000002,
    });
    expect(crossed.x + crossed.width).toBe(tiny.x + tiny.width);
    expect(crossed.y + crossed.height).toBe(tiny.y + tiny.height);
    expect(crossed.width).toBeCloseTo(tiny.width, 14);
    expect(crossed.height).toBeCloseTo(tiny.height, 14);
  });
});

describe("aspect-constrained Page Frame resize", () => {
  it("uses the start aspect when Shift is already held", () => {
    const resized = updatePageFrameManipulation(
      begin("bottom-right", { shiftKey: true }),
      { x: POINTER.x + 50, y: POINTER.y + 4 },
      true,
    ).frame;

    expect(resized).toEqual({ x: 10, y: 20, width: 150, height: 120 });
    expect(resized.width / resized.height).toBe(START.width / START.height);
  });

  it.each<readonly [PageFrameResizeHandle, { x: number; y: number }, object]>([
    ["top-left", { x: -20, y: -1 }, { x: -10, y: 4, width: 120, height: 96 }],
    ["top-right", { x: 30, y: -1 }, { x: 10, y: -4, width: 130, height: 104 }],
    [
      "bottom-right",
      { x: 30, y: 1 },
      { x: 10, y: 20, width: 130, height: 104 },
    ],
    [
      "bottom-left",
      { x: -20, y: 1 },
      { x: -10, y: 20, width: 120, height: 96 },
    ],
  ])(
    "keeps the opposite corner fixed for constrained %s",
    (handle, delta, expected) => {
      const resized = updatePageFrameManipulation(
        begin(handle, { shiftKey: true }),
        { x: POINTER.x + delta.x, y: POINTER.y + delta.y },
        true,
      ).frame;

      expect(resized).toEqual(expected);
    },
  );

  it.each<readonly [PageFrameResizeHandle, { x: number; y: number }, object]>([
    ["left", { x: -20, y: 99 }, { x: -10, y: 30, width: 120, height: 60 }],
    ["right", { x: 20, y: 99 }, { x: 10, y: 30, width: 120, height: 60 }],
    ["top", { x: 99, y: -10 }, { x: -30, y: 10, width: 180, height: 90 }],
    ["bottom", { x: 99, y: 10 }, { x: -30, y: 20, width: 180, height: 90 }],
  ])(
    "centers the orthogonal dimension for a ratio-constrained %s edge",
    (handle, delta, expected) => {
      const resized = updatePageFrameManipulation(
        begin(handle, { constraint: { kind: "ratio", ratio: 2 } }),
        { x: POINTER.x + delta.x, y: POINTER.y + delta.y },
        false,
      ).frame;

      expect(resized).toEqual(expected);
    },
  );

  it("rebases false-to-true-to-false Shift transitions without jumps", () => {
    let state = updatePageFrameManipulation(
      begin("bottom-right"),
      { x: POINTER.x + 20, y: POINTER.y + 10 },
      false,
    );
    expect(state.frame).toEqual({ x: 10, y: 20, width: 120, height: 90 });

    const constrainedStart = updatePageFrameManipulation(
      state,
      { x: POINTER.x + 30, y: POINTER.y + 20 },
      true,
    );
    expect(constrainedStart.frame).toBe(state.frame);

    state = updatePageFrameManipulation(
      constrainedStart,
      { x: POINTER.x + 50, y: POINTER.y + 20 },
      true,
    );
    expect(state.frame).toEqual({ x: 10, y: 20, width: 140, height: 105 });

    const freeStart = updatePageFrameManipulation(
      state,
      { x: POINTER.x + 60, y: POINTER.y + 30 },
      false,
    );
    expect(freeStart.frame).toBe(state.frame);

    state = updatePageFrameManipulation(
      freeStart,
      { x: POINTER.x + 70, y: POINTER.y + 35 },
      false,
    );
    expect(state.frame).toEqual({ x: 10, y: 20, width: 150, height: 110 });
  });

  it("gives a persistent ratio precedence over Shift", () => {
    let state = updatePageFrameManipulation(
      begin("right", { constraint: { kind: "ratio", ratio: 2 } }),
      { x: POINTER.x + 20, y: POINTER.y },
      false,
    );
    expect(state.frame).toEqual({ x: 10, y: 30, width: 120, height: 60 });

    state = updatePageFrameManipulation(
      state,
      { x: POINTER.x + 20, y: POINTER.y },
      true,
    );
    expect(state.frame).toEqual({ x: 10, y: 30, width: 120, height: 60 });

    state = updatePageFrameManipulation(
      state,
      { x: POINTER.x + 30, y: POINTER.y },
      true,
    );
    expect(state.frame).toEqual({ x: 10, y: 27.5, width: 130, height: 65 });
  });
});

describe("Page Frame pan and gesture safety", () => {
  it("stores interior pan solely as an inverse Page Frame position", () => {
    const state = beginPageFrameManipulation({
      frame: START,
      target: { kind: "pan" },
      pointer: POINTER,
      constraint: { kind: "ratio", ratio: 16 / 9 },
      shiftKey: true,
    });
    const moved = updatePageFrameManipulation(
      state,
      { x: POINTER.x + 25, y: POINTER.y - 15 },
      false,
    );

    expect(moved.frame).toEqual({ x: -15, y: 35, width: 100, height: 80 });
    expect(Object.keys(moved.frame).sort()).toEqual([
      "height",
      "width",
      "x",
      "y",
    ]);
  });

  it("returns the latest frame on finish and the exact start frame on cancel", () => {
    const state = begin("right");
    const changed = updatePageFrameManipulation(
      state,
      { x: POINTER.x + 25, y: POINTER.y },
      false,
    );

    expect(finishPageFrameManipulation(changed)).toBe(changed.frame);
    expect(cancelPageFrameManipulation(changed)).toBe(state.startFrame);
    expect(cancelPageFrameManipulation(changed)).toEqual(START);
  });

  it("rejects invalid starts and aspect constraints", () => {
    expect(() =>
      beginPageFrameManipulation({
        frame: { ...START, width: Number.NaN },
        target: { kind: "pan" },
        pointer: POINTER,
        constraint: FREE,
        shiftKey: false,
      }),
    ).toThrow(/width must be a finite positive number/);
    expect(() =>
      beginPageFrameManipulation({
        frame: START,
        target: { kind: "pan" },
        pointer: { x: Number.POSITIVE_INFINITY, y: 0 },
        constraint: FREE,
        shiftKey: false,
      }),
    ).toThrow(/pointer coordinates must be finite/);
    expect(() =>
      beginPageFrameManipulation({
        frame: START,
        target: { kind: "resize", handle: "right" },
        pointer: POINTER,
        constraint: { kind: "ratio", ratio: 0 },
        shiftKey: false,
      }),
    ).toThrow(/aspect ratio must be a finite positive number/);
  });

  it("retains the last valid state after a non-finite update and recovers", () => {
    const start = begin("right");
    const ordinary = updatePageFrameManipulation(
      start,
      { x: POINTER.x + 10, y: POINTER.y },
      false,
    );
    const nonFinite = updatePageFrameManipulation(
      ordinary,
      { x: Number.NaN, y: POINTER.y },
      false,
    );
    expect(nonFinite).toBe(ordinary);

    const recovered = updatePageFrameManipulation(
      nonFinite,
      { x: POINTER.x + 30, y: POINTER.y },
      false,
    );
    expect(recovered.frame).toEqual({ x: 10, y: 20, width: 130, height: 80 });
  });

  it("recovers from extreme constrained arithmetic that cannot form a valid frame", () => {
    const start = begin("bottom", {
      constraint: { kind: "ratio", ratio: Number.MAX_VALUE },
    });
    const invalid = updatePageFrameManipulation(
      start,
      { x: POINTER.x, y: POINTER.y + Number.MAX_VALUE },
      false,
    );
    expect(invalid).toBe(start);

    const recovered = updatePageFrameManipulation(
      invalid,
      { x: POINTER.x, y: POINTER.y },
      false,
    );
    expect(recovered.frame).toBe(start.frame);
  });
});
