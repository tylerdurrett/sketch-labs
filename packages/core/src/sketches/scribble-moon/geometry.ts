import type { Point } from '../../types'

export const TAU = Math.PI * 2

export type ScribbleMoonPoint = readonly [number, number]

export interface ScribbleMoonCircle {
  readonly center: ScribbleMoonPoint
  readonly radius: number
}

export interface ScribbleMoonArc extends ScribbleMoonCircle {
  readonly id: string
  readonly startAngle: number
  readonly endAngle: number
  readonly width: number
}

export interface ScribbleMoonEllipseArc {
  readonly id: string
  readonly center: ScribbleMoonPoint
  readonly radiusX: number
  readonly radiusY: number
  readonly rotation: number
  readonly startAngle: number
  readonly endAngle: number
  readonly width: number
}

export function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= 1) return 1
  return value
}

export function smoothstepUnit(value: number): number {
  const bounded = clampUnit(value)
  return bounded * bounded * (3 - 2 * bounded)
}

export function distanceBetween(
  [ax, ay]: Readonly<Point>,
  [bx, by]: ScribbleMoonPoint,
): number {
  return Math.hypot(ax - bx, ay - by)
}

function normalizedAngle(angle: number): number {
  const wrapped = angle % TAU
  return wrapped < 0 ? wrapped + TAU : wrapped
}

function angleIsInArc(
  angle: number,
  startAngle: number,
  endAngle: number,
): boolean {
  const angleValue = normalizedAngle(angle)
  const start = normalizedAngle(startAngle)
  const span = endAngle - startAngle

  if (Math.abs(span) >= TAU) return true

  const positiveSpan = normalizedAngle(span)
  const offset = normalizedAngle(angleValue - start)
  return offset <= positiveSpan
}

export function pointOnCircle(
  circle: ScribbleMoonCircle,
  angle: number,
): ScribbleMoonPoint {
  return [
    circle.center[0] + Math.cos(angle) * circle.radius,
    circle.center[1] + Math.sin(angle) * circle.radius,
  ]
}

export function pointOnEllipseArc(
  arc: ScribbleMoonEllipseArc,
  angle: number,
): ScribbleMoonPoint {
  const x = Math.cos(angle) * arc.radiusX
  const y = Math.sin(angle) * arc.radiusY
  const cosine = Math.cos(arc.rotation)
  const sine = Math.sin(arc.rotation)

  return [
    arc.center[0] + x * cosine - y * sine,
    arc.center[1] + x * sine + y * cosine,
  ]
}

export function distanceToCircleArc(
  point: Readonly<Point>,
  arc: ScribbleMoonArc,
): number {
  const dx = point[0] - arc.center[0]
  const dy = point[1] - arc.center[1]
  const angle = Math.atan2(dy, dx)

  if (angleIsInArc(angle, arc.startAngle, arc.endAngle)) {
    return Math.abs(Math.hypot(dx, dy) - arc.radius)
  }

  return Math.min(
    distanceBetween(point, pointOnCircle(arc, arc.startAngle)),
    distanceBetween(point, pointOnCircle(arc, arc.endAngle)),
  )
}

export function distanceToEllipseArc(
  point: Readonly<Point>,
  arc: ScribbleMoonEllipseArc,
): number {
  const dx = point[0] - arc.center[0]
  const dy = point[1] - arc.center[1]
  const cosine = Math.cos(arc.rotation)
  const sine = Math.sin(arc.rotation)
  const localX = dx * cosine + dy * sine
  const localY = -dx * sine + dy * cosine
  const angle = Math.atan2(localY / arc.radiusY, localX / arc.radiusX)

  if (angleIsInArc(angle, arc.startAngle, arc.endAngle)) {
    const normalizedRadius = Math.hypot(
      localX / arc.radiusX,
      localY / arc.radiusY,
    )
    return Math.abs(normalizedRadius - 1) * Math.min(arc.radiusX, arc.radiusY)
  }

  return Math.min(
    distanceBetween(point, pointOnEllipseArc(arc, arc.startAngle)),
    distanceBetween(point, pointOnEllipseArc(arc, arc.endAngle)),
  )
}

/** Full permission in the interior, an inward feather, then exact-zero exterior. */
export function featheredPermission(
  signedDistance: number,
  featherWidth: number,
): number {
  if (featherWidth <= 0) return signedDistance <= 0 ? 1 : 0
  if (signedDistance >= 0) return 0
  if (signedDistance <= -featherWidth) return 1
  return smoothstepUnit(-signedDistance / featherWidth)
}

/** Smooth ink target centered on a sparse authored line. */
export function strokeTone(distance: number, width: number): number {
  if (width <= 0 || distance >= width / 2) return 0
  return 1 - smoothstepUnit(distance / (width / 2))
}
