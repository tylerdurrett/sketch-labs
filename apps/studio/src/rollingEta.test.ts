import { describe, expect, it } from "vitest";

import {
  createRollingEtaEstimator,
  type RollingEtaSample,
} from "./rollingEta";

function sample(
  timestampMs: number,
  completedWork: number,
  totalWork = 100,
): RollingEtaSample {
  return { timestampMs, completedWork, totalWork };
}

describe("rolling ETA", () => {
  it("waits for minimum elapsed time and positive observed work", () => {
    const eta = createRollingEtaEstimator({ minElapsedMs: 1_000, windowMs: 5_000 });

    expect(eta.estimate).toEqual({ kind: "estimating", revision: 0 });
    expect(eta.observe(sample(0, 0))).toEqual({ kind: "estimating", revision: 1 });
    expect(eta.observe(sample(999, 10))).toEqual({ kind: "estimating", revision: 2 });
    expect(eta.observe(sample(1_000, 20))).toEqual({
      kind: "remaining",
      revision: 3,
      remainingMs: 4_000,
    });
  });

  it("revises from the recent weighted-work rate instead of lifetime rate", () => {
    const eta = createRollingEtaEstimator({ minElapsedMs: 0, windowMs: 2_000 });

    eta.observe(sample(0, 0, 200));
    eta.observe(sample(1_000, 20, 200));
    eta.observe(sample(2_000, 40, 200));
    eta.observe(sample(3_000, 80, 200));
    expect(eta.observe(sample(4_000, 120, 200))).toEqual({
      kind: "remaining",
      revision: 5,
      // Window baseline is t=2s: 80 work / 2s, with 80 remaining.
      remainingMs: 2_000,
    });
  });

  it("keeps the last pre-window sample when reports are sparse", () => {
    const eta = createRollingEtaEstimator({ minElapsedMs: 0, windowMs: 500 });

    eta.observe(sample(0, 0));
    expect(eta.observe(sample(1_000, 25))).toEqual({
      kind: "remaining",
      revision: 2,
      remainingMs: 3_000,
    });
  });

  it("ignores duplicate, out-of-order, regressive, and changed-total samples", () => {
    const eta = createRollingEtaEstimator({ minElapsedMs: 0, windowMs: 1_000 });
    eta.observe(sample(0, 0));
    const current = eta.observe(sample(1_000, 20));

    expect(eta.observe(sample(1_000, 30))).toBe(current);
    expect(eta.observe(sample(999, 30))).toBe(current);
    expect(eta.observe(sample(2_000, 20))).toBe(current);
    expect(eta.observe(sample(2_000, 19))).toBe(current);
    expect(eta.observe(sample(2_000, 30, 101))).toBe(current);
    expect(eta.estimate).toBe(current);
  });

  it("ignores non-finite and negative observations without corrupting state", () => {
    const eta = createRollingEtaEstimator({ minElapsedMs: 0, windowMs: 1_000 });
    const initial = eta.estimate;

    expect(eta.observe(sample(Number.NaN, 0))).toBe(initial);
    expect(eta.observe(sample(0, Number.POSITIVE_INFINITY))).toBe(initial);
    expect(eta.observe(sample(0, 0, Number.NaN))).toBe(initial);
    expect(eta.observe(sample(0, -1))).toBe(initial);
    expect(eta.observe(sample(0, 0, -1))).toBe(initial);

    eta.observe(sample(0, 0, Number.MAX_VALUE));
    expect(eta.observe(sample(Number.MAX_VALUE, 1, Number.MAX_VALUE))).toEqual({
      kind: "estimating",
      revision: 2,
    });
  });

  it("completes zero-work and over-complete jobs immediately with finite zero", () => {
    const empty = createRollingEtaEstimator();
    expect(empty.observe(sample(10, 0, 0))).toEqual({
      kind: "remaining",
      revision: 1,
      remainingMs: 0,
    });

    const complete = createRollingEtaEstimator();
    expect(complete.observe(sample(10, 120, 100))).toEqual({
      kind: "remaining",
      revision: 1,
      remainingMs: 0,
    });
  });

  it("does not leak throughput or revisions between job instances", () => {
    const first = createRollingEtaEstimator({ minElapsedMs: 0 });
    first.observe(sample(0, 0));
    expect(first.observe(sample(1_000, 50)).kind).toBe("remaining");

    const second = createRollingEtaEstimator({ minElapsedMs: 0 });
    expect(second.estimate).toEqual({ kind: "estimating", revision: 0 });
    expect(second.observe(sample(1_000, 50))).toEqual({
      kind: "estimating",
      revision: 1,
    });
  });

  it("rejects option values that cannot define a time interval", () => {
    expect(() => createRollingEtaEstimator({ minElapsedMs: -1 })).toThrow(RangeError);
    expect(() => createRollingEtaEstimator({ minElapsedMs: Number.NaN })).toThrow(
      RangeError,
    );
    expect(() => createRollingEtaEstimator({ windowMs: 0 })).toThrow(RangeError);
    expect(() =>
      createRollingEtaEstimator({ windowMs: Number.POSITIVE_INFINITY }),
    ).toThrow(RangeError);
  });
});
