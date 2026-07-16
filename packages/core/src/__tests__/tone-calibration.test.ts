import { describe, expect, it } from 'vitest'

import {
  DEFAULT_COMPOSITION_FRAME,
  defaultParams,
  resolveCompositionFrame,
  toneCalibration as publicToneCalibration,
  toneCalibrationSchema as publicToneCalibrationSchema,
} from '../index'
import {
  toneCalibration,
  toneCalibrationSchema,
} from '../sketches/tone-calibration'

describe('Tone Calibration Sketch contract', () => {
  it('publishes the fixed identity and an exactly empty parameter schema', () => {
    expect(toneCalibration.id).toBe('tone-calibration')
    expect(toneCalibration.name).toBe('Tone Calibration')
    expect(toneCalibration.schema).toBe(toneCalibrationSchema)
    expect(toneCalibration.schema).toEqual({})
    expect(defaultParams(toneCalibration.schema)).toEqual({})
  })

  it('is exported from the core public entry point', () => {
    expect(publicToneCalibration).toBe(toneCalibration)
    expect(publicToneCalibrationSchema).toBe(toneCalibrationSchema)
  })

  it.each([
    ['square', resolveCompositionFrame(1)],
    ['portrait', resolveCompositionFrame(2 / 3)],
    ['landscape', resolveCompositionFrame(3 / 2)],
  ])(
    'returns the exact supplied %s frame with no artwork or background',
    (_name, frame) => {
      const scene = toneCalibration.generate({}, 'any-seed', 123, frame)

      expect(scene).toEqual({ space: frame, primitives: [] })
      expect(scene.space).not.toBe(frame)
      expect(scene.primitives).toHaveLength(0)
      expect(scene).not.toHaveProperty('background')
    },
  )

  it('keeps empty artwork independent of Seed and time', () => {
    const first = toneCalibration.generate(
      {},
      'seed-a',
      -10,
      DEFAULT_COMPOSITION_FRAME,
    )
    const second = toneCalibration.generate(
      {},
      'seed-b',
      Number.MAX_SAFE_INTEGER,
      DEFAULT_COMPOSITION_FRAME,
    )

    expect(second).toEqual(first)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('delegates its target directly to the accepted frame-relative source', () => {
    const frame = resolveCompositionFrame(16 / 9)
    const source = toneCalibration.generateToneSource!({}, frame)

    expect(source.layout.frame).toEqual(frame)
    expect(source.layout.circle.center).toEqual([
      frame.width / 2,
      frame.height / 2,
    ])
    expect(source.layout.circle.diameter).toBe(
      Math.min(frame.width, frame.height) * 0.8,
    )
  })

  it('keeps source layout and samples invariant across interleaved Seeds and times', () => {
    const frame = resolveCompositionFrame(4 / 3)
    const first = toneCalibration.generateToneSource!({}, frame)

    toneCalibration.generate({}, 'seed-a', -1, frame)
    toneCalibration.generate({}, 'seed-b', 42, resolveCompositionFrame(2 / 3))

    const second = toneCalibration.generateToneSource!({}, frame)
    const { center, radius } = first.layout.circle
    const points = [
      [0, 0] as const,
      center,
      [center[0], center[1] - radius] as const,
      [frame.width, frame.height] as const,
    ]
    const samples = (source: typeof first) =>
      points.map((point) => [
        source.toneField.sample(point),
        source.shadingMask.sample(point),
      ])

    expect(JSON.stringify(second.layout)).toBe(JSON.stringify(first.layout))
    expect(samples(second)).toEqual(samples(first))
  })
})
