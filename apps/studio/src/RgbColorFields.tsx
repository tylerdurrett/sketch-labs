import { useEffect, useId, useRef, useState } from "react";

import {
  hexToRgb,
  parseRgbChannelDraft,
  rgbToHex,
  type RgbColor,
} from "./colorValue";

type RgbChannel = keyof RgbColor;
type RgbDrafts = Record<RgbChannel, string>;

const CHANNELS = ["r", "g", "b"] as const;
const CHANNEL_NAMES: Record<RgbChannel, string> = {
  r: "red",
  g: "green",
  b: "blue",
};

export interface RgbColorFieldsProps {
  /** The parameter key used to give each field a distinct accessible name. */
  paramKey: string;
  /** The controlled color in canonical `#rrggbb` form. */
  color: string;
  /** Begins one field edit on its first change, valid or invalid. */
  onEditBegin: () => void;
  /** Updates picker-local color immediately for every valid channel draft. */
  onLocalPreview: (next: string) => void;
  /** Settles the latest valid color once on Enter or blur. */
  onSettle: (next: string) => void;
  /** Cancels the edit and restores the whole color captured on focus. */
  onCancel: (focusColor: string) => void;
}

function colorToDrafts(color: string): RgbDrafts {
  const rgb = hexToRgb(color) ?? { r: 0, g: 0, b: 0 };
  return {
    r: String(rgb.r),
    g: String(rgb.g),
    b: String(rgb.b),
  };
}

/**
 * Controlled RGB entry with local text drafts for partial and invalid input.
 *
 * Valid integer drafts preview a canonical color immediately. Invalid drafts
 * remain isolated to their focused field until blur/Enter cancels them or
 * Escape restores the complete color snapshot taken when focus arrived.
 */
export function RgbColorFields({
  paramKey,
  color,
  onEditBegin,
  onLocalPreview,
  onSettle,
  onCancel,
}: RgbColorFieldsProps) {
  const guidanceId = useId();
  const [drafts, setDrafts] = useState(() => colorToDrafts(color));
  const [active, setActive] = useState(false);
  const focusedChannelRef = useRef<RgbChannel | null>(null);
  const focusColorRef = useRef(color);
  const lastValidColorRef = useRef(color);
  const activeRef = useRef(false);
  const finishedRef = useRef(false);

  useEffect(() => {
    // A merely focused field is still idle. Once the user changes its draft,
    // the local interaction owns the display until it settles or cancels.
    if (activeRef.current) return;
    setDrafts(colorToDrafts(color));
    lastValidColorRef.current = color;
  }, [color]);

  const begin = () => {
    if (activeRef.current) return;
    activeRef.current = true;
    setActive(true);
    finishedRef.current = false;
    onEditBegin();
  };

  const restore = (snapshot: string) => {
    lastValidColorRef.current = snapshot;
    setDrafts(colorToDrafts(snapshot));
  };

  const finish = () => {
    if (!activeRef.current || finishedRef.current) return;

    finishedRef.current = true;
    activeRef.current = false;
    setActive(false);
    const channel = focusedChannelRef.current;
    const result = channel === null
      ? { valid: false as const }
      : parseRgbChannelDraft(drafts[channel]);

    if (result.valid) {
      const settledColor = lastValidColorRef.current;
      setDrafts(colorToDrafts(settledColor));
      onSettle(settledColor);
    } else {
      const snapshot = focusColorRef.current;
      restore(snapshot);
      onCancel(snapshot);
    }
  };

  const cancel = () => {
    if (!activeRef.current || finishedRef.current) return;
    finishedRef.current = true;
    activeRef.current = false;
    setActive(false);
    const snapshot = focusColorRef.current;
    restore(snapshot);
    onCancel(snapshot);
  };

  return (
    <div
      className="flex gap-2"
      role="group"
      aria-label={`${paramKey} RGB channels`}
      data-studio-history={active ? "exclude" : undefined}
    >
      <span id={guidanceId} className="sr-only">
        Enter an integer from 0 through 255. Out-of-range values are clamped.
      </span>
      {CHANNELS.map((channel) => (
        <label key={channel} className="flex min-w-0 flex-1 items-center gap-1">
          <span className="text-xs font-medium uppercase text-muted-foreground">
            {channel}
          </span>
          <input
            type="text"
            inputMode="numeric"
            aria-label={`${paramKey} ${CHANNEL_NAMES[channel]} channel`}
            aria-describedby={guidanceId}
            aria-invalid={
              parseRgbChannelDraft(drafts[channel]).valid ? undefined : true
            }
            value={drafts[channel]}
            onFocus={() => {
              focusedChannelRef.current = channel;
              focusColorRef.current = color;
              lastValidColorRef.current = color;
              activeRef.current = false;
              finishedRef.current = false;
            }}
            onChange={(event) => {
              const rawDraft = event.target.value;
              begin();

              const parsed = parseRgbChannelDraft(rawDraft);
              if (!parsed.valid) {
                setDrafts((current) => ({ ...current, [channel]: rawDraft }));
                return;
              }

              const current = hexToRgb(lastValidColorRef.current) ?? {
                r: 0,
                g: 0,
                b: 0,
              };
              const nextColor = rgbToHex({ ...current, [channel]: parsed.value });
              lastValidColorRef.current = nextColor;
              const canonicalDrafts = colorToDrafts(nextColor);
              setDrafts({ ...canonicalDrafts, [channel]: rawDraft });
              onLocalPreview(nextColor);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                finish();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancel();
              }
            }}
            onBlur={() => {
              finish();
              focusedChannelRef.current = null;
            }}
            className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-right text-sm text-foreground tabular-nums outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </label>
      ))}
    </div>
  );
}
