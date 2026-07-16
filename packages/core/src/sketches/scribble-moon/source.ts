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
  TAU,
  clampUnit,
  distanceBetween,
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

interface PreparedSamplingGeometry {
  readonly overall: Bounds
  readonly sphere: Bounds
  readonly craters: readonly Bounds[]
  readonly halo: Bounds
  readonly rings: PreparedEllipseFamily
  readonly satellites: readonly Bounds[]
  readonly contours: PreparedCircleFamily
}

interface Bounds {
  readonly minX: number
  readonly maxX: number
  readonly minY: number
  readonly maxY: number
}

interface PreparedArcInterval {
  readonly start: number
  readonly positiveSpan: number
  readonly full: boolean
}

interface PreparedArc<TArc> {
  readonly arc: TArc
  readonly bounds: Bounds
  readonly interval: PreparedArcInterval
  readonly startPoint: ScribbleMoonPoint
  readonly endPoint: ScribbleMoonPoint
}

interface PreparedArcFamily<TArc, TGeometry> {
  readonly bounds: Bounds
  readonly arcs: readonly PreparedArc<TArc>[]
  /** Geometry shared by every authored segment in the family. */
  readonly sharedGeometry: TGeometry | undefined
  readonly toneScale: number
}

interface PreparedCircleGeometry {
  readonly center: ScribbleMoonPoint
}

interface PreparedEllipseGeometry {
  readonly center: ScribbleMoonPoint
  readonly radiusX: number
  readonly radiusY: number
  readonly rotationCosine: number
  readonly rotationSine: number
}

type PreparedCircleArc = PreparedArc<ScribbleMoonArc>
type PreparedCircleFamily = PreparedArcFamily<
  ScribbleMoonArc,
  PreparedCircleGeometry
>
type PreparedEllipseArc = PreparedArc<ScribbleMoonEllipseArc>
type PreparedEllipseFamily = PreparedArcFamily<
  ScribbleMoonEllipseArc,
  PreparedEllipseGeometry
>
type StrokeFamilySample = 'tone' | 'permission'

function normalizedAngle(angle: number): number {
  const wrapped = angle % TAU
  return wrapped < 0 ? wrapped + TAU : wrapped
}

function prepareArcInterval(
  startAngle: number,
  endAngle: number,
): PreparedArcInterval {
  const span = endAngle - startAngle
  return {
    start: normalizedAngle(startAngle),
    positiveSpan: normalizedAngle(span),
    full: Math.abs(span) >= TAU,
  }
}

function angleIsInPreparedArc(
  angle: number,
  interval: PreparedArcInterval,
): boolean {
  if (interval.full) return true
  const angleValue = normalizedAngle(angle)
  const offset = normalizedAngle(angleValue - interval.start)
  return offset <= interval.positiveSpan
}

function circlePointAt(
  circle: ScribbleMoonCircle,
  angle: number,
): ScribbleMoonPoint {
  return [
    circle.center[0] + Math.cos(angle) * circle.radius,
    circle.center[1] + Math.sin(angle) * circle.radius,
  ]
}

function ellipsePointAt(
  ellipse: ScribbleMoonEllipseArc,
  angle: number,
  cosine: number,
  sine: number,
): ScribbleMoonPoint {
  const x = Math.cos(angle) * ellipse.radiusX
  const y = Math.sin(angle) * ellipse.radiusY
  return [
    ellipse.center[0] + x * cosine - y * sine,
    ellipse.center[1] + x * sine + y * cosine,
  ]
}

function circleBounds(circle: ScribbleMoonCircle, padding = 0): Bounds {
  const radius = circle.radius + padding
  return {
    minX: circle.center[0] - radius,
    maxX: circle.center[0] + radius,
    minY: circle.center[1] - radius,
    maxY: circle.center[1] + radius,
  }
}

