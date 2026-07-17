import { describe, expect, it } from 'vitest'

import { resolveCompositionFrame } from '../compositionFrame'
import type { CoordinateSpace } from '../scene'
import {
  createToneCalibrationLayout,
  createToneCalibrationSource,
} from '../sketches/tone-calibration/source'

describe('Tone Calibration source', () => {
  it.each([
    ['square', 1],
    ['portrait', 2 / 3],
    ['landscape', 3 / 2],
  ])('centers a true 80%%-short-side circle in a %s frame', (_name, aspect) => {
    const frame = resolveCompositionFrame(aspect)
    const layout = createToneCalibrationLayout(frame)
    const expectedDiameter = Math.min(frame.width, frame.height) * 0.8

    expect(layout.frame).toEqual(frame)
    expect(layout.frame).not.toBe(frame)
    expect(layout.circle.center).toEqual([frame.width / 2, frame.height / 2])
    expect(layout.circle.diameter).toBe(expectedDiameter)
    expect(layout.circle.radius).toBe(expectedDiameter / 2)
    expect(Object.isFrozen(layout)).toBe(true)
    expect(Object.isFrozen(layout.frame)).toBe(true)
    expect(Object.isFrozen(layout.circle)).toBe(true)
    expect(Object.isFrozen(layout.circle.center)).toBe(true)
  })

  it('samples the complete background ramp outside the circle', () => {
    const frame = resolveCompositionFrame(1)
    const { toneField } = createToneCalibrationSource(frame)
    const exteriorX = 0

    expect(toneField.sample([exteriorX, 0])).toBe(0)
    expect(toneField.sample([exteriorX, frame.height / 2])).toBe(0.5)
    expect(toneField.sample([exteriorX, frame.height])).toBe(1)
  })

  it('samples the complete inverse local ramp inside the circle', () => {
    const source = createToneCalibrationSource(resolveCompositionFrame(1))
    const { center, radius } = source.layout.circle

    expect(source.toneField.sample([center[0], center[1] - radius])).toBe(1)
    expect(source.toneField.sample(center)).toBe(0.5)
    expect(source.toneField.sample([center[0], center[1] + radius])).toBe(0)
  })

  it('hard-overwrites the background through the inclusive circle boundary', () => {
    const source = createToneCalibrationSource(resolveCompositionFrame(1))
    const { frame, circle } = source.layout
    const dy = -circle.radius / 4
    const boundaryX =
      circle.center[0] + Math.sqrt(circle.radius ** 2 - dy ** 2)
    const y = circle.center[1] + dy
    const epsilon = circle.radius * 1e-6
    const circleTone =
      (circle.center[1] + circle.radius - y) / circle.diameter
    const backgroundTone = y / frame.height

    expect(source.toneField.sample([boundaryX - epsilon, y])).toBe(circleTone)
    expect(source.toneField.sample([boundaryX + epsilon, y])).toBe(
      backgroundTone,
    )
    expect(circleTone).not.toBe(backgroundTone)

    expect(
      source.toneField.sample([
        circle.center[0] + circle.radius,
        circle.center[1],
      ]),
    ).toBe(0.5)
  })

  it('returns exact full permission throughout every supported frame shape', () => {
    for (const aspect of [1, 2 / 3, 3 / 2]) {
      const frame = resolveCompositionFrame(aspect)
      const { shadingMask } = createToneCalibrationSource(frame)

      for (let row = 0; row <= 20; row += 1) {
        for (let column = 0; column <= 20; column += 1) {
          expect(
            shadingMask.sample([
              (column / 20) * frame.width,
              (row / 20) * frame.height,
            ]),
          ).toBe(1)
        }
      }
    }
  })

  it('keeps dense tone samples finite and bounded across aspect ratios', () => {
    for (const aspect of [1, 2 / 3, 3 / 2]) {
      const frame = resolveCompositionFrame(aspect)
      const { toneField } = createToneCalibrationSource(frame)

      for (let row = 0; row <= 40; row += 1) {
        for (let column = 0; column <= 40; column += 1) {
          const tone = toneField.sample([
            (column / 40) * frame.width,
            (row / 40) * frame.height,
          ])
          expect(Number.isFinite(tone)).toBe(true)
          expect(tone).toBeGreaterThanOrEqual(0)
          expect(tone).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('repeats identical layouts and scalar samples without a random input', () => {
    const frame = resolveCompositionFrame(3 / 2)
    const first = createToneCalibrationSource(frame)
    const second = createToneCalibrationSource(frame)
    const points = Array.from({ length: 37 }, (_, index) => [
      ((index * 17) % 37) * (frame.width / 36),
      index * (frame.height / 36),
    ] as const)
    const samples = (source: typeof first): readonly number[] =>
      points.flatMap((point) => [
        source.toneField.sample(point),
        source.shadingMask.sample(point),
      ])

    expect(JSON.stringify(second.layout)).toBe(JSON.stringify(first.layout))
    expect(samples(second)).toEqual(samples(first))
  })

  it.each([
    { width: 0, height: 100 },
    { width: 100, height: 0 },
    { width: -1, height: 100 },
    { width: 100, height: Number.NaN },
    { width: Number.POSITIVE_INFINITY, height: 100 },
  ] satisfies CoordinateSpace[])('rejects invalid frame dimensions: %o', (frame) => {
    expect(() => createToneCalibrationLayout(frame)).toThrow(
      'frame must have finite positive dimensions',
    )
    expect(() => createToneCalibrationSource(frame)).toThrow(
      'frame must have finite positive dimensions',
    )
  })
})
