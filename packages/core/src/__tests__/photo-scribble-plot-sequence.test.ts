import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import type { DecodedPixels, SketchEnvironment } from '../imageAssets'
import {
  createPlotStageGeneratorInput,
  invokePlotStageGenerator,
  projectPlotSequenceRegistrationIdentity,
  projectPlotStageParams,
  projectPlotStagePreparationIdentity,
  validatePlotSequence,
  type PlotStageGenerator,
  type PlotStageGeneratorInput,
} from '../plotSequence'
import {
  createPhotoScribble,
  createPhotoScribbleSchema,
  generatePhotoScribbleShadingArtwork,
  generatePhotoScribbleWatercolorStage,
  photoScribble,
  photoScribblePlotSequence,
} from '../sketches/photo-scribble'
import { defaultParams, type Params } from '../sketch'
import type { WatercolorFormsControls } from '../sketches/watercolor-forms/controls'
import { generateWatercolorForms } from '../sketches/watercolor-forms/generator'
import { createWatercolorForms } from '../sketches/watercolor-forms'

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

function photoParams(extra: Readonly<Params> = {}): Params {
  return {
    ...defaultParams(createPhotoScribbleSchema(SELECTED_ID)),
    watercolorGamma: CONTROLS.gamma,
    watercolorContrast: CONTROLS.contrast,
    watercolorPivot: CONTROLS.pivot,
    watercolorFormDetail: CONTROLS.formDetail,
    watercolorColorSensitivity: CONTROLS.colorSensitivity,
    watercolorBoundaryStrength: CONTROLS.boundaryStrength,
    watercolorBoundarySmoothing: CONTROLS.boundarySmoothing,
    ...extra,
  }
}

