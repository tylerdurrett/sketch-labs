/**
 * Photo Scribble's tone-domain controls.
 *
 * All three controls are 0-1 sliders with 0.5 as exact identity. The
 * photographic source first applies an identity-centered gamma curve, then a
 * pivot-anchored contrast line. Both curves map their control exponentially
 * around center (`base ** (2 * (control - 0.5))`): equal slider steps multiply
 * the effect equally, reciprocal control pairs (0.25/0.75) cancel exactly, and
 * the top of the range reaches blow-out strength without collapsing the usable
 * identity region the way a linear map would.
 *
 * Contrast gain base 20 puts the gain in `[1/20, 20]`. At maximum, the line
 * through the pivot has slope 20, so the whole 0-to-1 transition fits inside a
 * 1/20-wide band around the pivot: a smooth ramp renders effectively binary.
 * That base constant is the blow-out tuning knob. Gamma base 8 spans exponents
 * `[1/8, 8]` — enough to crush-to-paper or blow-to-ink on its own, well beyond
 * the earlier `[0.5, 2]`.
 *
 * `tonePivot` makes the contrast anchor explicit: `out = pivot + (in - pivot)
 * * gain`, clamped to `[0, 1]`. At high gain the pivot is a movable threshold.
 *
 * Zero-preservation is an explicit guard, not emergent: tone exactly 0 returns
 * 0 before any curve runs, so an adjustment can never turn an absent target
 * into ink demand. The pivot line requires the guard — at gain < 1 it would
 * lift tone 0 to `pivot * (1 - gain)` — leaving a deliberate discontinuity at
 * 0 for gain < 1, as the previous hard-coded-pivot curve already had in kind.
 * Identity at 0.5 is an early return on the control value (float-exact);
 * contrast 0.5 is identity at any pivot. These controls remain source-side
 * concerns; the Scribble Strategy only receives their completed Tone Field.
 */

export interface PhotoToneControls {
  /** Identity-centered power-curve control in the declared `[0, 1]` range. */
  readonly toneGamma: number
  /** Identity-centered pivot-anchored contrast control in the declared `[0, 1]` range. */
  readonly toneContrast: number
  /** Contrast pivot in `[0, 1]` — the movable tonal cut point. */
  readonly tonePivot: number
}

export const PHOTO_TONE_CONTROL_MIN = 0
export const PHOTO_TONE_CONTROL_MAX = 1
export const PHOTO_TONE_CONTROL_DEFAULT = 0.5

const TONE_GAMMA_EXPONENT_BASE = 8 // exponent spans [1/8, 8], identity at 0.5
const TONE_CONTRAST_GAIN_BASE = 20 // gain spans [1/20, 20], identity at 0.5

function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function clampControl(value: number): number {
  if (!Number.isFinite(value)) return PHOTO_TONE_CONTROL_DEFAULT
  return clampUnit(value)
}

/** Map the centered gamma control to a positive `[0.125, 8]` exponent. */
export function toneGammaExponent(toneGamma: number): number {
  const control = clampControl(toneGamma)
  return TONE_GAMMA_EXPONENT_BASE ** (2 * (control - PHOTO_TONE_CONTROL_DEFAULT))
}

/** Apply Photo Scribble's zero-preserving power curve in the tone domain. */
export function applyToneGamma(tone: number, toneGamma: number): number {
  const boundedTone = clampUnit(tone)
  if (boundedTone === 0) return 0
  const control = clampControl(toneGamma)
  if (control === PHOTO_TONE_CONTROL_DEFAULT) return boundedTone
  return clampUnit(boundedTone ** toneGammaExponent(control))
}

/** Map the centered contrast control to a positive `[0.05, 20]` gain. */
export function toneContrastGain(toneContrast: number): number {
  const control = clampControl(toneContrast)
  return TONE_CONTRAST_GAIN_BASE ** (2 * (control - PHOTO_TONE_CONTROL_DEFAULT))
}

/** Apply Photo Scribble's zero-preserving, pivot-anchored contrast line. */
export function applyToneContrast(
  tone: number,
  toneContrast: number,
  tonePivot: number,
): number {
  const boundedTone = clampUnit(tone)
  if (boundedTone === 0) return 0

  const control = clampControl(toneContrast)
  if (control === PHOTO_TONE_CONTROL_DEFAULT) return boundedTone
  const pivot = clampControl(tonePivot)
  return clampUnit(pivot + (boundedTone - pivot) * toneContrastGain(control))
}

/** Apply gamma before contrast, which is Photo Scribble's authored order. */
export function applyPhotoToneControls(
  tone: number,
  controls: Readonly<PhotoToneControls>,
): number {
  return applyToneContrast(
    applyToneGamma(tone, controls.toneGamma),
    controls.toneContrast,
    controls.tonePivot,
  )
}
