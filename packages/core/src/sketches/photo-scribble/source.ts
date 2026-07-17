/**
 * Photo Scribble's Image Asset-backed Tone Source.
 *
 * Asset loading and decoding stay with the supplied Harness environment. This
 * source synchronously resolves the already-decoded record, applies core's
 * contain-fitted raster interpretation, then applies Photo Scribble's authored
 * gamma-before-contrast controls to tone only. Alpha permission passes through
 * unchanged, and a missing lookup or asset fails closed to paper/forbidden.
 */

import type { SketchEnvironment } from '../../imageAssets'
import { createRasterToneSource } from '../../rasterToneSource'
import type { CoordinateSpace } from '../../scene'
import {
  createShadingMask,
  createToneField,
  sampleToneField,
  type ToneSource,
} from '../../shadingFields'
import { applyPhotoToneControls, type PhotoToneControls } from './tone'

const ZERO_PHOTO_SOURCE: ToneSource = Object.freeze({
  toneField: createToneField(() => 0),
  shadingMask: createShadingMask(() => 0),
})

/** Resolve and adapt one selected Image Asset without loading or decoding it. */
export function createResolvedPhotoScribbleSource(
  imageAssetId: string,
  controls: Readonly<PhotoToneControls>,
  frame: CoordinateSpace,
  environment?: SketchEnvironment,
): ToneSource {
  const pixels = environment?.imageAssets(imageAssetId)
  if (pixels === undefined) return ZERO_PHOTO_SOURCE

  const raster = createRasterToneSource(pixels, frame)
  return Object.freeze({
    toneField: createToneField((point) =>
      applyPhotoToneControls(sampleToneField(raster.toneField, point), controls),
    ),
    shadingMask: raster.shadingMask,
  })
}
