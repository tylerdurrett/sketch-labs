/**
 * Scribble Moon's current authored vector representation.
 *
 * The smooth procedural target in `source.ts` is reference data, not artwork.
 * Fill therefore contains only a sparse set of black vector contours derived
 * from the same fixed layout: the moon, its craters and inner contours, a halo,
 * a broken ring, and two satellites. The structural builder is intentionally
 * separate from the Scribble pass so these identifying contours remain fixed
 * while Seed and the shared artist controls change the generated shading.
 */

import { createScene } from '../../scene'
import type { CoordinateSpace, Primitive, Scene } from '../../scene'
import {
  scribbleControlSchema,
  scribbleStrategy,
  type ScribbleControls,
  type ScribbleObserver,
  type ScribbleResult,
} from '../../scribbleStrategy'
import {
  createScribbleDiagnostics,
  type NumberParamSpec,
  type OutlineTarget,
  type Params,
  type ScribbleArtwork,
  type Seed,
  type StatelessSketch,
} from '../../sketch'
import type { Point, Polyline } from '../../types'
import { numberParam } from '../sketch-util'
import {
  pointOnCircle,
  pointOnEllipseArc,
  TAU,
  type ScribbleMoonArc,
  type ScribbleMoonCircle,
  type ScribbleMoonEllipseArc,
} from './geometry'
import { createScribbleMoonLayout, createScribbleMoonSource } from './source'

export * from './geometry'
export * from './source'

const FULL_CIRCLE_SEGMENTS = 72
const OUTLINE_COLOR = '#111111'
const OUTLINE_PAPER_COLOR = '#ffffff'

const HALO_INDEX = 0
const FRONT_RING_INDEX = 1
const BACK_RING_INDEX = 2
const SATELLITE_INDICES = [3, 4] as const
const SPHERE_INDEX = 5
const STRUCTURAL_PRIMITIVE_COUNT = 13

/** Scribble Moon's source controls followed by the six shared Scribble controls. */
export const scribbleMoonSchema = {
  /** Direction of the sphere's projected light, in degrees. */
  lightAngle: {
    kind: 'number',
    min: 0,
    max: 360,
    default: 25,
    step: 1,
  },
  /** Width of the transition between the lit and dark hemispheres. */
  terminatorSoftness: {
    kind: 'number',
    min: 0,
    max: 1,
    default: 0.4,
    step: 0.01,
  },
  /** Separation between light and dark target tones. */
  toneContrast: {
    kind: 'number',
    min: 0,
    max: 1,
    default: 0.55,
    step: 0.01,
  },
  /** Width of the inward permission transition at authored boundaries. */
  maskFeather: {
    kind: 'number',
    min: 0,
    max: 1,
    default: 0.5,
    step: 0.01,
  },
  ...scribbleControlSchema,
} satisfies Record<string, NumberParamSpec>

function sourceControls(params: Params) {
  return {
    lightAngle: numberParam(params, scribbleMoonSchema, 'lightAngle'),
    terminatorSoftness: numberParam(
      params,
      scribbleMoonSchema,
      'terminatorSoftness',
    ),
    toneContrast: numberParam(params, scribbleMoonSchema, 'toneContrast'),
    maskFeather: numberParam(params, scribbleMoonSchema, 'maskFeather'),
  }
}

function scribbleControls(params: Params): ScribbleControls {
  return {
    pathDensity: numberParam(params, scribbleMoonSchema, 'pathDensity'),
    scribbleScale: numberParam(params, scribbleMoonSchema, 'scribbleScale'),
    momentum: numberParam(params, scribbleMoonSchema, 'momentum'),
    chaos: numberParam(params, scribbleMoonSchema, 'chaos'),
    toneFidelity: numberParam(params, scribbleMoonSchema, 'toneFidelity'),
    stopPoint: numberParam(params, scribbleMoonSchema, 'stopPoint'),
  }
}

function circlePath(
  circle: ScribbleMoonCircle,
  segments = FULL_CIRCLE_SEGMENTS,
): Polyline {
  const points: Point[] = []
  for (let index = 0; index < segments; index += 1) {
    const point = pointOnCircle(circle, (index / segments) * TAU)
    points.push([point[0], point[1]])
  }
  return points
}

