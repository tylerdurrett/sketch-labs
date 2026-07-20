import {
  type ChoiceParamSpec,
  validateChoiceParamValue,
} from "@harness/core";

import type { EditTransactionLifecycle } from "./editHistory";

/** Props for one schema-derived, lock-free Choice parameter control. */
export interface ChoiceControlProps {
  /** The schema key, used as the visible and accessible label. */
  paramKey: string;
  /** Ordered stable values and their user-facing labels. */
  spec: ChoiceParamSpec;
  /** The current declared stable value. */
  value: string;
  /** Standalone fallback for lifting one atomic selection. */
  onChange: (value: string) => void;
  /** Optional shared-history seam for committing the selection atomically. */
  editHistory?: EditTransactionLifecycle<string> | undefined;
}

/**
 * A controlled native select for one deliberate Choice parameter.
 *
 * The visible labels are presentation only; callbacks receive the declared
 * stable values stored in Params and Presets. Choice is never randomized, so
 * this row intentionally has no Lock affordance. A selection is an atomic edit:
 * when shared history is present it begins, previews, and commits synchronously.
 */
export function ChoiceControl({
  paramKey,
  spec,
  value,
  onChange,
  editHistory,
}: ChoiceControlProps) {
  const inputId = `control-${paramKey}`;
  const currentValue = validateChoiceParamValue(spec, value, paramKey);

  const select = (next: string): void => {
    if (
      next === currentValue ||
      !spec.options.some((option) => option.value === next)
    ) {
      return;
    }
    if (editHistory === undefined) {
      onChange(next);
      return;
    }
    editHistory.onBegin();
    editHistory.onPreview(next);
    editHistory.onCommit();
  };

  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor={inputId}
        className="min-w-0 flex-1 truncate text-sm text-foreground"
      >
        {paramKey}
      </label>
      <select
        id={inputId}
        value={currentValue}
        onChange={(event) => select(event.currentTarget.value)}
        className="h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {spec.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
