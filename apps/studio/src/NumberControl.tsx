import { clamp, type NumberParamSpec } from "@harness/core";
import { Lock, LockOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Slider } from "./components/ui/slider";
import type { EditTransactionLifecycle } from "./editHistory";
import { cn } from "./lib/utils";

/**
 * Props for {@link NumberControl}.
 *
 * The authored value is controlled by `value`; the component owns only the
 * transient text draft needed for partial numeric entry. Without `editHistory`,
 * `onChange` lifts live values to the panel; with it, previews and transaction
 * boundaries use that lifecycle.
 */
export interface NumberControlProps {
  /** The param's key in the schema — used as the label and input id. */
  paramKey: string;
  /** The declaration this control is derived from. */
  spec: NumberParamSpec;
  /** The current value. The number input is the source of truth for it. */
  value: number;
  /**
   * Whether this param is locked. Lock is Randomize-EXCLUSION only: it drives
   * the toggle's pressed state but NEVER disables the slider/input — a locked
   * control stays fully hand-editable.
   */
  locked: boolean;
  /** Standalone fallback for lifting a live value change to the owner. */
  onChange: (value: number) => void;
  /** Optional shared-history transaction seam for previewable edits. */
  editHistory?: EditTransactionLifecycle<number> | undefined;
  /** Toggle this param's lock membership. */
  onToggleLock: () => void;
}

/**
 * Coerce a free-entry number into the value domain `spec` declares.
 *
 * The number input is the SOURCE OF TRUTH for the exact value, so this is the
 * only place the value-domain constraints are enforced: clamp to `[min, max]`,
 * and round to a whole number IFF `integer`. Crucially it does NOT snap to
 * `spec.step` — `step` is a UI drag-granularity hint only (ADR / #47), so an
 * off-step value like `23` under `step: 10` is a legal, hand-editable value and
 * is preserved here untouched.
 *
 * @param raw - The raw number the user typed (already parsed from the input).
 * @param spec - The param declaration whose `min`/`max`/`integer` constrain it.
 * @returns The in-domain value to store.
 */
export function coerceToDomain(raw: number, spec: NumberParamSpec): number {
  const clamped = clamp(raw, spec.min, spec.max);
  return spec.integer ? Math.round(clamped) : clamped;
}

/**
 * A single numeric control, laid out as TWO lines. Top line: the param label,
 * a free-entry number input, and a lucide Lock toggle. Bottom line: a full-width
 * {@link Slider}. Both the number input and the slider are two-way bound to the
 * same `value`.
 *
 * The slider's `step` is `spec.step` (defaulting to a fine, range-relative
 * increment so an unspecified step gives effectively continuous drag — Base UI's
 * Slider has no `"any"` sentinel) — that governs DRAG GRANULARITY only. The
 * number input takes free entry and is the source of truth for the exact stored
 * value: on change its text is parsed and run through {@link coerceToDomain}
 * (clamp to `[min, max]`, round iff `integer`), but never snapped onto the step
 * grid. So the slider drags in coarse `step` increments while the number input
 * can still hold and edit an off-step value (e.g. `23` under `step: 10`). Slider
 * drags run through the SAME {@link coerceToDomain}, keeping it the single
 * value-domain enforcement point.
 *
 * LOCK affordance: a lucide icon toggle (Lock when locked, LockOpen when not)
 * whose `aria-pressed` reflects `locked`. Lock is Randomize-EXCLUSION only — it
 * is read by the studio solely to skip this param in a roll. It deliberately
 * does NOT disable the slider or input: a locked control stays fully
 * hand-editable, so there is no `disabled` anywhere in this markup.
 */
export function NumberControl({
  paramKey,
  spec,
  value,
  locked,
  onChange,
  editHistory,
  onToggleLock,
}: NumberControlProps) {
  const inputId = `control-${paramKey}`;
  const [draft, setDraft] = useState(String(value));
  const editingRef = useRef(false);
  const transactionRef = useRef(false);
  const focusValueRef = useRef(value);
  const lastPreviewRef = useRef(value);

  useEffect(() => {
    if (!editingRef.current) setDraft(String(value));
  }, [value]);

  const parse = (raw: string) => {
    if (raw.trim() === "") return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? coerceToDomain(parsed, spec) : null;
  };

  const beginTransaction = () => {
    if (!editHistory || transactionRef.current) return;
    editHistory.onBegin();
    transactionRef.current = true;
  };

  const preview = (next: number) => {
    if (editHistory) {
      beginTransaction();
      editHistory.onPreview(next);
    } else {
      onChange(next);
    }
    lastPreviewRef.current = next;
  };

  const commitTransaction = () => {
    if (!transactionRef.current) return;
    transactionRef.current = false;
    editHistory?.onCommit();
  };

  const cancelTransaction = () => {
    if (!transactionRef.current) return;
    transactionRef.current = false;
    editHistory?.onCancel();
  };

  // Drag granularity: the declared step, or a fine range-relative fallback that
  // stands in for the old native `step="any"` (Base UI's Slider takes a numeric
  // step only, defaulting to a coarse `1`).
  const sliderStep = spec.step ?? (spec.max - spec.min) / 1000;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <label
          htmlFor={inputId}
          className="min-w-0 flex-1 truncate text-sm text-foreground"
        >
          {paramKey}
        </label>
        <input
          id={inputId}
          type="number"
          min={spec.min}
          max={spec.max}
          value={draft}
          onFocus={() => {
            editingRef.current = true;
            focusValueRef.current = value;
            lastPreviewRef.current = value;
            setDraft(String(value));
          }}
          onChange={(event) => {
            const nextDraft = event.target.value;
            setDraft(nextDraft);
            // Even an empty or temporarily invalid draft is an active field
            // edit. Begin before parsing so native field-level Undo keeps
            // precedence until Enter, blur, or Escape ends the transaction.
            beginTransaction();
            const next = parse(nextDraft);
            if (next !== null) preview(next);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              const next = parse(draft);
              commitTransaction();
              editingRef.current = false;
              setDraft(String(next ?? value));
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              if (editHistory) {
                cancelTransaction();
              } else if (
                !Object.is(lastPreviewRef.current, focusValueRef.current)
              ) {
                onChange(focusValueRef.current);
              }
              editingRef.current = false;
              lastPreviewRef.current = focusValueRef.current;
              setDraft(String(focusValueRef.current));
            }
          }}
          onBlur={() => {
            if (transactionRef.current) commitTransaction();
            editingRef.current = false;
            setDraft(String(lastPreviewRef.current));
          }}
          className="w-16 rounded-md border bg-background px-2 py-1 text-right text-sm text-foreground tabular-nums outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <button
          type="button"
          aria-label={`${paramKey} lock`}
          aria-pressed={locked}
          onClick={onToggleLock}
          className={cn(
            "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
            locked && "text-foreground",
          )}
        >
          {locked ? (
            <Lock className="size-4" />
          ) : (
            <LockOpen className="size-4" />
          )}
        </button>
      </div>
      <Slider
        aria-label={`${paramKey} slider`}
        min={spec.min}
        max={spec.max}
        step={sliderStep}
        value={value}
        onValueChange={(next) => preview(coerceToDomain(next, spec))}
        onValueCommitted={commitTransaction}
      />
    </div>
  );
}
