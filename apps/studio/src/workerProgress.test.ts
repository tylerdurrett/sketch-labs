import { describe, expect, it, vi } from "vitest";

import { createWorkerProgressEmitter } from "./workerProgress";

interface ProgressSnapshot {
  readonly value: number;
  readonly terminal: boolean;
}

describe("worker progress emitter", () => {
  it("emits the initial snapshot and then at most once per 100ms interval", () => {
    const emitted: ProgressSnapshot[] = [];
    const clock = [1_000, 1_025, 1_099, 1_100, 1_150];
    const report = createWorkerProgressEmitter(
      (snapshot: ProgressSnapshot) => emitted.push(snapshot),
      () => clock.shift()!,
    );

    for (const value of [1, 2, 3, 4, 5]) {
      report({ value, terminal: false });
    }

    expect(emitted).toEqual([
      { value: 1, terminal: false },
      { value: 4, terminal: false },
    ]);
  });

  it("always emits terminal snapshots without sampling or changing the clock", () => {
    const emitted: ProgressSnapshot[] = [];
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(50);
    const report = createWorkerProgressEmitter(
      (snapshot: ProgressSnapshot) => emitted.push(snapshot),
      now,
    );

    report({ value: 0, terminal: true });
    report({ value: 1, terminal: false });
    report({ value: 2, terminal: true });
    report({ value: 3, terminal: false });

    expect(emitted).toEqual([
      { value: 0, terminal: true },
      { value: 1, terminal: false },
      { value: 2, terminal: true },
    ]);
    expect(now).toHaveBeenCalledTimes(2);
  });
});
