import { describe, expect, it, vi } from 'vitest'

import {
  createPencilContour,
  defaultParams,
  defaultPencilContourControls,
  generatePencilContour,
  PENCIL_CONTOUR_DEFAULT_IMAGE_ASSET_ID,
  pencilContour,
  pencilContourControlSchema,
  type DecodedPixels,
  type SketchEnvironment,
} from '../index'

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

describe('Pencil Contour registered Sketch', () => {
  it('publishes stable metadata and the managed asset plus reusable controls in authored order', () => {
    const sketch = createPencilContour(SELECTED_ID)

    expect(sketch.id).toBe('pencil-contour')
    expect(sketch.name).toBe('Pencil Contour')
    expect(Object.keys(sketch.schema)).toEqual([
      'imageAsset',
      'gamma',
      'contrast',
      'pivot',
      'contourDetail',
      'contourSmoothing',
    ])
    expect(sketch.schema).toEqual({
      imageAsset: { kind: 'image-asset', default: SELECTED_ID },
      ...pencilContourControlSchema,
    })
    expect(defaultParams(sketch.schema)).toEqual({
      imageAsset: SELECTED_ID,
      ...defaultPencilContourControls,
    })
  })

  it('binds production to the bundled stable sample without changing the factory default', () => {
    expect(PENCIL_CONTOUR_DEFAULT_IMAGE_ASSET_ID).toBe(
      'pinecone-4330aa0314f7',
    )
    expect(pencilContour.schema.imageAsset).toEqual({
      kind: 'image-asset',
      default: PENCIL_CONTOUR_DEFAULT_IMAGE_ASSET_ID,
    })
  })

  it('looks up only the exact selected asset and never substitutes other bytes', () => {
    const sketch = createPencilContour(DEFAULT_ID)
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
    expect(lookup.mock.calls).toEqual([[SELECTED_ID]])
  })

  it.each([
    ['absent environment', undefined],
    ['missing selected asset', environmentFor(() => undefined)],
    [
      'malformed selected pixels',
      environmentFor((id) =>
        id === SELECTED_ID
          ? { width: 2, height: 2, data: new Uint8Array(3) }
          : transition(),
      ),
    ],
  ] as const)('fails closed in the exact frame for %s', (_name, environment) => {
    const sketch = createPencilContour(SELECTED_ID)

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

  it('ignores seed and time and exactly matches the direct headless generator', () => {
    const sketch = createPencilContour(SELECTED_ID)
    const params = {
      ...defaultParams(sketch.schema),
      gamma: 0.8,
      contrast: 0.2,
      pivot: 0.4,
      contourDetail: 0.7,
      contourSmoothing: 1,
    }
    const pixels = transition()
    const environment = environmentFor((id) =>
      id === SELECTED_ID ? pixels : undefined,
    )
    const direct = generatePencilContour({
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

    expect(sketch.generate(params, 'seed-a', 0, FRAME, environment)).toEqual(
      direct,
    )
    expect(sketch.generate(params, 'seed-b', 999, FRAME, environment)).toEqual(
      direct,
    )
    expect(direct.primitives.length).toBeGreaterThan(0)
  })
})
