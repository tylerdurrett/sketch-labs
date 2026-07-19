import { describe, expect, it } from "vitest";

import {
  EDIT_HISTORY_LIMIT,
  beginEditTransaction,
  canRedo,
  canUndo,
  cancelEditTransaction,
  commitEditState,
  commitEditTransaction,
  createEditHistory,
  hasActiveTransaction,
  previewEditState,
  redoEdit,
  sameStudioEditState,
  undoEdit,
  type EditHistory,
  type StudioEditState,
} from "./editHistory";

/** Compile-time coverage for the snapshot contract's structural immutability. */
function assertReadonlySnapshot(state: StudioEditState): void {
  // @ts-expect-error History consumers cannot replace a top-level state axis.
  state.seed = 2;
  // @ts-expect-error Dynamic Parameter Schema values are readonly in snapshots.
  state.params.radius = 20;
  // @ts-expect-error The complete Plot Profile is readonly in snapshots.
  state.profile.width = 420;
  // @ts-expect-error Nested profile insets are readonly too.
  state.profile.insets.left = 25;
  // @ts-expect-error Locks expose no mutating Set operations.
  state.locks.add("radius");
}

void assertReadonlySnapshot;

function editState(
  seed: number,
  overrides: Partial<StudioEditState> = {},
): StudioEditState {
  return {
    params: { radius: 10, color: "#112233" },
    seed,
    locks: new Set(["radius"]),
    profile: {
      width: 210,
      height: 297,
      insets: { top: 10, right: 11, bottom: 12, left: 13 },
      includeFrame: true,
      toolWidthMillimeters: 0.3,
    },
    tolerance: 0,
    ...overrides,
  };
}

function commitSeed(history: EditHistory, seed: number): EditHistory {
  return commitEditState(history, editState(seed));
}

describe("edit history", () => {
  it("traverses committed edits in order and suppresses no-op commits", () => {
    const initial = editState(0);
    const unchanged = commitEditState(createEditHistory(initial), editState(0));
    const committed = commitSeed(commitSeed(unchanged, 1), 2);

    expect(unchanged).toEqual(createEditHistory(initial));
    expect(canUndo(committed)).toBe(true);
    expect(canRedo(committed)).toBe(false);

    const atOne = undoEdit(committed);
    const atInitial = undoEdit(atOne);
    expect(atOne.present.seed).toBe(1);
    expect(atInitial.present.seed).toBe(0);
    expect(undoEdit(atInitial)).toBe(atInitial);

    const redone = redoEdit(redoEdit(atInitial));
    expect(redone.present.seed).toBe(2);
    expect(redoEdit(redone)).toBe(redone);
  });

  it("clears the redo branch when a new edit is committed after Undo", () => {
    const history = commitSeed(commitSeed(createEditHistory(editState(0)), 1), 2);
    const branched = commitSeed(undoEdit(history), 3);

    expect(branched.present.seed).toBe(3);
    expect(branched.past.map((state) => state.seed)).toEqual([0, 1]);
    expect(branched.future).toEqual([]);
    expect(canRedo(branched)).toBe(false);
  });

  it("retains only the latest 100 committed edits", () => {
    let history = createEditHistory(editState(0));
    for (let seed = 1; seed <= EDIT_HISTORY_LIMIT + 5; seed += 1) {
      history = commitSeed(history, seed);
    }

    expect(history.past).toHaveLength(EDIT_HISTORY_LIMIT);
    expect(history.past[0]?.seed).toBe(5);
    expect(history.past.at(-1)?.seed).toBe(104);

    for (let count = 0; count < EDIT_HISTORY_LIMIT; count += 1) {
      history = undoEdit(history);
    }
    expect(history.present.seed).toBe(5);
    expect(canUndo(history)).toBe(false);
  });

  it("coalesces many previews into one whole-state commit", () => {
    const initial = editState(0);
    let history = beginEditTransaction(createEditHistory(initial));
    const start = history.transactionStart;
    history = beginEditTransaction(history);
    expect(history.transactionStart).toBe(start);
    expect(hasActiveTransaction(history)).toBe(true);

    history = previewEditState(history, editState(0, { tolerance: 0.1 }));
    history = previewEditState(history, editState(0, { tolerance: 0.6 }));
    history = previewEditState(history, editState(0, { tolerance: 1.25 }));
    history = commitEditTransaction(history);

    expect(history.present.tolerance).toBe(1.25);
    expect(history.past).toEqual([initial]);
    expect(hasActiveTransaction(history)).toBe(false);
    expect(undoEdit(history).present).toBe(initial);
  });

  it("restores the complete transaction-start state on cancel without an entry", () => {
    const initial = editState(7);
    let history = beginEditTransaction(createEditHistory(initial));
    history = previewEditState(
      history,
      editState(8, {
        params: { radius: 99, futureParam: "automatic" },
        locks: new Set(["futureParam"]),
        tolerance: 1.5,
      }),
    );
    history = cancelEditTransaction(history);

    expect(history.present).toBe(initial);
    expect(history.past).toEqual([]);
    expect(history.future).toEqual([]);
    expect(hasActiveTransaction(history)).toBe(false);
    expect(cancelEditTransaction(history)).toBe(history);
  });

  it("records a multi-axis atomic command once and suppresses an equal command", () => {
    const initial = editState(1);
    const preset = editState(2, {
      params: { radius: 24, newlyAddedSchemaParam: 3 },
      locks: new Set(["newlyAddedSchemaParam"]),
      profile: {
        width: 420,
        height: 210,
        insets: { top: 1, right: 2, bottom: 3, left: 4 },
        includeFrame: false,
        toolWidthMillimeters: 0.5,
      },
      tolerance: 0.75,
    });

    const committed = commitEditState(createEditHistory(initial), preset);
    const unchanged = commitEditState(committed, editState(2, preset));

    expect(committed.past).toEqual([initial]);
    expect(committed.present).toBe(preset);
    expect(unchanged).toBe(committed);
  });

  it("undoes and redoes an Image Asset ID as exact authored state", () => {
    const initialAsset = "portrait-alpha-000000000001";
    const unresolvedAsset = "missing/opaque ID?variant=🌲";
    const initial = editState(1, {
      params: { imageAsset: initialAsset, toneGamma: 0.5 },
    });
    const selected = editState(1, {
      params: { imageAsset: unresolvedAsset, toneGamma: 0.5 },
    });

    const committed = commitEditState(createEditHistory(initial), selected);

    expect(committed.past).toEqual([initial]);
    expect(committed.present.params.imageAsset).toBe(unresolvedAsset);
    expect(undoEdit(committed).present.params.imageAsset).toBe(initialAsset);
    expect(redoEdit(undoEdit(committed)).present.params.imageAsset).toBe(
      unresolvedAsset,
    );
    expect(sameStudioEditState(initial, selected)).toBe(false);
  });
});

