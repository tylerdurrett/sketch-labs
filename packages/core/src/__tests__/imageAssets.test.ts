import { describe, expect, it } from 'vitest'

import type {
  DecodedPixels,
  ImageAssetLookup,
  Rgba8Bytes,
  SketchEnvironment,
} from '../index'

describe('decoded Image Asset contract', () => {
  it.each([
    ['Uint8Array', Uint8Array.from([1, 2, 3, 4])],
    ['Uint8ClampedArray', Uint8ClampedArray.from([1, 2, 3, 4])],
  ] as const)('accepts a readonly %s RGBA8 fixture', (_name, bytes) => {
    const data: Rgba8Bytes = bytes
    const pixels: DecodedPixels = { width: 1, height: 1, data }
    const lookup: ImageAssetLookup = (id) =>
      id === 'portrait-a1b2c3d4' ? pixels : undefined
    const environment: SketchEnvironment = { imageAssets: lookup }

    expect(environment.imageAssets('portrait-a1b2c3d4')).toBe(pixels)
    expect(environment.imageAssets('missing')).toBeUndefined()
    expect(pixels.data).toBe(bytes)
  })
})
