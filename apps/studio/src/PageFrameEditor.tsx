import {
  pageFrameFromPercentages,
  pageFrameToPercentages,
  type CoordinateSpace,
  type PageFrame,
  type PageFramePercentages,
  type PlotProfile,
} from "@harness/core";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "./components/ui/button";
import { PageFramePhysicalFields } from "./PageFramePhysicalFields";
import type { PageFrameAspectConstraint } from "./pageFrameManipulation";
import type { PaperDisplayUnit } from "./paperDisplayUnit";

type PageFrameField = keyof PageFramePercentages;
type AspectPreset = "free" | "1:1" | "4:3" | "3:2" | "16:9" | "custom";

interface PageFrameEditorBaseProps {
  compositionFrame: CoordinateSpace;
  profile: PlotProfile;
  representedFrame: PageFrame;
  displayUnit: PaperDisplayUnit;
  onDraftChange: (frame: PageFrame) => void;
  onApply: (frame: PageFrame) => void;
  onCancel: () => void;
  onReset: () => void;
  aspectConstraint?: PageFrameAspectConstraint;
  onAspectConstraintChange?: (
    constraint: PageFrameAspectConstraint,
  ) => void;
}

/** `initialFrame` remains as a temporary compatibility seam for callers. */
export type PageFrameEditorProps = PageFrameEditorBaseProps &
  (
    | { readonly frame: PageFrame; readonly initialFrame?: never }
    | { readonly frame?: never; readonly initialFrame: PageFrame }
  );

interface PageFrameError {
  readonly field: PageFrameField;
  readonly message: string;
}

interface CustomAspectError {
  readonly field: "customAspectWidth" | "customAspectHeight";
  readonly message: string;
}

const FIELDS = ["x", "y", "width", "height"] as const;
const LABELS: Record<PageFrameField, string> = {
  x: "X",
  y: "Y",
  width: "W",
  height: "H",
};
const ASPECT_PRESETS: Readonly<
  Record<Exclude<AspectPreset, "custom">, number | null>
> = {
  free: null,
  "1:1": 1,
  "4:3": 4 / 3,
  "3:2": 3 / 2,
  "16:9": 16 / 9,
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

function sameFrame(left: PageFrame, right: PageFrame): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function sameConstraint(
  left: PageFrameAspectConstraint,
  right: PageFrameAspectConstraint,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "free" ||
      (right.kind === "ratio" && left.ratio === right.ratio))
  );
}

function presetForConstraint(
  constraint: PageFrameAspectConstraint,
): AspectPreset {
  if (constraint.kind === "free") return "free";
  for (const [preset, ratio] of Object.entries(ASPECT_PRESETS)) {
    if (ratio === constraint.ratio) return preset as AspectPreset;
  }
  return "custom";
}

function formatNumber(value: number): string {
  return String(Number(value.toPrecision(12)));
}

function pairedDimensionDraft(
  draft: Readonly<Record<PageFrameField, string>>,
  editedField: PageFrameField,
  compositionFrame: CoordinateSpace,
  constraint: PageFrameAspectConstraint,
): Record<PageFrameField, string> {
  if (
    constraint.kind === "free" ||
    (editedField !== "width" && editedField !== "height")
  ) {
    return { ...draft };
  }

  const value = Number(draft[editedField].trim());
  if (!Number.isFinite(value) || value <= 0) return { ...draft };

  if (editedField === "width") {
    const height =
      (value * compositionFrame.width) /
      (constraint.ratio * compositionFrame.height);
    return Number.isFinite(height) && height > 0
      ? { ...draft, height: formatNumber(height) }
      : { ...draft };
  }

  const width =
    (value * compositionFrame.height * constraint.ratio) /
    compositionFrame.width;
  return Number.isFinite(width) && width > 0
    ? { ...draft, width: formatNumber(width) }
    : { ...draft };
}

