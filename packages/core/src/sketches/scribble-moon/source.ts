/**
 * Deterministic procedural source model for Scribble Moon.
 *
 * The authored layout is expressed only in Composition Frame coordinates and is
 * scaled from the frame's shorter side. Output resolution, physical dimensions,
 * Seed, time, Tool width, and Shading Strategy concerns never enter this module.
 * Source controls do not move authored geometry: Light angle, Terminator
 * softness, and Tone contrast affect only the Tone Field, while Mask feather
 * affects only the Shading Mask's inward permission transition.
 *
 * This Sketch-local construction rationale lives beside the implementation per
 * ADR-0007. The reusable separation between darkness and permission is the
 * system decision recorded by ADR-0013.
 */

import type { CoordinateSpace } from '../../scene'
import {
  createShadingMask,
  createToneField,
  type ToneSource,
} from '../../shadingFields'
import type { Point } from '../../types'
import {
  clampUnit,
  distanceBetween,
  distanceToCircleArc,
  distanceToEllipseArc,
  featheredPermission,
  smoothstepUnit,
  strokeTone,
  type ScribbleMoonArc,
  type ScribbleMoonCircle,
  type ScribbleMoonEllipseArc,
  type ScribbleMoonPoint,
} from './geometry'

export interface ScribbleMoonControls {
  /** Direction of the projected light around the sphere, in degrees. */
  readonly lightAngle: number
  /** Normalized terminator transition width, from crisp `0` to broad `1`. */
  readonly terminatorSoftness: number
  /** Normalized tonal separation, from subdued `0` to strong `1`. */
  readonly toneContrast: number
  /** Normalized inward permission feather, from hard `0` to broad `1`. */
  readonly maskFeather: number
}

export interface ScribbleMoonCrater extends ScribbleMoonCircle {
  readonly id: string
  readonly depth: number
}

export interface ScribbleMoonSatellite extends ScribbleMoonCircle {
  readonly id: string
  readonly tone: number
}

export interface ScribbleMoonLayout {
  readonly frame: Readonly<CoordinateSpace>
  readonly unit: number
  readonly sphere: ScribbleMoonCircle
  readonly craters: readonly ScribbleMoonCrater[]
  readonly halo: ScribbleMoonCircle & { readonly width: number }
  readonly brokenRingSegments: readonly ScribbleMoonEllipseArc[]
  readonly satellites: readonly ScribbleMoonSatellite[]
  readonly structuralContours: readonly ScribbleMoonArc[]
}

export interface ScribbleMoonSource extends ToneSource {
  readonly layout: ScribbleMoonLayout
  /** Resolved Composition Frame width of the mask's inward transition. */
  readonly maskFeatherWidth: number
}

function freezePoint(x: number, y: number): ScribbleMoonPoint {
  return Object.freeze([x, y] as const)
}

function freezeCircle(
  center: ScribbleMoonPoint,
  radius: number,
): ScribbleMoonCircle {
  return Object.freeze({ center, radius })
}

function assertFrame(frame: CoordinateSpace): void {
  if (
    !Number.isFinite(frame.width) ||
    !Number.isFinite(frame.height) ||
    frame.width <= 0 ||
    frame.height <= 0
  ) {
    throw new Error(
      `createScribbleMoonLayout: frame must have finite positive dimensions, got ${frame.width} × ${frame.height}`,
    )
  }
}

