import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import {
  applyStandardPaper,
  derivePaperOrientation,
  inchToMm,
  matchStandardPaper,
  STANDARD_PAPER_NAMES,
  swapPlotOrientation,
  validatePlotProfile,
  type PlotProfile,
  type StandardPaperName,
} from "@harness/core";

import type { EditTransactionLifecycle } from "./editHistory";
import {
  formatPaperDimension as formatDimension,
  readPaperDisplayUnit,
  writePaperDisplayUnit,
  type PaperDisplayUnit,
} from "./paperDisplayUnit";

export { PAPER_DISPLAY_UNIT_STORAGE_KEY } from "./paperDisplayUnit";

export type PaperProfileCandidateSource =
  | "width"
  | "height"
  | "margin"
  | "format"
  | "orientation";

export type PaperProfileCandidateDecision =
  | { readonly kind: "accept"; readonly profile: PlotProfile }
  | { readonly kind: "reject"; readonly message: string };

/** Decide an aspect-affecting Paper candidate before Studio previews it. */
export type PaperProfileCandidateRouter = (
  candidate: PlotProfile,
  source: PaperProfileCandidateSource,
) => PaperProfileCandidateDecision;

interface PaperSectionBaseProps {
  /** The authoritative, millimeter-canonical Plot Profile owned by Studio. */
  profile: PlotProfile;
  /** Whether physical plotter SVGs include the full paper extent. */
  includePaperMargins: boolean;
  /** Update Studio's export preference without changing the Plot Profile. */
  onIncludePaperMarginsChange: (includePaperMargins: boolean) => void;
  /**
   * Optional owner boundary for framed Page semantics. It may normalize a
   * candidate, accept it unchanged, or reject it before any edit callback.
   */
  routeProfileCandidate?: PaperProfileCandidateRouter | undefined;
  /** Controlled lock state for an existing committed Page Frame. */
  aspectLocked?: boolean | undefined;
  /** Commit an explicit user lock/unlock choice. */
  onAspectLockedChange?: ((locked: boolean) => void) | undefined;
}

interface TransactionalPaperSectionProps {
  /** Lifecycle for focus-bounded dimension and margin edits. */
  transaction: EditTransactionLifecycle<PlotProfile>;
  /** Commit one format, orientation, or composition-frame command. */
  onAtomicChange: (profile: PlotProfile) => void;
  onChange?: never;
}

interface LegacyPaperSectionProps {
  /** @deprecated Supply `transaction` and `onAtomicChange` for history support. */
  onChange: (profile: PlotProfile) => void;
  transaction?: never;
  onAtomicChange?: never;
}

export type PaperSectionProps = PaperSectionBaseProps &
  (TransactionalPaperSectionProps | LegacyPaperSectionProps);

type PaperDimension = "width" | "height";
type PaperErrorTarget =
  | "format"
  | "orientation"
  | "margin"
  | "toolWidth"
  | PaperDimension;
type PaperField = PaperDimension | "margin" | "toolWidth";

interface PaperError {
  target: PaperErrorTarget;
  message: string;
}

function paperName(name: StandardPaperName): string {
  return name.startsWith("a")
    ? name.toUpperCase()
    : `${name[0]!.toUpperCase()}${name.slice(1)}`;
}

function linkedInset(profile: PlotProfile): number | null {
  const { top, right, bottom, left } = profile.insets;
  return top === right && right === bottom && bottom === left ? top : null;
}

function copyProfile(profile: PlotProfile): PlotProfile {
  return { ...profile, insets: { ...profile.insets } };
}

function sameProfile(left: PlotProfile, right: PlotProfile): boolean {
  return (
    Object.is(left.width, right.width) &&
    Object.is(left.height, right.height) &&
    Object.is(left.insets.top, right.insets.top) &&
    Object.is(left.insets.right, right.insets.right) &&
    Object.is(left.insets.bottom, right.insets.bottom) &&
    Object.is(left.insets.left, right.insets.left) &&
    left.includeFrame === right.includeFrame &&
    Object.is(left.toolWidthMillimeters, right.toolWidthMillimeters)
  );
}