function parseCustomAspect(
  widthDraft: string,
  heightDraft: string,
):
  | { readonly constraint: PageFrameAspectConstraint; readonly error: null }
  | { readonly constraint: null; readonly error: CustomAspectError } {
  const width = Number(widthDraft.trim());
  if (!Number.isFinite(width) || width <= 0) {
    return {
      constraint: null,
      error: {
        field: "customAspectWidth",
        message: "Custom aspect width must be a finite number greater than 0.",
      },
    };
  }
  const height = Number(heightDraft.trim());
  if (!Number.isFinite(height) || height <= 0) {
    return {
      constraint: null,
      error: {
        field: "customAspectHeight",
        message: "Custom aspect height must be a finite number greater than 0.",
      },
    };
  }

  const ratio = width / height;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return {
      constraint: null,
      error: {
        field: "customAspectWidth",
        message: "Custom aspect ratio must be finite and greater than 0.",
      },
    };
  }
  return { constraint: { kind: "ratio", ratio }, error: null };
}

/** Transient numeric editor for a Page Frame expressed in Composition percentages. */
export function PageFrameEditor({
  compositionFrame,
  frame,
  initialFrame,
  profile,
  representedFrame,
  displayUnit,
  onDraftChange,
  onApply,
  onCancel,
  onReset,
  aspectConstraint: controlledAspectConstraint,
  onAspectConstraintChange,
}: PageFrameEditorProps) {
  const controlledFrame = frame ?? initialFrame;
  const [draft, setDraft] = useState(() =>
    initialDraft(controlledFrame, compositionFrame),
  );
  const [error, setError] = useState<PageFrameError | null>(null);
  const [physicalFieldsValid, setPhysicalFieldsValid] = useState(true);
  const [uncontrolledAspectConstraint, setUncontrolledAspectConstraint] =
    useState<PageFrameAspectConstraint>({ kind: "free" });
  const aspectConstraint =
    controlledAspectConstraint ?? uncontrolledAspectConstraint;
  const [aspectPreset, setAspectPreset] = useState<AspectPreset>(() =>
    presetForConstraint(aspectConstraint),
  );
  const [customAspectWidth, setCustomAspectWidth] = useState(() =>
    aspectConstraint.kind === "ratio"
      ? formatNumber(aspectConstraint.ratio)
      : formatNumber(controlledFrame.width),
  );
  const [customAspectHeight, setCustomAspectHeight] = useState(() =>
    aspectConstraint.kind === "ratio"
      ? "1"
      : formatNumber(controlledFrame.height),
  );
  const [customAspectError, setCustomAspectError] =
    useState<CustomAspectError | null>(null);
  const lastEmittedFrame = useRef<PageFrame | null>(null);
  const lastFrameProp = useRef({ frame: controlledFrame, compositionFrame });
  const lastEmittedConstraint = useRef<PageFrameAspectConstraint | null>(null);
  const lastControlledConstraint = useRef(controlledAspectConstraint);
  const errorId = useId();
  const customAspectErrorId = useId();

  useEffect(() => {
    const previous = lastFrameProp.current;
    lastFrameProp.current = { frame: controlledFrame, compositionFrame };
    if (
      sameFrame(previous.frame, controlledFrame) &&
      previous.compositionFrame.width === compositionFrame.width &&
      previous.compositionFrame.height === compositionFrame.height
    ) {
      return;
    }

    if (
      lastEmittedFrame.current !== null &&
      sameFrame(lastEmittedFrame.current, controlledFrame) &&
      previous.compositionFrame.width === compositionFrame.width &&
      previous.compositionFrame.height === compositionFrame.height
    ) {
      lastEmittedFrame.current = null;
      return;
    }

    lastEmittedFrame.current = null;
    setDraft(initialDraft(controlledFrame, compositionFrame));
    setError(null);
  }, [compositionFrame, controlledFrame]);

  useEffect(() => {
    if (controlledAspectConstraint === undefined) return;
    const previous = lastControlledConstraint.current;
    lastControlledConstraint.current = controlledAspectConstraint;
    if (
      previous !== undefined &&
      sameConstraint(previous, controlledAspectConstraint)
    ) {
      return;
    }

    if (
      lastEmittedConstraint.current !== null &&
      sameConstraint(lastEmittedConstraint.current, controlledAspectConstraint)
    ) {
      lastEmittedConstraint.current = null;
      return;
    }

    lastEmittedConstraint.current = null;
    setAspectPreset(presetForConstraint(controlledAspectConstraint));
    if (controlledAspectConstraint.kind === "ratio") {
      setCustomAspectWidth(formatNumber(controlledAspectConstraint.ratio));
      setCustomAspectHeight("1");
    }
    setCustomAspectError(null);
  }, [controlledAspectConstraint]);

  const emitAspectConstraint = (
    next: PageFrameAspectConstraint,
  ): void => {
    setCustomAspectError(null);
    if (controlledAspectConstraint === undefined) {
      setUncontrolledAspectConstraint(next);
    } else {
      lastEmittedConstraint.current = next;
    }
    onAspectConstraintChange?.(next);
  };

  const updateAspectPreset = (preset: AspectPreset): void => {
    setAspectPreset(preset);
    if (preset === "custom") {
      const widthDraft = formatNumber(controlledFrame.width);
      const heightDraft = formatNumber(controlledFrame.height);
      setCustomAspectWidth(widthDraft);
      setCustomAspectHeight(heightDraft);
      const parsed = parseCustomAspect(widthDraft, heightDraft);
      if (parsed.constraint === null) {
        setCustomAspectError(parsed.error);
      } else {
        emitAspectConstraint(parsed.constraint);
      }
      return;
    }

    const ratio = ASPECT_PRESETS[preset];
    emitAspectConstraint(
      ratio === null ? { kind: "free" } : { kind: "ratio", ratio },
    );
  };

  const applyCustomAspect = (): void => {
    const parsed = parseCustomAspect(customAspectWidth, customAspectHeight);
    if (parsed.constraint === null) {
      setCustomAspectError(parsed.error);
      return;
    }
    emitAspectConstraint(parsed.constraint);
  };

  const updateField = (field: PageFrameField, value: string): void => {
    const next = pairedDimensionDraft(
      { ...draft, [field]: value },
      field,
      compositionFrame,
      aspectConstraint,
    );
    setDraft(next);
    setError(null);
    const parsed = parseDraft(next, compositionFrame);
    if (parsed.frame !== null) {
      lastEmittedFrame.current = parsed.frame;
      onDraftChange(parsed.frame);
    }
  };

  const apply = (): void => {
    if (!physicalFieldsValid) return;
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
        frame={controlledFrame}
        displayUnit={displayUnit}
        onFrameChange={onDraftChange}
        onValidityChange={setPhysicalFieldsValid}
      />
      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span>Aspect ratio</span>
          <select
            name="aspectConstraint"
            value={aspectPreset}
            onChange={(event) =>
              updateAspectPreset(event.target.value as AspectPreset)
            }
            className="rounded-md border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <option value="free">Freeform</option>
            <option value="1:1">1:1</option>
            <option value="4:3">4:3</option>
            <option value="3:2">3:2</option>
            <option value="16:9">16:9</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        {aspectPreset === "custom" && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
              <span>Custom W</span>
              <input
                name="customAspectWidth"
                type="number"
                step="any"
                value={customAspectWidth}
                aria-invalid={
                  customAspectError?.field === "customAspectWidth" || undefined
                }
                aria-describedby={
                  customAspectError?.field === "customAspectWidth"
                    ? customAspectErrorId
                    : undefined
                }
                onChange={(event) => {
                  setCustomAspectWidth(event.target.value);
                  setCustomAspectError(null);
                }}
                className="min-w-0 rounded-md border bg-background px-2 py-1.5 text-right text-sm text-foreground tabular-nums outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
            </label>
            <span className="pb-1.5 text-muted-foreground" aria-hidden>
              :
            </span>
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
              <span>Custom H</span>
              <input
                name="customAspectHeight"
                type="number"
                step="any"
                value={customAspectHeight}
                aria-invalid={
                  customAspectError?.field === "customAspectHeight" || undefined
                }
                aria-describedby={
                  customAspectError?.field === "customAspectHeight"
                    ? customAspectErrorId
                    : undefined
                }
                onChange={(event) => {
                  setCustomAspectHeight(event.target.value);
                  setCustomAspectError(null);
                }}
                className="min-w-0 rounded-md border bg-background px-2 py-1.5 text-right text-sm text-foreground tabular-nums outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={applyCustomAspect}
            >
              Use Custom Ratio
            </Button>
          </div>
        )}
        {customAspectError !== null && (
          <p
            id={customAspectErrorId}
            role="alert"
            className="text-sm text-destructive"
          >
            {customAspectError.message}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Drag an edge or corner to resize. Drag inside the frame to pan the
          composition. Hold Shift while dragging for a temporary aspect lock.
          Aspect constraints also pair W and H edits and stay active until
          Freeform is selected.
        </p>
      </div>
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
