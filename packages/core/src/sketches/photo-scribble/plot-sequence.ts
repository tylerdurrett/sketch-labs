/**
 * Supporting Plot Stage adapters owned by Photo Scribble.
 *
 * This module stays below both registered Sketches: it resolves the projected
 * Stage inputs and delegates directly to Watercolor Forms' headless generator.
 * Plot Sequence declaration, scheduling, presentation, and finalization belong
 * to their respective callers.
 */

import type {
  PlotSequenceDeclaration,
  PlotStageGenerator,
} from '../../plotSequence'
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

/** Photo Scribble's authored supporting-Watercolor then primary-Ink plot order. */
export const photoScribblePlotSequence: PlotSequenceDeclaration = Object.freeze({
  sharedParameters: Object.freeze([
    Object.freeze({ schemaKey: 'imageAsset', key: 'imageAsset' }),
  ]),
  stages: Object.freeze([
    Object.freeze({
      id: 'watercolor-forms',
      name: 'Watercolor Forms',
      source: Object.freeze({
        kind: 'generator',
        generatorId: 'watercolor-forms',
        generate: generatePhotoScribbleWatercolorStage,
      }),
      parameters: Object.freeze([
        Object.freeze({ schemaKey: 'watercolorGamma', key: 'gamma' }),
        Object.freeze({
          schemaKey: 'watercolorContrast',
          key: 'contrast',
        }),
        Object.freeze({ schemaKey: 'watercolorPivot', key: 'pivot' }),
        Object.freeze({
          schemaKey: 'watercolorFormDetail',
          key: 'formDetail',
        }),
        Object.freeze({
          schemaKey: 'watercolorColorSensitivity',
          key: 'colorSensitivity',
        }),
        Object.freeze({
          schemaKey: 'watercolorBoundaryStrength',
          key: 'boundaryStrength',
        }),
        Object.freeze({
          schemaKey: 'watercolorBoundarySmoothing',
          key: 'boundarySmoothing',
        }),
      ]),
      dependencies: Object.freeze({ usesSeed: false, usesTime: false }),
    }),
    Object.freeze({
      id: 'ink-scribble',
      name: 'Ink Scribble',
      source: Object.freeze({
        kind: 'primary',
        generatorId: 'photo-scribble',
      }),
      parameters: Object.freeze([
        Object.freeze({ schemaKey: 'toneContrast', key: 'toneContrast' }),
        Object.freeze({ schemaKey: 'tonePivot', key: 'tonePivot' }),
        Object.freeze({ schemaKey: 'toneGamma', key: 'toneGamma' }),
        Object.freeze({
          schemaKey: 'detailSensitivity',
          key: 'detailSensitivity',
        }),
        Object.freeze({
          schemaKey: 'detailInfluence',
          key: 'detailInfluence',
        }),
        Object.freeze({ schemaKey: 'pathDensity', key: 'pathDensity' }),
        Object.freeze({ schemaKey: 'scribbleScale', key: 'scribbleScale' }),
        Object.freeze({ schemaKey: 'momentum', key: 'momentum' }),
        Object.freeze({ schemaKey: 'chaos', key: 'chaos' }),
        Object.freeze({ schemaKey: 'toneFidelity', key: 'toneFidelity' }),
        Object.freeze({ schemaKey: 'stopPoint', key: 'stopPoint' }),
      ]),
      dependencies: Object.freeze({ usesSeed: true, usesTime: false }),
    }),
  ]),
})
