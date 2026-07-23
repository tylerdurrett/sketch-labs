import { describe, expect, it } from 'vitest'

import type { DecodedPixels } from '../imageAssets'
import { createRasterContainFit } from '../rasterSampling'
import type { CoordinateSpace, Scene } from '../scene'
import {
  defaultWatercolorFormsControls,
  type WatercolorFormsControls,
} from '../sketches/watercolor-forms/controls'
import { generateWatercolorForms } from '../sketches/watercolor-forms/generator'
import { WATERCOLOR_FORMS_LIMITS } from '../sketches/watercolor-forms/limits'
import type { Point } from '../types'

const FRAME: CoordinateSpace = { width: 100, height: 80 }

function pixels(
  width: number,
  height: number,
  rgba: (
    x: number,
    y: number,
  ) => readonly [number, number, number, number],
): DecodedPixels {
  return {
    width,
    height,
    data: Uint8Array.from(
      Array.from({ length: width * height }, (_, index) =>
        rgba(index % width, Math.floor(index / width)),
      ).flat(),
    ),
  }
}

function controls(
  overrides: Partial<WatercolorFormsControls> = {},
): WatercolorFormsControls {
  return { ...defaultWatercolorFormsControls, ...overrides }
}

function generate(
  source: Readonly<DecodedPixels>,
  overrides: Partial<WatercolorFormsControls> = {},
  frame: Readonly<CoordinateSpace> = FRAME,
) {
  return generateWatercolorForms({
    pixels: source,
    frame,
    controls: controls(overrides),
  })
}

function allPoints(scene: Readonly<Scene>): readonly Readonly<Point>[] {
  return scene.primitives.flatMap((primitive) => primitive.points)
}

function twoBlocks(
  width = 8,
  height = 6,
  left = 0,
  right = 255,
): DecodedPixels {
  return pixels(width, height, (x) => {
    const value = x < width / 2 ? left : right
    return [value, value, value, 255]
  })
}

function alphaBox(size = 9): DecodedPixels {
  return pixels(size, size, (x, y) => {
    const visible = x >= 2 && x < size - 2 && y >= 2 && y < size - 2
    return [96, 96, 96, visible ? 255 : 0]
  })
}

