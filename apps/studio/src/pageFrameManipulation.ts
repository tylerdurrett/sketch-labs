/** Pure direct-manipulation geometry for the transient Page Frame draft. */

import {
  validatePageFrame,
  type CoordinateSpace,
  type PageFrame,
} from "@harness/core";

/**
 * Fraction of the Composition axis used as the baseline crossing floor.
 *
 * The effective floor also includes eight ULPs at the fixed edge's coordinate,
 * keeping the two edges representably distinct at very large origins. Existing
 * valid frames smaller than that combined floor remain usable: a gesture uses
 * their current extent, so beginning a drag never enlarges a tiny frame.
 */
export const PAGE_FRAME_MIN_EXTENT_FRACTION = 1e-6;

export const PAGE_FRAME_RESIZE_HANDLES = [
  "top-left",
  "top",
  "top-right",
  "right",
  "bottom-right",
  "bottom",
  "bottom-left",
  "left",
] as const;

export type PageFrameResizeHandle = (typeof PAGE_FRAME_RESIZE_HANDLES)[number];

export type PageFrameManipulationTarget =
  | { readonly kind: "pan" }
  | {
      readonly kind: "resize";
      readonly handle: PageFrameResizeHandle;
    };

/** Persistent toolbar choice. Common and custom ratios share the same math. */
export type PageFrameAspectConstraint =
  | { readonly kind: "free" }
  | { readonly kind: "ratio"; readonly ratio: number };

export interface PageFramePointer {
  readonly x: number;
  readonly y: number;
}

/**
 * Immutable, caller-owned state for one pointer gesture.
 *
 * `frame` is the only draft transform produced by this module. In particular,
 * pan is represented by inverse changes to `frame.x/y`, never by a second
 * persisted composition transform. `startFrame` is retained for exact cancel.
 */
export interface PageFrameManipulationState {
  readonly target: PageFrameManipulationTarget;
  readonly constraint: PageFrameAspectConstraint;
  readonly compositionFrame: CoordinateSpace;
  readonly startFrame: PageFrame;
  readonly frame: PageFrame;
  readonly anchorFrame: PageFrame;
  readonly anchorPointer: PageFramePointer;
  readonly shiftKey: boolean;
}

export interface BeginPageFrameManipulation {
  readonly frame: PageFrame;
  readonly target: PageFrameManipulationTarget;
  readonly pointer: PageFramePointer;
  readonly constraint: PageFrameAspectConstraint;
  readonly compositionFrame: CoordinateSpace;
  readonly shiftKey: boolean;
}

/** Validate and begin a gesture without changing the supplied frame. */
export function beginPageFrameManipulation({
  frame,
  target,
  pointer,
  constraint,
  compositionFrame,
  shiftKey,
}: BeginPageFrameManipulation): PageFrameManipulationState {
  validatePageFrame(frame);
  validatePointer(pointer, "beginPageFrameManipulation");
  validateTarget(target);
  validateConstraint(constraint);
  validateCompositionFrame(compositionFrame);

  const startFrame = freezeFrame(frame);
  return Object.freeze({
    target: freezeTarget(target),
    constraint: freezeConstraint(constraint),
    compositionFrame: Object.freeze({ ...compositionFrame }),
    startFrame,
    frame: startFrame,
    anchorFrame: startFrame,
    anchorPointer: freezePointer(pointer),
    shiftKey,
  });
}

/**
 * Reduce one pointer update into the next valid draft frame.
 *
 * Non-finite pointers and arithmetic overflow leave the entire state at its
 * last valid value, so a later ordinary event recovers naturally. When Shift
 * changes the current frame and pointer are instead adopted as new anchors;
 * that event cannot jump the geometry. A persistent ratio always wins over
 * temporary Shift, so Shift transitions do not rebase ratio-constrained drags.
 */
export function updatePageFrameManipulation(
  state: PageFrameManipulationState,
  pointer: PageFramePointer,
  shiftKey: boolean,
): PageFrameManipulationState {
  if (!isFinitePointer(pointer)) return state;

  const currentRatio = activeAspectRatio(state);
  const nextRatio = activeAspectRatio({ ...state, shiftKey });
  if (currentRatio !== nextRatio) {
    return rebaseGesture(state, pointer, shiftKey);
  }

  const frame = manipulateFrame(state, pointer, nextRatio);
  if (frame === null) return state;

  if (frame === state.frame && shiftKey === state.shiftKey) return state;
  return Object.freeze({ ...state, frame, shiftKey });
}

/** Return the latest valid Page Frame when the pointer gesture finishes. */
export function finishPageFrameManipulation(
  state: PageFrameManipulationState,
): PageFrame {
  return state.frame;
}