/** Build the fixed, deeply immutable authored geometry for one Composition Frame. */
export function createScribbleMoonLayout(
  frame: CoordinateSpace,
): ScribbleMoonLayout {
  assertFrame(frame)

  const unit = Math.min(frame.width, frame.height)
  const center = freezePoint(frame.width * 0.5, frame.height * 0.5)
  const radius = unit * 0.255
  const sphere = freezeCircle(center, radius)

  const craters = Object.freeze([
    Object.freeze({
      id: 'mare-west',
      center: freezePoint(center[0] - radius * 0.29, center[1] - radius * 0.12),
      radius: radius * 0.16,
      depth: 0.18,
    }),
    Object.freeze({
      id: 'mare-southeast',
      center: freezePoint(center[0] + radius * 0.25, center[1] + radius * 0.2),
      radius: radius * 0.12,
      depth: 0.15,
    }),
    Object.freeze({
      id: 'mare-northeast',
      center: freezePoint(center[0] + radius * 0.13, center[1] - radius * 0.31),
      radius: radius * 0.095,
      depth: 0.13,
    }),
    Object.freeze({
      id: 'mare-south',
      center: freezePoint(center[0] - radius * 0.11, center[1] + radius * 0.34),
      radius: radius * 0.07,
      depth: 0.1,
    }),
  ] satisfies ScribbleMoonCrater[])

  const halo = Object.freeze({
    center,
    radius: radius * 1.3,
    width: radius * 0.075,
  })

  const ringBase = {
    center,
    radiusX: radius * 1.58,
    radiusY: radius * 0.5,
    rotation: -Math.PI * 0.09,
    width: radius * 0.075,
  }
  const brokenRingSegments = Object.freeze([
    Object.freeze({
      ...ringBase,
      id: 'ring-north',
      startAngle: Math.PI * 0.1,
      endAngle: Math.PI * 0.82,
    }),
    Object.freeze({
      ...ringBase,
      id: 'ring-south',
      startAngle: Math.PI * 1.08,
      endAngle: Math.PI * 1.82,
    }),
  ] satisfies ScribbleMoonEllipseArc[])

  const satellites = Object.freeze([
    Object.freeze({
      id: 'satellite-northwest',
      center: freezePoint(center[0] - radius * 1.62, center[1] - radius * 1.18),
      radius: radius * 0.09,
      tone: 0.52,
    }),
    Object.freeze({
      id: 'satellite-southeast',
      center: freezePoint(center[0] + radius * 1.58, center[1] + radius * 1.12),
      radius: radius * 0.075,
      tone: 0.62,
    }),
  ] satisfies ScribbleMoonSatellite[])

  const contourBase = { center, width: radius * 0.035 }
  const structuralContours = Object.freeze([
    Object.freeze({
      ...contourBase,
      id: 'contour-northwest',
      radius: radius * 0.73,
      startAngle: Math.PI * 0.72,
      endAngle: Math.PI * 1.2,
    }),
    Object.freeze({
      ...contourBase,
      id: 'contour-east',
      radius: radius * 0.64,
      startAngle: -Math.PI * 0.22,
      endAngle: Math.PI * 0.23,
    }),
    Object.freeze({
      ...contourBase,
      id: 'contour-south',
      radius: radius * 0.82,
      startAngle: Math.PI * 0.28,
      endAngle: Math.PI * 0.63,
    }),
  ] satisfies ScribbleMoonArc[])

  return Object.freeze({
    frame: Object.freeze({ width: frame.width, height: frame.height }),
    unit,
    sphere,
    craters,
    halo,
    brokenRingSegments,
    satellites,
    structuralContours,
  })
}

function normalizedControl(value: number, fallback: number): number {
  return clampUnit(Number.isFinite(value) ? value : fallback)
}

function normalizedLightAngle(value: number): number {
  if (!Number.isFinite(value)) return 0
  const wrapped = value % 360
  return (wrapped < 0 ? wrapped + 360 : wrapped) * (Math.PI / 180)
}

function sphereToneAt(
  point: Readonly<Point>,
  layout: ScribbleMoonLayout,
  lightAngle: number,
  softness: number,
): number {
  const { sphere } = layout
  const nx = (point[0] - sphere.center[0]) / sphere.radius
  const ny = (point[1] - sphere.center[1]) / sphere.radius
  const radialSquared = nx * nx + ny * ny
  if (radialSquared > 1) return 0

  const nz = Math.sqrt(Math.max(0, 1 - radialSquared))
  const projectedLight = 0.82
  const forwardLight = Math.sqrt(1 - projectedLight * projectedLight)
  const lightDot =
    nx * Math.cos(lightAngle) * projectedLight +
    ny * Math.sin(lightAngle) * projectedLight +
    nz * forwardLight
  const transition = 0.035 + softness * 0.46
  const illumination = smoothstepUnit(
    (lightDot + transition) / (transition * 2),
  )
  let tone = 0.24 + (1 - illumination) * 0.61 + (1 - nz) * 0.08

  for (const crater of layout.craters) {
    const normalizedDistance =
      distanceBetween(point, crater.center) / crater.radius
    if (normalizedDistance >= 1) continue

    const bowl = 1 - smoothstepUnit(normalizedDistance)
    const rim = 1 - Math.min(1, Math.abs(normalizedDistance - 0.82) / 0.18)
    tone += crater.depth * (bowl + rim * 0.35)
  }

  return clampUnit(tone)
}

