/**
 * Photo Scribble's tone-domain controls.
 *
 * The photographic source first applies an identity-centered gamma curve, then
 * pivots contrast around mid-tone. Both transforms preserve authored paper
 * (`tone === 0`) exactly so an adjustment can never turn an absent target into
 * ink demand. These controls remain source-side concerns; the Scribble Strategy
 * only receives their completed Tone Field.
 */

export interface PhotoToneControls {
  /** Identity-centered power-curve control in the declared `[0, 1]` range. */
  readonly toneGamma: number
  /** Identity-centered mid-tone contrast control in the declared `[0, 1]` range. */
  readonly toneContrast: number
}

export const PHOTO_TONE_CONTROL_MIN = 0
export const PHOTO_TONE_CONTROL_MAX = 1
export const PHOTO_TONE_CONTROL_DEFAULT = 0.5

function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function clampControl(value: number): number {
  if (!Number.isFinite(value)) return PHOTO_TONE_CONTROL_DEFAULT
  return clampUnit(value)
}

/** Map the centered gamma control to a positive `[0.5, 2]` exponent. */
export function toneGammaExponent(toneGamma: number): number {
  const control = clampControl(toneGamma)
  return 2 ** (2 * (control - PHOTO_TONE_CONTROL_DEFAULT))
}

/** Apply Photo Scribble's zero-preserving power curve in the tone domain. */
export function applyToneGamma(tone: number, toneGamma: number): number {
  const boundedTone = clampUnit(tone)
  if (boundedTone === 0) return 0
  const control = clampControl(toneGamma)
  if (control === PHOTO_TONE_CONTROL_DEFAULT) return boundedTone
  return clampUnit(boundedTone ** toneGammaExponent(control))
}

/** Apply Photo Scribble's zero-preserving, mid-tone-pivoted contrast curve. */
export function applyToneContrast(tone: number, toneContrast: number): number {
  const boundedTone = clampUnit(tone)
  if (boundedTone === 0) return 0

  const control = clampControl(toneContrast)
  if (control === PHOTO_TONE_CONTROL_DEFAULT) return boundedTone
  const gain = 0.15 + 1.7 * control
  return clampUnit(0.5 + (boundedTone - 0.5) * gain)
}

/** Apply gamma before contrast, which is Photo Scribble's authored order. */
export function applyPhotoToneControls(
  tone: number,
  controls: Readonly<PhotoToneControls>,
): number {
  return applyToneContrast(
    applyToneGamma(tone, controls.toneGamma),
    controls.toneContrast,
  )
}
