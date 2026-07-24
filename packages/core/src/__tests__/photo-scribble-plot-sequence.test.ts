import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import type { DecodedPixels, SketchEnvironment } from '../imageAssets'
import type {
  PlotStageGenerator,
  PlotStageGeneratorInput,
} from '../plotSequence'
import type { Params } from '../sketch'
import {
  generatePhotoScribbleWatercolorStage,
} from '../sketches/photo-scribble/plot-sequence'
import type { WatercolorFormsControls } from '../sketches/watercolor-forms/controls'
import { generateWatercolorForms } from '../sketches/watercolor-forms/generator'

const FRAME = Object.freeze({ width: 80, height: 60 })
const SELECTED_ID = 'selected-0123456789ab'
const OTHER_ID = 'other-abcdef012345'
const CONTROLS: Readonly<WatercolorFormsControls> = Object.freeze({
  gamma: 0.5,
  contrast: 0.5,
  pivot: 0.5,
  formDetail: 1,
  colorSensitivity: 0.7,
  boundaryStrength: 0,
  boundarySmoothing: 0,
})

function transition(): DecodedPixels {
  return {
    width: 8,
    height: 6,
    data: Uint8Array.from(
      Array.from({ length: 8 * 6 }, (_, index) => {
        const byte = index % 8 >= 4 ? 255 : 0
        return [byte, byte, byte, 255]
      }).flat(),
    ),
  }
}

function canonicalParams(extra: Readonly<Params> = {}): Readonly<Params> {
  return Object.freeze({
    imageAsset: SELECTED_ID,
    ...CONTROLS,
    ...extra,
  })
}

function environmentFor(
  lookup: SketchEnvironment['imageAssets'],
): SketchEnvironment {
  return { imageAssets: lookup }
}

function inputFor(
  params: Readonly<Params>,
  environment?: SketchEnvironment,
  seed = 'sequence-seed',
  t = 0,
): Readonly<PlotStageGeneratorInput> {
  return Object.freeze({
    params,
    seed,
    t,
    frame: FRAME,
    ...(environment === undefined ? {} : { environment }),
  })
}

describe('Photo Scribble Watercolor Plot Stage adapter', () => {
  it('is a PlotStageGenerator and resolves only the exact selected asset without fallback', () => {
    const generator: PlotStageGenerator = generatePhotoScribbleWatercolorStage
    const lookup = vi.fn((id: string) =>
      id === OTHER_ID ? transition() : undefined,
    )

    expect(
      generator(
        inputFor(
          canonicalParams({ fallbackImageAsset: OTHER_ID }),
          environmentFor(lookup),
        ),
      ),
    ).toEqual({ space: FRAME, primitives: [] })
    expect(lookup.mock.calls).toEqual([[SELECTED_ID]])
  })

  it('fails closed in-frame before headless analysis when environment or the exact asset is missing', () => {
    const paramsWithoutReadableControls: Params = {
      imageAsset: SELECTED_ID,
    }
    for (const key of Object.keys(CONTROLS)) {
      Object.defineProperty(paramsWithoutReadableControls, key, {
        enumerable: true,
        get: () => {
          throw new Error(`must not read ${key}`)
        },
      })
    }

    expect(
      generatePhotoScribbleWatercolorStage(
        inputFor(paramsWithoutReadableControls),
      ),
    ).toEqual({ space: FRAME, primitives: [] })

    const lookup = vi.fn(() => undefined)
    expect(
      generatePhotoScribbleWatercolorStage(
        inputFor(
          paramsWithoutReadableControls,
          environmentFor(lookup),
        ),
      ),
    ).toEqual({ space: FRAME, primitives: [] })
    expect(lookup.mock.calls).toEqual([[SELECTED_ID]])
  })

  it('returns the exact unfinalized Scene produced by the direct headless generator', () => {
    const pixels = transition()
    const environment = environmentFor((id) =>
      id === SELECTED_ID ? pixels : undefined,
    )
    const direct = generateWatercolorForms({
      pixels,
      frame: FRAME,
      controls: CONTROLS,
    }).scene

    const adapted = generatePhotoScribbleWatercolorStage(
      inputFor(canonicalParams(), environment),
    )

    expect(adapted).toEqual(direct)
    expect(adapted.primitives.length).toBeGreaterThan(0)
  })

  it('accepts unchanged Seed and time inputs without making geometry depend on either', () => {
    const pixels = transition()
    const environment = environmentFor((id) =>
      id === SELECTED_ID ? pixels : undefined,
    )

    const first = generatePhotoScribbleWatercolorStage(
      inputFor(canonicalParams(), environment, 'seed-a', 0),
    )
    const second = generatePhotoScribbleWatercolorStage(
      inputFor(canonicalParams(), environment, 'seed-b', 999),
    )

    expect(first.primitives.length).toBeGreaterThan(0)
    expect(second).toEqual(first)
  })

  it('consumes only the canonical image and seven Watercolor parameter keys', () => {
    const pixels = transition()
    const environment = environmentFor((id) =>
      id === SELECTED_ID ? pixels : undefined,
    )
    const aliasesAndUnownedValues = {
      watercolorGamma: 0,
      watercolorContrast: 0,
      watercolorPivot: 0,
      watercolorFormDetail: 0,
      watercolorColorSensitivity: 0,
      watercolorBoundaryStrength: 1,
      watercolorBoundarySmoothing: 1,
      toneGamma: 0,
      fallbackImageAsset: OTHER_ID,
      unexpected: 'ignored',
    }

    expect(
      generatePhotoScribbleWatercolorStage(
        inputFor(
          canonicalParams(aliasesAndUnownedValues),
          environment,
        ),
      ),
    ).toEqual(
      generatePhotoScribbleWatercolorStage(
        inputFor(canonicalParams(), environment),
      ),
    )
  })

  it('imports Watercolor controls and runtime from cycle-safe leaf modules only', () => {
    const source = readFileSync(
      new URL(
        '../sketches/photo-scribble/plot-sequence.ts',
        import.meta.url,
      ),
      'utf8',
    )

    expect(source).toContain("from '../watercolor-forms/controls'")
    expect(source).toContain("from '../watercolor-forms/generator'")
    expect(source).not.toMatch(
      /from ['"]\.\.\/watercolor-forms(?:\/index)?['"]/,
    )
    expect(source).not.toMatch(/from ['"]\.\/index['"]/)
    expect(source).not.toContain('createWatercolorForms')
    expect(source).not.toContain('watercolorForms')
  })
})