describe('Photo Scribble Plot Sequence declaration', () => {
  it('declares exact physical order, source metadata, dependencies, and complete ownership', () => {
    const schema = createPhotoScribbleSchema(SELECTED_ID)
    const declaration = photoScribblePlotSequence

    expect(() => validatePlotSequence(declaration, schema)).not.toThrow()
    expect(declaration.sharedParameters).toEqual([
      { schemaKey: 'imageAsset', key: 'imageAsset' },
    ])
    expect(
      declaration.stages.map(({ id, name, source, dependencies }) => ({
        id,
        name,
        source: {
          kind: source.kind,
          generatorId: source.generatorId,
        },
        dependencies,
      })),
    ).toEqual([
      {
        id: 'watercolor-forms',
        name: 'Watercolor Forms',
        source: { kind: 'generator', generatorId: 'watercolor-forms' },
        dependencies: { usesSeed: false, usesTime: false },
      },
      {
        id: 'ink-scribble',
        name: 'Ink Scribble',
        source: { kind: 'primary', generatorId: 'photo-scribble' },
        dependencies: { usesSeed: true, usesTime: false },
      },
    ])
    expect(
      declaration.stages.filter(({ source }) => source.kind === 'primary'),
    ).toHaveLength(1)
    expect(declaration.stages[0]?.parameters).toEqual([
      { schemaKey: 'watercolorGamma', key: 'gamma' },
      { schemaKey: 'watercolorContrast', key: 'contrast' },
      { schemaKey: 'watercolorPivot', key: 'pivot' },
      { schemaKey: 'watercolorFormDetail', key: 'formDetail' },
      {
        schemaKey: 'watercolorColorSensitivity',
        key: 'colorSensitivity',
      },
      { schemaKey: 'watercolorBoundaryStrength', key: 'boundaryStrength' },
      {
        schemaKey: 'watercolorBoundarySmoothing',
        key: 'boundarySmoothing',
      },
    ])
    expect(declaration.stages[1]?.parameters).toEqual([
      { schemaKey: 'toneContrast', key: 'toneContrast' },
      { schemaKey: 'tonePivot', key: 'tonePivot' },
      { schemaKey: 'toneGamma', key: 'toneGamma' },
      { schemaKey: 'detailSensitivity', key: 'detailSensitivity' },
      { schemaKey: 'detailInfluence', key: 'detailInfluence' },
      { schemaKey: 'pathDensity', key: 'pathDensity' },
      { schemaKey: 'scribbleScale', key: 'scribbleScale' },
      { schemaKey: 'momentum', key: 'momentum' },
      { schemaKey: 'chaos', key: 'chaos' },
      { schemaKey: 'toneFidelity', key: 'toneFidelity' },
      { schemaKey: 'stopPoint', key: 'stopPoint' },
    ])

    const ownedKeys = [
      ...declaration.sharedParameters,
      ...declaration.stages.flatMap(({ parameters }) => parameters),
    ].map(({ schemaKey }) => schemaKey)
    expect(new Set(ownedKeys)).toEqual(new Set(Object.keys(schema)))
    expect(ownedKeys).toHaveLength(Object.keys(schema).length)
  })

  it('attaches the equivalent declaration to factory and named instances with exact callback identity', () => {
    const factorySketch = createPhotoScribble('factory-asset')
    const watercolorStage = photoScribblePlotSequence.stages[0]

    expect(factorySketch.plotSequence).toBe(photoScribblePlotSequence)
    expect(photoScribble.plotSequence).toBe(photoScribblePlotSequence)
    expect(() =>
      validatePlotSequence(factorySketch.plotSequence!, factorySketch.schema),
    ).not.toThrow()
    expect(() =>
      validatePlotSequence(photoScribble.plotSequence!, photoScribble.schema),
    ).not.toThrow()
    expect(watercolorStage?.source.kind).toBe('generator')
    if (watercolorStage?.source.kind !== 'generator') {
      throw new Error('expected generated Watercolor Stage')
    }
    expect(watercolorStage.source.generate).toBe(
      generatePhotoScribbleWatercolorStage,
    )
  })

  it('isolates shared registration and each Stage projection from aliases and sibling values', () => {
    const schema = createPhotoScribbleSchema(SELECTED_ID)
    const frame = Object.freeze({ width: 640, height: 480 })
    const params = photoParams({
      toneGamma: 0.2,
      watercolorGamma: 0.8,
      gamma: 0.1,
      unexpected: 'ignored',
    })

    const registration = projectPlotSequenceRegistrationIdentity(
      schema,
      photoScribblePlotSequence,
      params,
      frame,
    )
    const watercolor = projectPlotStageParams(
      schema,
      photoScribblePlotSequence,
      'watercolor-forms',
      params,
    )
    const ink = projectPlotStageParams(
      schema,
      photoScribblePlotSequence,
      'ink-scribble',
      params,
    )

    expect(registration).toEqual({
      params: { imageAsset: SELECTED_ID },
      frame,
    })
    expect(registration.frame).toBe(frame)
    expect(watercolor).toEqual({
      imageAsset: SELECTED_ID,
      ...CONTROLS,
      gamma: 0.8,
    })
    expect(ink).toEqual({
      imageAsset: SELECTED_ID,
      toneContrast: 0.5,
      tonePivot: 0.5,
      toneGamma: 0.2,
      detailSensitivity: 0.5,
      detailInfluence: 0,
      pathDensity: 1,
      scribbleScale: 1,
      momentum: 0.75,
      chaos: 0.25,
      toneFidelity: 0.9,
      stopPoint: 100,
    })
    expect(watercolor).not.toHaveProperty('watercolorGamma')
    expect(watercolor).not.toHaveProperty('toneGamma')
    expect(ink).not.toHaveProperty('watercolorGamma')
    expect(ink).not.toHaveProperty('unexpected')
  })

  it('passes unchanged Sequence seed/time to generation while dependency identities stay authored', () => {
    const schema = createPhotoScribbleSchema(SELECTED_ID)
    const params = photoParams()
    const environment = environmentFor(() => transition())
    const generatorInput = createPlotStageGeneratorInput(
      schema,
      photoScribblePlotSequence,
      'watercolor-forms',
      params,
      'sequence-seed',
      123,
      FRAME,
      environment,
    )
    const watercolorIdentity = projectPlotStagePreparationIdentity(
      schema,
      photoScribblePlotSequence,
      'watercolor-forms',
      params,
      'sequence-seed',
      123,
      FRAME,
    )
    const inkIdentity = projectPlotStagePreparationIdentity(
      schema,
      photoScribblePlotSequence,
      'ink-scribble',
      params,
      'ink-seed-a',
      123,
      FRAME,
    )
    const reseededInkIdentity = projectPlotStagePreparationIdentity(
      schema,
      photoScribblePlotSequence,
      'ink-scribble',
      params,
      'ink-seed-b',
      999,
      FRAME,
    )

    expect(generatorInput.seed).toBe('sequence-seed')
    expect(generatorInput.t).toBe(123)
    expect(generatorInput.environment).toBe(environment)
    expect(watercolorIdentity).not.toHaveProperty('seed')
    expect(watercolorIdentity).not.toHaveProperty('t')
    expect(inkIdentity).toMatchObject({ seed: 'ink-seed-a' })
    expect(inkIdentity).not.toHaveProperty('t')
    expect(reseededInkIdentity.params).toEqual(inkIdentity.params)
    expect(reseededInkIdentity.frame).toBe(inkIdentity.frame)
    expect(reseededInkIdentity.seed).not.toBe(inkIdentity.seed)
  })

  it('invokes Watercolor generically with parity to direct and independent generation', () => {
    const pixels = transition()
    const environment = environmentFor((id) =>
      id === SELECTED_ID ? pixels : undefined,
    )
    const schema = createPhotoScribbleSchema(SELECTED_ID)
    const params = photoParams()
    const direct = generateWatercolorForms({
      pixels,
      frame: FRAME,
      controls: CONTROLS,
    }).scene
    const invoked = invokePlotStageGenerator(
      schema,
      photoScribblePlotSequence,
      'watercolor-forms',
      params,
      'sequence-seed',
      321,
      FRAME,
      environment,
    )
    const independent = createWatercolorForms(SELECTED_ID).generate(
      {
        imageAsset: SELECTED_ID,
        ...CONTROLS,
      },
      'independent-seed',
      654,
      FRAME,
      environment,
    )

    expect(invoked).toEqual(direct)
    expect(independent).toEqual(direct)
    expect(invoked.primitives.length).toBeGreaterThan(0)
  })

  it('leaves ordinary Ink output and diagnostics unchanged by declaration attachment or Watercolor values', () => {
    const sketch = createPhotoScribble(SELECTED_ID)
    const schema = sketch.schema
    const environment = environmentFor((id) =>
      id === SELECTED_ID ? transition() : undefined,
    )
    const params = photoParams()
    const watercolorChanged = photoParams({
      watercolorGamma: 1,
      watercolorContrast: 0,
      watercolorPivot: 0,
      watercolorFormDetail: 0,
      watercolorColorSensitivity: 1,
      watercolorBoundaryStrength: 1,
      watercolorBoundarySmoothing: 0,
    })
    const direct = generatePhotoScribbleShadingArtwork(
      params,
      'ink-seed',
      FRAME,
      schema,
      undefined,
      environment,
    )
    const ordinary = sketch.generateShadingArtwork!(
      params,
      'ink-seed',
      FRAME,
      undefined,
      environment,
    )
    const changed = sketch.generateShadingArtwork!(
      watercolorChanged,
      'ink-seed',
      FRAME,
      undefined,
      environment,
    )

    expect(ordinary).toEqual(direct)
    expect(
      sketch.generate(params, 'ink-seed', 99, FRAME, environment),
    ).toEqual(direct.scene)
    expect(changed.scene).toEqual(ordinary.scene)
    expect(changed.diagnostics).toEqual(ordinary.diagnostics)
  })
})

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