function ellipseBounds(
  ellipse: ScribbleMoonEllipseArc,
  padding: number,
): Bounds {
  // `distanceToEllipseArc` measures normalized radial error in units of the
  // smaller radius. Scaling both radii by this factor encloses every point whose
  // exact distance can fall within `padding`, including endpoint neighborhoods.
  const scale = 1 + padding / Math.min(ellipse.radiusX, ellipse.radiusY)
  const radiusX = ellipse.radiusX * scale
  const radiusY = ellipse.radiusY * scale
  const cosine = Math.cos(ellipse.rotation)
  const sine = Math.sin(ellipse.rotation)
  const extentX = Math.hypot(radiusX * cosine, radiusY * sine)
  const extentY = Math.hypot(radiusX * sine, radiusY * cosine)
  return {
    minX: ellipse.center[0] - extentX,
    maxX: ellipse.center[0] + extentX,
    minY: ellipse.center[1] - extentY,
    maxY: ellipse.center[1] + extentY,
  }
}

function prepareCircleArc(arc: ScribbleMoonArc): PreparedCircleArc {
  return {
    arc,
    bounds: circleBounds(arc, arc.width / 2),
    interval: prepareArcInterval(arc.startAngle, arc.endAngle),
    startPoint: circlePointAt(arc, arc.startAngle),
    endPoint: circlePointAt(arc, arc.endAngle),
  }
}

function prepareEllipseArc(arc: ScribbleMoonEllipseArc): PreparedEllipseArc {
  const rotationCosine = Math.cos(arc.rotation)
  const rotationSine = Math.sin(arc.rotation)
  return {
    arc,
    bounds: ellipseBounds(arc, arc.width / 2),
    interval: prepareArcInterval(arc.startAngle, arc.endAngle),
    startPoint: ellipsePointAt(
      arc,
      arc.startAngle,
      rotationCosine,
      rotationSine,
    ),
    endPoint: ellipsePointAt(
      arc,
      arc.endAngle,
      rotationCosine,
      rotationSine,
    ),
  }
}

function prepareCircleFamily(
  arcs: readonly ScribbleMoonArc[],
): PreparedCircleFamily {
  const prepared = arcs.map(prepareCircleArc)
  const first = arcs[0]
  if (
    first !== undefined &&
    arcs.some(
      (arc) =>
        arc.center[0] !== first.center[0] || arc.center[1] !== first.center[1],
    )
  ) {
    throw new Error('Scribble Moon circle-arc families must share a center')
  }
  return {
    bounds: unionBounds(prepared.map((candidate) => candidate.bounds)),
    arcs: prepared,
    sharedGeometry: first === undefined ? undefined : { center: first.center },
    toneScale: 0.34,
  }
}

function sampleCircleFamily(
  point: Readonly<Point>,
  family: PreparedCircleFamily,
  sample: StrokeFamilySample,
  featherWidth = 0,
): number {
  const { sharedGeometry } = family
  if (
    sharedGeometry === undefined ||
    !pointIsInBounds(point, family.bounds)
  ) {
    return 0
  }

  const dx = point[0] - sharedGeometry.center[0]
  const dy = point[1] - sharedGeometry.center[1]
  const radialDistance = Math.hypot(dx, dy)
  let angle: number | undefined
  let maximum = 0

  for (const prepared of family.arcs) {
    if (!pointIsInBounds(point, prepared.bounds)) continue
    const width = prepared.arc.width
    const radialLowerBound = Math.abs(radialDistance - prepared.arc.radius)
    const outsideStroke =
      sample === 'tone'
        ? radialLowerBound >= width / 2
        : radialLowerBound > width / 2
    if (outsideStroke) continue
    angle ??= Math.atan2(dy, dx)
    let distance: number
    if (angleIsInPreparedArc(angle, prepared.interval)) {
      distance = Math.abs(radialDistance - prepared.arc.radius)
    } else {
      distance = Math.min(
        distanceBetween(point, prepared.startPoint),
        distanceBetween(point, prepared.endPoint),
      )
    }
    const value =
      sample === 'tone'
        ? strokeTone(distance, width) * family.toneScale
        : featheredPermission(
            distance - width / 2,
            Math.min(featherWidth, width / 2),
          )
    maximum = Math.max(maximum, value)
  }

  return maximum
}

