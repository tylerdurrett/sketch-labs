import type { PageFrame, Params, PlotProfile, Seed } from "@harness/core";

/** The maximum number of committed edit states retained for Undo. */
export const EDIT_HISTORY_LIMIT = 100;

/** Plot Profile as stored in a history snapshot, including readonly insets. */
export type StudioEditProfile = Readonly<Omit<PlotProfile, "insets">> & {
  readonly insets: Readonly<PlotProfile["insets"]>;
};

/** Pair-safe absence or committed Page Frame with its frozen generation basis. */
export type StudioFramingState =
  | { readonly kind: "unframed" }
  | {
      readonly kind: "framed";
      readonly pageFrame: Readonly<PageFrame>;
      readonly generationAspect: number;
      readonly aspectLocked: boolean;
    };

/**
 * The complete authored state of one mounted Sketch session.
 *
 * Adding an undoable Studio setting means adding it here. Transient navigation,
 * preview, transport, and presentation preferences deliberately live elsewhere.
 */
export interface StudioEditState {
  readonly params: Readonly<Params>;
  readonly seed: Seed;
  readonly locks: ReadonlySet<string>;
  readonly profile: StudioEditProfile;
  readonly framing: StudioFramingState;
  readonly tolerance: number;
}

/**
 * Shared control-level transaction boundary. Continuous controls may preview
 * many values between one begin and commit; Escape-capable controls cancel.
 */
export interface EditTransactionLifecycle<Value> {
  onBegin: () => void;
  onPreview: (value: Value) => void;
  onCommit: () => void;
  onCancel: () => void;
}

/** Immutable history for the currently mounted Sketch session. */
export interface EditHistory {
  readonly past: readonly StudioEditState[];
  readonly present: StudioEditState;
  readonly future: readonly StudioEditState[];
  readonly transactionStart: StudioEditState | null;
}

/** Start a fresh in-memory history at the mounted session state. */
export function createEditHistory(present: StudioEditState): EditHistory {
  return { past: [], present, future: [], transactionStart: null };
}

/** Whether a committed earlier state is available. */
export function canUndo(history: EditHistory): boolean {
  return history.past.length > 0;
}

/** Whether a committed later state is available. */
export function canRedo(history: EditHistory): boolean {
  return history.future.length > 0;
}

/** Whether a control currently owns a whole-state transaction. */
export function hasActiveTransaction(history: EditHistory): boolean {
  return history.transactionStart !== null;
}

/** Snapshot the whole present once. Repeated begin signals are idempotent. */
export function beginEditTransaction(history: EditHistory): EditHistory {
  if (hasActiveTransaction(history)) return history;
  return { ...history, transactionStart: history.present };
}

/** Update the live authored state without creating a history entry. */
export function previewEditState(
  history: EditHistory,
  present: StudioEditState,
): EditHistory {
  if (sameStudioEditState(history.present, present)) return history;
  return { ...history, present };
}

/**
 * Finish the active transaction, recording its starting state exactly once.
 * A transaction that finishes where it began creates no history entry.
 */
export function commitEditTransaction(history: EditHistory): EditHistory {
  const start = history.transactionStart;
  if (start === null) return history;
  if (sameStudioEditState(start, history.present)) {
    return { ...history, present: start, transactionStart: null };
  }
  return recordCommit(history, start, history.present);
}

/** Restore the whole transaction-start state without creating an entry. */
export function cancelEditTransaction(history: EditHistory): EditHistory {
  const start = history.transactionStart;
  if (start === null) return history;
  return { ...history, present: start, transactionStart: null };
}

/**
 * Commit one atomic command, even when it changes several authored axes.
 * Commands that leave the complete state unchanged are suppressed.
 */
export function commitEditState(
  history: EditHistory,
  present: StudioEditState,
): EditHistory {
  const start = history.transactionStart ?? history.present;
  if (sameStudioEditState(start, present)) {
    if (history.transactionStart === null) return history;
    return { ...history, present: start, transactionStart: null };
  }
  return recordCommit(history, start, present);
}

/** Restore the previous committed whole state. */
export function undoEdit(history: EditHistory): EditHistory {
  if (!canUndo(history)) return history;
  const present = history.transactionStart ?? history.present;
  const previous = history.past.at(-1)!;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [present, ...history.future],
    transactionStart: null,
  };
}

/** Restore the next committed whole state. */
export function redoEdit(history: EditHistory): EditHistory {
  if (!canRedo(history)) return history;
  const present = history.transactionStart ?? history.present;
  const [next, ...future] = history.future;
  return {
    past: appendPast(history.past, present),
    present: next!,
    future,
    transactionStart: null,
  };
}

/** Compare every authored axis, independent of object and Set identity. */
export function sameStudioEditState(
  left: StudioEditState,
  right: StudioEditState,
): boolean {
  return (
    sameParams(left.params, right.params) &&
    Object.is(left.seed, right.seed) &&
    sameLocks(left.locks, right.locks) &&
    sameProfile(left.profile, right.profile) &&
    sameFraming(left.framing, right.framing) &&
    Object.is(left.tolerance, right.tolerance)
  );
}

function recordCommit(
  history: EditHistory,
  start: StudioEditState,
  present: StudioEditState,
): EditHistory {
  return {
    past: appendPast(history.past, start),
    present,
    future: [],
    transactionStart: null,
  };
}

function appendPast(
  past: readonly StudioEditState[],
  state: StudioEditState,
): readonly StudioEditState[] {
  const next = [...past, state];
  return next.length > EDIT_HISTORY_LIMIT
    ? next.slice(next.length - EDIT_HISTORY_LIMIT)
    : next;
}

function sameParams(left: Readonly<Params>, right: Readonly<Params>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(right, key) && Object.is(left[key], right[key]),
    )
  );
}

function sameLocks(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return left.size === right.size && [...left].every((key) => right.has(key));
}

function sameProfile(
  left: StudioEditProfile,
  right: StudioEditProfile,
): boolean {
  return (
    Object.is(left.width, right.width) &&
    Object.is(left.height, right.height) &&
    Object.is(left.insets.top, right.insets.top) &&
    Object.is(left.insets.right, right.insets.right) &&
    Object.is(left.insets.bottom, right.insets.bottom) &&
    Object.is(left.insets.left, right.insets.left) &&
    left.includeFrame === right.includeFrame &&
    Object.is(left.toolWidthMillimeters, right.toolWidthMillimeters)
  );
}

function sameFraming(
  left: StudioFramingState,
  right: StudioFramingState,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "unframed" || right.kind === "unframed") return true;
  return (
    Object.is(left.pageFrame.x, right.pageFrame.x) &&
    Object.is(left.pageFrame.y, right.pageFrame.y) &&
    Object.is(left.pageFrame.width, right.pageFrame.width) &&
    Object.is(left.pageFrame.height, right.pageFrame.height) &&
    Object.is(left.generationAspect, right.generationAspect) &&
    left.aspectLocked === right.aspectLocked
  );
}
