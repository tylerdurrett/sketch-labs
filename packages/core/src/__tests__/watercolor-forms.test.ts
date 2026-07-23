import { describe, expect, it, vi } from 'vitest'

import {
  applyPreset,
  createWatercolorForms,
  createWatercolorFormsSchema,
  defaultParams,
  defaultWatercolorFormsControls,
  deserialize,
  generateWatercolorForms,
  makePreset,
  serialize,
  WATERCOLOR_FORMS_DEFAULT_IMAGE_ASSET_ID,
  watercolorForms,
  watercolorFormsControlSchema,
  type DecodedPixels,
  type SketchEnvironment,
  type WatercolorFormsGenerator,
} from '../index'
import * as watercolorFormsModule from '../sketches/watercolor-forms'

const FRAME = { width: 80, height: 60 }
const DEFAULT_ID = 'default-001122334455'
const SELECTED_ID = 'selected-0123456789ab'
const OTHER_ID = 'other-abcdef012345'

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

function environmentFor(
  lookup: SketchEnvironment['imageAssets'],
): SketchEnvironment {
  return { imageAssets: lookup }
}

describe('Watercolor Forms registered Sketch', () => {
  it('publishes stable metadata and the managed asset plus four controls in authored order', () => {
    const sketch = createWatercolorForms(SELECTED_ID)

    expect(sketch.id).toBe('watercolor-forms')
    expect(sketch.name).toBe('Watercolor Forms')
    expect(Object.keys(sketch.schema)).toEqual([
      'imageAsset',
      'formDetail',
      'colorSensitivity',
      'boundaryStrength',
      'boundarySmoothing',
    ])
    expect(sketch.schema).toEqual({
      imageAsset: { kind: 'image-asset', default: SELECTED_ID },
      ...watercolorFormsControlSchema,
    })
    expect(defaultParams(sketch.schema)).toEqual({
      imageAsset: SELECTED_ID,
      ...defaultWatercolorFormsControls,
    })
    expect(createWatercolorFormsSchema(SELECTED_ID)).toEqual(sketch.schema)
  })

  it('binds production to the bundled stable sample without changing factory defaults', () => {
    expect(WATERCOLOR_FORMS_DEFAULT_IMAGE_ASSET_ID).toBe(
      'pinecone-4330aa0314f7',
    )
    expect(watercolorForms.schema.imageAsset).toEqual({
      kind: 'image-asset',
      default: WATERCOLOR_FORMS_DEFAULT_IMAGE_ASSET_ID,
    })
  })

  it('exports the authored controls and headless generator independently', () => {
    const generator: WatercolorFormsGenerator = generateWatercolorForms

    expect(watercolorFormsModule.generateWatercolorForms).toBe(generator)
    expect(watercolorFormsModule.watercolorFormsControlSchema).toBe(
      watercolorFormsControlSchema,
    )
    expect(watercolorFormsModule.defaultWatercolorFormsControls).toBe(
      defaultWatercolorFormsControls,
    )
  })

  it('looks up only the exact selected asset and retains an unresolved stable ID', () => {
    const sketch = createWatercolorForms(DEFAULT_ID)
    const params = {
      ...defaultParams(sketch.schema),
      imageAsset: SELECTED_ID,
    }
    const lookup = vi.fn((id: string) =>
      id === OTHER_ID ? transition() : undefined,
    )

    expect(
      sketch.generate(params, 'seed', 1, FRAME, environmentFor(lookup)),
    ).toEqual({ space: FRAME, primitives: [] })
    expect(params.imageAsset).toBe(SELECTED_ID)
    expect(lookup.mock.calls).toEqual([[SELECTED_ID]])
  })

  it('returns an empty Scene without launching a lookup when no environment exists', () => {
    const sketch = createWatercolorForms(SELECTED_ID)

    expect(
      sketch.generate(
        defaultParams(sketch.schema),
        'any-seed',
        42,
        FRAME,
      ),
    ).toEqual({ space: FRAME, primitives: [] })
  })

  it('ignores seed and time and exactly matches the direct headless generator', () => {
    const sketch = createWatercolorForms(SELECTED_ID)
    const params = {
      ...defaultParams(sketch.schema),
      formDetail: 1,
      colorSensitivity: 0.7,
      boundaryStrength: 0,
      boundarySmoothing: 0,
    }
    const pixels = transition()
    const environment = environmentFor((id) =>
      id === SELECTED_ID ? pixels : undefined,
    )
    const direct = generateWatercolorForms({
      pixels,
      frame: FRAME,
      controls: {
        formDetail: 1,
        colorSensitivity: 0.7,
        boundaryStrength: 0,
        boundarySmoothing: 0,
      },
    }).scene

    expect(sketch.generate(params, 'seed-a', 0, FRAME, environment)).toEqual(
      direct,
    )
    expect(sketch.generate(params, 'seed-b', 999, FRAME, environment)).toEqual(
      direct,
    )
    expect(direct.primitives.length).toBeGreaterThan(0)
  })

  it('round-trips the asset ID and all four controls through the Preset spine', () => {
    const schema = createWatercolorFormsSchema(DEFAULT_ID)
    const params = {
      imageAsset: SELECTED_ID,
      formDetail: 0.17,
      colorSensitivity: 0.31,
      boundaryStrength: 0.53,
      boundarySmoothing: 0.79,
    }
    const preset = makePreset(
      'watercolor-forms',
      'round-trip',
      params,
      'ignored-by-v1-geometry',
      new Set(['formDetail', 'boundarySmoothing']),
    )

    const loaded = deserialize(serialize(preset))
    const applied = applyPreset(schema, loaded)

    expect(loaded.params).toEqual(params)
    expect(applied.params).toEqual(params)
    expect(applied.seed).toBe('ignored-by-v1-geometry')
    expect(applied.locks).toEqual(['boundarySmoothing', 'formDetail'])
  })
})