function authoredLineTone(
  point: Readonly<Point>,
  layout: ScribbleMoonLayout,
): number {
  const haloDistance = Math.abs(
    distanceBetween(point, layout.halo.center) - layout.halo.radius,
  )
  let tone = strokeTone(haloDistance, layout.halo.width) * 0.2

  for (const ring of layout.brokenRingSegments) {
    tone = Math.max(
      tone,
      strokeTone(distanceToEllipseArc(point, ring), ring.width) * 0.58,
    )
  }

  for (const contour of layout.structuralContours) {
    tone = Math.max(
      tone,
      strokeTone(distanceToCircleArc(point, contour), contour.width) * 0.34,
    )
  }

  return tone
}

function satelliteTone(
  point: Readonly<Point>,
  satellites: readonly ScribbleMoonSatellite[],
): number {
  let tone = 0

  for (const satellite of satellites) {
    const normalizedDistance =
      distanceBetween(point, satellite.center) / satellite.radius
    if (normalizedDistance > 1) continue
    tone = Math.max(
      tone,
      satellite.tone * (0.72 + 0.28 * smoothstepUnit(normalizedDistance)),
    )
  }

  return tone
}

function applyContrast(tone: number, contrast: number): number {
  if (tone <= 0) return 0
  const gain = 0.65 + contrast * 1.7
  return clampUnit(0.5 + (tone - 0.5) * gain)
}

function permissionAt(
  point: Readonly<Point>,
  layout: ScribbleMoonLayout,
  featherWidth: number,
): number {
  let permission = featheredPermission(
    distanceBetween(point, layout.sphere.center) - layout.sphere.radius,
    featherWidth,
  )

  const haloSignedDistance =
    Math.abs(distanceBetween(point, layout.halo.center) - layout.halo.radius) -
    layout.halo.width / 2
  permission = Math.max(
    permission,
    featheredPermission(
      haloSignedDistance,
      Math.min(featherWidth, layout.halo.width / 2),
    ),
  )

  for (const ring of layout.brokenRingSegments) {
    permission = Math.max(
      permission,
      featheredPermission(
        distanceToEllipseArc(point, ring) - ring.width / 2,
        Math.min(featherWidth, ring.width / 2),
      ),
    )
  }

  for (const satellite of layout.satellites) {
    permission = Math.max(
      permission,
      featheredPermission(
        distanceBetween(point, satellite.center) - satellite.radius,
        Math.min(featherWidth, satellite.radius),
      ),
    )
  }

  for (const contour of layout.structuralContours) {
    permission = Math.max(
      permission,
      featheredPermission(
        distanceToCircleArc(point, contour) - contour.width / 2,
        Math.min(featherWidth, contour.width / 2),
      ),
    )
  }

  return permission
}

/** Create the fixed Scribble Moon target and permission fields. */
export function createScribbleMoonSource(
  controls: ScribbleMoonControls,
  frame: CoordinateSpace,
): ScribbleMoonSource {
  const layout = createScribbleMoonLayout(frame)
  const lightAngle = normalizedLightAngle(controls.lightAngle)
  const softness = normalizedControl(controls.terminatorSoftness, 0.5)
  const contrast = normalizedControl(controls.toneContrast, 0.5)
  const maskFeather = normalizedControl(controls.maskFeather, 0.5)
  const maskFeatherWidth = layout.sphere.radius * 0.14 * maskFeather

  const toneField = createToneField((point) => {
    const tone = Math.max(
      sphereToneAt(point, layout, lightAngle, softness),
      authoredLineTone(point, layout),
      satelliteTone(point, layout.satellites),
    )
    return applyContrast(tone, contrast)
  })
  const shadingMask = createShadingMask((point) =>
    permissionAt(point, layout, maskFeatherWidth),
  )

  return Object.freeze({ layout, maskFeatherWidth, toneField, shadingMask })
}
