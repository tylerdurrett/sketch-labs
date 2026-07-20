import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
  createImageDetailField,
  createRasterToneSource,
  prepareImageDetailAnalysis,
  type DecodedPixels,
  type PreparedImageDetailAnalysis,
} from '../index'
import type { CoordinateSpace } from '../scene'

function pixels(
  width: number,
  height: number,
  at: (x: number, y: number) => readonly [number, number, number, number],
): DecodedPixels {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.set(at(x, y), (y * width + x) * 4)
    }
  }
  return { width, height, data }
}

function gray(value: number, alpha = 255) {
  const byte = Math.max(0, Math.min(255, Math.round(value)))
  return [byte, byte, byte, alpha] as const
}

function maxValue(prepared: Readonly<PreparedImageDetailAnalysis>): number {
  let maximum = 0
  for (const value of prepared.data) maximum = Math.max(maximum, value)
  return maximum
}

function positiveCount(
  prepared: Readonly<PreparedImageDetailAnalysis>,
  threshold = 0,
): number {
  let count = 0
  for (const value of prepared.data) {
    if (value > threshold) count += 1
  }
  return count
}

function unitPrepared(
  sourceWidth: number,
  sourceHeight: number,
): PreparedImageDetailAnalysis {
  const prepared = prepareImageDetailAnalysis(
    pixels(sourceWidth, sourceHeight, () => gray(128)),
  )
  return {
    ...prepared,
    data: new Float64Array(prepared.data.length).fill(1),
  }
}

function clonePrepared(
  prepared: Readonly<PreparedImageDetailAnalysis>,
  overrides: Partial<PreparedImageDetailAnalysis>,
): PreparedImageDetailAnalysis {
  return { ...prepared, ...overrides }
}

