/**
 * Registered Watercolor Forms Sketch composition.
 *
 * Image Asset resolution belongs to this thin Sketch adapter. The reusable
 * generator remains a headless decoded-pixel capability and deliberately has no
 * dependency on the registry, Seeds, or time.
 */

import type { SketchEnvironment } from '../../imageAssets'
import { createScene, type CoordinateSpace } from '../../scene'
import type { ParamSpec, Params, StatelessSketch } from '../../sketch'
import { imageAssetParam, numberParam } from '../sketch-util'
import { PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID } from '../photo-scribble'
import {
  watercolorFormsControlSchema,
  type WatercolorFormsControls,
} from './controls'
import { generateWatercolorForms } from './generator'

export * from './controls'
export * from './generator'
export type {
  WatercolorFormsGenerator,
  WatercolorFormsGeneratorInput,
  WatercolorFormsGeneratorResult,
} from './types'

/** The bundled sample shared with the other production photo-backed Sketches. */
export const WATERCOLOR_FORMS_DEFAULT_IMAGE_ASSET_ID =
  PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID

/** Build Watercolor Forms' managed Image Asset and authored control schema. */
export function createWatercolorFormsSchema(defaultImageAssetId: string) {
  return Object.freeze({
    imageAsset: Object.freeze({
      kind: 'image-asset',
      default: defaultImageAssetId,
    }),
    ...watercolorFormsControlSchema,
  } satisfies Record<string, ParamSpec>)
}

export type WatercolorFormsSchema = ReturnType<
  typeof createWatercolorFormsSchema
>

function controlsFromParams(
  params: Params,
  schema: WatercolorFormsSchema,
): WatercolorFormsControls {
  return {
    formDetail: numberParam(params, schema, 'formDetail'),
    colorSensitivity: numberParam(params, schema, 'colorSensitivity'),
    boundaryStrength: numberParam(params, schema, 'boundaryStrength'),
    boundarySmoothing: numberParam(params, schema, 'boundarySmoothing'),
  }
}

function emptyScene(frame: CoordinateSpace) {
  return createScene(frame).build()
}

/** Construct an unregistered Watercolor Forms Sketch with a caller-owned default. */
export function createWatercolorForms(
  defaultImageAssetId: string,
): StatelessSketch {
  const schema = createWatercolorFormsSchema(defaultImageAssetId)
  return {
    id: 'watercolor-forms',
    name: 'Watercolor Forms',
    schema,
    generate(params, _seed, _t, frame, environment?: SketchEnvironment) {
      const imageAssetId = imageAssetParam(
        params,
        schema,
        'imageAsset',
      )
      const pixels = environment?.imageAssets(imageAssetId)
      if (pixels === undefined) return emptyScene(frame)

      return generateWatercolorForms({
        pixels,
        frame,
        controls: controlsFromParams(params, schema),
      }).scene
    },
  }
}

/** Named production composition registered by the default catalog. */
export const watercolorForms = createWatercolorForms(
  WATERCOLOR_FORMS_DEFAULT_IMAGE_ASSET_ID,
)
