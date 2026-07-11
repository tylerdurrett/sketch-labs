/** 2D vector / point tuple */
export type Vec2 = [number, number]

/** 3D vector tuple */
export type Vec3 = [number, number, number]

/** Alias for Vec2 — compatible everywhere Vec2 is used */
export type Point = Vec2

/** Array of points forming a polyline path */
export type Polyline = Point[]

/** Physical length unit */
export type LengthUnit = 'cm' | 'in' | 'mm'

/** Seeded random number generator instance */
export interface Random {
  /** Uniform random value in [0, 1) */
  value(): number
  /** Uniform random float in [min, max) */
  range(min: number, max: number): number
  /** Random integer in [min, max) */
  rangeFloor(min: number, max: number): number
  /** Normal distribution via Box-Muller transform */
  gaussian(mean?: number, std?: number): number
  /** 50/50 boolean */
  boolean(): boolean
  /** Random element from array */
  pick<T>(array: readonly T[]): T
  /** Fisher-Yates shuffle (returns new array, no mutation) */
  shuffle<T>(array: readonly T[]): T[]
  /** Random point on circle perimeter */
  onCircle(radius?: number): Vec2
  /** Random point inside circle */
  insideCircle(radius?: number): Vec2
  /** 2D simplex noise seeded to this instance */
  noise2D(x: number, y: number): number
  /** 3D simplex noise seeded to this instance */
  noise3D(x: number, y: number, z: number): number
  /** 4D simplex noise seeded to this instance */
  noise4D(x: number, y: number, z: number, w: number): number
}
