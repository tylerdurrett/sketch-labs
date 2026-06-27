import type { Vec2, Vec3 } from './types'

/** Internal union type for dimension-generic functions */
type Vec = Vec2 | Vec3

/** Component-wise addition */
function add(a: Vec2, b: Vec2): Vec2
function add(a: Vec3, b: Vec3): Vec3
function add(a: Vec, b: Vec): Vec {
  return a.map((v, i) => v + b[i]!) as Vec
}

/** Component-wise subtraction */
function sub(a: Vec2, b: Vec2): Vec2
function sub(a: Vec3, b: Vec3): Vec3
function sub(a: Vec, b: Vec): Vec {
  return a.map((v, i) => v - b[i]!) as Vec
}

/** Scalar multiply */
function scale(a: Vec2, s: number): Vec2
function scale(a: Vec3, s: number): Vec3
function scale(a: Vec, s: number): Vec {
  return a.map((v) => v * s) as Vec
}

/** Flip sign of all components */
function negate(a: Vec2): Vec2
function negate(a: Vec3): Vec3
function negate(a: Vec): Vec {
  return a.map((v) => -v) as Vec
}

/** Dot product */
function dot(a: Vec, b: Vec): number {
  return a.reduce((sum, v, i) => sum + v * b[i]!, 0)
}

/** Squared length (avoids sqrt) */
function lenSq(a: Vec): number {
  return dot(a, a)
}

/** Length / magnitude */
function len(a: Vec): number {
  return Math.sqrt(lenSq(a))
}

/** Unit vector. Returns zero vector if input has zero length. */
function normalize(a: Vec2): Vec2
function normalize(a: Vec3): Vec3
function normalize(a: Vec): Vec {
  let sumSq = 0
  for (let i = 0; i < a.length; i++) sumSq += a[i]! * a[i]!
  const l = Math.sqrt(sumSq)
  if (l === 0) return a.map(() => 0) as Vec
  const inv = 1 / l
  return a.map((v) => v * inv) as Vec
}

/** Squared distance between two points (avoids sqrt and temp array) */
function distSq(a: Vec, b: Vec): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += (a[i]! - b[i]!) ** 2
  return sum
}

/** Distance between two points */
function dist(a: Vec, b: Vec): number {
  return Math.sqrt(distSq(a, b))
}

/** Linear interpolation between two vectors */
function lerp(a: Vec2, b: Vec2, t: number): Vec2
function lerp(a: Vec3, b: Vec3, t: number): Vec3
function lerp(a: Vec, b: Vec, t: number): Vec {
  return a.map((v, i) => v + (b[i]! - v) * t) as Vec
}

/** Angle between two vectors in radians. Returns 0 for zero-length vectors. */
function angleBetween(a: Vec, b: Vec): number {
  const la = len(a)
  const lb = len(b)
  if (la === 0 || lb === 0) return 0
  const d = dot(a, b) / (la * lb)
  return Math.acos(Math.min(1, Math.max(-1, d)))
}

/** 90° rotation: [-y, x] */
function perpendicular(a: Vec2): Vec2 {
  // Use (0 - y) to avoid -0 when y is 0
  return [a[1] === 0 ? 0 : -a[1], a[0]]
}

/** Cross product (3D only) */
function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

/** Orthographic projection — drop one axis (default 'z' for top-down view) */
function projectOrthographic(p: Vec3, axis: 'x' | 'y' | 'z' = 'z'): Vec2 {
  if (axis === 'x') return [p[1], p[2]]
  if (axis === 'y') return [p[0], p[2]]
  return [p[0], p[1]]
}

/** Perspective projection — simple perspective divide by z. Caller must ensure p[2] > 0. */
function projectPerspective(p: Vec3, focalLength: number): Vec2 {
  return [(p[0] * focalLength) / p[2], (p[1] * focalLength) / p[2]]
}

export const vec = {
  add,
  sub,
  scale,
  negate,
  dot,
  lenSq,
  len,
  normalize,
  distSq,
  dist,
  lerp,
  angleBetween,
  perpendicular,
  cross,
  projectOrthographic,
  projectPerspective,
}
