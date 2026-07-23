import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import {
  applyPreset,
  createFlowingContours,
  createFlowingContoursSchema,
  defaultFlowingContoursControls,
  defaultParams,
  defaultPencilContourControls,
  FLOWING_CONTOURS_DEFAULT_IMAGE_ASSET_ID,
  flowingContours,
  flowingContoursControlSchema,
  generateFlowingContours,
  generatePencilContour,
  makePreset,
  pencilContour,
  pencilContourControlSchema,
  type DecodedPixels,
  type FlowingContoursGenerator,
  type OutlineTarget,
  type Scene,
  type SketchEnvironment,
} from '../index'
import * as flowingContoursModule from '../sketches/flowing-contours'

const FRAME = { width: 80, height: 60 }
const DEFAULT_ID = 'default-001122334455'
const SELECTED_ID = 'selected-0123456789ab'
const OTHER_ID = 'other-abcdef012345'

function raster(
  width: number,
  height: number,
  at: (
    x: number,
    y: number,
  ) => readonly [number, number, number, number],
): DecodedPixels {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.set(at(x, y), (y * width + x) * 4)
    }
  }
  return { width, height, data }
}

function flowingBoundary(): DecodedPixels {
  return raster(80, 40, (x, y) => {
    const byte = x < 35 + y * 0.2 ? 20 : 235
    return [byte, byte, byte, 255]
  })
}

function pencilTransition(): DecodedPixels {
  return raster(8, 6, (x) => {
    const byte = x >= 4 ? 255 : 0
    return [byte, byte, byte, 255]
  })
}

function environmentFor(
  lookup: SketchEnvironment['imageAssets'],
): SketchEnvironment {
  return { imageAssets: lookup }
}

function withoutStrokeWidth(scene: Readonly<Scene>) {
  return {
    ...scene,
    primitives: scene.primitives.map(({ stroke, ...primitive }) =>
      stroke === undefined
        ? primitive
        : { ...primitive, stroke: { color: stroke.color } },
    ),
  }
}