describe('public image-detail analysis', () => {
  it('exports the fixed two-stage API without authored analysis controls', () => {
    expect(prepareImageDetailAnalysis.length).toBe(1)
    expect(createImageDetailField.length).toBe(2)
    expectTypeOf(prepareImageDetailAnalysis).parameters.toEqualTypeOf<
      [pixels: Readonly<DecodedPixels>]
    >()
    expectTypeOf(createImageDetailField).parameters.toEqualTypeOf<
      [
        prepared: Readonly<PreparedImageDetailAnalysis>,
        compositionFrame: Readonly<CoordinateSpace>,
      ]
    >()
  })

  it('prepares exact-zero fields for constants and capped broad ramps', () => {
    const constant = prepareImageDetailAnalysis(
      pixels(48, 32, () => gray(137)),
    )
    const ramp = prepareImageDetailAnalysis(
      pixels(513, 257, (x) => gray((x / 512) * 255)),
    )

    expect([...constant.data].every((value) => value === 0)).toBe(true)
    expect([...ramp.data].every((value) => value === 0)).toBe(true)
    expect(Math.max(ramp.gridWidth, ramp.gridHeight)).toBeLessThanOrEqual(256)
    expect(ramp.gridWidth).toBeLessThan(ramp.sourceWidth)
    expect(
      createImageDetailField(ramp, { width: 1000, height: 500 }).sample([
        500, 250,
      ]),
    ).toBe(0)
  })

  it('turns hard edges and fixed fine and medium bands into useful detail', () => {
    const edge = prepareImageDetailAnalysis(
      pixels(96, 48, (x, y) =>
        x >= 36 && x < 60 && y >= 12 && y < 36 ? gray(232) : gray(24),
      ),
    )
    const periodic = (period: number) =>
      prepareImageDetailAnalysis(
        pixels(96, 48, (x) =>
          gray(128 + 96 * Math.sin((x * Math.PI * 2) / period)),
        ),
      )

    for (const prepared of [edge, periodic(4), periodic(12)]) {
      expect(maxValue(prepared)).toBe(1)
      expect(positiveCount(prepared, 0.2)).toBeGreaterThan(0)
      const strongest = prepared.data.indexOf(maxValue(prepared))
      const x = strongest % prepared.gridWidth
      const y = Math.floor(strongest / prepared.gridWidth)
      const field = createImageDetailField(prepared, {
        width: prepared.sourceWidth,
        height: prepared.sourceHeight,
      })
      expect(field.sample([x + 0.5, y + 0.5])).toBeGreaterThan(0.9)
    }
  })

  it('normalizes low-contrast structure relatively and collapses bounded noise', () => {
    const lowContrast = prepareImageDetailAnalysis(
      pixels(128, 48, (x) =>
        gray(128 + 8 * Math.sin((x * Math.PI * 2) / 12)),
      ),
    )
    const boundedNoise = prepareImageDetailAnalysis(
      pixels(128, 48, (x, y) => gray(128 + ((x * 17 + y * 29) % 3) - 1)),
    )
    const positive = [...lowContrast.data].filter((value) => value > 0)

    expect(positive.length).toBeGreaterThan(0)
    expect(Math.min(...positive)).toBeLessThan(0.25)
    expect(Math.max(...positive)).toBe(1)
    expect(new Set(positive).size).toBeGreaterThan(8)
    expect([...boundedNoise.data].every((value) => value === 0)).toBe(true)
  })

  it('keeps ordinary structure useful in the presence of an isolated extreme', () => {
    const ordinary = prepareImageDetailAnalysis(
      pixels(128, 64, (x) =>
        gray(128 + 12 * Math.sin((x * Math.PI * 2) / 16)),
      ),
    )
    const withOutlier = prepareImageDetailAnalysis(
      pixels(128, 64, (x, y) =>
        x === 120 && y === 8
          ? gray(255)
          : gray(128 + 12 * Math.sin((x * Math.PI * 2) / 16)),
      ),
    )

    expect(maxValue(withOutlier)).toBe(1)
    expect(positiveCount(withOutlier, 0.4)).toBeGreaterThan(
      positiveCount(ordinary, 0.4) * 0.75,
    )
  })

  it('ignores hidden RGB, including through capped preparation', () => {
    const blackHidden = prepareImageDetailAnalysis(
      pixels(513, 129, (x) =>
        x < 257 ? [180, 180, 180, 255] : [0, 0, 0, 0],
      ),
    )
    const patternedHidden = prepareImageDetailAnalysis(
      pixels(513, 129, (x, y) =>
        x < 257
          ? [180, 180, 180, 255]
          : [(x * 71) % 256, (y * 97) % 256, ((x + y) * 43) % 256, 0],
      ),
    )

    expect(patternedHidden).toEqual(blackHidden)
    expect(patternedHidden.gridWidth).toBeLessThan(
      patternedHidden.sourceWidth,
    )
  })

  it('registers hard and soft alpha transitions', () => {
    const hard = prepareImageDetailAnalysis(
      pixels(96, 48, (x) => [0, 0, 0, x < 48 ? 255 : 0]),
    )
    const soft = prepareImageDetailAnalysis(
      pixels(96, 48, (x) => [
        0,
        0,
        0,
        Math.round(Math.max(0, Math.min(1, (60 - x) / 24)) * 255),
      ]),
    )

    expect(positiveCount(hard)).toBeGreaterThan(0)
    expect(positiveCount(soft)).toBeGreaterThan(0)
    expect(maxValue(hard)).toBe(1)
    expect(maxValue(soft)).toBe(1)
  })

  it('matches Raster Tone Source contain boundaries for wide and tall images', () => {
    const frame = { width: 100, height: 100 }
    for (const source of [
      pixels(4, 2, () => [0, 0, 0, 255]),
      pixels(2, 4, () => [0, 0, 0, 255]),
    ]) {
      const detail = createImageDetailField(
        unitPrepared(source.width, source.height),
        frame,
      )
      const raster = createRasterToneSource(source, frame)
      const wide = source.width > source.height
      const boundary = 25
      const points = wide
        ? [
            [50, boundary - 0.001],
            [50, boundary],
            [50, 100 - boundary],
            [50, 100 - boundary + 0.001],
          ]
        : [
            [boundary - 0.001, 50],
            [boundary, 50],
            [100 - boundary, 50],
            [100 - boundary + 0.001, 50],
          ]

      expect(
        points.map((point) => detail.sample(point as [number, number])),
      ).toEqual([0, 1, 1, 0])
      expect(
        points.map((point) =>
          raster.shadingMask.sample(point as [number, number]),
        ),
      ).toEqual([0, 1, 1, 0])
    }
  })

  it('uses original dimensions when cap rounding changes the lattice aspect', () => {
    const sourceWidth = 1000
    const sourceHeight = 373
    const prepared = unitPrepared(sourceWidth, sourceHeight)
    const frame = { width: 200, height: 100 }
    const field = createImageDetailField(prepared, frame)
    const originalTop =
      (frame.height - (frame.width * sourceHeight) / sourceWidth) / 2
    const gridTop =
      (frame.height -
        (frame.width * prepared.gridHeight) / prepared.gridWidth) /
      2

    expect(prepared.gridWidth / prepared.gridHeight).not.toBe(
      sourceWidth / sourceHeight,
    )
    expect(originalTop).toBeLessThan(gridTop)
    expect(field.sample([100, originalTop - 1e-6])).toBe(0)
    expect(field.sample([100, originalTop])).toBe(1)
    expect(field.sample([100, (originalTop + gridTop) / 2])).toBe(1)
  })

  it('is deterministic, independently owned, and structured-cloneable', () => {
    const source = pixels(91, 53, (x, y) => [
      (x * 17 + y * 3) % 256,
      (x * 7 + y * 19) % 256,
      (x * 11 + y * 13) % 256,
      (x * y * 5) % 256,
    ])
    const sourceBefore = Uint8Array.from(source.data)
    const first = prepareImageDetailAnalysis(source)
    const second = prepareImageDetailAnalysis(source)
    const cloned = structuredClone(first)

    expect(second).toEqual(first)
    expect(second).not.toBe(first)
    expect(second.data).not.toBe(first.data)
    expect(Object.isFrozen(first)).toBe(true)
    expect(source.data).toEqual(sourceBefore)
    expect(
      new Uint8Array(second.data.buffer).every(
        (byte, index) => byte === new Uint8Array(first.data.buffer)[index],
      ),
    ).toBe(true)
    expect(cloned).toEqual(first)
    expect(cloned.data).toBeInstanceOf(Float64Array)

    const frame = { width: 300, height: 200 }
    const originalField = createImageDetailField(first, frame)
    const clonedField = createImageDetailField(cloned, frame)
    for (const point of [
      [0, 0],
      [20, 50],
      [150, 100],
      [299, 199],
    ] as const) {
      expect(clonedField.sample(point)).toBe(originalField.sample(point))
    }
  })

  it('samples one field identically at arbitrary and different densities', () => {
    const prepared = prepareImageDetailAnalysis(
      pixels(80, 40, (x) => gray(x < 40 ? 16 : 240)),
    )
    const field = createImageDetailField(prepared, { width: 400, height: 200 })
    const sparsePoints = Array.from(
      { length: 21 },
      (_, index) => [index * 20, 100] as const,
    )
    const sparse = sparsePoints.map((point) => field.sample(point))

    // Sampling interstitial points cannot alter this stateless field's values
    // at the original positions.
    for (let x = 0; x <= 400; x += 1) field.sample([x, 100])
    expect(sparsePoints.map((point) => field.sample(point))).toEqual(sparse)
  })

  it('throws bounded TypeErrors for invalid decoded and prepared records', () => {
    for (const malformed of [
      null,
      { width: 0, height: 1, data: new Uint8Array() },
      { width: 1, height: 1, data: new Uint8Array(3) },
      { width: 1, height: 1, data: [0, 0, 0, 255] },
    ]) {
      expect(() =>
        prepareImageDetailAnalysis(malformed as never),
      ).toThrowError(TypeError)
      try {
        prepareImageDetailAnalysis(malformed as never)
      } catch (error) {
        expect((error as Error).message.length).toBeLessThan(100)
      }
    }

    const valid = unitPrepared(4, 2)
    const malformedPrepared: unknown[] = [
      null,
      clonePrepared(valid, { definitionId: 'wrong' as never }),
      clonePrepared(valid, { sourceWidth: 0 }),
      clonePrepared(valid, { sourceHeight: Number.NaN }),
      clonePrepared(valid, { gridWidth: valid.gridWidth + 1 }),
      clonePrepared(valid, { gridHeight: 0 }),
      clonePrepared(valid, { data: new Float64Array(valid.data.length - 1) }),
      clonePrepared(valid, { data: new Float32Array(valid.data) as never }),
      clonePrepared(valid, { data: [1, 1] as never }),
      clonePrepared(valid, {
        data: Float64Array.from(valid.data, (_, index) =>
          index === 0 ? Number.NaN : 1,
        ),
      }),
      clonePrepared(valid, {
        data: Float64Array.from(valid.data, (_, index) =>
          index === 0 ? -0.01 : 1,
        ),
      }),
      clonePrepared(valid, {
        data: Float64Array.from(valid.data, (_, index) =>
          index === 0 ? 1.01 : 1,
        ),
      }),
    ]

    for (const malformed of malformedPrepared) {
      expect(() =>
        createImageDetailField(malformed as PreparedImageDetailAnalysis, {
          width: 100,
          height: 100,
        }),
      ).toThrowError(TypeError)
    }
    expect(IMAGE_DETAIL_ANALYSIS_DEFINITION_ID).toBe(valid.definitionId)
  })

  it('fails invalid frames, malformed points, and post-bind non-finite cells to zero', () => {
    const prepared = unitPrepared(4, 2)
    for (const frame of [
      null,
      { width: 0, height: 100 },
      { width: 100, height: Number.NaN },
      { width: Infinity, height: 100 },
    ]) {
      const field = createImageDetailField(prepared, frame as never)
      expect(field.sample([50, 50])).toBe(0)
    }

    const mutable = clonePrepared(prepared, {
      data: Float64Array.from(prepared.data),
    })
    const field = createImageDetailField(mutable, { width: 100, height: 50 })
    expect(field.sample([50, 25])).toBe(1)
    expect(field.sample([Number.NaN, 25])).toBe(0)
    expect(field.sample([50, Infinity])).toBe(0)
    expect(field.sample(null as never)).toBe(0)

    mutable.data.fill(Number.NaN)
    expect(field.sample([50, 25])).toBe(0)
  })
})
