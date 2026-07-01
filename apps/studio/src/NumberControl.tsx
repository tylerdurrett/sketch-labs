import { clamp, type NumberParamSpec } from "@harness/core";

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
 * A single numeric control: a range slider and a number input, BOTH two-way
 * bound to the same `value`.
 *
 * The slider's `step` attribute is `spec.step` (defaulting to `"any"` so an
 * unspecified step gives continuous drag) — that governs DRAG GRANULARITY only.
 * The number input takes free entry and is the source of truth for the exact
 * stored value: on change its text is parsed and run through
 * {@link coerceToDomain} (clamp to `[min, max]`, round iff `integer`), but never
 * snapped onto the step grid. So the slider drags in coarse `step` increments
 * while the number input can still hold and edit an off-step value (e.g. `23`
 * under `step: 10`).
 *
 * LOCK affordance: a toggle button whose pressed state reflects `locked`. Lock
 * is Randomize-EXCLUSION only — it is read by the studio solely to skip this
 * param in a roll. It deliberately does NOT disable the slider or input: a
 * locked control stays fully hand-editable.
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

  return (
    <div className="control control--number">
      <label className="control__label" htmlFor={inputId}>
        {paramKey}
      </label>
      <input
        className="control__slider"
        type="range"
        aria-label={`${paramKey} slider`}
        min={spec.min}
        max={spec.max}
        step={spec.step ?? "any"}
        value={value}
        onChange={(event) => commit(event.target.value)}
      />
      <input
        id={inputId}
        className="control__number"
        type="number"
        min={spec.min}
        max={spec.max}
        value={value}
        onChange={(event) => commit(event.target.value)}
      />
      <button
        type="button"
        className="control__lock"
        aria-label={`${paramKey} lock`}
        aria-pressed={locked}
        onClick={onToggleLock}
      >
        {locked ? "Locked" : "Lock"}
      </button>
    </div>
  );
}
