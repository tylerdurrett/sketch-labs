import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DecodedPixels, SketchEnvironment } from '../imageAssets'
import {
  createImageDetailField,
  IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
  type PreparedImageDetailAnalysis,
} from '../imageDetailAnalysis'
import { applyPreset } from '../preset'
import { createRasterToneSource } from '../rasterToneSource'
import { defaultParams, randomize, type Params } from '../sketch'
import type { ScribbleStrategyInput } from '../scribbleStrategy'
import { scribbleStrategy } from '../scribbleStrategy'
import {
  PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID,
  createPhotoScribble,
  createPhotoScribbleDetailField,
  createPhotoScribbleSchema,
  createPhotoScribbleSource,
  generatePhotoScribble,
  generatePhotoScribbleShadingArtwork,
  photoScribble,
} from '../sketches/photo-scribble'
import { applyPhotoToneControls } from '../sketches/photo-scribble/tone'
import { scribbleMoon } from '../sketches/scribble-moon'
import { toneCalibration } from '../sketches/tone-calibration'
import {
  defaultWatercolorFormsControls,
  watercolorFormsControlSchema,
} from '../sketches/watercolor-forms/controls'

vi.mock('../scribbleStrategy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scribbleStrategy')>()
  return { ...actual, scribbleStrategy: vi.fn() }
})

vi.mock('../imageDetailAnalysis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageDetailAnalysis')>()
  return {
    ...actual,
    createImageDetailField: vi.fn(actual.createImageDetailField),
  }
})

const scribbleStrategyMock = vi.mocked(scribbleStrategy)
const createImageDetailFieldMock = vi.mocked(createImageDetailField)
const HEADLESS_FIXTURE_LOOKUP_KEY = 'headless-fixture'
const SELECTED_FIXTURE_LOOKUP_KEY = 'selected-fixture'
const FRAME = { width: 20, height: 10 }
const FIXTURE_PIXELS: DecodedPixels = {
  width: 1,
  height: 1,
  data: Uint8Array.from([64, 128, 192, 255]),
}

function environment(
  lookup = vi.fn((key: string) =>
    key === HEADLESS_FIXTURE_LOOKUP_KEY || key === SELECTED_FIXTURE_LOOKUP_KEY
      ? FIXTURE_PIXELS
      : undefined,
  ),
): SketchEnvironment {
  return { imageAssets: lookup }
}

function params(overrides: Params = {}): Params {
  return {
    ...defaultParams(createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)),
    ...overrides,
  }
}

function resultFor(input: ScribbleStrategyInput) {
  const permitted = input.source.shadingMask.sample([10, 5]) > 0
  return {
    polylines: permitted
      ? [
          [
            [1, 2],
            [3, 4],
          ],
          [
            [5, 6],
            [7, 8],
          ],
        ]
      : [],
    termination: 'completed' as const,
    residualError: permitted ? 0.125 : 0,
  }
}

beforeEach(() => {
  scribbleStrategyMock.mockReset()
  scribbleStrategyMock.mockImplementation(resultFor)
  createImageDetailFieldMock.mockClear()
})