function prepareEllipseFamily(
  arcs: readonly ScribbleMoonEllipseArc[],
): PreparedEllipseFamily {
  const prepared = arcs.map(prepareEllipseArc)
  const first = arcs[0]
  if (
    first !== undefined &&
    arcs.some(
      (arc) =>
        arc.center[0] !== first.center[0] ||
        arc.center[1] !== first.center[1] ||
        arc.radiusX !== first.radiusX ||
        arc.radiusY !== first.radiusY ||
        arc.rotation !== first.rotation,
    )
  ) {
    throw new Error(
      'Scribble Moon ellipse-arc families must share center, radii, and rotation',
    )
  }
  return {
    bounds: unionBounds(prepared.map((candidate) => candidate.bounds)),
    arcs: prepared,
    sharedGeometry:
      first === undefined
        ? undefined
        : {
            center: first.center,
            radiusX: first.radiusX,
            radiusY: first.radiusY,
            rotationCosine: Math.cos(first.rotation),
            rotationSine: Math.sin(first.rotation),
          },
    toneScale: 0.58,
  }
}

function sampleEllipseFamily(
  point: Readonly<Point>,
  family: PreparedEllipseFamily,
  sample: StrokeFamilySample,
  featherWidth = 0,
): number {
  const { sharedGeometry } = family
  if (
    sharedGeometry === undefined ||
    !pointIsInBounds(point, family.bounds)
  ) {
    return 0
  }

  const dx = point[0] - sharedGeometry.center[0]
  const dy = point[1] - sharedGeometry.center[1]
  const localX =
    dx * sharedGeometry.rotationCosine + dy * sharedGeometry.rotationSine
  const localY =
    -dx * sharedGeometry.rotationSine + dy * sharedGeometry.rotationCosine
  const normalizedRadius = Math.hypot(
    localX / sharedGeometry.radiusX,
    localY / sharedGeometry.radiusY,
  )
  const radialLowerBound =
    Math.abs(normalizedRadius - 1) *
    Math.min(sharedGeometry.radiusX, sharedGeometry.radiusY)
  let angle: number | undefined
  let maximum = 0

  for (const prepared of family.arcs) {
    const width = prepared.arc.width
    const outsideStroke =
      sample === 'tone'
        ? radialLowerBound >= width / 2
        : radialLowerBound > width / 2
    if (outsideStroke) continue
    angle ??= Math.atan2(
      localY / sharedGeometry.radiusY,
      localX / sharedGeometry.radiusX,
    )
    let distance: number
    if (angleIsInPreparedArc(angle, prepared.interval)) {
      distance =
        Math.abs(normalizedRadius - 1) *
        Math.min(sharedGeometry.radiusX, sharedGeometry.radiusY)
    } else {
      distance = Math.min(
        distanceBetween(point, prepared.startPoint),
        distanceBetween(point, prepared.endPoint),
      )
    }
    const value =
      sample === 'tone'
        ? strokeTone(distance, width) * family.toneScale
        : featheredPermission(
            distance - width / 2,
            Math.min(featherWidth, width / 2),
          )
    maximum = Math.max(maximum, value)
  }

  return maximum
}

function pointIsInBounds(point: Readonly<Point>, bounds: Bounds): boolean {
  return (
    point[0] >= bounds.minX &&
    point[0] <= bounds.maxX &&
    point[1] >= bounds.minY &&
    point[1] <= bounds.maxY
  )
}

