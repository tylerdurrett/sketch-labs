/** An RGB color whose channels conventionally occupy the inclusive 0–255 range. */
export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** An HSV color expressed as hue degrees and saturation/value percentages. */
export interface HsvColor {
  readonly h: number;
  readonly s: number;
  readonly v: number;
}

const CANONICAL_HEX_COLOR = /^#[0-9a-f]{6}$/;
const INTEGER_DECIMAL_DRAFT = /^[+-]?\d+$/;

/** Whether a value is exactly the Studio's lowercase `#rrggbb` color form. */
export function isCanonicalHexColor(value: string): boolean {
  return CANONICAL_HEX_COLOR.test(value);
}

/** Parse a canonical lowercase `#rrggbb` color, rejecting every other form. */
export function hexToRgb(value: string): RgbColor | null {
  if (!isCanonicalHexColor(value)) return null;

  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
  };
}

/** Serialize RGB channels to canonical hex after rounding and clamping them. */
export function rgbToHex(color: RgbColor): string {
  return `#${channelToHex(color.r)}${channelToHex(color.g)}${channelToHex(color.b)}`;
}

/** Convert RGB channels to hue degrees and saturation/value percentages. */
export function rgbToHsv(color: RgbColor): HsvColor {
  const r = normalizeChannel(color.r) / 255;
  const g = normalizeChannel(color.g) / 255;
  const b = normalizeChannel(color.b) / 255;
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const delta = maximum - minimum;

  let h = 0;
  if (delta !== 0) {
    if (maximum === r) {
      h = 60 * (((g - b) / delta) % 6);
    } else if (maximum === g) {
      h = 60 * ((b - r) / delta + 2);
    } else {
      h = 60 * ((r - g) / delta + 4);
    }
  }

  if (h < 0) h += 360;

  return {
    h,
    s: maximum === 0 ? 0 : (delta / maximum) * 100,
    v: maximum * 100,
  };
}

/** Parse canonical hex and convert it to HSV for accessible color descriptions. */
export function hexToHsv(value: string): HsvColor | null {
  const rgb = hexToRgb(value);
  return rgb === null ? null : rgbToHsv(rgb);
}

/**
 * Parse a draft RGB channel as a signed base-10 integer and clamp it to 0–255.
 * Partial, fractional, exponential, and non-finite drafts fail.
 */
export function parseRgbChannelDraft(value: string): number | null {
  const trimmed = value.trim();
  if (!INTEGER_DECIMAL_DRAFT.test(trimmed)) return null;

  const channel = Number(trimmed);
  if (!Number.isFinite(channel)) return null;
  return clampChannel(channel);
}

function channelToHex(channel: number): string {
  return normalizeChannel(channel).toString(16).padStart(2, "0");
}

function normalizeChannel(channel: number): number {
  if (Number.isNaN(channel)) return 0;
  return Math.round(clampChannel(channel));
}

function clampChannel(channel: number): number {
  return Math.min(255, Math.max(0, channel));
}
