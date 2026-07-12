import { useEffect, useRef, useState } from "react";

import type { Seed } from "@harness/core";

import type { EditTransactionLifecycle } from "./editHistory";

export interface SeedControlProps {
  /** The current Studio seed. The owner remains the value source of truth. */
  value: Seed;
  /** Transaction callbacks supplied by the owner of Studio edit history. */
  editHistory: EditTransactionLifecycle<number>;
}

/**
 * Controlled numeric seed editor with a local text draft.
 *
 * Valid numbers preview immediately inside one focus-bounded transaction.
 * Blank and invalid text stay local so partially typing a number cannot mutate
 * the rendered Sketch. Enter or blur commits once; Escape cancels back to the
 * value captured on focus.
 */
export function SeedControl({ value, editHistory }: SeedControlProps) {
  const [draft, setDraft] = useState(() => String(value));
  const focused = useRef(false);
  const focusValue = useRef(value);
  const settled = useRef(false);
  const canceled = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);

  const finish = (input: HTMLInputElement) => {
    if (!settled.current) {
      settled.current = true;
      editHistory.onCommit();
    }
    input.blur();
  };

  const cancel = (input: HTMLInputElement) => {
    if (!settled.current) {
      settled.current = true;
      canceled.current = true;
      setDraft(String(focusValue.current));
      editHistory.onCancel();
    }
    input.blur();
  };

  return (
    <div className="flex items-center gap-2">
      <label
        className="flex-none min-w-16 text-sm text-muted-foreground"
        htmlFor="sketch-seed"
      >
        seed
      </label>
      <input
        id="sketch-seed"
        className="flex-1 h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        type="number"
        value={draft}
        onFocus={() => {
          focused.current = true;
          focusValue.current = value;
          settled.current = false;
          canceled.current = false;
          setDraft(String(value));
          editHistory.onBegin();
        }}
        onChange={(event) => {
          const raw = event.target.value;
          setDraft(raw);
          if (raw.trim() === "") return;
          const parsed = Number(raw);
          if (Number.isNaN(parsed)) return;
          editHistory.onPreview(parsed);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            finish(event.currentTarget);
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancel(event.currentTarget);
          }
        }}
        onBlur={() => {
          focused.current = false;
          setDraft(String(canceled.current ? focusValue.current : value));
          if (!settled.current) {
            settled.current = true;
            editHistory.onCommit();
          }
        }}
      />
    </div>
  );
}