function segmentCount(startAngle: number, endAngle: number): number {
  return Math.max(
    4,
    Math.ceil((Math.abs(endAngle - startAngle) / TAU) * FULL_CIRCLE_SEGMENTS),
  )
}

function circleArcPath(arc: ScribbleMoonArc): Polyline {
  const segments = segmentCount(arc.startAngle, arc.endAngle)
  const points: Point[] = []
  for (let index = 0; index <= segments; index += 1) {
    const progress = index / segments
    const angle = arc.startAngle + (arc.endAngle - arc.startAngle) * progress
    const point = pointOnCircle(arc, angle)
    points.push([point[0], point[1]])
  }
  return points
}

function ellipseArcPath(arc: ScribbleMoonEllipseArc): Polyline {
  const segments = segmentCount(arc.startAngle, arc.endAngle)
  const points: Point[] = []
  for (let index = 0; index <= segments; index += 1) {
    const progress = index / segments
    const angle = arc.startAngle + (arc.endAngle - arc.startAngle) * progress
    const point = pointOnEllipseArc(arc, angle)
    points.push([point[0], point[1]])
  }
  return points
}

/**
 * Build Scribble Moon's fixed identifying contours.
 *
 * This helper deliberately accepts only the Composition Frame. In particular,
 * Seed and the four tonal controls cannot move, add, or remove these paths.
 */
export function createScribbleMoonStructuralScene(
  frame: CoordinateSpace,
): Scene {
  const layout = createScribbleMoonLayout(frame)
  const builder = createScene(frame)
  const stroke = { color: 'black', width: layout.unit * 0.0015 }
  const fineStroke = { color: 'black', width: layout.unit * 0.0011 }

  // Broadest context first, then the sphere and its identifying surface marks.
  builder.addPath(circlePath(layout.halo), {
    closed: true,
    stroke: fineStroke,
    hiddenLineRole: 'source',
  })
  for (const segment of layout.brokenRingSegments) {
    builder.addPath(ellipseArcPath(segment), {
      closed: false,
      stroke,
      hiddenLineRole: 'source',
    })
  }
  for (const satellite of layout.satellites) {
    builder.addPath(circlePath(satellite, 24), {
      closed: true,
      stroke,
      hiddenLineRole: 'source',
    })
  }
  builder.addPath(circlePath(layout.sphere), {
    closed: true,
    stroke,
    hiddenLineRole: 'source',
  })
  for (const crater of layout.craters) {
    builder.addPath(circlePath(crater, 32), {
      closed: true,
      stroke: fineStroke,
      hiddenLineRole: 'source',
    })
  }
  for (const contour of layout.structuralContours) {
    builder.addPath(circleArcPath(contour), {
      closed: false,
      stroke: fineStroke,
      hiddenLineRole: 'source',
    })
  }

  return builder.build()
}

/**
 * Generate only Scribble Moon's headless strategy result.
 *
 * Keeping this seam independent of Scene styling lets downstream integrations
 * inspect truthful termination and residual error without duplicating how Moon
 * resolves its source and the six shared controls.
 */
export function generateScribbleMoonScribble(
  params: Params,
  seed: Seed,
  frame: CoordinateSpace,
  observer?: ScribbleObserver,
): ScribbleResult {
  return scribbleStrategy({
    source: createScribbleMoonSource(sourceControls(params), frame),
    frame,
    controls: scribbleControls(params),
    seed,
    ...(observer === undefined ? {} : { observer }),
  })
}

function completeScene(
  frame: CoordinateSpace,
  structural: Readonly<Scene>,
  scribble: Readonly<ScribbleResult>,
): Scene {
  const builder = createScene(frame)

  for (const primitive of structural.primitives) builder.add(primitive)

  const stroke = {
    color: 'black',
    width: Math.min(frame.width, frame.height) * 0.0011,
  }
  for (const polyline of scribble.polylines) {
    builder.addPath(polyline, {
      closed: false,
      stroke,
      hiddenLineRole: 'source',
    })
  }

  return builder.build()
}

