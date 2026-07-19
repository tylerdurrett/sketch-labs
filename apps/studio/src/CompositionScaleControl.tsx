import { useEffect, useId, useRef, useState } from "react";

/** Lower end of the direct manipulation range, expressed as a percentage. */
export const COMPOSITION_SCALE_RANGE_MIN_PERCENT = 10;

/** Upper end of the direct manipulation range, expressed as a percentage. */
export const COMPOSITION_SCALE_RANGE_MAX_PERCENT = 400;

export interface CompositionScaleControlProps {
  /**
   * Controlled scale percentage. `100` is the centered, full-Composition fit.
   * The owner must supply a finite positive value, which may sit outside the
   * direct range's presentation bounds.
   */
  scalePercent: number;
  /** Lift a finite positive percentage to the Page Frame draft owner. */
  onScalePercentChange: (scalePercent: number) => void;
  /** Lets the containing commit boundary block while a text draft is invalid. */
  onValidityChange?: (valid: boolean) => void;
}

const INVALID_SCALE_MESSAGE =
  "Composition scale must be a finite positive percentage.";

function parseScalePercent(raw: string): number | null {
  if (raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function rangePresentationValue(scalePercent: number): number {
  if (!Number.isFinite(scalePercent)) {
    return COMPOSITION_SCALE_RANGE_MIN_PERCENT;
  }
  return Math.min(
    COMPOSITION_SCALE_RANGE_MAX_PERCENT,
    Math.max(COMPOSITION_SCALE_RANGE_MIN_PERCENT, scalePercent),
  );
}

/**
 * Controlled uniform Composition-scale editor for fixed-page framing.
 *
 * The range offers convenient direct manipulation from 10–400%, but those
 * bounds are presentation only. The numeric field accepts any finite positive
 * percentage without clamping. Its local draft preserves partial input while
 * focused; invalid drafts do not change the controlled scale and are reported
 * to the containing Page Frame commit boundary through `onValidityChange`.
 */
export function CompositionScaleControl({
  scalePercent,
  onScalePercentChange,
  onValidityChange,
}: CompositionScaleControlProps) {
  const [draft, setDraft] = useState(() => String(scalePercent));
  const [error, setError] = useState<string | null>(null);
  const numericInputFocused = useRef(false);
  const descriptionId = useId();
  const errorId = useId();

  useEffect(() => {
    if (numericInputFocused.current) return;
    setDraft(String(scalePercent));
    setError(null);
  }, [scalePercent]);

  useEffect(() => {
    onValidityChange?.(error === null);
  }, [error, onValidityChange]);

  const updateFromRange = (nextScalePercent: number): void => {
    setDraft(String(nextScalePercent));
    setError(null);
    onScalePercentChange(nextScalePercent);
  };

  const updateNumericDraft = (raw: string): void => {
    setDraft(raw);
    const parsed = parseScalePercent(raw);
    if (parsed === null) {
      setError(INVALID_SCALE_MESSAGE);
      return;
    }

    setError(null);
    onScalePercentChange(parsed);
  };

  const describedBy =
    error === null ? descriptionId : `${descriptionId} ${errorId}`;

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm text-foreground">Composition scale</legend>
      <p id={descriptionId} className="text-xs text-muted-foreground">
        100% centers and fits the full Composition.
      </p>
      <div className="flex items-center gap-2">
        <input
          type="range"
          aria-label="Composition scale"
          aria-describedby={descriptionId}
          className="min-w-0 flex-1 accent-primary"
          min={COMPOSITION_SCALE_RANGE_MIN_PERCENT}
          max={COMPOSITION_SCALE_RANGE_MAX_PERCENT}
          step={1}
          value={rangePresentationValue(scalePercent)}
          onChange={(event) => updateFromRange(event.currentTarget.valueAsNumber)}
        />
        <label className="flex w-24 items-center gap-1 text-sm">
          <span className="sr-only">Composition scale percentage</span>
          <input
            type="number"
            aria-label="Composition scale percentage"
            aria-describedby={describedBy}
            aria-invalid={error === null ? undefined : true}
            className="min-w-0 w-full rounded-md border bg-background px-2 py-1.5 text-right text-sm text-foreground tabular-nums outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            min={Number.MIN_VALUE}
            step="any"
            value={draft}
            onFocus={() => {
              numericInputFocused.current = true;
              setDraft(String(scalePercent));
              setError(null);
            }}
            onChange={(event) => updateNumericDraft(event.target.value)}
            onBlur={() => {
              numericInputFocused.current = false;
              setDraft(String(scalePercent));
              setError(null);
            }}
          />
          <span className="text-muted-foreground" aria-hidden>
            %
          </span>
        </label>
      </div>
      {error !== null && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}
