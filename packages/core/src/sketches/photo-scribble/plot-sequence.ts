/**
 * Supporting Plot Stage adapters owned by Photo Scribble.
 *
 * This module stays below both registered Sketches: it resolves the projected
 * Stage inputs and delegates directly to Watercolor Forms' headless generator.
 * Plot Sequence declaration, scheduling, presentation, and finalization belong
 * to their respective callers.
 */

import type { PlotStageGenerator } from '../../plotSequence'
import { createScene } from '../../scene'
import type { Params } from '../../sketch'
import type { WatercolorFormsControls } from '../watercolor-forms/controls'
import { generateWatercolorForms } from '../watercolor-forms/generator'

function controlsFromStageParams(
  params: Readonly<Params>,
): WatercolorFormsControls {
  return {
    gamma: params.gamma as number,
    contrast: params.contrast as number,
    pivot: params.pivot as number,
    formDetail: params.formDetail as number,
    colorSensitivity: params.colorSensitivity as number,
    boundaryStrength: params.boundaryStrength as number,
    boundarySmoothing: params.boundarySmoothing as number,
  }
}

/**
 * Generate Photo Scribble's supporting Watercolor Stage.
 *
 * The callback intentionally ignores the Sequence Seed and time: Watercolor
 * Forms geometry depends only on its canonical projected params, the exact
 * Composition Frame, and the exact selected decoded Image Asset.
 */
export const generatePhotoScribbleWatercolorStage: PlotStageGenerator = ({
  params,
  frame,
  environment,
}) => {
  const emptyScene = () => createScene(frame).build()
  if (environment === undefined) return emptyScene()

  const imageAssetId = params.imageAsset
  if (typeof imageAssetId !== 'string') return emptyScene()

  const pixels = environment.imageAssets(imageAssetId)
  if (pixels === undefined) return emptyScene()

  return generateWatercolorForms({
    pixels,
    frame,
    controls: controlsFromStageParams(params),
  }).scene
}
