/**
 * Registered Flowing Contours Sketch composition.
 *
 * Image Asset resolution belongs to this thin adapter. The reusable generator
 * remains a headless decoded-pixel capability and deliberately has no
 * dependency on the registry, another artistic algorithm, Seeds, time,
 * renderers, or physical-output settings.
 */

import type { SketchEnvironment } from '../../imageAssets'
import {
  createScene,
  type CoordinateSpace,
  type Primitive,
  type Scene,
} from '../../scene'
import type {
  OutlineTarget,
  ParamSpec,
  Params,
  StatelessSketch,
} from '../../sketch'
import { imageAssetParam, numberParam } from '../sketch-util'
import { PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID } from '../photo-scribble'
import {
  flowingContoursControlSchema,
  type FlowingContoursControls,
} from './controls'
import { generateFlowingContours } from './generator'

export * from './controls'
export * from './generator'
export * from './types'

/** The bundled sample shared with the other production photo-backed Sketches. */
export const FLOWING_CONTOURS_DEFAULT_IMAGE_ASSET_ID =
  PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID

/** Build Flowing Contours' managed Image Asset and seven-control schema. */
export function createFlowingContoursSchema(defaultImageAssetId: string) {
  return Object.freeze({
    imageAsset: Object.freeze({
      kind: 'image-asset',
      default: defaultImageAssetId,
    }),
    ...flowingContoursControlSchema,
  } satisfies Record<string, ParamSpec>)
}

export type FlowingContoursSchema = ReturnType<
  typeof createFlowingContoursSchema
>

/** Reusable headless generator function signature. */
export type FlowingContoursGenerator = typeof generateFlowingContours

function controlsFromParams(
  params: Params,
  schema: FlowingContoursSchema,
): FlowingContoursControls {
  return {
    gamma: numberParam(params, schema, 'gamma'),
    contrast: numberParam(params, schema, 'contrast'),
    pivot: numberParam(params, schema, 'pivot'),
    curveDetail: numberParam(params, schema, 'curveDetail'),
    continuity: numberParam(params, schema, 'continuity'),
    flowSmoothing: numberParam(params, schema, 'flowSmoothing'),
    minimumStrokeLength: numberParam(
      params,
      schema,
      'minimumStrokeLength',
    ),
  }
}

function emptyScene(frame: CoordinateSpace) {
  return createScene(frame).build()
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
    throw new RangeError(
      'millimetersPerSceneUnit must be finite and positive',
    )
  }
}

/**
 * Retarget an exact completed Scene to a physical tool without regenerating or
 * changing its path geometry.
 */
function deriveFlowingContoursOutlineSource(
  completedScene: Readonly<Scene>,
  target: OutlineTarget,
): Scene {
  validateOutlineTarget(target)
  const width =
    target.toolWidthMillimeters / target.millimetersPerSceneUnit

  return {
    space: { ...completedScene.space },
    primitives: completedScene.primitives.map(
      (primitive): Primitive => ({
        ...primitive,
        points: primitive.points.map(([x, y]) => [x, y]),
        ...(primitive.stroke === undefined
          ? {}
          : { stroke: { ...primitive.stroke, width } }),
      }),
    ),
    ...(completedScene.background === undefined
      ? {}
      : { background: { ...completedScene.background } }),
  }
}

/** Construct an unregistered Flowing Contours Sketch with a caller-owned default. */
export function createFlowingContours(
  defaultImageAssetId: string,
): StatelessSketch {
  const schema = createFlowingContoursSchema(defaultImageAssetId)
  return {
    id: 'flowing-contours',
    name: 'Flowing Contours',
    schema,
    deriveOutlineSource: deriveFlowingContoursOutlineSource,
    generate(params, _seed, _t, frame, environment?: SketchEnvironment) {
      const imageAssetId = imageAssetParam(
        params,
        schema,
        'imageAsset',
      )
      try {
        const pixels = environment?.imageAssets(imageAssetId)
        if (pixels === undefined) return emptyScene(frame)

        return generateFlowingContours({
          pixels,
          frame,
          controls: controlsFromParams(params, schema),
        }).scene
      } catch {
        return emptyScene(frame)
      }
    },
  }
}

/** Named production composition registered by the default catalog. */
export const flowingContours = createFlowingContours(
  FLOWING_CONTOURS_DEFAULT_IMAGE_ASSET_ID,
)