describe('generateWatercolorForms', () => {
  it('composes a simple partition into one once-owned shared boundary', () => {
    const generated = generate(twoBlocks(), {
      formDetail: 1,
      boundaryStrength: 0,
      boundarySmoothing: 0,
    })

    expect(generated.diagnostics.termination).toBe('complete')
    expect(generated.scene.primitives).toHaveLength(1)
    expect(generated.diagnostics.retainedBoundarySegmentCount).toBe(6)
    expect(generated.diagnostics.boundaryPathCount).toBe(1)
    expect(generated.scene.primitives[0]!.points).toHaveLength(7)
  })

  it('emits exact closed alpha-silhouette topology without hidden RGB marks', () => {
    const visible = generate(alphaBox(), {
      formDetail: 1,
      boundaryStrength: 0,
      boundarySmoothing: 0,
    })
    const hiddenRed = generate(
      pixels(9, 9, (x, y) => {
        const supported = x >= 2 && x < 7 && y >= 2 && y < 7
        return supported
          ? [96, 96, 96, 255]
          : [255, 0, 0, 0]
      }),
      {
        formDetail: 1,
        boundaryStrength: 0,
        boundarySmoothing: 0,
      },
    )
    const hiddenGreen = generate(
      pixels(9, 9, (x, y) => {
        const supported = x >= 2 && x < 7 && y >= 2 && y < 7
        return supported
          ? [96, 96, 96, 255]
          : [0, 255, 0, 0]
      }),
      {
        formDetail: 1,
        boundaryStrength: 0,
        boundarySmoothing: 0,
      },
    )

    expect(visible.scene.primitives).not.toHaveLength(0)
    expect(
      visible.scene.primitives.some((primitive) => primitive.closed === true),
    ).toBe(true)
    expect(hiddenRed).toEqual(hiddenGreen)
    for (const primitive of visible.scene.primitives) {
      if (primitive.closed !== true) continue
      expect(primitive.points[0]).not.toEqual(primitive.points.at(-1))
    }
  })

  it('returns complete empty Scenes for transparent and flat opaque rasters', () => {
    const transparent = generate(
      pixels(6, 4, () => [210, 20, 180, 0]),
    )
    const flat = generate(pixels(6, 4, () => [128, 128, 128, 255]))

    expect(transparent.scene.primitives).toEqual([])
    expect(transparent.diagnostics.termination).toBe('complete')
    expect(transparent.diagnostics.initialRegionCount).toBe(0)
    expect(flat.scene.primitives).toEqual([])
    expect(flat.diagnostics.termination).toBe('complete')
    expect(flat.diagnostics.initialRegionCount).toBe(1)
  })

  it('maps lattice boundaries through the original-raster contain fit', () => {
    const source = twoBlocks(4, 2)
    const frame = { width: 100, height: 100 }
    const generated = generate(
      source,
      {
        formDetail: 1,
        boundaryStrength: 0,
        boundarySmoothing: 0,
      },
      frame,
    )
    const fit = createRasterContainFit(source, frame)!

    expect(generated.scene.space).toEqual(frame)
    expect(generated.scene.primitives).toHaveLength(1)
    expect(generated.scene.primitives[0]!.points).toEqual([
      [fit.left + fit.fittedWidth / 2, fit.top],
      [fit.left + fit.fittedWidth / 2, fit.top + fit.fittedHeight / 2],
      [fit.left + fit.fittedWidth / 2, fit.bottom],
    ])
  })

  it('emits only finite in-frame black width-1 source strokes', () => {
    const generated = generate(alphaBox(), {
      formDetail: 1,
      boundaryStrength: 0,
      boundarySmoothing: 0.8,
    })
    const fit = createRasterContainFit(alphaBox(), FRAME)!

    expect(generated.scene).not.toHaveProperty('background')
    for (const primitive of generated.scene.primitives) {
      expect(primitive).not.toHaveProperty('fill')
      expect(primitive.stroke).toEqual({ color: 'black', width: 1 })
      expect(primitive.hiddenLineRole).toBe('source')
      for (const [x, y] of primitive.points) {
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true)
        expect(x).toBeGreaterThanOrEqual(fit.left)
        expect(x).toBeLessThanOrEqual(fit.right)
        expect(y).toBeGreaterThanOrEqual(fit.top)
        expect(y).toBeLessThanOrEqual(fit.bottom)
      }
    }
  })

  it('responds directly and monotonically to boundary strength', () => {
    const source = twoBlocks(8, 6, 96, 128)
    const permissive = generate(source, {
      formDetail: 1,
      colorSensitivity: 1,
      boundaryStrength: 0,
      boundarySmoothing: 0,
    })
    const strict = generate(source, {
      formDetail: 1,
      colorSensitivity: 1,
      boundaryStrength: 1,
      boundarySmoothing: 0,
    })

    expect(permissive.scene.primitives.length).toBeGreaterThan(
      strict.scene.primitives.length,
    )
  })

  it('lets form detail admit a finer hierarchy cut', () => {
    const source = pixels(18, 6, (x) => {
      const value = x < 6 ? 48 : x < 12 ? 128 : 224
      return [value, value, value, 255]
    })
    const coarse = generate(source, {
      formDetail: 0,
      boundaryStrength: 0,
      boundarySmoothing: 0,
    })
    const fine = generate(source, {
      formDetail: 1,
      boundaryStrength: 0,
      boundarySmoothing: 0,
    })

    expect(fine.diagnostics.selectedRegionCount).toBeGreaterThanOrEqual(
      coarse.diagnostics.selectedRegionCount,
    )
    expect(fine.scene.primitives.length).toBeGreaterThanOrEqual(
      coarse.scene.primitives.length,
    )
  })

  it('makes visible color separation more conservative at high sensitivity', () => {
    const source = twoBlocks(12, 6, 96, 128)
    const comparisons = Array.from({ length: 21 }, (_, index) => {
      const formDetail = index / 20
      const low = generate(source, {
        formDetail,
        colorSensitivity: 0,
        boundaryStrength: 0,
        boundarySmoothing: 0,
      })
      const high = generate(source, {
        formDetail,
        colorSensitivity: 1,
        boundaryStrength: 0,
        boundarySmoothing: 0,
      })
      return [low, high] as const
    })

    expect(
      comparisons.every(
        ([low, high]) =>
          high.diagnostics.selectedRegionCount >=
          low.diagnostics.selectedRegionCount,
      ),
    ).toBe(true)
    expect(
      comparisons.some(
        ([low, high]) =>
          high.diagnostics.selectedRegionCount >
          low.diagnostics.selectedRegionCount,
      ),
    ).toBe(true)
  })

  it('uses smoothing without increasing emitted point complexity', () => {
    const source = alphaBox(17)
    const unsmoothed = generate(source, {
      formDetail: 1,
      boundaryStrength: 0,
      boundarySmoothing: 0,
    })
    const smoothed = generate(source, {
      formDetail: 1,
      boundaryStrength: 0,
      boundarySmoothing: 1,
    })

    expect(smoothed.diagnostics.curvePointCount).toBeLessThanOrEqual(
      unsmoothed.diagnostics.curvePointCount,
    )
    expect(smoothed.diagnostics.primitiveCount).toBe(
      unsmoothed.diagnostics.primitiveCount,
    )
  })

  it('normalizes malformed controls through the declared defaults', () => {
    const source = twoBlocks()
    const baseline = generate(source)
    const malformed = generateWatercolorForms({
      pixels: source,
      frame: FRAME,
      controls: {
        formDetail: Number.NaN,
        colorSensitivity: Number.POSITIVE_INFINITY,
        boundaryStrength: Number.NEGATIVE_INFINITY,
        boundarySmoothing: Number.NaN,
      },
    })

    expect(malformed).toEqual(baseline)
  })

  it('fails malformed decoded rasters and frames closed with diagnostics', () => {
    const malformedPixels = {
      width: 2,
      height: 2,
      data: new Uint8Array(3),
    } as DecodedPixels
    const badRaster = generate(malformedPixels)
    const badFrame = generate(twoBlocks(), {}, { width: Number.NaN, height: 2 })

    expect(badRaster.scene.primitives).toEqual([])
    expect(badRaster.diagnostics.termination).toBe('invalid-input')
    expect(badFrame.scene.primitives).toEqual([])
    expect(badFrame.diagnostics.termination).toBe('invalid-input')
  })

  it('is byte-for-byte deterministic with stable primitive order', () => {
    const source = pixels(24, 18, (x, y) => {
      const red = (x * 37 + y * 11) % 256
      const green = (x * 13 + y * 41) % 256
      const blue = (x * 29 + y * 7) % 256
      return [red, green, blue, 255]
    })
    const first = generate(source, {
      formDetail: 0.8,
      colorSensitivity: 0.7,
      boundaryStrength: 0.25,
      boundarySmoothing: 0.6,
    })
    const second = generate(source, {
      formDetail: 0.8,
      colorSensitivity: 0.7,
      boundaryStrength: 0.25,
      boundarySmoothing: 0.6,
    })

    expect(second).toEqual(first)
    expect(generateWatercolorForms.length).toBe(1)
  })

  it('keeps every accounting field within the declared production caps', () => {
    const generated = generate(
      pixels(300, 257, (x, y) => [
        (x * 17 + y * 23) % 256,
        (x * 43 + y * 3) % 256,
        (x * 7 + y * 31) % 256,
        255,
      ]),
      {
        formDetail: 0.7,
        colorSensitivity: 0.8,
        boundaryStrength: 0.4,
        boundarySmoothing: 0.5,
      },
    )
    const diagnostics = generated.diagnostics

    expect(diagnostics.sampleCount).toBeLessThanOrEqual(
      WATERCOLOR_FORMS_LIMITS.maxSampleCount,
    )
    expect(diagnostics.initialRegionCount).toBeLessThanOrEqual(
      WATERCOLOR_FORMS_LIMITS.maxInitialRegionCount,
    )
    expect(diagnostics.gridAdjacencyCount).toBeLessThanOrEqual(
      WATERCOLOR_FORMS_LIMITS.maxGridAdjacencyCount,
    )
    expect(diagnostics.mergeCount).toBeLessThanOrEqual(
      WATERCOLOR_FORMS_LIMITS.maxMergeCount,
    )
    expect(diagnostics.mergeQueueEntryCount).toBeLessThanOrEqual(
      WATERCOLOR_FORMS_LIMITS.maxMergeQueueEntryCount,
    )
    expect(diagnostics.regionUpdateCount).toBeLessThanOrEqual(
      WATERCOLOR_FORMS_LIMITS.maxRegionUpdateCount,
    )
    expect(diagnostics.retainedBoundarySegmentCount).toBeLessThanOrEqual(
      WATERCOLOR_FORMS_LIMITS.maxRetainedBoundarySegmentCount,
    )
    expect(diagnostics.boundaryPathCount).toBeLessThanOrEqual(
      WATERCOLOR_FORMS_LIMITS.maxBoundaryPathCount,
    )
    expect(diagnostics.curvePointCount).toBeLessThanOrEqual(
      WATERCOLOR_FORMS_LIMITS.maxCurvePointCount,
    )
    expect(diagnostics.primitiveCount).toBeLessThanOrEqual(
      WATERCOLOR_FORMS_LIMITS.maxPrimitiveCount,
    )
    expect(allPoints(generated.scene).every(([x, y]) =>
      Number.isFinite(x) && Number.isFinite(y),
    )).toBe(true)
  }, 30_000)

  it.each([
    [1, 7],
    [7, 1],
  ])('handles tiny extreme-aspect rasters (%d×%d)', (width, height) => {
    const generated = generate(
      pixels(width, height, (_x, y) => {
        const value = y < height / 2 ? 32 : 224
        return [value, value, value, 255]
      }),
    )

    expect(['complete', 'limit-reached']).toContain(
      generated.diagnostics.termination,
    )
    expect(
      allPoints(generated.scene).every(
        ([x, y]) =>
          Number.isFinite(x) &&
          Number.isFinite(y) &&
          x >= 0 &&
          x <= FRAME.width &&
          y >= 0 &&
          y <= FRAME.height,
      ),
    ).toBe(true)
  })
})
