/**
 * Linear interpolation between a and b.
 * Returns a when t=0, b when t=1.
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * Inverse of lerp: returns the t value that produces v in [a, b].
 * Returns 0 when a === b to avoid division by zero.
 */
export function inverseLerp(a: number, b: number, v: number): number {
  if (a === b) return 0
  return (v - a) / (b - a)
}

/**
 * Clamp value to the range [min, max].
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Map a value from one range to another.
 * Equivalent to lerp(outMin, outMax, inverseLerp(inMin, inMax, value)).
 */
export function mapRange(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  return lerp(outMin, outMax, inverseLerp(inMin, inMax, value))
}

/**
 * Fractional part of a number: v - floor(v).
 * Always returns a value in [0, 1).
 */
export function fract(v: number): number {
  return v - Math.floor(v)
}

/**
 * True modulo that handles negative numbers correctly.
 * Unlike JS %, the result always has the same sign as the divisor.
 */
export function mod(a: number, b: number): number {
  return ((a % b) + b) % b
}

/**
 * Convert degrees to radians.
 */
export function degToRad(deg: number): number {
  return deg * (Math.PI / 180)
}

/**
 * Convert radians to degrees.
 */
export function radToDeg(rad: number): number {
  return rad * (180 / Math.PI)
}

/**
 * Hermite interpolation with clamped t.
 * Returns 0 when x <= edge0, 1 when x >= edge1,
 * and smooth interpolation in between.
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  // Reuse inverseLerp for consistent degenerate-case handling (edge0 === edge1)
  const t = clamp(inverseLerp(edge0, edge1, x), 0, 1)
  return t * t * (3 - 2 * t)
}
