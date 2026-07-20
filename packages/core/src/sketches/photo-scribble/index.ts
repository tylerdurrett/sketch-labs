/**
 * Headless Photo Scribble Sketch composition.
 *
 * The named Sketch uses the committed sample's opaque, content-derived Image
 * Asset ID. The factory remains available for callers and tests that own a
 * different default; core deliberately does not parse or validate either form.
 *
 * Artwork contains only generated Scribble paths. The photograph remains source
 * data and never becomes a Primitive, authored contour, occluder, guide, or
 * background.
 */

import { createDetailField, sampleDetailField } from '../../detailFields'
import type { DetailField } from '../../detailFields'
import {
  createImageDetailField,
  IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
} from '../../imageDetailAnalysis'
import {
  scribbleControlSchema,
  scribbleStrategy,
  type ScribbleControls,
  type ScribbleObserver,
  type ScribbleResult,
} from '../../scribbleStrategy'
import { createScene } from '../../scene'
import type { CoordinateSpace, Scene } from '../../scene'
import {
  createScribbleDiagnostics,
  type ParamSpec,
  type Params,
  type ScribbleArtwork,
  type Seed,
  type StatelessSketch,
} from '../../sketch'
import type { SketchEnvironment } from '../../imageAssets'
import { imageAssetParam, numberParam } from '../sketch-util'
import {
  applyPhotoDetailSensitivity,
  PHOTO_DETAIL_SENSITIVITY_DEFAULT,
  PHOTO_DETAIL_SENSITIVITY_MAX,
  PHOTO_DETAIL_SENSITIVITY_MIN,
} from './detail'
import {
  PHOTO_TONE_CONTROL_DEFAULT,
  PHOTO_TONE_CONTROL_MAX,
  PHOTO_TONE_CONTROL_MIN,
  type PhotoToneControls,
} from './tone'
import { createResolvedPhotoScribbleSource } from './source'

export * from './source'
export * from './detail'
export * from './tone'

const PHOTO_TONE_CONTROL_STEP = 0.01
const PHOTO_DETAIL_SENSITIVITY_STEP = 0.01
const PREVIEW_STROKE = Object.freeze({ color: 'black', width: 1 })
const ZERO_PHOTO_DETAIL_FIELD = createDetailField(() => 0)

/** Opaque stable ID of the bundled sample; its filename and bytes live in Studio. */
export const PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID =
  'pinecone-4330aa0314f7'

/** Build the exact schema bound to one real default Image Asset ID. */
export function createPhotoScribbleSchema(defaultImageAssetId: string) {
  return Object.freeze({
    imageAsset: { kind: 'image-asset', default: defaultImageAssetId },
    toneContrast: {
      kind: 'number',
      min: PHOTO_TONE_CONTROL_MIN,
      max: PHOTO_TONE_CONTROL_MAX,
      default: PHOTO_TONE_CONTROL_DEFAULT,
      step: PHOTO_TONE_CONTROL_STEP,
    },
    tonePivot: {
      kind: 'number',
      min: PHOTO_TONE_CONTROL_MIN,
      max: PHOTO_TONE_CONTROL_MAX,
      default: PHOTO_TONE_CONTROL_DEFAULT,
      step: PHOTO_TONE_CONTROL_STEP,
    },
    toneGamma: {
      kind: 'number',
      min: PHOTO_TONE_CONTROL_MIN,
      max: PHOTO_TONE_CONTROL_MAX,
      default: PHOTO_TONE_CONTROL_DEFAULT,
      step: PHOTO_TONE_CONTROL_STEP,
    },
    detailSensitivity: {
      kind: 'number',
      min: PHOTO_DETAIL_SENSITIVITY_MIN,
      max: PHOTO_DETAIL_SENSITIVITY_MAX,
      default: PHOTO_DETAIL_SENSITIVITY_DEFAULT,
      step: PHOTO_DETAIL_SENSITIVITY_STEP,
    },
    ...scribbleControlSchema,
  } satisfies Record<string, ParamSpec>)
}

export type PhotoScribbleSchema = ReturnType<typeof createPhotoScribbleSchema>

function toneControls(
  params: Params,
  schema: PhotoScribbleSchema,
): PhotoToneControls {
  return {
    toneGamma: numberParam(params, schema, 'toneGamma'),
    toneContrast: numberParam(params, schema, 'toneContrast'),
    tonePivot: numberParam(params, schema, 'tonePivot'),
  }
}

