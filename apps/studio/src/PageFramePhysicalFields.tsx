import {
  derivePageFramePlotProfile,
  inchToMm,
  resizePageFrameFromPhysicalDimension,
  type PageFrame,
  type PageFramePhysicalDimension,
  type PlotProfile,
} from "@harness/core";
import { useEffect, useId, useState } from "react";

import {
  formatPaperDimension,
  type PaperDisplayUnit,
} from "./paperDisplayUnit";

export interface PageFramePhysicalFieldsProps {
  /** The canonical profile representing `representedFrame`. */
  profile: PlotProfile;
  /** The committed frame whose drawable extent is represented by `profile`. */
  representedFrame: PageFrame;
  /** The current transient Page Frame draft. */
  frame: PageFrame;
  displayUnit: PaperDisplayUnit;
  onFrameChange: (frame: PageFrame) => void;
  /** Lets a containing commit boundary block while a local text draft is invalid. */
  onValidityChange?: (valid: boolean) => void;
  /**
   * Present the exact profile dimensions without allowing Page-size edits.
   * Fixed-page framing owns scale and position instead, so the profile and all
   * four of its physical insets remain visible but immutable.
   */
  readOnly?: boolean;
}

interface PhysicalFieldError {
  readonly field: PageFramePhysicalDimension;
  readonly message: string;
}

const DIMENSIONS = ["width", "height"] as const;
const INSET_LABELS = {
  top: "Top inset",
  right: "Right inset",
  bottom: "Bottom inset",
  left: "Left inset",
} as const;

function physicalDrafts(
  profile: PlotProfile,
  representedFrame: PageFrame,
  frame: PageFrame,
  displayUnit: PaperDisplayUnit,
): Record<PageFramePhysicalDimension, string> {
  const draftProfile = derivePageFramePlotProfile(
    profile,
    representedFrame,
    frame,
  );
  return {
    width: formatPaperDimension(draftProfile.width, displayUnit),
    height: formatPaperDimension(draftProfile.height, displayUnit),
  };
}

function dimensionLabel(dimension: PageFramePhysicalDimension): string {
  return dimension === "width" ? "Page width" : "Page height";
}

/** Controlled total-paper dimensions for the transient Page Frame draft. */
export function PageFramePhysicalFields({
  profile,
  representedFrame,
  frame,
  displayUnit,
  onFrameChange,
  onValidityChange,
  readOnly = false,
}: PageFramePhysicalFieldsProps) {
  const [drafts, setDrafts] = useState(() =>
    physicalDrafts(profile, representedFrame, frame, displayUnit),
  );
  const [error, setError] = useState<PhysicalFieldError | null>(null);
  const errorId = useId();

  useEffect(() => {
    setDrafts(
      physicalDrafts(profile, representedFrame, frame, displayUnit),
    );
    setError(null);
    onValidityChange?.(true);
  }, [
    displayUnit,
    readOnly,
    frame.height,
    frame.width,
    profile.height,
    profile.insets.bottom,
    profile.insets.left,
    profile.insets.right,
    profile.insets.top,
    profile.width,
    representedFrame.height,
    representedFrame.width,
  ]);

  const updateDimension = (
    dimension: PageFramePhysicalDimension,
    raw: string,
  ): void => {
    if (readOnly) return;
    setDrafts((current) => ({ ...current, [dimension]: raw }));

    const displayValue = raw.trim() === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(displayValue) || displayValue <= 0) {
      onValidityChange?.(false);
      setError({
        field: dimension,
        message: `${dimensionLabel(dimension)} must be a finite positive number.`,
      });
      return;
    }

    const millimeters =
      displayUnit === "in" ? inchToMm(displayValue) : displayValue;
    if (!Number.isFinite(millimeters)) {
      onValidityChange?.(false);
      setError({
        field: dimension,
        message: `${dimensionLabel(dimension)} must be a finite positive number.`,
      });
      return;
    }

    const insetExtent =
      dimension === "width"
        ? profile.insets.left + profile.insets.right
        : profile.insets.top + profile.insets.bottom;
    if (millimeters <= insetExtent) {
      onValidityChange?.(false);
      const axis = dimension === "width" ? "horizontal" : "vertical";
      setError({
        field: dimension,
        message: `${dimensionLabel(dimension)} must exceed the fixed ${axis} paper insets.`,
      });
      return;
    }

    try {
      const next = resizePageFrameFromPhysicalDimension(
        profile,
        representedFrame,
        frame,
        dimension,
        millimeters,
      );
      setError(null);
      onValidityChange?.(true);
      onFrameChange(next);
    } catch {
      onValidityChange?.(false);
      setError({
        field: dimension,
        message: `${dimensionLabel(dimension)} must produce a finite positive Page extent.`,
      });
    }
  };

  return (
    <fieldset className="grid grid-cols-2 gap-3">
      <legend className="col-span-2 text-xs text-muted-foreground">
        Total physical paper size
      </legend>
      {DIMENSIONS.map((dimension) => (
        <label key={dimension} className="flex flex-col gap-1 text-sm">
          <span>{dimension === "width" ? "Width" : "Height"}</span>
          <span className="flex items-center gap-1">
            <input
              name={`physical-${dimension}`}
              type="number"
              step="any"
              value={drafts[dimension]}
              readOnly={readOnly}
              aria-label={`${dimensionLabel(dimension)} (${displayUnit})`}
              aria-invalid={error?.field === dimension || undefined}
              aria-describedby={
                error?.field === dimension ? errorId : undefined
              }
              onChange={(event) =>
                updateDimension(dimension, event.target.value)
              }
              className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-right text-sm text-foreground tabular-nums outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            <span className="text-muted-foreground" aria-hidden>
              {displayUnit}
            </span>
          </span>
        </label>
      ))}
      {readOnly && (
        <div className="col-span-2 grid grid-cols-2 gap-3">
          {(["top", "right", "bottom", "left"] as const).map((side) => (
            <label key={side} className="flex flex-col gap-1 text-sm">
              <span>{INSET_LABELS[side]}</span>
              <span className="flex items-center gap-1">
                <input
                  name={`physical-inset-${side}`}
                  type="number"
                  value={formatPaperDimension(
                    profile.insets[side],
                    displayUnit,
                  )}
                  aria-label={`Page ${side} inset (${displayUnit})`}
                  readOnly
                  className="min-w-0 flex-1 rounded-md border bg-muted px-2 py-1.5 text-right text-sm text-muted-foreground tabular-nums"
                />
                <span className="text-muted-foreground" aria-hidden>
                  {displayUnit}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
      {error !== null && (
        <p
          id={errorId}
          role="alert"
          className="col-span-2 text-sm text-destructive"
        >
          {error.message}
        </p>
      )}
    </fieldset>
  );
}