/** Return the exact valid Page Frame captured before the gesture began. */
export function cancelPageFrameManipulation(
  state: PageFrameManipulationState,
): PageFrame {
  return state.startFrame;
}

function manipulateFrame(
  state: PageFrameManipulationState,
  pointer: PageFramePointer,
  ratio: number | null,
): PageFrame | null {
  const dx = pointer.x - state.anchorPointer.x;
  const dy = pointer.y - state.anchorPointer.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;

  const candidate =
    state.target.kind === "pan"
      ? panFrame(state.anchorFrame, dx, dy)
      : resizeFrame(
          state.anchorFrame,
          state.compositionFrame,
          state.target.handle,
          dx,
          dy,
          ratio,
        );
  if (candidate === null) return null;

  try {
    validatePageFrame(candidate);
  } catch {
    return null;
  }
  return freezeFrame(candidate);
}

function panFrame(frame: PageFrame, dx: number, dy: number): PageFrame | null {
  const x = frame.x - dx;
  const y = frame.y - dy;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, width: frame.width, height: frame.height };
}

function resizeFrame(
  frame: PageFrame,
  compositionFrame: CoordinateSpace,
  handle: PageFrameResizeHandle,
  dx: number,
  dy: number,
  ratio: number | null,
): PageFrame | null {
  const horizontal = horizontalDirection(handle);
  const vertical = verticalDirection(handle);
  if (ratio === null) {
    return freeResize(frame, compositionFrame, horizontal, vertical, dx, dy);
  }
  return constrainedResize(
    frame,
    compositionFrame,
    horizontal,
    vertical,
    dx,
    dy,
    ratio,
  );
}

type AxisDirection = -1 | 0 | 1;

function freeResize(
  frame: PageFrame,
  compositionFrame: CoordinateSpace,
  horizontal: AxisDirection,
  vertical: AxisDirection,
  dx: number,
  dy: number,
): PageFrame | null {
  const right = frame.x + frame.width;
  const bottom = frame.y + frame.height;
  const fixedX = horizontal < 0 ? right : frame.x;
  const fixedY = vertical < 0 ? bottom : frame.y;
  const minWidth = minimumExtent(frame.width, compositionFrame.width, fixedX);
  const minHeight = minimumExtent(
    frame.height,
    compositionFrame.height,
    fixedY,
  );

  let left = frame.x;
  let nextRight = right;
  let top = frame.y;
  let nextBottom = bottom;

  // Clamp the moving edge against its fixed opposite before subtracting. This
  // prevents crossing from flipping the rectangle or changing which edge owns
  // the gesture.
  if (horizontal < 0) left = Math.min(frame.x + dx, right - minWidth);
  if (horizontal > 0) nextRight = Math.max(right + dx, frame.x + minWidth);
  if (vertical < 0) top = Math.min(frame.y + dy, bottom - minHeight);
  if (vertical > 0) nextBottom = Math.max(bottom + dy, frame.y + minHeight);

  const width = nextRight - left;
  const height = nextBottom - top;
  if (![left, top, width, height].every(Number.isFinite)) return null;
  return { x: left, y: top, width, height };
}

function constrainedResize(
  frame: PageFrame,
  compositionFrame: CoordinateSpace,
  horizontal: AxisDirection,
  vertical: AxisDirection,
  dx: number,
  dy: number,
  ratio: number,
): PageFrame | null {
  const right = frame.x + frame.width;
  const bottom = frame.y + frame.height;
  const centerX = frame.x + frame.width / 2;
  const centerY = frame.y + frame.height / 2;
  if (![right, bottom, centerX, centerY].every(Number.isFinite)) return null;

  const fixedX = horizontal < 0 ? right : horizontal > 0 ? frame.x : centerX;
  const fixedY = vertical < 0 ? bottom : vertical > 0 ? frame.y : centerY;
  const minWidth = minimumExtent(frame.width, compositionFrame.width, fixedX);
  const minHeight = minimumExtent(
    frame.height,
    compositionFrame.height,
    fixedY,
  );
  const ratioMinWidth = Math.max(minWidth, minHeight * ratio);
  const ratioMinHeight = ratioMinWidth / ratio;
  if (!Number.isFinite(ratioMinWidth) || !Number.isFinite(ratioMinHeight)) {
    return null;
  }

  let width: number;
  let height: number;
  if (horizontal !== 0 && vertical !== 0) {
    const rawWidth = Math.max(ratioMinWidth, frame.width + horizontal * dx);
    const rawHeight = Math.max(ratioMinHeight, frame.height + vertical * dy);
    const horizontalChange = Math.abs(rawWidth - frame.width);
    const verticalChangeAsWidth = Math.abs(rawHeight - frame.height) * ratio;
    if (horizontalChange >= verticalChangeAsWidth) {
      width = rawWidth;
      height = width / ratio;
    } else {
      height = rawHeight;
      width = height * ratio;
    }
  } else if (horizontal !== 0) {
    width = Math.max(ratioMinWidth, frame.width + horizontal * dx);
    height = width / ratio;
  } else {
    height = Math.max(ratioMinHeight, frame.height + vertical * dy);
    width = height * ratio;
  }
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;

  // Corners keep their opposite corner fixed. Constrained edges keep their
  // opposite edge fixed and grow/shrink symmetrically on the orthogonal axis.
  const x =
    horizontal < 0
      ? right - width
      : horizontal > 0
        ? frame.x
        : centerX - width / 2;
  const y =
    vertical < 0
      ? bottom - height
      : vertical > 0
        ? frame.y
        : centerY - height / 2;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, width, height };
}

