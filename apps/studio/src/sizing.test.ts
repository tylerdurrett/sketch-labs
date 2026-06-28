import { describe, expect, it } from "vitest";

import { sizeToBox } from "./LiveCanvas";

/**
 * `sizeToBox` is the backing-store dedup primitive: it sizes a canvas's backing
 * store to its CSS box × `dpr` and returns whether it ACTUALLY changed anything.
 * The no-op guard is the load-bearing bit — reassigning `canvas.width`/`height`
 * (even to the same value) clears the backing store, so callers rely on the
 * `false` return to skip a redundant clear. These tests exercise only the
 * structural shape the function reads (`width`/`height`/`getBoundingClientRect`)
 * via a DOM-free stub cast, so the dedup math is verified without a real canvas.
 */
describe("sizeToBox", () => {
  it("sizes the backing store to round(cssW*dpr) x round(cssH*dpr) and returns true on first fit", () => {
    // A 100×50 CSS box at dpr 2 → a 200×100 device-pixel backing store. The store
    // starts at 0×0 (unsized), so this is a real change: assign and return true.
    const stub = {
      width: 0,
      height: 0,
      getBoundingClientRect: () => ({ width: 100, height: 50 }),
    } as unknown as HTMLCanvasElement;

    expect(sizeToBox(stub, 2)).toBe(true);
    expect(stub.width).toBe(200);
    expect(stub.height).toBe(100);
  });

  it("returns false and leaves the backing store untouched when already sized (no redundant clear)", () => {
    // Prove the no-op without spying on a plain property: pre-set width/height to
    // exactly the target dimensions (100×50 @ dpr 1). sizeToBox must detect the
    // match, return false, and NOT reassign — reassignment would clear the store.
    const stub = {
      width: 100,
      height: 50,
      getBoundingClientRect: () => ({ width: 100, height: 50 }),
    } as unknown as HTMLCanvasElement;

    expect(sizeToBox(stub, 1)).toBe(false);
    expect(stub.width).toBe(100);
    expect(stub.height).toBe(50);
  });

  it("returns true and updates the store when the dimensions differ", () => {
    // The complement of the no-op case: a store whose dimensions do NOT match the
    // target (here 50×50, but the box at dpr 1 wants 100×50) is a real change, so
    // sizeToBox reassigns both axes and returns true.
    const stub = {
      width: 50,
      height: 50,
      getBoundingClientRect: () => ({ width: 100, height: 50 }),
    } as unknown as HTMLCanvasElement;

    expect(sizeToBox(stub, 1)).toBe(true);
    expect(stub.width).toBe(100);
    expect(stub.height).toBe(50);
  });

  it("re-fits on a DPR change with the same CSS box (returns true, updates the store)", () => {
    // A pure DPR change (same CSS box, different device-pixel ratio) changes the
    // backing-store dimensions: a store sized for dpr 2 (200×100) dropping to dpr
    // 1 wants 100×50, so sizeToBox detects the mismatch, resizes, and returns true.
    const stub = {
      width: 200,
      height: 100,
      getBoundingClientRect: () => ({ width: 100, height: 50 }),
    } as unknown as HTMLCanvasElement;

    expect(sizeToBox(stub, 1)).toBe(true);
    expect(stub.width).toBe(100);
    expect(stub.height).toBe(50);
  });

  it("rounds a fractional cssW*dpr with Math.round", () => {
    // Device pixels are integral, so a fractional CSS-box × dpr product is rounded.
    // 100×50 @ dpr 1.5 → 150×75 exactly; 33×33 @ dpr 1.5 → 49.5×49.5 → round → 50×50.
    const stub = {
      width: 0,
      height: 0,
      getBoundingClientRect: () => ({ width: 33, height: 33 }),
    } as unknown as HTMLCanvasElement;

    expect(sizeToBox(stub, 1.5)).toBe(true);
    expect(stub.width).toBe(50); // round(49.5) = 50
    expect(stub.height).toBe(50);
  });
});
