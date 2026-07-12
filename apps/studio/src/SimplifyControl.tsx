import { clamp } from "@harness/core";
import { useEffect, useRef, useState } from "react";

import { Slider } from "./components/ui/slider";
import type { EditTransactionLifecycle } from "./editHistory";

/** Upper bound of the Studio's Hidden-line simplification tolerance. */
export const SIMPLIFY_MAX = 2;

export interface SimplifyControlProps {
  /** Current simplification tolerance, controlled by the Studio owner. */
  value: number;
  /** Transaction callbacks supplied by the owner of Studio edit history. */
  editHistory: EditTransactionLifecycle<number>;
}

/** Clamp a numeric tolerance into the Studio's supported range. */
export function clampSimplifyValue(value: number): number {
  return clamp(value, 0, SIMPLIFY_MAX);
}

/**
 * Controlled simplification editor for both direct numeric entry and Slider.
 * Numeric entry follows a focus transaction with Escape cancellation. Slider
 * previews share one transaction and only Base UI's settled-value signal commits
 * it, covering thumb drags, track presses, and keyboard adjustments alike.
 */
export function SimplifyControl({ value, editHistory }: SimplifyControlProps) {
  const [draft, setDraft] = useState(() => String(value));
  const inputFocused = useRef(false);
  const focusValue = useRef(value);
  const inputSettled = useRef(false);
  const inputCanceled = useRef(false);
  const sliderActive = useRef(false);

  useEffect(() => {
    if (!inputFocused.current) setDraft(String(value));
  }, [value]);

  const finishInput = (input: HTMLInputElement) => {
    if (!inputSettled.current) {
      inputSettled.current = true;
      editHistory.onCommit();
    }
    input.blur();
  };

  const cancelInput = (input: HTMLInputElement) => {
    if (!inputSettled.current) {
      inputSettled.current = true;
      inputCanceled.current = true;
      setDraft(String(focusValue.current));
      editHistory.onCancel();
    }
    input.blur();
  };

  return (
    <div className="flex items-center gap-2">
      <label
        className="flex-none min-w-16 text-sm text-muted-foreground"
        htmlFor="sketch-tolerance"
      >
        simplify
      </label>
      <Slider
        aria-label="Simplification tolerance"
        className="flex-1"
        min={0}
        max={SIMPLIFY_MAX}
        step={SIMPLIFY_MAX / 1000}
        value={value}
        onValueChange={(next) => {
          if (!sliderActive.current) {
            sliderActive.current = true;
            editHistory.onBegin();
          }
          editHistory.onPreview(clampSimplifyValue(next));
        }}
        onValueCommitted={() => {
          if (!sliderActive.current) return;
          sliderActive.current = false;
          editHistory.onCommit();
        }}
      />
      <input
        id="sketch-tolerance"
        className="w-16 rounded-md border border-input bg-transparent px-3 py-1 text-right text-sm tabular-nums shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        type="number"
        min={0}
        max={SIMPLIFY_MAX}
        step="any"
        value={draft}
        onFocus={() => {
          inputFocused.current = true;
          focusValue.current = value;
          inputSettled.current = false;
          inputCanceled.current = false;
          setDraft(String(value));
          editHistory.onBegin();
        }}
        onChange={(event) => {
          const raw = event.target.value;
          setDraft(raw);
          if (raw.trim() === "") return;
          const parsed = Number(raw);
          if (Number.isNaN(parsed)) return;
          editHistory.onPreview(clampSimplifyValue(parsed));
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            finishInput(event.currentTarget);
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancelInput(event.currentTarget);
          }
        }}
        onBlur={() => {
          inputFocused.current = false;
          setDraft(String(inputCanceled.current ? focusValue.current : value));
          if (!inputSettled.current) {
            inputSettled.current = true;
            editHistory.onCommit();
          }
        }}
      />
    </div>
  );
}
