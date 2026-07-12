import { Popover as PopoverPrimitive } from "@base-ui-components/react/popover";
import { type ColorParamSpec } from "@harness/core";
import { useEffect, useRef, useState } from "react";

import { ColorPickerSurface } from "./ColorPickerSurface";
import type { EditTransactionLifecycle } from "./editHistory";
import { RgbColorFields } from "./RgbColorFields";

type EditOwner = "idle" | "rgb" | "gesture";

const GESTURE_LIFT_DELAY_MS = 100;

/** Props for the Studio-owned color popover. */
export interface ColorControlProps {
  /** The param's key in the schema and the root of its accessible names. */
  paramKey: string;
  /** The declaration this control is derived from. */
  spec: ColorParamSpec;
  /** The current canonical `#rrggbb` value. */
  value: string;
  /** Standalone fallback for lifting a completed or live edit. */
  onChange: (value: string) => void;
  /** Optional shared-history transaction seam. */
  editHistory?: EditTransactionLifecycle<string> | undefined;
}

/**
 * A controlled Base UI popover that composes the picker surface, RGB entry,
 * and the Harness-wide black/white Palette.
 *
 * The popup stays mounted so its controls can retain their browser-owned state.
 * `editOwner` is therefore the synchronization boundary: external values win
 * while idle, while an active RGB or picker gesture keeps its local draft.
 */
