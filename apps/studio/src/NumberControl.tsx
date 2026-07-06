import { clamp, type NumberParamSpec } from "@harness/core";
import { Lock, LockOpen } from "lucide-react";

import { Slider } from "./components/ui/slider";
import { cn } from "./lib/utils";

/**
 * Props for {@link NumberControl}.
 *
 * The control is fully controlled: it owns no value state. `value` is the
 * current number and `onChange` lifts every committed change up to the panel,
 * which is the single owner of the param map.
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
  /** Lift a committed value change up to the owner. */
  onChange: (value: number) => void;
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
  onToggleLock,
}: NumberControlProps) {
  const inputId = `control-${paramKey}`;

  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) return;
    onChange(coerceToDomain(parsed, spec));
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
          value={value}
          onChange={(event) => commit(event.target.value)}
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
        onValueChange={(next) => onChange(coerceToDomain(next, spec))}
      />
    </div>
  );
}