function activeAspectRatio(
  state: Pick<
    PageFrameManipulationState,
    "constraint" | "shiftKey" | "anchorFrame" | "target"
  >,
): number | null {
  if (state.target.kind === "pan") return null;
  if (state.constraint.kind === "ratio") return state.constraint.ratio;
  return state.shiftKey
    ? state.anchorFrame.width / state.anchorFrame.height
    : null;
}

function minimumExtent(
  startingExtent: number,
  compositionExtent: number,
  fixedEdge: number,
): number {
  const scaleAwareFloor = Math.max(
    compositionExtent * PAGE_FRAME_MIN_EXTENT_FRACTION,
    Math.abs(fixedEdge) * Number.EPSILON * 8,
    Number.MIN_VALUE,
  );
  return Math.min(startingExtent, scaleAwareFloor);
}

function rebaseGesture(
  state: PageFrameManipulationState,
  pointer: PageFramePointer,
  shiftKey: boolean,
): PageFrameManipulationState {
  return Object.freeze({
    ...state,
    anchorFrame: state.frame,
    anchorPointer: freezePointer(pointer),
    shiftKey,
  });
}

function horizontalDirection(handle: PageFrameResizeHandle): AxisDirection {
  if (handle.endsWith("left") || handle === "left") return -1;
  if (handle.endsWith("right") || handle === "right") return 1;
  return 0;
}

function verticalDirection(handle: PageFrameResizeHandle): AxisDirection {
  if (handle.startsWith("top")) return -1;
  if (handle.startsWith("bottom")) return 1;
  return 0;
}

function validateTarget(target: PageFrameManipulationTarget): void {
  if (target.kind === "pan") return;
  if (
    target.kind !== "resize" ||
    !PAGE_FRAME_RESIZE_HANDLES.includes(target.handle)
  ) {
    throw new Error("beginPageFrameManipulation: unknown manipulation target");
  }
}

function validateConstraint(constraint: PageFrameAspectConstraint): void {
  if (constraint.kind === "free") return;
  if (
    constraint.kind !== "ratio" ||
    !Number.isFinite(constraint.ratio) ||
    constraint.ratio <= 0
  ) {
    throw new Error(
      "beginPageFrameManipulation: aspect ratio must be a finite positive number",
    );
  }
}

function validateCompositionFrame(compositionFrame: CoordinateSpace): void {
  if (
    !Number.isFinite(compositionFrame.width) ||
    compositionFrame.width <= 0 ||
    !Number.isFinite(compositionFrame.height) ||
    compositionFrame.height <= 0
  ) {
    throw new Error(
      "beginPageFrameManipulation: Composition Frame extents must be finite positive numbers",
    );
  }
}

function validatePointer(pointer: PageFramePointer, operation: string): void {
  if (!isFinitePointer(pointer)) {
    throw new Error(`${operation}: pointer coordinates must be finite`);
  }
}

function isFinitePointer(pointer: PageFramePointer): boolean {
  return Number.isFinite(pointer.x) && Number.isFinite(pointer.y);
}

function freezeFrame(frame: PageFrame): PageFrame {
  return Object.freeze({ ...frame });
}

function freezePointer(pointer: PageFramePointer): PageFramePointer {
  return Object.freeze({ ...pointer });
}

function freezeTarget(
  target: PageFrameManipulationTarget,
): PageFrameManipulationTarget {
  return Object.freeze({ ...target });
}

function freezeConstraint(
  constraint: PageFrameAspectConstraint,
): PageFrameAspectConstraint {
  return Object.freeze({ ...constraint });
}