describe('Flowing Contours registered Sketch', () => {
  it('publishes stable metadata and one managed asset plus exactly four controls', () => {
    const sketch = createFlowingContours(SELECTED_ID)

    expect(sketch.id).toBe('flowing-contours')
    expect(sketch.name).toBe('Flowing Contours')
    expect(Object.keys(sketch.schema)).toEqual([
      'imageAsset',
      'curveDetail',
      'continuity',
      'flowSmoothing',
      'minimumStrokeLength',
    ])
    expect(sketch.schema).toEqual({
      imageAsset: { kind: 'image-asset', default: SELECTED_ID },
      ...flowingContoursControlSchema,
    })
    expect(defaultParams(sketch.schema)).toEqual({
      imageAsset: SELECTED_ID,
      ...defaultFlowingContoursControls,
    })
    expect(createFlowingContoursSchema(SELECTED_ID)).toEqual(sketch.schema)
  })

  it('binds production to the stable bundled sample and exports headless APIs', () => {
    const generator: FlowingContoursGenerator = generateFlowingContours

    expect(FLOWING_CONTOURS_DEFAULT_IMAGE_ASSET_ID).toBe(
      'pinecone-4330aa0314f7',
    )
    expect(flowingContours.schema.imageAsset).toEqual({
      kind: 'image-asset',
      default: FLOWING_CONTOURS_DEFAULT_IMAGE_ASSET_ID,
    })
    expect(flowingContoursModule.generateFlowingContours).toBe(generator)
    expect(flowingContoursModule.flowingContoursControlSchema).toBe(
      flowingContoursControlSchema,
    )
    expect(flowingContoursModule.defaultFlowingContoursControls).toBe(
      defaultFlowingContoursControls,
    )
  })

  it('looks up only the exact selected asset without substitution', () => {
    const sketch = createFlowingContours(DEFAULT_ID)
    const params = {
      ...defaultParams(sketch.schema),
      imageAsset: SELECTED_ID,
    }
    const lookup = vi.fn((id: string) =>
      id === OTHER_ID ? flowingBoundary() : undefined,
    )

    expect(
      sketch.generate(params, 'seed', 1, FRAME, environmentFor(lookup)),
    ).toEqual({ space: FRAME, primitives: [] })
    expect(params.imageAsset).toBe(SELECTED_ID)
    expect(lookup.mock.calls).toEqual([[SELECTED_ID]])
  })

  it.each([
    ['absent environment', undefined],
    ['missing selected asset', environmentFor(() => undefined)],
    [
      'malformed selected pixels',
      environmentFor(() => ({
        width: 2,
        height: 2,
        data: new Uint8Array(3),
      })),
    ],
    [
      'throwing resolver',
      environmentFor(() => {
        throw new Error('asset unavailable')
      }),
    ],
  ] as const)('fails closed in the exact frame for %s', (_name, environment) => {
    const sketch = createFlowingContours(SELECTED_ID)

    expect(
      sketch.generate(
        defaultParams(sketch.schema),
        'any-seed',
        42,
        FRAME,
        environment,
      ),
    ).toEqual({ space: FRAME, primitives: [] })
  })

  it('ignores seed and time and exactly matches the headless generator', () => {
    const sketch = createFlowingContours(SELECTED_ID)
    const params = {
      imageAsset: SELECTED_ID,
      curveDetail: 1,
      continuity: 0.6,
      flowSmoothing: 0.8,
      minimumStrokeLength: 0.005,
    }
    const pixels = flowingBoundary()
    const environment = environmentFor((id) =>
      id === SELECTED_ID ? pixels : undefined,
    )
    const direct = generateFlowingContours({
      pixels,
      frame: FRAME,
      controls: {
        curveDetail: 1,
        continuity: 0.6,
        flowSmoothing: 0.8,
        minimumStrokeLength: 0.005,
      },
    }).scene

    expect(direct.primitives.length).toBeGreaterThan(0)
    expect(sketch.generate(params, 'seed-a', 0, FRAME, environment)).toEqual(
      direct,
    )
    expect(sketch.generate(params, 'seed-b', 999, FRAME, environment)).toEqual(
      direct,
    )
    expect(
      direct.primitives.every(
        (primitive) =>
          primitive.stroke?.color === 'black' &&
          primitive.fill === undefined &&
          primitive.hiddenLineRole === 'source',
      ),
    ).toBe(true)
  })

  it('retargets only stroke width and keeps physical-tool geometry invariant', () => {
    const params = {
      imageAsset: SELECTED_ID,
      curveDetail: 1,
      continuity: 0.6,
      flowSmoothing: 0.8,
      minimumStrokeLength: 0.005,
    }
    const completed = createFlowingContours(SELECTED_ID).generate(
      params,
      'ignored',
      0,
      FRAME,
      environmentFor(() => flowingBoundary()),
    )
    const targets = [
      { toolWidthMillimeters: 0.3, millimetersPerSceneUnit: 0.2 },
      { toolWidthMillimeters: 0.9, millimetersPerSceneUnit: 0.1 },
    ] as const satisfies readonly OutlineTarget[]
    const derive = flowingContours.deriveOutlineSource!
    const [first, second] = targets.map((target) =>
      derive(completed, target),
    )

    expect(completed.primitives.length).toBeGreaterThan(0)
    expect(withoutStrokeWidth(second)).toEqual(withoutStrokeWidth(first))
    for (const [index, scene] of [first, second].entries()) {
      const expectedWidth =
        targets[index]!.toolWidthMillimeters /
        targets[index]!.millimetersPerSceneUnit
      expect(
        scene.primitives.every(
          (primitive) => primitive.stroke?.width === expectedWidth,
        ),
      ).toBe(true)
    }
  })

  it('round-trips its asset and four controls through the generic Preset spine', () => {
    const schema = createFlowingContoursSchema(DEFAULT_ID)
    const params = {
      imageAsset: SELECTED_ID,
      curveDetail: 0.17,
      continuity: 0.31,
      flowSmoothing: 0.79,
      minimumStrokeLength: 0.055,
    }
    const preset = makePreset(
      'flowing-contours',
      'round-trip',
      params,
      'ignored-by-v1-geometry',
      new Set(['continuity', 'flowSmoothing']),
    )

    const applied = applyPreset(schema, preset)
    expect(applied.params).toEqual(params)
    expect(applied.seed).toBe('ignored-by-v1-geometry')
    expect(applied.locks).toEqual(['continuity', 'flowSmoothing'])
  })

  it('does not import Pencil Contour or Watercolor Forms artistic modules', () => {
    const directory = new URL('../sketches/flowing-contours/', import.meta.url)
    const imports = readdirSync(directory)
      .filter((name) => name.endsWith('.ts'))
      .flatMap((name) =>
        [...readFileSync(new URL(name, directory), 'utf8').matchAll(
          /(?:from|import)\s*['"]([^'"]+)['"]/g,
        )].map((match) => match[1]),
      )

    expect(
      imports.filter(
        (path) =>
          path.includes('/pencil-contour') ||
          path.includes('/watercolor-forms'),
      ),
    ).toEqual([])
  })
})

describe('Pencil Contour registration regression', () => {
  it('keeps identity, schema defaults, Presets, and headless geometry unchanged', () => {
    expect(pencilContour.id).toBe('pencil-contour')
    expect(pencilContour.name).toBe('Pencil Contour')
    expect(Object.keys(pencilContour.schema)).toEqual([
      'imageAsset',
      'gamma',
      'contrast',
      'pivot',
      'contourDetail',
      'contourSmoothing',
    ])
    expect(defaultParams(pencilContour.schema)).toEqual({
      imageAsset: 'pinecone-4330aa0314f7',
      ...defaultPencilContourControls,
    })
    expect(pencilContour.schema).toEqual({
      imageAsset: {
        kind: 'image-asset',
        default: 'pinecone-4330aa0314f7',
      },
      ...pencilContourControlSchema,
    })

    const params = {
      imageAsset: SELECTED_ID,
      gamma: 0.8,
      contrast: 0.2,
      pivot: 0.4,
      contourDetail: 0.7,
      contourSmoothing: 1,
    }
    const preset = makePreset(
      'pencil-contour',
      'registration-regression',
      params,
      'existing-seed',
      new Set(['contourSmoothing']),
    )
    expect(applyPreset(pencilContour.schema, preset)).toMatchObject({
      params,
      seed: 'existing-seed',
      locks: ['contourSmoothing'],
    })

    const pixels = pencilTransition()
    const registered = pencilContour.generate(
      params,
      'ignored-seed',
      91,
      FRAME,
      environmentFor((id) => (id === SELECTED_ID ? pixels : undefined)),
    )
    const headless = generatePencilContour({
      pixels,
      frame: FRAME,
      controls: {
        gamma: 0.8,
        contrast: 0.2,
        pivot: 0.4,
        contourDetail: 0.7,
        contourSmoothing: 1,
      },
    }).scene

    expect(registered).toEqual(headless)
    expect(registered.primitives.length).toBeGreaterThan(0)
  })
})
