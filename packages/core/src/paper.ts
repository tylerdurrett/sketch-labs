import type { PaperSize } from './types'

/** Paper orientation */
export type Orientation = 'portrait' | 'landscape'

/** All paper sizes in centimeters, portrait orientation */
export const PAPER_SIZES: Record<string, PaperSize> = {
  letter: { width: 21.59, height: 27.94 },
  tabloid: { width: 27.94, height: 43.18 },
  a2: { width: 42.0, height: 59.4 },
  a3: { width: 29.7, height: 42.0 },
  a4: { width: 21.0, height: 29.7 },
  a5: { width: 14.8, height: 21.0 },
}

/**
 * Get paper dimensions by name and orientation.
 * Accepts a preset name (e.g. 'letter', 'a4') or a custom { width, height } object.
 * Swaps width/height for landscape orientation.
 * Throws if the paper name is not recognized or dimensions are invalid.
 */
export function getPaperSize(
  paper: string | PaperSize,
  orientation: Orientation = 'portrait',
): PaperSize {
  const size =
    typeof paper === 'string' ? PAPER_SIZES[paper] : validatePaperSize(paper)

  if (!size) {
    throw new Error(
      `Unknown paper size: "${paper}". Available: ${Object.keys(PAPER_SIZES).join(', ')}`,
    )
  }

  if (orientation === 'landscape') {
    return { width: size.height, height: size.width }
  }

  return { ...size }
}

/**
 * Validate that a custom paper size has positive dimensions.
 * Returns the size if valid, throws otherwise.
 */
function validatePaperSize(size: PaperSize): PaperSize {
  if (size.width <= 0 || size.height <= 0) {
    throw new Error(
      `Paper dimensions must be positive: got ${size.width} × ${size.height}`,
    )
  }
  return size
}
