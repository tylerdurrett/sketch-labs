import { beforeEach, describe, expect, it, vi } from 'vitest'

const scribbleStrategySpy = vi.hoisted(() => vi.fn())

vi.mock('../scribbleStrategy/index', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../scribbleStrategy/index')
  >()
  scribbleStrategySpy.mockImplementation(actual.scribbleStrategy)
  return { ...actual, scribbleStrategy: scribbleStrategySpy }
})

import type { DecodedPixels, SketchEnvironment } from '../imageAssets'
import type { PlotProfile } from '../plotProfile'
import { applyPreset, deserialize, makePreset, serialize } from '../preset'
import { defaultParams, type Params } from '../sketch'
import type {
  ScribbleResult,
  ScribbleStrategyInput,
} from '../scribbleStrategy/index'
import {
  createPhotoScribble,
  createPhotoScribbleSource,
  createPhotoScribbleSchema,
  generatePhotoScribble,
} from '../sketches/photo-scribble'
import type { ToneSource } from '../shadingFields'
import type { Point } from '../types'

const HEADLESS_FIXTURE_LOOKUP_KEY = 'headless-contract-fixture'
const AUTHORED_FIXTURE_LOOKUP_KEY = 'authored-contract-fixture'
const FRAME = { width: 48, height: 32 }
const SOURCE_SAMPLE_POINTS = [
  [0, 0],
  [3, 0],
  [12, 8],
  [24, 16],
  [36, 24],
  [45, 31],
  [48, 32],
] as const satisfies readonly Point[]

const FIXTURE_PIXELS: DecodedPixels = {
  width: 4,
  height: 3,
  data: Uint8Array.from([
    0, 0, 0, 255,
    96, 96, 96, 255,
    255, 255, 255, 255,
    255, 0, 0, 128,
    0, 0, 255, 255,
    32, 32, 32, 255,
    0, 255, 0, 192,
    0, 0, 0, 255,
    255, 255, 255, 0,
    128, 128, 128, 64,
    255, 0, 255, 255,
    16, 16, 16, 255,
  ]),
}

const CHANGED_PIXELS: DecodedPixels = {
  width: FIXTURE_PIXELS.width,
  height: FIXTURE_PIXELS.height,
  data: Uint8Array.from([
    255, 255, 255, 255,
    32, 32, 32, 255,
    0, 0, 0, 255,
    0, 255, 255, 128,
    255, 255, 0, 255,
    224, 224, 224, 255,
    255, 0, 255, 192,
    255, 255, 255, 255,
    0, 0, 0, 0,
    64, 64, 64, 64,
    0, 255, 0, 255,
    240, 240, 240, 255,
  ]),
}

const PROFILE: PlotProfile = {
  width: FRAME.width,
  height: FRAME.height,
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
  includeFrame: true,
  toolWidthMillimeters: 0.3,
}

function environmentFor(pixels: Readonly<DecodedPixels>): SketchEnvironment {
  return {
    imageAssets: (id) =>
      id === HEADLESS_FIXTURE_LOOKUP_KEY ? pixels : undefined,
  }
}

function fastParams(overrides: Params = {}): Params {
  return {
    ...defaultParams(createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)),
    pathDensity: 0.5,
    scribbleScale: 2,
    momentum: 0.5,
    chaos: 0.75,
    toneFidelity: 0,
    ...overrides,
  }
}

function sourceSnapshot(
  input: ScribbleStrategyInput,
  points: readonly Readonly<Point>[] = SOURCE_SAMPLE_POINTS,
) {
  return fieldSnapshot(input.source, points)
}

function fieldSnapshot(
  source: ToneSource,
  points: readonly Readonly<Point>[] = SOURCE_SAMPLE_POINTS,
) {
  return points.map((point) => ({
    point,
    tone: source.toneField.sample(point),
    permission: source.shadingMask.sample(point),
  }))
}