describe('Photo Scribble headless composition', () => {
  it('preserves every Ink declaration and appends the seven exact Watercolor declarations', () => {
    const schema = createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)
    const inkKeys = [
      'imageAsset',
      'toneContrast',
      'tonePivot',
      'toneGamma',
      'detailSensitivity',
      'detailInfluence',
      'pathDensity',
      'scribbleScale',
      'momentum',
      'chaos',
      'toneFidelity',
      'stopPoint',
    ]
    const watercolorKeys = [
      'watercolorGamma',
      'watercolorContrast',
      'watercolorPivot',
      'watercolorFormDetail',
      'watercolorColorSensitivity',
      'watercolorBoundaryStrength',
      'watercolorBoundarySmoothing',
    ]

    expect(Object.keys(schema)).toEqual([...inkKeys, ...watercolorKeys])
    expect(schema.imageAsset).toEqual({
      kind: 'image-asset',
      default: HEADLESS_FIXTURE_LOOKUP_KEY,
    })
    expect(schema.toneContrast).toEqual({
      kind: 'number',
      min: 0,
      max: 1,
      default: 0.5,
      step: 0.01,
    })
    expect(schema.toneGamma).toEqual(schema.toneContrast)
    expect(schema.tonePivot).toEqual(schema.toneContrast)
    expect(schema.detailSensitivity).toEqual(schema.toneContrast)
    expect(schema.detailInfluence).toEqual({
      kind: 'number',
      min: 0,
      max: 1,
      default: 0,
      step: 0.01,
    })
    expect(defaultParams(schema)).toEqual({
      imageAsset: HEADLESS_FIXTURE_LOOKUP_KEY,
      toneContrast: 0.5,
      tonePivot: 0.5,
      toneGamma: 0.5,
      detailSensitivity: 0.5,
      detailInfluence: 0,
      pathDensity: 1,
      scribbleScale: 1,
      momentum: 0.75,
      chaos: 0.25,
      toneFidelity: 0.9,
      stopPoint: 100,
      watercolorGamma: defaultWatercolorFormsControls.gamma,
      watercolorContrast: defaultWatercolorFormsControls.contrast,
      watercolorPivot: defaultWatercolorFormsControls.pivot,
      watercolorFormDetail: defaultWatercolorFormsControls.formDetail,
      watercolorColorSensitivity:
        defaultWatercolorFormsControls.colorSensitivity,
      watercolorBoundaryStrength:
        defaultWatercolorFormsControls.boundaryStrength,
      watercolorBoundarySmoothing:
        defaultWatercolorFormsControls.boundarySmoothing,
    })
    expect(schema.watercolorGamma).toBe(watercolorFormsControlSchema.gamma)
    expect(schema.watercolorContrast).toBe(
      watercolorFormsControlSchema.contrast,
    )
    expect(schema.watercolorPivot).toBe(watercolorFormsControlSchema.pivot)
    expect(schema.watercolorFormDetail).toBe(
      watercolorFormsControlSchema.formDetail,
    )
    expect(schema.watercolorColorSensitivity).toBe(
      watercolorFormsControlSchema.colorSensitivity,
    )
    expect(schema.watercolorBoundaryStrength).toBe(
      watercolorFormsControlSchema.boundaryStrength,
    )
    expect(schema.watercolorBoundarySmoothing).toBe(
      watercolorFormsControlSchema.boundarySmoothing,
    )
  })

  it('preserves arbitrary caller-owned default Image Asset IDs', () => {
    const sketch = createPhotoScribble(HEADLESS_FIXTURE_LOOKUP_KEY)

    expect(sketch.id).toBe('photo-scribble')
    expect(sketch.name).toBe('Photo Scribble')
    expect(sketch.schema.imageAsset).toEqual({
      kind: 'image-asset',
      default: HEADLESS_FIXTURE_LOOKUP_KEY,
    })
  })

  it('loads a legacy Preset without Stop point at the full default', () => {
    const schema = createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)
    const legacyParams = defaultParams(schema)
    delete legacyParams.stopPoint

    const restored = applyPreset(schema, {
      version: 1,
      sketch: 'photo-scribble',
      name: 'legacy-without-stop-point',
      seed: 'legacy-seed',
      params: legacyParams,
      locks: [],
    })

    expect(restored.params.stopPoint).toBe(100)
  })

  it('loads a legacy Preset without Tone pivot at the centered identity', () => {
    const schema = createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)
    const legacyParams = defaultParams(schema)
    delete legacyParams.tonePivot

    const restored = applyPreset(schema, {
      version: 1,
      sketch: 'photo-scribble',
      name: 'legacy-without-tone-pivot',
      seed: 'legacy-seed',
      params: legacyParams,
      locks: [],
    })

    expect(restored.params.tonePivot).toBe(0.5)
  })

  it('reconciles legacy Presets and randomizes all seven Watercolor values independently', () => {
    const schema = createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)
    const watercolorKeys = [
      'watercolorGamma',
      'watercolorContrast',
      'watercolorPivot',
      'watercolorFormDetail',
      'watercolorColorSensitivity',
      'watercolorBoundaryStrength',
      'watercolorBoundarySmoothing',
    ] as const
    const legacyParams = defaultParams(schema)
    for (const key of watercolorKeys) delete legacyParams[key]

    const restored = applyPreset(schema, {
      version: 1,
      sketch: 'photo-scribble',
      name: 'legacy-without-watercolor-controls',
      seed: 'legacy-seed',
      params: legacyParams,
      locks: [],
    })
    const rolls = [0.11, 0.22, 0.33, 0.44, 0.55, 0.66, 0.77]
    let roll = 0
    const randomized = randomize(
      schema,
      restored.params,
      new Set(
        Object.keys(schema).filter(
          (key) =>
            !watercolorKeys.includes(
              key as (typeof watercolorKeys)[number],
            ),
        ),
      ),
      () => rolls[roll++]!,
    )

    expect(
      Object.fromEntries(
        watercolorKeys.map((key) => [key, restored.params[key]]),
      ),
    ).toEqual({
      watercolorGamma: defaultWatercolorFormsControls.gamma,
      watercolorContrast: defaultWatercolorFormsControls.contrast,
      watercolorPivot: defaultWatercolorFormsControls.pivot,
      watercolorFormDetail: defaultWatercolorFormsControls.formDetail,
      watercolorColorSensitivity:
        defaultWatercolorFormsControls.colorSensitivity,
      watercolorBoundaryStrength:
        defaultWatercolorFormsControls.boundaryStrength,
      watercolorBoundarySmoothing:
        defaultWatercolorFormsControls.boundarySmoothing,
    })
    expect(
      Object.fromEntries(
        watercolorKeys.map((key) => [key, randomized[key]]),
      ),
    ).toEqual({
      watercolorGamma: 0.11,
      watercolorContrast: 0.22,
      watercolorPivot: 0.33,
      watercolorFormDetail: 0.44,
      watercolorColorSensitivity: 0.55,
      watercolorBoundaryStrength: 0.66,
      watercolorBoundarySmoothing: 0.77,
    })
    expect(roll).toBe(watercolorKeys.length)
    expect(randomized.toneGamma).toBe(restored.params.toneGamma)
    expect(randomized.toneContrast).toBe(restored.params.toneContrast)
    expect(randomized.tonePivot).toBe(restored.params.tonePivot)
  })

  it('reconciles, randomizes, and locks both Detail controls through the ordinary schema spine', () => {
    const schema = createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)
    const legacyParams = defaultParams(schema)
    delete legacyParams.detailSensitivity
    delete legacyParams.detailInfluence

    const restored = applyPreset(schema, {
      version: 1,
      sketch: 'photo-scribble',
      name: 'legacy-without-detail-sensitivity',
      seed: 'legacy-seed',
      params: legacyParams,
      locks: [],
    })
    const randomized = randomize(
      schema,
      restored.params,
      new Set(
        Object.keys(schema).filter(
          (key) => key !== 'detailSensitivity' && key !== 'detailInfluence',
        ),
      ),
      () => 0.25,
    )
    const locked = randomize(
      schema,
      restored.params,
      new Set(Object.keys(schema)),
      () => {
        throw new Error('locked controls must not consume randomness')
      },
    )

    expect(restored.params.detailSensitivity).toBe(0.5)
    expect(restored.params.detailInfluence).toBe(0)
    expect(randomized.detailSensitivity).toBe(0.25)
    expect(randomized.detailInfluence).toBe(0.25)
    expect(locked.detailSensitivity).toBe(0.5)
    expect(locked.detailInfluence).toBe(0)
  })

  it('resolves prepared detail by exact asset and definition identity and ignores tone controls', () => {
    const prepared: PreparedImageDetailAnalysis = {
      definitionId: IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
      sourceWidth: 1,
      sourceHeight: 1,
      gridWidth: 1,
      gridHeight: 1,
      data: Float64Array.of(0.25),
    }
    const lookup = vi.fn(
      (
        assetId: string,
        definitionId: typeof IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
      ) =>
        assetId === SELECTED_FIXTURE_LOOKUP_KEY &&
        definitionId === IMAGE_DETAIL_ANALYSIS_DEFINITION_ID
          ? prepared
          : undefined,
    )
    const env: SketchEnvironment = {
      imageAssets: vi.fn(() => FIXTURE_PIXELS),
      getPreparedImageDetailAnalysis: lookup,
    }
    const schema = createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)
    const selected = params({
      imageAsset: SELECTED_FIXTURE_LOOKUP_KEY,
      detailSensitivity: 1,
      toneGamma: 0,
      toneContrast: 1,
      tonePivot: 0,
    })
    const direct = createPhotoScribbleDetailField(selected, FRAME, schema, env)
    const toneChanged = createPhotoScribbleDetailField(
      {
        ...selected,
        toneGamma: 1,
        toneContrast: 0,
        tonePivot: 1,
      },
      FRAME,
      schema,
      env,
    )
    const throughSketch = createPhotoScribble(
      HEADLESS_FIXTURE_LOOKUP_KEY,
    ).generateDetailField?.(selected, FRAME, env)

    expect(direct.sample([10, 5])).toBe(0.25 ** 0.25)
    expect(toneChanged.sample([10, 5])).toBe(direct.sample([10, 5]))
    expect(throughSketch?.sample([10, 5])).toBe(direct.sample([10, 5]))
    expect(lookup).toHaveBeenCalledTimes(3)
    expect(lookup).toHaveBeenCalledWith(
      SELECTED_FIXTURE_LOOKUP_KEY,
      IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
    )
    expect(env.imageAssets).not.toHaveBeenCalled()
  })

  it('reuses the already-normalized image Detail Field at exact identity sensitivity', () => {
    const prepared: PreparedImageDetailAnalysis = {
      definitionId: IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
      sourceWidth: 1,
      sourceHeight: 1,
      gridWidth: 1,
      gridHeight: 1,
      data: Float64Array.of(0.25),
    }
    const schema = createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)
    const field = createPhotoScribbleDetailField(
      params({ detailSensitivity: 0.5 }),
      FRAME,
      schema,
      {
        imageAssets: () => FIXTURE_PIXELS,
        getPreparedImageDetailAnalysis: () => prepared,
      },
    )

    expect(createImageDetailFieldMock).toHaveBeenCalledOnce()
    expect(field).toBe(createImageDetailFieldMock.mock.results[0]!.value)
  })

  it('returns a safe zero Detail Field when no prepared analysis is resolved', () => {
    const schema = createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)
    const field = createPhotoScribbleDetailField(params(), FRAME, schema)

    expect(field.sample([10, 5])).toBe(0)
  })

  it('keeps the Detail capability Photo-only', () => {
    expect(
      createPhotoScribble(HEADLESS_FIXTURE_LOOKUP_KEY).generateDetailField,
    ).toBeTypeOf('function')
    expect(toneCalibration.generateDetailField).toBeUndefined()
    expect(scribbleMoon.generateDetailField).toBeUndefined()
  })

  it('exports the named production Sketch with its opaque bundled default', () => {
    expect(photoScribble.id).toBe('photo-scribble')
    expect(photoScribble.name).toBe('Photo Scribble')
    expect(photoScribble.schema.imageAsset).toEqual({
      kind: 'image-asset',
      default: PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID,
    })
    expect(PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID).toBe(
      'pinecone-4330aa0314f7',
    )
  })

  it('passes the selected lookup key verbatim and defaults only a non-string value', () => {
    const lookup = vi.fn((key: string) =>
      key === SELECTED_FIXTURE_LOOKUP_KEY || key === HEADLESS_FIXTURE_LOOKUP_KEY
        ? FIXTURE_PIXELS
        : undefined,
    )
    const env = environment(lookup)
    const schema = createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)

    createPhotoScribbleSource(
      params({ imageAsset: SELECTED_FIXTURE_LOOKUP_KEY }),
      FRAME,
      schema,
      env,
    )
    createPhotoScribbleSource(
      params({ imageAsset: 42 }),
      FRAME,
      schema,
      env,
    )

    expect(lookup).toHaveBeenNthCalledWith(1, SELECTED_FIXTURE_LOOKUP_KEY)
    expect(lookup).toHaveBeenNthCalledWith(2, HEADLESS_FIXTURE_LOOKUP_KEY)
  })

  it('shares the same adjusted source semantics with Tone reference and Scribble', () => {
    const env = environment()
    const schema = createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)
    const adjusted = params({ toneGamma: 0.75, toneContrast: 0.25 })
    const direct = createPhotoScribbleSource(adjusted, FRAME, schema, env)

    generatePhotoScribble(adjusted, 'seed', FRAME, schema, undefined, env)
    const consumed = scribbleStrategyMock.mock.calls[0]![0].source
    const sketchSource = createPhotoScribble(
      HEADLESS_FIXTURE_LOOKUP_KEY,
    ).generateToneSource?.(adjusted, FRAME, env)
    const points = [
      [5, 5],
      [10, 5],
      [15, 5],
    ] as const

    for (const point of points) {
      expect(consumed.toneField.sample(point)).toBe(
        direct.toneField.sample(point),
      )
      expect(consumed.shadingMask.sample(point)).toBe(
        direct.shadingMask.sample(point),
      )
      expect(sketchSource?.toneField.sample(point)).toBe(
        direct.toneField.sample(point),
      )
      expect(sketchSource?.shadingMask.sample(point)).toBe(
        direct.shadingMask.sample(point),
      )
    }
  })

  it('applies Photo Scribble gamma then contrast to raster tone only', () => {
    const env = environment()
    const schema = createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)
    const controls = { toneGamma: 0.75, toneContrast: 0.25, tonePivot: 0.35 }
    const source = createPhotoScribbleSource(
      params(controls),
      FRAME,
      schema,
      env,
    )
    const raster = createRasterToneSource(FIXTURE_PIXELS, FRAME)
    const point = [10, 5] as const
    const rawTone = raster.toneField.sample(point)

    expect(source.toneField.sample(point)).toBe(
      applyPhotoToneControls(rawTone, controls),
    )
    expect(source.toneField.sample(point)).not.toBe(rawTone)
    expect(source.shadingMask.sample(point)).toBe(
      raster.shadingMask.sample(point),
    )
  })

  it('passes the six Scribble controls and Seed to the Strategy', () => {
    const schema = createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)
    generatePhotoScribble(
      params({
        pathDensity: 2,
        scribbleScale: 0.5,
        momentum: 0.25,
        chaos: 0.75,
        toneFidelity: 0.4,
        stopPoint: 50,
      }),
      'routing-seed',
      FRAME,
      schema,
      undefined,
      environment(),
    )

    expect(scribbleStrategyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        frame: FRAME,
        seed: 'routing-seed',
        controls: {
          pathDensity: 2,
          scribbleScale: 0.5,
          momentum: 0.25,
          chaos: 0.75,
          toneFidelity: 0.4,
          stopPoint: 50,
        },
      }),
    )
  })

  it('omits local scale and prepared analysis lookup at exact zero influence', () => {
    const schema = createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)
    const preparedLookup = vi.fn(() => {
      throw new Error('zero influence must not request prepared analysis')
    })

    generatePhotoScribble(
      params({ detailInfluence: 0 }),
      'uniform-seed',
      FRAME,
      schema,
      undefined,
      {
        imageAssets: () => FIXTURE_PIXELS,
        getPreparedImageDetailAnalysis: preparedLookup,
      },
    )

    expect(scribbleStrategyMock.mock.calls[0]![0]).not.toHaveProperty(
      'scaleField',
    )
    expect(preparedLookup).not.toHaveBeenCalled()
  })

  it('requires exact prepared analysis before positive-influence generation', () => {
    const schema = createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)
    const imageAssets = vi.fn(() => FIXTURE_PIXELS)
    const preparedLookup = vi.fn(() => undefined)

    expect(() =>
      generatePhotoScribble(
        params({ detailInfluence: 0.5 }),
        'missing-detail',
        FRAME,
        schema,
        undefined,
        {
          imageAssets,
          getPreparedImageDetailAnalysis: preparedLookup,
        },
      ),
    ).toThrowError(
      'Photo Scribble requires prepared image-detail analysis when Detail influence is positive',
    )
    expect(preparedLookup).toHaveBeenCalledWith(
      HEADLESS_FIXTURE_LOOKUP_KEY,
      IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
    )
    expect(imageAssets).not.toHaveBeenCalled()
    expect(scribbleStrategyMock).not.toHaveBeenCalled()
  })

  it('routes sensitivity-adjusted local scale independently of tone controls', () => {
    const schema = createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)
    const prepared: PreparedImageDetailAnalysis = {
      definitionId: IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
      sourceWidth: 1,
      sourceHeight: 1,
      gridWidth: 1,
      gridHeight: 1,
      data: Float64Array.of(0.5),
    }
    const env: SketchEnvironment = {
      imageAssets: () => FIXTURE_PIXELS,
      getPreparedImageDetailAnalysis: () => prepared,
    }
    const base = params({
      detailInfluence: 1,
      detailSensitivity: 0.5,
      scribbleScale: 2,
      toneGamma: 0,
      toneContrast: 1,
      tonePivot: 0,
    })

    generatePhotoScribble(base, 'detail-scale', FRAME, schema, undefined, env)
    generatePhotoScribble(
      { ...base, toneGamma: 1, toneContrast: 0, tonePivot: 1 },
      'detail-scale',
      FRAME,
      schema,
      undefined,
      env,
    )

    const firstScale = scribbleStrategyMock.mock.calls[0]![0].scaleField
    const secondScale = scribbleStrategyMock.mock.calls[1]![0].scaleField
    expect(firstScale?.sample([10, 5])).toBe(4)
    expect(secondScale?.sample([10, 5])).toBe(4)
  })

  it('emits only open black generated source paths and scalar diagnostics', () => {
    const schema = createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)
    const artwork = generatePhotoScribbleShadingArtwork(
      params(),
      'seed',
      FRAME,
      schema,
      undefined,
      environment(),
    )

    expect(artwork.scene.space).toEqual(FRAME)
    expect(artwork.scene.background).toBeUndefined()
    expect(artwork.scene.primitives).toEqual([
      {
        points: [
          [1, 2],
          [3, 4],
        ],
        closed: false,
        stroke: { color: 'black', width: 1 },
        hiddenLineRole: 'source',
      },
      {
        points: [
          [5, 6],
          [7, 8],
        ],
        closed: false,
        stroke: { color: 'black', width: 1 },
        hiddenLineRole: 'source',
      },
    ])
    expect(artwork.scene.primitives.every(({ fill }) => fill === undefined)).toBe(
      true,
    )
    expect(artwork.diagnostics).toEqual({
      termination: 'completed',
      pathLength: 2 * Math.hypot(2, 2),
      polylineCount: 2,
      penLiftCount: 1,
      fidelity: { kind: 'scribble', residualError: 0.125 },
    })
    expect(artwork).not.toHaveProperty('polylines')
    expect(artwork.diagnostics).not.toHaveProperty('polylines')
  })

  it('keeps ordinary Ink Scene and diagnostics independent of Watercolor-only values', () => {
    const schema = createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)
    const base = params()
    const changed = {
      ...base,
      watercolorGamma: 0,
      watercolorContrast: 1,
      watercolorPivot: 0.25,
      watercolorFormDetail: 0.1,
      watercolorColorSensitivity: 0.9,
      watercolorBoundaryStrength: 0.2,
      watercolorBoundarySmoothing: 0.8,
    }

    const before = generatePhotoScribbleShadingArtwork(
      base,
      'ink-isolation',
      FRAME,
      schema,
      undefined,
      environment(),
    )
    const beforeInput = scribbleStrategyMock.mock.calls[0]![0]
    const after = generatePhotoScribbleShadingArtwork(
      changed,
      'ink-isolation',
      FRAME,
      schema,
      undefined,
      environment(),
    )
    const afterInput = scribbleStrategyMock.mock.calls[1]![0]

    expect(after.scene).toEqual(before.scene)
    expect(after.diagnostics).toEqual(before.diagnostics)
    expect(afterInput.controls).toEqual(beforeInput.controls)
    expect(afterInput.seed).toBe(beforeInput.seed)
  })

  it('makes cold generate and prepared artwork use the same path-only Scene', () => {
    const sketch = createPhotoScribble(HEADLESS_FIXTURE_LOOKUP_KEY)
    const currentParams = params()
    const env = environment()
    const prepared = sketch.generateShadingArtwork?.(
      currentParams,
      'seed',
      FRAME,
      undefined,
      env,
    )
    const cold = sketch.generate(currentParams, 'seed', 123, FRAME, env)

    expect(cold).toEqual(prepared?.scene)
    expect(cold.space).toEqual(FRAME)
  })

  it('keeps the named production instance path-only', () => {
    const currentParams = defaultParams(photoScribble.schema)
    const env = environment(vi.fn(() => FIXTURE_PIXELS))
    const scene = photoScribble.generate(currentParams, 'seed', 0, FRAME, env)

    expect(scene.background).toBeUndefined()
    expect(scene.primitives).not.toHaveLength(0)
    expect(
      scene.primitives.every(
        (primitive) =>
          primitive.closed === false &&
          primitive.fill === undefined &&
          primitive.hiddenLineRole === 'source',
      ),
    ).toBe(true)
  })

  it.each([
    ['absent environment', undefined],
    ['missing lookup result', { imageAssets: () => undefined }],
  ] as const)('fails closed to a zero source and empty Scene for %s', (_name, env) => {
    const sketch = createPhotoScribble(HEADLESS_FIXTURE_LOOKUP_KEY)
    const source = sketch.generateToneSource?.(params(), FRAME, env)
    const scene = sketch.generate(params(), 'seed', 0, FRAME, env)

    expect(source?.toneField.sample([10, 5])).toBe(0)
    expect(source?.shadingMask.sample([10, 5])).toBe(0)
    expect(scene).toEqual({ space: FRAME, primitives: [] })
  })
})