export function ColorControl({
  paramKey,
  value,
  onChange,
  editHistory,
}: ColorControlProps) {
  const [open, setOpen] = useState(false);
  const [draftColor, setDraftColorState] = useState(value);
  const [editOwner, setEditOwnerState] = useState<EditOwner>("idle");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef(false);
  const draftColorRef = useRef(value);
  const editOwnerRef = useRef<EditOwner>("idle");
  const gestureTransactionRef = useRef(false);
  const gestureLiftTimerRef = useRef<number | null>(null);
  const latestGestureColorRef = useRef<string | null>(null);
  const lastGestureLiftRef = useRef<string | null>(null);
  const ignoredSurfaceSyncRef = useRef<string | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const editHistoryRef = useRef(editHistory);
  valueRef.current = value;
  onChangeRef.current = onChange;
  editHistoryRef.current = editHistory;

  const setDraftColor = (next: string) => {
    draftColorRef.current = next;
    setDraftColorState(next);
  };

  const setEditOwner = (next: EditOwner) => {
    editOwnerRef.current = next;
    setEditOwnerState(next);
  };

  const ignoreSurfaceCallbacksForTick = (color: string) => {
    ignoredSurfaceSyncRef.current = color;
    window.setTimeout(() => {
      if (ignoredSurfaceSyncRef.current === color) {
        ignoredSurfaceSyncRef.current = null;
      }
    }, 0);
  };

  const synchronizeDraftColor = (next: string) => {
    ignoreSurfaceCallbacksForTick(next);
    setDraftColor(next);
  };

  useEffect(() => {
    if (editOwnerRef.current === "idle" && draftColorRef.current !== value) {
      synchronizeDraftColor(value);
    }
  }, [value]);

  const clearGestureLiftTimer = () => {
    if (gestureLiftTimerRef.current === null) return;
    window.clearTimeout(gestureLiftTimerRef.current);
    gestureLiftTimerRef.current = null;
  };

  const liftGestureColor = (next: string) => {
    if (lastGestureLiftRef.current === next) return;
    const currentEditHistory = editHistoryRef.current;
    if (currentEditHistory) currentEditHistory.onPreview(next);
    else onChangeRef.current(next);
    lastGestureLiftRef.current = next;
  };

  const scheduleGestureLift = () => {
    clearGestureLiftTimer();
    gestureLiftTimerRef.current = window.setTimeout(() => {
      gestureLiftTimerRef.current = null;
      const latest = latestGestureColorRef.current;
      if (latest !== null) liftGestureColor(latest);
    }, GESTURE_LIFT_DELAY_MS);
  };

  useEffect(
    () => () => {
      clearGestureLiftTimer();
    },
    [],
  );

  const applyAtomicEdit = (next: string) => {
    synchronizeDraftColor(next);
    const currentEditHistory = editHistoryRef.current;
    if (currentEditHistory) {
      currentEditHistory.onBegin();
      currentEditHistory.onPreview(next);
      currentEditHistory.onCommit();
    } else {
      onChangeRef.current(next);
    }
    setEditOwner("idle");
  };

  const resetGesture = () => {
    gestureTransactionRef.current = false;
    latestGestureColorRef.current = null;
    lastGestureLiftRef.current = null;
    setEditOwner("idle");
  };

  const finishGesture = (finalColor?: string) => {
    if (editOwnerRef.current !== "gesture") return;

    if (finalColor !== undefined) {
      setDraftColor(finalColor);
      latestGestureColorRef.current = finalColor;
    }
    clearGestureLiftTimer();
    const latest = latestGestureColorRef.current;
    if (latest !== null) liftGestureColor(latest);
    if (gestureTransactionRef.current) {
      editHistoryRef.current?.onCommit();
    }
    resetGesture();
  };

  /** One close path for every Base UI dismissal reason and direct close. */
  const closePicker = () => {
    openRef.current = false;
    if (editOwnerRef.current === "gesture") {
      finishGesture();
      ignoreSurfaceCallbacksForTick(draftColorRef.current);
    }
    setOpen(false);
  };

  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {paramKey}
      </span>
      <PopoverPrimitive.Root
        open={open}
        onOpenChange={(nextOpen, eventDetails) => {
          if (nextOpen) {
            openRef.current = true;
            setOpen(true);
          } else {
            closePicker();
            if (eventDetails.reason === "escape-key") {
              // Kept-mounted focus guards restore inside the hidden popup in
              // jsdom before their cleanup runs. Finish keyboard restoration
              // after Base UI's own finalFocus pass; pointer closes skip it.
              window.setTimeout(() => triggerRef.current?.focus(), 0);
            }
          }
        }}
      >
        <PopoverPrimitive.Trigger
          ref={triggerRef}
          aria-label={`${paramKey} current color ${draftColor}`}
          className="inline-flex h-8 w-16 shrink-0 items-center justify-center rounded-md border bg-background p-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span
            aria-hidden="true"
            className="size-full rounded-sm border"
            style={{ backgroundColor: draftColor }}
          />
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal keepMounted>
          <PopoverPrimitive.Positioner sideOffset={4} className="z-50">
            <PopoverPrimitive.Popup
              aria-label={`${paramKey} color picker`}
              finalFocus={(closeType) =>
                closeType === "keyboard" ? triggerRef.current : false
              }
              className="w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none"
            >
              <div className="flex flex-col gap-3">
                <ColorPickerSurface
                  paramKey={paramKey}
                  color={draftColor}
                  onChange={(next) => {
                    if (ignoredSurfaceSyncRef.current !== null) {
                      return;
                    }
                    if (!openRef.current) {
                      // react-colorful may batch the last keyboard/pointer
                      // change until after Base UI has reported dismissal. At
                      // that point there was no active gesture for closePicker
                      // to flush, so settle this one completed value atomically.
                      applyAtomicEdit(next);
                      return;
                    }
                    // A controlled react-colorful update can round-trip through
                    // HSV. The RGB editor remains the sole owner while active.
                    if (editOwnerRef.current === "rgb") return;
                    if (
                      editOwnerRef.current !== "gesture" &&
                      next === draftColorRef.current
                    ) {
                      return;
                    }
                    setEditOwner("gesture");
                    setDraftColor(next);
                    latestGestureColorRef.current = next;
                    if (!gestureTransactionRef.current) {
                      const currentEditHistory = editHistoryRef.current;
                      if (currentEditHistory) {
                        // History must snapshot the pre-gesture state before
                        // any delayed preview can reach the shared owner.
                        currentEditHistory.onBegin();
                        gestureTransactionRef.current = true;
                      }
                    }
                    scheduleGestureLift();
                  }}
                  onChangeEnd={(next) => {
                    if (editOwnerRef.current === "gesture") finishGesture(next);
                  }}
                />
                <RgbColorFields
                  paramKey={paramKey}
                  color={draftColor}
                  onEditBegin={() => setEditOwner("rgb")}
                  onLocalPreview={setDraftColor}
                  onSettle={applyAtomicEdit}
                  onCancel={() => {
                    // RGB retains its focus snapshot while active, but an
                    // external controlled update that arrived meanwhile wins
                    // as soon as cancellation releases local ownership.
                    synchronizeDraftColor(valueRef.current);
                    setEditOwner("idle");
                  }}
                />
                <div
                  role="group"
                  aria-label={`${paramKey} Palette`}
                  className="flex gap-2"
                >
                  {[
                    ["Black", "#000000"],
                    ["White", "#ffffff"],
                  ].map(([name, color]) => (
                    <button
                      key={color}
                      type="button"
                      aria-label={`${paramKey} Palette ${name}`}
                      onClick={() => {
                        applyAtomicEdit(color!);
                        closePicker();
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md border bg-background p-2 text-xs outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <span
                        aria-hidden="true"
                        className="size-5 rounded-sm border"
                        style={{ backgroundColor: color }}
                      />
                      {name}
                    </button>
                  ))}
                </div>
              </div>
            </PopoverPrimitive.Popup>
          </PopoverPrimitive.Positioner>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
      <span className="sr-only" aria-live="polite">
        {editOwner === "idle" ? `${paramKey} color ${draftColor}` : undefined}
      </span>
    </div>
  );
}