describe("Studio edit-state equality", () => {
  it("covers dynamic params and ignores Set identity and insertion order", () => {
    const left = editState(1, {
      params: { alpha: 1, futureSchemaEntry: "yes" },
      locks: new Set(["alpha", "futureSchemaEntry"]),
    });
    const right = editState(1, {
      params: { futureSchemaEntry: "yes", alpha: 1 },
      locks: new Set(["futureSchemaEntry", "alpha"]),
    });

    expect(sameStudioEditState(left, right)).toBe(true);
    expect(
      sameStudioEditState(left, {
        ...right,
        params: { ...right.params, futureSchemaEntry: "changed" },
      }),
    ).toBe(false);
    expect(
      sameStudioEditState(left, { ...right, locks: new Set(["alpha"]) }),
    ).toBe(false);
  });

  it.each([
    ["seed", (state: StudioEditState) => ({ ...state, seed: 2 })],
    [
      "width",
      (state: StudioEditState) => ({
        ...state,
        profile: { ...state.profile, width: 211 },
      }),
    ],
    [
      "height",
      (state: StudioEditState) => ({
        ...state,
        profile: { ...state.profile, height: 298 },
      }),
    ],
    ...(["top", "right", "bottom", "left"] as const).map(
      (edge) =>
        [
          `inset ${edge}`,
          (state: StudioEditState) => ({
            ...state,
            profile: {
              ...state.profile,
              insets: { ...state.profile.insets, [edge]: 99 },
            },
          }),
        ] as const,
    ),
    [
      "composition frame",
      (state: StudioEditState) => ({
        ...state,
        profile: { ...state.profile, includeFrame: false },
      }),
    ],
    [
      "tolerance",
      (state: StudioEditState) => ({ ...state, tolerance: 0.25 }),
    ],
  ] as const)("detects a changed %s", (_label, change) => {
    const state = editState(1);
    expect(sameStudioEditState(state, change(state))).toBe(false);
  });
});
