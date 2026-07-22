/**
 * Registered Pencil Contour Sketch composition.
 *
 * Image Asset resolution belongs to the Sketch adapter: the reusable generator
 * remains a headless decoded-pixel capability and has no dependency on the
 * registry, Photo Scribble, Seeds, or time.
 */

import type { SketchEnvironment } from '../../imageAssets'
import { createScene, type CoordinateSpace } from '../../scene'
import type {
  ParamSpec,
  Params,
  StatelessSketch,
} from '../../sketch'
import { imageAssetParam, numberParam } from '../sketch-util'
import { PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID } from '../photo-scribble'
import {
  pencilContourControlSchema,
  type PencilContourControls,
} from './controls'
import { generatePencilContour } from './generator'

export * from './controls'
export * from './generator'
export type {
  PencilContourGenerator,
  PencilContourGeneratorInput,
  PencilContourGeneratorResult,
} from './types'

/** The bundled sample shared with Photo Scribble's production composition. */
export const PENCIL_CONTOUR_DEFAULT_IMAGE_ASSET_ID =
  PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID

/** Build Pencil Contour's managed Image Asset and reusable control schema. */
export function createPencilContourSchema(defaultImageAssetId: string) {
  return Object.freeze({
    imageAsset: Object.freeze({
      kind: 'image-asset',
      default: defaultImageAssetId,
    }),
    ...pencilContourControlSchema,
  } satisfies Record<string, ParamSpec>)
}

export type PencilContourSchema = ReturnType<typeof createPencilContourSchema>

function controlsFromParams(
  params: Params,
  schema: PencilContourSchema,
): PencilContourControls {
  return {
    gamma: numberParam(params, schema, 'gamma'),
    contrast: numberParam(params, schema, 'contrast'),
    pivot: numberParam(params, schema, 'pivot'),
    contourDetail: numberParam(params, schema, 'contourDetail'),
    contourSmoothing: numberParam(params, schema, 'contourSmoothing'),
  }
}

function emptyScene(frame: CoordinateSpace) {
  return createScene(frame).build()
}

/** Construct an unregistered Pencil Contour Sketch with a caller-owned default. */
export function createPencilContour(
  defaultImageAssetId: string,
): StatelessSketch {
  const schema = createPencilContourSchema(defaultImageAssetId)
  return {
    id: 'pencil-contour',
    name: 'Pencil Contour',
    schema,
    generate(params, _seed, _t, frame, environment?: SketchEnvironment) {
      const imageAssetId = imageAssetParam(
        params,
        schema,
        'imageAsset',
      )
      const pixels = environment?.imageAssets(imageAssetId)
      if (pixels === undefined) return emptyScene(frame)

      return generatePencilContour({
        pixels,
        frame,
        controls: controlsFromParams(params, schema),
      }).scene
    },
  }
}

/** Named production composition registered by the default catalog. */
export const pencilContour = createPencilContour(
  PENCIL_CONTOUR_DEFAULT_IMAGE_ASSET_ID,
)