function scribbleControls(
  params: Params,
  schema: PhotoScribbleSchema,
): ScribbleControls {
  return {
    pathDensity: numberParam(params, schema, 'pathDensity'),
    scribbleScale: numberParam(params, schema, 'scribbleScale'),
    momentum: numberParam(params, schema, 'momentum'),
    chaos: numberParam(params, schema, 'chaos'),
    toneFidelity: numberParam(params, schema, 'toneFidelity'),
    stopPoint: numberParam(params, schema, 'stopPoint'),
  }
}

/** Derive the selected, adjusted photographic source from schema-backed params. */
export function createPhotoScribbleSource(
  params: Params,
  frame: CoordinateSpace,
  schema: PhotoScribbleSchema,
  environment?: SketchEnvironment,
) {
  return createResolvedPhotoScribbleSource(
    imageAssetParam(params, schema, 'imageAsset'),
    toneControls(params, schema),
    frame,
    environment,
  )
}

/**
 * Derive the selected sensitivity-adjusted Detail Field from prepared analysis.
 *
 * This pure capability performs only a synchronous exact-identity lookup and
 * field binding. The Harness owns asset resolution, decoding, and preparation.
 */
export function createPhotoScribbleDetailField(
  params: Params,
  frame: CoordinateSpace,
  schema: PhotoScribbleSchema,
  environment?: SketchEnvironment,
): DetailField {
  const prepared = environment?.getPreparedImageDetailAnalysis?.(
    imageAssetParam(params, schema, 'imageAsset'),
    IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
  )
  if (prepared === undefined) return ZERO_PHOTO_DETAIL_FIELD

  const base = createImageDetailField(prepared, frame)
  const sensitivity = numberParam(params, schema, 'detailSensitivity')
  return createDetailField((point) =>
    applyPhotoDetailSensitivity(sampleDetailField(base, point), sensitivity),
  )
}

/** Run the existing Scribble Strategy against one resolved photographic source. */
export function generatePhotoScribble(
  params: Params,
  seed: Seed,
  frame: CoordinateSpace,
  schema: PhotoScribbleSchema,
  observer?: ScribbleObserver,
  environment?: SketchEnvironment,
): ScribbleResult {
  return scribbleStrategy({
    source: createPhotoScribbleSource(params, frame, schema, environment),
    frame,
    controls: scribbleControls(params, schema),
    seed,
    ...(observer === undefined ? {} : { observer }),
  })
}

function sceneFromScribble(
  frame: CoordinateSpace,
  result: Readonly<ScribbleResult>,
): Scene {
  const builder = createScene(frame)
  for (const polyline of result.polylines) {
    builder.addPath(polyline, {
      closed: false,
      stroke: PREVIEW_STROKE,
      hiddenLineRole: 'source',
    })
  }
  return builder.build()
}

/** Complete Photo Scribble Scene plus compact scalar diagnostics. */
export function generatePhotoScribbleArtwork(
  params: Params,
  seed: Seed,
  frame: CoordinateSpace,
  schema: PhotoScribbleSchema,
  observer?: ScribbleObserver,
  environment?: SketchEnvironment,
): ScribbleArtwork {
  const result = generatePhotoScribble(
    params,
    seed,
    frame,
    schema,
    observer,
    environment,
  )
  return {
    scene: sceneFromScribble(frame, result),
    diagnostics: createScribbleDiagnostics(result),
  }
}

/** Construct an unregistered, headless Sketch around a caller-owned default ID. */
export function createPhotoScribble(
  defaultImageAssetId: string,
): StatelessSketch {
  const schema = createPhotoScribbleSchema(defaultImageAssetId)
  return {
    id: 'photo-scribble',
    name: 'Photo Scribble',
    schema,
    generateToneSource(params, frame, environment) {
      return createPhotoScribbleSource(params, frame, schema, environment)
    },
    generateDetailField(params, frame, environment) {
      return createPhotoScribbleDetailField(
        params,
        frame,
        schema,
        environment,
      )
    },
    generateScribbleArtwork(params, seed, frame, observer, environment) {
      return generatePhotoScribbleArtwork(
        params,
        seed,
        frame,
        schema,
        observer,
        environment,
      )
    },
    generate(params, seed, _t, frame, environment) {
      return generatePhotoScribbleArtwork(
        params,
        seed,
        frame,
        schema,
        undefined,
        environment,
      ).scene
    },
  }
}

/** Named production composition; Studio registration lands with its asset loader. */
export const photoScribble = createPhotoScribble(
  PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID,
)
