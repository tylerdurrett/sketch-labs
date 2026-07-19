import {
  pageFrameFromPercentages,
  pageFrameToPercentages,
  type CoordinateSpace,
  type PageFrame,
  type PageFramePercentages,
  type PlotProfile,
} from "@harness/core";
import { useEffect, useId, useState } from "react";

import { Button } from "./components/ui/button";
import { PageFramePhysicalFields } from "./PageFramePhysicalFields";
import type { PaperDisplayUnit } from "./paperDisplayUnit";

type PageFrameField = keyof PageFramePercentages;

export interface PageFrameEditorProps {
  compositionFrame: CoordinateSpace;
  initialFrame: PageFrame;
  profile: PlotProfile;
  representedFrame: PageFrame;
  displayUnit: PaperDisplayUnit;
  onDraftChange: (frame: PageFrame) => void;
  onApply: (frame: PageFrame) => void;
  onCancel: () => void;
  onReset: () => void;
}

interface PageFrameError {
  readonly field: PageFrameField;
  readonly message: string;
}

const FIELDS = ["x", "y", "width", "height"] as const;
const LABELS: Record<PageFrameField, string> = {
  x: "X",
  y: "Y",
  width: "W",
  height: "H",
};

function initialDraft(
  initialFrame: PageFrame,
  compositionFrame: CoordinateSpace,
): Record<PageFrameField, string> {
  const percentages = pageFrameToPercentages(initialFrame, compositionFrame);
  return {
    x: String(percentages.x),
    y: String(percentages.y),
    width: String(percentages.width),
    height: String(percentages.height),
  };
}

function parseDraft(
  draft: Readonly<Record<PageFrameField, string>>,
  compositionFrame: CoordinateSpace,
):
  | { readonly frame: PageFrame; readonly error: null }
  | {
      readonly frame: null;
      readonly error: PageFrameError;
    } {
  const percentages = {} as Record<PageFrameField, number>;
  for (const field of FIELDS) {
    const raw = draft[field].trim();
    const value = raw === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(value)) {
      return {
        frame: null,
        error: { field, message: `${LABELS[field]} must be a finite number.` },
      };
    }
    if ((field === "width" || field === "height") && value <= 0) {
      return {
        frame: null,
        error: {
          field,
          message: `${LABELS[field]} must be greater than 0%.`,
        },
      };
    }
    percentages[field] = value;
  }

  try {
    return {
      frame: pageFrameFromPercentages(percentages, compositionFrame),
      error: null,
    };
  } catch {
    return {
      frame: null,
      error: {
        field: "width",
        message:
          "The Page Frame must have finite origins and positive extents.",
      },
    };
  }
}

/** Transient numeric editor for a Page Frame expressed in Composition percentages. */
export function PageFrameEditor({
  compositionFrame,
  initialFrame,
  profile,
  representedFrame,
  displayUnit,
  onDraftChange,
  onApply,
  onCancel,
  onReset,
}: PageFrameEditorProps) {
  const [draft, setDraft] = useState(() =>
    initialDraft(initialFrame, compositionFrame),
  );
  const [error, setError] = useState<PageFrameError | null>(null);
  const errorId = useId();

  useEffect(() => {
    setDraft(initialDraft(initialFrame, compositionFrame));
    setError(null);
  }, [
    compositionFrame.height,
    compositionFrame.width,
    initialFrame.height,
    initialFrame.width,
    initialFrame.x,
    initialFrame.y,
  ]);

  const updateField = (field: PageFrameField, value: string): void => {
    const next = { ...draft, [field]: value };
    setDraft(next);
    setError(null);
    const parsed = parseDraft(next, compositionFrame);
    if (parsed.frame !== null) onDraftChange(parsed.frame);
  };

  const apply = (): void => {
    const parsed = parseDraft(draft, compositionFrame);
    if (parsed.frame === null) {
      setError(parsed.error);
      return;
    }
    setError(null);
    onApply(parsed.frame);
  };

  return (
    <section className="page-frame-editor" aria-labelledby="page-frame-title">
      <div>
        <h2 id="page-frame-title" className="text-base font-semibold">
          Edit Page Frame
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Percent of the original Composition Frame
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {FIELDS.map((field) => (
          <label key={field} className="flex flex-col gap-1 text-sm">
            <span>{LABELS[field]}</span>
            <span className="flex items-center gap-1">
              <input
                name={field}
                type="number"
                step="any"
                autoFocus={field === "x"}
                value={draft[field]}
                aria-invalid={error?.field === field || undefined}
                aria-describedby={error?.field === field ? errorId : undefined}
                onChange={(event) => updateField(field, event.target.value)}
                className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-right text-sm text-foreground tabular-nums outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
              <span className="text-muted-foreground" aria-hidden>
                %
              </span>
            </span>
          </label>
        ))}
      </div>
      <PageFramePhysicalFields
        profile={profile}
        representedFrame={representedFrame}
        frame={initialFrame}
        displayUnit={displayUnit}
        onFrameChange={onDraftChange}
      />
      {error !== null && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={apply}>
          Apply
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onReset}>
          Reset Frame
        </Button>
      </div>
    </section>
  );
}
