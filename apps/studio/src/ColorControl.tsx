import { type ColorParamSpec } from "@harness/core";
import { Lock, LockOpen } from "lucide-react";

import { cn } from "./lib/utils";

/**
 * Props for {@link ColorControl}.
 *
 * The control is fully controlled: it owns no value state. `value` is the
 * current hex color string and `onChange` lifts every committed change up to
 * the panel, which is the single owner of the param map — the exact shape of
 * `NumberControlProps`, with the value typed to the color domain.
 */
export interface ColorControlProps {
  /** The param's key in the schema — used as the label and input id. */
  paramKey: string;
  /** The declaration this control is derived from. */
  spec: ColorParamSpec;
  /**
   * The current hex color string (e.g. `'#1a2b3c'` — the `ColorParamSpec`
   * value domain). The color input is the source of truth for it.
   */
  value: string;
  /**
   * Whether this param is locked. Lock is Randomize-EXCLUSION only: it drives
   * the toggle's pressed state but NEVER disables the input — a locked control
   * stays fully hand-editable.
   */
  locked: boolean;
  /** Lift a committed value change up to the owner. */
  onChange: (value: string) => void;
  /** Toggle this param's lock membership. */
  onToggleLock: () => void;
}

/**
 * A single color control, laid out as ONE line: the param label, a native
 * `<input type="color">` swatch, and a lucide Lock toggle — NumberControl's top
 * line with the free-entry number input swapped for the color swatch (there is
 * no slider line: a color has no `[min, max]` to drag across).
 *
 * The native color input speaks EXACTLY the `#rrggbb` hex form, which is why
 * `ColorParamSpec` pins its value domain to hex — the input both emits hex from
 * the browser's picker and renders the current value as its swatch, so no
 * parse/normalize layer sits between the control and the stored param.
 *
 * LOCK affordance: mirrors NumberControl's exactly — a lucide icon toggle
 * (Lock when locked, LockOpen when not) whose `aria-pressed` reflects `locked`.
 * Colors are NEVER randomized (core's `randomize` passes every color through,
 * ADR-0010), so for a color the lock excludes nothing — it is kept anyway so
 * the control chrome stays uniform across kinds (a harmless no-op, not a
 * different affordance per row), and like NumberControl's it NEVER disables the
 * input: there is no `disabled` anywhere in this markup.
 */
// `spec` is part of the uniform control contract (every control receives its
// declaration, as NumberControl does) but is deliberately NOT destructured: a
// ColorParamSpec carries only `default`, and the panel — not this control —
// resolves an unset param to that default before it reaches the controlled
// `value` prop (the same split NumberControl has).
export function ColorControl({
  paramKey,
  value,
  locked,
  onChange,
  onToggleLock,
}: ColorControlProps) {
  const inputId = `control-${paramKey}`;

  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor={inputId}
        className="min-w-0 flex-1 truncate text-sm text-foreground"
      >
        {paramKey}
      </label>
      <input
        id={inputId}
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-16 shrink-0 cursor-pointer rounded-md border bg-background p-0.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
  );
}