function validateOutlineTarget(target: OutlineTarget): void {
  if (
    !Number.isFinite(target.toolWidthMillimeters) ||
    target.toolWidthMillimeters <= 0
  ) {
    throw new RangeError('toolWidthMillimeters must be finite and positive')
  }
  if (
    !Number.isFinite(target.millimetersPerSceneUnit) ||
    target.millimetersPerSceneUnit <= 0
  ) {
    throw new RangeError('millimetersPerSceneUnit must be finite and positive')
  }
}

function outlineSourcePrimitive(
  primitive: Readonly<Primitive>,
  width: number,
): Primitive {
  return {
    points: primitive.points.map(([x, y]) => [x, y]),
    ...(primitive.closed === undefined ? {} : { closed: primitive.closed }),
    stroke: { color: OUTLINE_COLOR, width },
    hiddenLineRole: 'source',
  }
}

function paperOccluder(primitive: Readonly<Primitive>): Primitive {
  return {
    points: primitive.points.map(([x, y]) => [x, y]),
    closed: true,
    fill: { color: OUTLINE_PAPER_COLOR },
    hiddenLineRole: 'occluder',
  }
}

/**
 * Restyle one completed Scribble Moon Scene as its faithful Outline source.
 *
 * The completed scene is authoritative: this function copies its exact visible
 * contours and generated Scribbles without re-running either source generation
 * or the Scribble strategy. The fixed structural prefix supplies the authored
 * depth order. Its upper ring arc sits behind the opaque moon, while the lower
 * arc, moon surface marks, and generated shading sit in front. Satellite discs
 * are persistent paper masks followed immediately by their visible rims.
 */
export function deriveScribbleMoonOutlineSource(
  completedScene: Readonly<Scene>,
  target: OutlineTarget,
): Scene {
  validateOutlineTarget(target)
  if (completedScene.primitives.length < STRUCTURAL_PRIMITIVE_COUNT) {
    throw new RangeError(
      `completed Scribble Moon Scene must contain at least ${STRUCTURAL_PRIMITIVE_COUNT} primitives`,
    )
  }

  const width = target.toolWidthMillimeters / target.millimetersPerSceneUnit
  const source = (index: number) =>
    outlineSourcePrimitive(completedScene.primitives[index]!, width)
  const primitives: Primitive[] = [
    source(HALO_INDEX),
    source(BACK_RING_INDEX),
    paperOccluder(completedScene.primitives[SPHERE_INDEX]!),
    source(FRONT_RING_INDEX),
  ]

  for (const index of SATELLITE_INDICES) {
    const satellite = completedScene.primitives[index]!
    primitives.push(
      paperOccluder(satellite),
      outlineSourcePrimitive(satellite, width),
    )
  }
  primitives.push(source(SPHERE_INDEX))
  for (
    let index = SPHERE_INDEX + 1;
    index < completedScene.primitives.length;
    index += 1
  ) {
    primitives.push(source(index))
  }

  return {
    space: {
      width: completedScene.space.width,
      height: completedScene.space.height,
    },
    primitives,
    ...(completedScene.background === undefined
      ? {}
      : { background: { ...completedScene.background } }),
  }
}

/** Prepare Moon's complete structural-plus-Scribble Scene and Scribble metrics. */
export function generateScribbleMoonArtwork(
  params: Params,
  seed: Seed,
  frame: CoordinateSpace,
  observer?: ScribbleObserver,
): ScribbleArtwork {
  const structural = createScribbleMoonStructuralScene(frame)
  const scribble = generateScribbleMoonScribble(params, seed, frame, observer)

  return {
    scene: completeScene(frame, structural, scribble),
    // Structural contours identify the authored Moon but are not Scribble work.
    diagnostics: createScribbleDiagnostics(scribble),
  }
}

/** A contour-plus-Scribble moon whose procedural target remains diagnostic. */
export const scribbleMoon: StatelessSketch = {
  id: 'scribble-moon',
  name: 'Scribble Moon',
  schema: scribbleMoonSchema,
  generateToneSource(params: Params, frame: CoordinateSpace) {
    return createScribbleMoonSource(sourceControls(params), frame)
  },
  generateScribbleArtwork: generateScribbleMoonArtwork,
  deriveOutlineSource: deriveScribbleMoonOutlineSource,
  generate(
    params: Params,
    seed: Seed,
    _t: number,
    frame: CoordinateSpace,
  ): Scene {
    return generateScribbleMoonArtwork(params, seed, frame).scene
  },
}