function unionBounds(bounds: readonly Bounds[]): Bounds {
  return bounds.reduce(
    (union, candidate) => ({
      minX: Math.min(union.minX, candidate.minX),
      maxX: Math.max(union.maxX, candidate.maxX),
      minY: Math.min(union.minY, candidate.minY),
      maxY: Math.max(union.maxY, candidate.maxY),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  )
}

function prepareSamplingGeometry(
  layout: ScribbleMoonLayout,
): PreparedSamplingGeometry {
  const sphere = circleBounds(layout.sphere)
  const craters = layout.craters.map((crater) => circleBounds(crater))
  const halo = circleBounds(layout.halo, layout.halo.width / 2)
  const rings = prepareEllipseFamily(layout.brokenRingSegments)
  const satellites = layout.satellites.map((satellite) =>
    circleBounds(satellite),
  )
  const contours = prepareCircleFamily(layout.structuralContours)
  return {
    overall: unionBounds([
      sphere,
      halo,
      rings.bounds,
      ...satellites,
      contours.bounds,
    ]),
    sphere,
    craters,
    halo,
    rings,
    satellites,
    contours,
  }
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
  sampling: PreparedSamplingGeometry,
  lightAngle: number,
  softness: number,
): number {
  const { sphere } = layout
  if (!pointIsInBounds(point, sampling.sphere)) return 0
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

  for (let index = 0; index < layout.craters.length; index += 1) {
    if (!pointIsInBounds(point, sampling.craters[index]!)) continue
    const crater = layout.craters[index]!
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
  sampling: PreparedSamplingGeometry,
): number {
  let tone = 0
  if (pointIsInBounds(point, sampling.halo)) {
    const haloDistance = Math.abs(
      distanceBetween(point, layout.halo.center) - layout.halo.radius,
    )
    tone = strokeTone(haloDistance, layout.halo.width) * 0.2
  }

  tone = Math.max(tone, sampleEllipseFamily(point, sampling.rings, 'tone'))
  tone = Math.max(tone, sampleCircleFamily(point, sampling.contours, 'tone'))

  return tone
}

function satelliteTone(
  point: Readonly<Point>,
  satellites: readonly ScribbleMoonSatellite[],
  sampling: PreparedSamplingGeometry,
): number {
  let tone = 0

  for (let index = 0; index < satellites.length; index += 1) {
    if (!pointIsInBounds(point, sampling.satellites[index]!)) continue
    const satellite = satellites[index]!
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
  sampling: PreparedSamplingGeometry,
  featherWidth: number,
): number {
  let permission = pointIsInBounds(point, sampling.sphere)
    ? featheredPermission(
        distanceBetween(point, layout.sphere.center) - layout.sphere.radius,
        featherWidth,
      )
    : 0
  if (permission === 1) return 1

  if (pointIsInBounds(point, sampling.halo)) {
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
  }

  permission = Math.max(
    permission,
    sampleEllipseFamily(point, sampling.rings, 'permission', featherWidth),
  )

  for (let index = 0; index < layout.satellites.length; index += 1) {
    if (!pointIsInBounds(point, sampling.satellites[index]!)) continue
    const satellite = layout.satellites[index]!
    permission = Math.max(
      permission,
      featheredPermission(
        distanceBetween(point, satellite.center) - satellite.radius,
        Math.min(featherWidth, satellite.radius),
      ),
    )
  }

  permission = Math.max(
    permission,
    sampleCircleFamily(point, sampling.contours, 'permission', featherWidth),
  )

  return permission
}

/** Create the fixed Scribble Moon target and permission fields. */
export function createScribbleMoonSource(
  controls: ScribbleMoonControls,
  frame: CoordinateSpace,
): ScribbleMoonSource {
  const layout = createScribbleMoonLayout(frame)
  const sampling = prepareSamplingGeometry(layout)
  const lightAngle = normalizedLightAngle(controls.lightAngle)
  const softness = normalizedControl(controls.terminatorSoftness, 0.5)
  const contrast = normalizedControl(controls.toneContrast, 0.5)
  const maskFeather = normalizedControl(controls.maskFeather, 0.5)
  const maskFeatherWidth = layout.sphere.radius * 0.14 * maskFeather

  const toneField = createToneField((point) => {
    if (!pointIsInBounds(point, sampling.overall)) return 0
    const tone = Math.max(
      sphereToneAt(point, layout, sampling, lightAngle, softness),
      authoredLineTone(point, layout, sampling),
      satelliteTone(point, layout.satellites, sampling),
    )
    return applyContrast(tone, contrast)
  })
  const shadingMask = createShadingMask((point) => {
    if (!pointIsInBounds(point, sampling.overall)) return 0
    return permissionAt(point, layout, sampling, maskFeatherWidth)
  })

  return Object.freeze({ layout, maskFeatherWidth, toneField, shadingMask })
}