function capturedInput(call: number): ScribbleStrategyInput {
  return scribbleStrategySpy.mock.calls[call]![0] as ScribbleStrategyInput
}

function capturedResult(call: number): ScribbleResult {
  return scribbleStrategySpy.mock.results[call]!.value as ScribbleResult
}

function objectGraphContains(root: unknown, target: unknown): boolean {
  const seen = new Set<unknown>()
  const visit = (value: unknown): boolean => {
    if (value === target) return true
    if (
      (typeof value !== 'object' && typeof value !== 'function') ||
      value === null ||
      seen.has(value)
    ) {
      return false
    }
    seen.add(value)
    return Reflect.ownKeys(value).some((key) =>
      visit((value as Record<PropertyKey, unknown>)[key]),
    )
  }
  return visit(root)
}

beforeEach(() => {
  scribbleStrategySpy.mockClear()
})

describe('Photo Scribble black-box contract', () => {
  it('reconciles legacy params to identity sensitivity without changing geometry', () => {
    const sketch = createPhotoScribble(HEADLESS_FIXTURE_LOOKUP_KEY)
    const legacyParams = fastParams()
    delete legacyParams.detailSensitivity
    const environment = environmentFor(FIXTURE_PIXELS)

    const before = sketch.generateScribbleArtwork!(
      legacyParams,
      'legacy-detail-sensitivity',
      FRAME,
      undefined,
      environment,
    )
    const beforeResult = capturedResult(0)
    const restored = applyPreset(sketch.schema, {
      version: 1,
      sketch: sketch.id,
      name: 'legacy-detail-sensitivity',
      seed: 'legacy-detail-sensitivity',
      params: legacyParams,
      locks: [],
    })
    const after = sketch.generateScribbleArtwork!(
      restored.params,
      restored.seed,
      FRAME,
      undefined,
      environment,
    )
    const afterResult = capturedResult(1)

    expect(restored.params.detailSensitivity).toBe(0.5)
    expect(afterResult.polylines).toEqual(beforeResult.polylines)
    expect(after.diagnostics).toEqual(before.diagnostics)
    expect(after.scene).toEqual(before.scene)
  })

  it('repeats termination, diagnostics, Scene, and polylines exactly', () => {
    const sketch = createPhotoScribble(HEADLESS_FIXTURE_LOOKUP_KEY)
    const params = fastParams()
    const environment = environmentFor(FIXTURE_PIXELS)

    const first = sketch.generateScribbleArtwork!(
      params,
      'repeatable-photo',
      FRAME,
      undefined,
      environment,
    )
    const second = sketch.generateScribbleArtwork!(
      params,
      'repeatable-photo',
      FRAME,
      undefined,
      environment,
    )
    const firstResult = capturedResult(0)
    const secondResult = capturedResult(1)

    expect(firstResult.polylines.length).toBeGreaterThan(0)
    expect(secondResult.termination).toBe(firstResult.termination)
    expect(secondResult.residualError).toBe(firstResult.residualError)
    expect(secondResult.polylines).toEqual(firstResult.polylines)
    expect(second.diagnostics).toEqual(first.diagnostics)
    expect(second.scene).toEqual(first.scene)
    expect(first.scene.primitives.map(({ points }) => points)).toEqual(
      firstResult.polylines,
    )
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('reproduces Tone, Shading, termination, and geometry after a v2 Preset round-trip', () => {
    const sketch = createPhotoScribble(HEADLESS_FIXTURE_LOOKUP_KEY)
    const params = fastParams({
      imageAsset: AUTHORED_FIXTURE_LOOKUP_KEY,
      toneContrast: 0.25,
      tonePivot: 0.3,
      toneGamma: 0.75,
    })
    const seed = 'persisted-photo'
    const environment: SketchEnvironment = {
      imageAssets: (id) => {
        if (id === AUTHORED_FIXTURE_LOOKUP_KEY) return FIXTURE_PIXELS
        if (id === HEADLESS_FIXTURE_LOOKUP_KEY) return CHANGED_PIXELS
        return undefined
      },
    }

    expect(environment.imageAssets(AUTHORED_FIXTURE_LOOKUP_KEY)).toBe(
      FIXTURE_PIXELS,
    )
    expect(environment.imageAssets(HEADLESS_FIXTURE_LOOKUP_KEY)).toBe(
      CHANGED_PIXELS,
    )

    const before = sketch.generateScribbleArtwork!(
      params,
      seed,
      FRAME,
      undefined,
      environment,
    )
    const beforeInput = capturedInput(0)
    const beforeResult = capturedResult(0)

    const loaded = deserialize(
      JSON.parse(
        JSON.stringify(
          serialize(
            makePreset(
              sketch.id,
              'persisted-photo',
              params,
              seed,
              new Set(['imageAsset']),
              PROFILE,
            ),
          ),
        ),
      ),
    )
    const restored = applyPreset(sketch.schema, loaded)
    const after = sketch.generateScribbleArtwork!(
      restored.params,
      restored.seed,
      FRAME,
      undefined,
      environment,
    )
    const afterInput = capturedInput(1)
    const afterResult = capturedResult(1)
    const defaultSource = createPhotoScribbleSource(
      fastParams(),
      FRAME,
      sketch.schema,
      environment,
    )

    expect(restored.params).toEqual(params)
    expect(restored.params.imageAsset).toBe(AUTHORED_FIXTURE_LOOKUP_KEY)
    expect(restored.profile).toEqual(PROFILE)
    expect(sourceSnapshot(afterInput)).toEqual(sourceSnapshot(beforeInput))
    expect(sourceSnapshot(afterInput)).not.toEqual(fieldSnapshot(defaultSource))
    expect(afterResult.termination).toBe(beforeResult.termination)
    expect(afterResult.residualError).toBe(beforeResult.residualError)
    expect(afterResult.polylines).toEqual(beforeResult.polylines)
    expect(after.diagnostics).toEqual(before.diagnostics)
    expect(after.scene).toEqual(before.scene)
  })

  it('changes routing by Seed alone while source snapshots remain exact', () => {
    const schema = createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)
    const params = fastParams()
    const environment = environmentFor(FIXTURE_PIXELS)

    const first = generatePhotoScribble(
      params,
      'route-a',
      FRAME,
      schema,
      undefined,
      environment,
    )
    const second = generatePhotoScribble(
      params,
      'route-b',
      FRAME,
      schema,
      undefined,
      environment,
    )

    expect(first.polylines.length).toBeGreaterThan(0)
    expect(second.polylines.length).toBeGreaterThan(0)
    expect(second.polylines).not.toEqual(first.polylines)
    expect(capturedInput(0).seed).toBe('route-a')
    expect(capturedInput(1).seed).toBe('route-b')
    expect(sourceSnapshot(capturedInput(1))).toEqual(
      sourceSnapshot(capturedInput(0)),
    )
  })

  it('keeps source snapshots independent of Scribble-only controls', () => {
    const schema = createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)
    const environment = environmentFor(FIXTURE_PIXELS)
    const base = fastParams()
    const changed = fastParams({
      pathDensity: 1,
      scribbleScale: 1.5,
      momentum: 1,
      chaos: 0,
      toneFidelity: 0.2,
    })

    generatePhotoScribble(
      base,
      'control-source',
      FRAME,
      schema,
      undefined,
      environment,
    )
    generatePhotoScribble(
      changed,
      'control-source',
      FRAME,
      schema,
      undefined,
      environment,
    )

    expect(capturedInput(1).controls).not.toEqual(capturedInput(0).controls)
    expect(sourceSnapshot(capturedInput(1))).toEqual(
      sourceSnapshot(capturedInput(0)),
    )
  })

  it('maps wide and tall Composition Frames deterministically', () => {
    const schema = createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)
    const params = fastParams()
    const environment = environmentFor(FIXTURE_PIXELS)
    const wide = { width: 80, height: 40 }
    const tall = { width: 40, height: 80 }
    const widePoints = [
      [0, 20],
      [14, 20],
      [40, 20],
      [66, 20],
      [80, 20],
    ] as const satisfies readonly Point[]
    const tallPoints = [
      [20, 0],
      [20, 24],
      [20, 40],
      [20, 56],
      [20, 80],
    ] as const satisfies readonly Point[]

    const wideFirst = createPhotoScribbleSource(
      params,
      wide,
      schema,
      environment,
    )
    const wideSecond = createPhotoScribbleSource(
      params,
      wide,
      schema,
      environment,
    )
    const tallFirst = createPhotoScribbleSource(
      params,
      tall,
      schema,
      environment,
    )
    const tallSecond = createPhotoScribbleSource(
      params,
      tall,
      schema,
      environment,
    )

    expect(fieldSnapshot(wideSecond, widePoints)).toEqual(
      fieldSnapshot(wideFirst, widePoints),
    )
    expect(fieldSnapshot(tallSecond, tallPoints)).toEqual(
      fieldSnapshot(tallFirst, tallPoints),
    )
    expect(wideFirst.shadingMask.sample(widePoints[0])).toBe(0)
    expect(wideFirst.shadingMask.sample(widePoints[2])).toBeGreaterThan(0)
    expect(wideFirst.shadingMask.sample(widePoints[4])).toBe(0)
    expect(tallFirst.shadingMask.sample(tallPoints[0])).toBe(0)
    expect(tallFirst.shadingMask.sample(tallPoints[2])).toBeGreaterThan(0)
    expect(tallFirst.shadingMask.sample(tallPoints[4])).toBe(0)
  })

  it('changes only the source when the resolved pixels change', () => {
    const schema = createPhotoScribbleSchema(HEADLESS_FIXTURE_LOOKUP_KEY)
    const params = fastParams()
    const original = createPhotoScribbleSource(
      params,
      FRAME,
      schema,
      environmentFor(FIXTURE_PIXELS),
    )
    const changed = createPhotoScribbleSource(
      params,
      FRAME,
      schema,
      environmentFor(CHANGED_PIXELS),
    )

    expect(fieldSnapshot(changed)).not.toEqual(fieldSnapshot(original))
    expect(params.imageAsset).toBe(HEADLESS_FIXTURE_LOOKUP_KEY)
  })

  it('does not expose decoded data through Strategy input or Scene output', () => {
    const sketch = createPhotoScribble(HEADLESS_FIXTURE_LOOKUP_KEY)
    const artwork = sketch.generateScribbleArtwork!(
      fastParams(),
      'no-raster-leak',
      FRAME,
      undefined,
      environmentFor(FIXTURE_PIXELS),
    )
    const input = capturedInput(0)

    expect(Object.keys(input).sort()).toEqual([
      'controls',
      'frame',
      'seed',
      'source',
    ])
    expect(Object.keys(input.source).sort()).toEqual([
      'shadingMask',
      'toneField',
    ])
    expect(objectGraphContains(input, FIXTURE_PIXELS)).toBe(false)
    expect(objectGraphContains(input, FIXTURE_PIXELS.data)).toBe(false)
    expect(objectGraphContains(artwork.scene, FIXTURE_PIXELS)).toBe(false)
    expect(objectGraphContains(artwork.scene, FIXTURE_PIXELS.data)).toBe(false)
    expect(JSON.stringify(input)).not.toMatch(
      /headless-contract-fixture|"data"|imageAsset/,
    )
    expect(JSON.stringify(artwork.scene)).not.toMatch(
      /headless-contract-fixture|"data"|toneField|shadingMask/,
    )
  })
})