/**
 * The controlled Paper inspector boundary.
 *
 * The native disclosure is collapsed by default and keeps the active dimensions
 * visible in its summary. Display units are deliberately local presentation
 * state: changing them never rewrites the canonical millimeter profile and never
 * invokes an edit callback. Dimension and margin fields preview complete profiles
 * through one focus-bounded transaction; discrete controls commit atomically.
 */
export function PaperSection({
  profile,
  includePaperMargins,
  onIncludePaperMarginsChange,
  routeProfileCandidate,
  aspectLocked,
  onAspectLockedChange,
  ...editProps
}: PaperSectionProps) {
  const [displayUnit, setDisplayUnit] =
    useState<PaperDisplayUnit>(readPaperDisplayUnit);
  const [dimensionDrafts, setDimensionDrafts] = useState(() => ({
    width: formatDimension(profile.width, displayUnit),
    height: formatDimension(profile.height, displayUnit),
  }));
  const [marginDraft, setMarginDraft] = useState(() => {
    const inset = linkedInset(profile);
    return inset === null ? "" : formatDimension(inset, displayUnit);
  });
  const [toolWidthDraft, setToolWidthDraft] = useState(() =>
    formatDimension(profile.toolWidthMillimeters, displayUnit),
  );
  const [error, setError] = useState<PaperError | null>(null);
  const activeField = useRef<{
    field: PaperField;
    snapshot: PlotProfile;
  } | null>(null);
  const dirtyDimensions = useRef<Set<PaperDimension>>(new Set());
  const id = useId();

  useEffect(() => {
    writePaperDisplayUnit(displayUnit);
  }, [displayUnit]);

  // A controlled profile update (including a Preset reload) or a presentation-
  // unit change replaces the drafts from the canonical model. Invalid partial
  // text otherwise remains editable because it does not change these dependencies.
  useEffect(() => {
    if (activeField.current !== null) return;
    setDimensionDrafts({
      width: formatDimension(profile.width, displayUnit),
      height: formatDimension(profile.height, displayUnit),
    });
    const inset = linkedInset(profile);
    setMarginDraft(inset === null ? "" : formatDimension(inset, displayUnit));
    setToolWidthDraft(
      formatDimension(profile.toolWidthMillimeters, displayUnit),
    );
    dirtyDimensions.current.clear();
    setError(null);
  }, [
    displayUnit,
    profile.height,
    profile.insets.bottom,
    profile.insets.left,
    profile.insets.right,
    profile.insets.top,
    profile.toolWidthMillimeters,
    profile.width,
  ]);

  const preview = (candidate: PlotProfile): void => {
    if ("transaction" in editProps && editProps.transaction !== undefined) {
      editProps.transaction.onPreview(candidate);
    } else {
      editProps.onChange(candidate);
    }
  };

  const restoreControlledDrafts = (): void => {
    setDimensionDrafts({
      width: formatDimension(profile.width, displayUnit),
      height: formatDimension(profile.height, displayUnit),
    });
    const inset = linkedInset(profile);
    setMarginDraft(inset === null ? "" : formatDimension(inset, displayUnit));
    setToolWidthDraft(
      formatDimension(profile.toolWidthMillimeters, displayUnit),
    );
    dirtyDimensions.current.clear();
  };

  const routeCandidate = (
    candidate: PlotProfile,
    source: PaperProfileCandidateSource,
    target: PaperErrorTarget,
  ): PlotProfile | null => {
    if (routeProfileCandidate === undefined) return candidate;

    const decision = routeProfileCandidate(candidate, source);
    if (decision.kind === "reject") {
      restoreControlledDrafts();
      setError({ target, message: decision.message });
      return null;
    }

    if (!sameProfile(candidate, decision.profile)) {
      if (source === "width" || source === "height") {
        setDimensionDrafts({
          width: formatDimension(decision.profile.width, displayUnit),
          height: formatDimension(decision.profile.height, displayUnit),
        });
      } else if (source === "margin") {
        const inset = linkedInset(decision.profile);
        setMarginDraft(
          inset === null ? "" : formatDimension(inset, displayUnit),
        );
      }
    }
    return decision.profile;
  };

  const beginField = (field: PaperField): void => {
    if (activeField.current?.field === field) return;
    dirtyDimensions.current.clear();
    activeField.current = { field, snapshot: copyProfile(profile) };
    if ("transaction" in editProps && editProps.transaction !== undefined) {
      editProps.transaction.onBegin();
    }
  };

  const commitField = (field: PaperField): void => {
    if (activeField.current?.field !== field) return;
    activeField.current = null;
    dirtyDimensions.current.clear();
    if ("transaction" in editProps && editProps.transaction !== undefined) {
      editProps.transaction.onCommit();
    }
  };

  const cancelField = (field: PaperField): void => {
    const active = activeField.current;
    if (active?.field !== field) return;
    activeField.current = null;
    dirtyDimensions.current.clear();
    const snapshot = active.snapshot;
    setDimensionDrafts({
      width: formatDimension(snapshot.width, displayUnit),
      height: formatDimension(snapshot.height, displayUnit),
    });
    const inset = linkedInset(snapshot);
    setMarginDraft(inset === null ? "" : formatDimension(inset, displayUnit));
    setToolWidthDraft(
      formatDimension(snapshot.toolWidthMillimeters, displayUnit),
    );
    setError(null);
    if ("transaction" in editProps && editProps.transaction !== undefined) {
      editProps.transaction.onCancel();
    } else {
      editProps.onChange(snapshot);
    }
  };

  const handleFieldKeyDown = (
    field: PaperField,
    event: KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelField(field);
      event.currentTarget.blur();
    } else if (event.key === "Enter") {
      event.preventDefault();
      commitField(field);
      event.currentTarget.blur();
    }
  };

  const commitCandidate = (
    candidate: PlotProfile,
    target: PaperErrorTarget,
    source?: PaperProfileCandidateSource,
  ): void => {
    try {
      validatePlotProfile(candidate);
      const accepted =
        source === undefined
          ? candidate
          : routeCandidate(candidate, source, target);
      if (accepted === null) return;
      validatePlotProfile(accepted);
      setError(null);
      preview(accepted);
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Invalid paper dimensions";
      // Dimension edits can accumulate as transient drafts, so validation may
      // identify the OTHER dirty dimension. Core's messages name the affected
      // axis; format changes remain owned by the select as a single operation.
      const resolvedTarget =
        target !== "width" && target !== "height"
          ? target
          : message.includes("width") || message.includes("horizontal")
            ? "width"
            : message.includes("height") || message.includes("vertical")
              ? "height"
              : target;
      setError({ target: resolvedTarget, message });
    }
  };

  const editDimension = (dimension: PaperDimension, draft: string): void => {
    const nextDrafts = { ...dimensionDrafts, [dimension]: draft };
    setDimensionDrafts(nextDrafts);
    dirtyDimensions.current.add(dimension);

    const candidate = { ...profile };
    for (const dirty of dirtyDimensions.current) {
      const dirtyDraft = nextDrafts[dirty];
      if (dirtyDraft.trim() === "") {
        setError({
          target: dirty,
          message: `${dirty[0]!.toUpperCase()}${dirty.slice(1)} is required.`,
        });
        return;
      }
      const displayValue = Number(dirtyDraft);
      candidate[dirty] =
        displayUnit === "in" ? inchToMm(displayValue) : displayValue;
    }
    commitCandidate(candidate, dimension, dimension);
  };

  const commitAtomicCandidate = (
    candidate: PlotProfile,
    target: PaperErrorTarget,
    source?: PaperProfileCandidateSource,
  ): void => {
    try {
      validatePlotProfile(candidate);
      const accepted =
        source === undefined
          ? candidate
          : routeCandidate(candidate, source, target);
      if (accepted === null) return;
      validatePlotProfile(accepted);
      setError(null);
      if (sameProfile(profile, accepted)) return;
      if (
        "onAtomicChange" in editProps &&
        editProps.onAtomicChange !== undefined
      ) {
        editProps.onAtomicChange(accepted);
      } else {
        editProps.onChange(accepted);
      }
    } catch (cause) {
      setError({
        target,
        message:
          cause instanceof Error ? cause.message : "Invalid paper dimensions",
      });
    }
  };

  const selectFormat = (value: string): void => {
    if (value === "custom") return;

    const name = value as StandardPaperName;
    commitAtomicCandidate(
      applyStandardPaper(profile, name, derivePaperOrientation(profile)),
      "format",
      "format",
    );
  };

  const swapOrientation = (): void => {
    commitAtomicCandidate(
      swapPlotOrientation(profile),
      "orientation",
      "orientation",
    );
  };

  const editMargin = (draft: string): void => {
    setMarginDraft(draft);
    if (draft.trim() === "") {
      setError({ target: "margin", message: "Margin is required." });
      return;
    }

    const displayValue = Number(draft);
    const millimeters =
      displayUnit === "in" ? inchToMm(displayValue) : displayValue;
    commitCandidate(
      {
        ...profile,
        insets: {
          top: millimeters,
          right: millimeters,
          bottom: millimeters,
          left: millimeters,
        },
      },
      "margin",
      "margin",
    );
  };

  const editToolWidth = (draft: string): void => {
    setToolWidthDraft(draft);
    if (draft.trim() === "") {
      setError({ target: "toolWidth", message: "Tool width is required." });
      return;
    }

    const displayValue = Number(draft);
    commitCandidate(
      {
        ...profile,
        toolWidthMillimeters:
          displayUnit === "in" ? inchToMm(displayValue) : displayValue,
      },
      "toolWidth",
    );
  };

  const dimensions = `${formatDimension(profile.width, displayUnit)} × ${formatDimension(profile.height, displayUnit)} ${displayUnit}`;
  const format = matchStandardPaper(profile) ?? "custom";
  const isExactSquare = profile.width === profile.height;
  const errorId = `${id}-error`;

  return (
    <details className="min-w-0 rounded-lg border border-border bg-card px-3 py-2">
      <summary className="flex min-w-0 cursor-pointer items-center justify-between gap-3 text-sm font-medium">
        <span>Paper</span>
        <span className="min-w-0 text-muted-foreground tabular-nums">
          {dimensions}
        </span>
      </summary>
      <div className="mt-3 min-w-0 space-y-3">
        <div className="flex min-w-0 items-center gap-3">
          <label
            className="min-w-16 text-sm text-muted-foreground"
            htmlFor={`${id}-format`}
          >
            format
          </label>
          <select
            id={`${id}-format`}
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
            value={format}
            aria-invalid={error?.target === "format"}
            aria-describedby={error?.target === "format" ? errorId : undefined}
            onChange={(event) => selectFormat(event.target.value)}
          >
            {STANDARD_PAPER_NAMES.map((name) => (
              <option key={name} value={name}>
                {paperName(name)}
              </option>
            ))}
            <option value="custom">Custom</option>
          </select>
        </div>
        <fieldset className="flex min-w-0 items-center gap-3 border-0 p-0">
          <legend className="sr-only">Paper display units</legend>
          <span aria-hidden className="min-w-16 text-sm text-muted-foreground">
            units
          </span>
          {(["mm", "in"] as const).map((unit) => (
            <label key={unit} className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name={`${id}-paper-display-unit`}
                value={unit}
                checked={displayUnit === unit}
                onChange={() => setDisplayUnit(unit)}
              />
              {unit}
            </label>
          ))}
        </fieldset>
        <fieldset className="grid min-w-0 grid-cols-2 gap-3 border-0 p-0">
          <legend className="sr-only">Custom paper dimensions</legend>
          {(["width", "height"] as const).map((dimension) => (
            <label key={dimension} className="grid min-w-0 gap-1 text-sm">
              <span className="text-muted-foreground">{dimension}</span>
              <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5">
                <input
                  className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-right tabular-nums"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={dimensionDrafts[dimension]}
                  aria-label={`Paper ${dimension} (${displayUnit})`}
                  aria-invalid={error?.target === dimension}
                  aria-describedby={
                    error?.target === dimension ? errorId : undefined
                  }
                  onChange={(event) =>
                    editDimension(dimension, event.target.value)
                  }
                  onFocus={() => beginField(dimension)}
                  onBlur={() => commitField(dimension)}
                  onKeyDown={(event) => handleFieldKeyDown(dimension, event)}
                />
                <span aria-hidden className="text-muted-foreground">
                  {displayUnit}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="flex min-w-0 items-center gap-3">
          <span className="min-w-16 text-sm text-muted-foreground">
            orientation
          </span>
          <button
            type="button"
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
            disabled={isExactSquare}
            aria-invalid={error?.target === "orientation"}
            aria-describedby={
              error?.target === "orientation" ? errorId : undefined
            }
            onClick={isExactSquare ? undefined : swapOrientation}
          >
            {isExactSquare
              ? "Square"
              : `Swap to ${derivePaperOrientation(profile) === "portrait" ? "landscape" : "portrait"}`}
          </button>
        </div>
        {aspectLocked === undefined ||
        onAspectLockedChange === undefined ? null : (
          <label className="flex min-w-0 items-center gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="Lock Page aspect"
              checked={aspectLocked}
              onChange={(event) =>
                onAspectLockedChange(event.target.checked)
              }
            />
            <span>Lock Page aspect</span>
          </label>
        )}
        <label className="grid min-w-0 gap-1 text-sm">
          <span className="text-muted-foreground">linked margin</span>
          <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5">
            <input
              className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-right tabular-nums"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={marginDraft}
              placeholder={linkedInset(profile) === null ? "mixed" : undefined}
              aria-label={`Linked paper margin (${displayUnit})`}
              aria-invalid={error?.target === "margin"}
              aria-describedby={
                error?.target === "margin" ? errorId : undefined
              }
              onChange={(event) => editMargin(event.target.value)}
              onFocus={() => beginField("margin")}
              onBlur={() => commitField("margin")}
              onKeyDown={(event) => handleFieldKeyDown("margin", event)}
            />
            <span aria-hidden className="text-muted-foreground">
              {displayUnit}
            </span>
          </span>
        </label>
        <label className="grid min-w-0 gap-1 text-sm">
          <span className="text-muted-foreground">tool width</span>
          <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5">
            <input
              className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-right tabular-nums"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={toolWidthDraft}
              aria-label={`Tool width (${displayUnit})`}
              aria-invalid={error?.target === "toolWidth"}
              aria-describedby={
                error?.target === "toolWidth" ? errorId : undefined
              }
              onChange={(event) => editToolWidth(event.target.value)}
              onFocus={() => beginField("toolWidth")}
              onBlur={() => commitField("toolWidth")}
              onKeyDown={(event) => handleFieldKeyDown("toolWidth", event)}
            />
            <span aria-hidden className="text-muted-foreground">
              {displayUnit}
            </span>
          </span>
        </label>
        <label className="flex min-w-0 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={profile.includeFrame}
            onChange={(event) =>
              commitAtomicCandidate(
                { ...profile, includeFrame: event.target.checked },
                "format",
              )
            }
          />
          <span>Include composition frame</span>
        </label>
        <label className="flex min-w-0 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includePaperMargins}
            onChange={(event) =>
              onIncludePaperMarginsChange(event.target.checked)
            }
          />
          <span>Include paper margins in plotter SVG</span>
        </label>
        {error === null ? null : (
          <p id={errorId} role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        )}
      </div>
    </details>
  );
}
