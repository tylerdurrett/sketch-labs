import { describe, expect, it } from 'vitest'

import { applyPreset, deserialize } from '../preset'
import { photoScribble } from '../sketches/photo-scribble'
import flowersDenseChaotic from '../sketches/photo-scribble/presets/flowers-dense-chaotic.json'
import flowersDense from '../sketches/photo-scribble/presets/flowers-dense.json'
import photoNeat from '../sketches/photo-scribble/presets/neat.json'
import { toneCalibration } from '../sketches/tone-calibration'
import toneNeat from '../sketches/tone-calibration/presets/neat.json'

const currentScribblePresets = [
  ['flowers-dense-chaotic', photoScribble, flowersDenseChaotic],
  ['flowers-dense', photoScribble, flowersDense],
  ['photo neat', photoScribble, photoNeat],
  ['tone neat', toneCalibration, toneNeat],
] as const

describe('Scribble production presets', () => {
  it.each(currentScribblePresets)(
    '%s writes the current artistic stop point explicitly',
    (_name, sketch, value) => {
      const preset = deserialize(value)

      expect(preset.params.stopPoint).toBe(100)
      expect(applyPreset(sketch.schema, preset).params.stopPoint).toBe(100)
    },
  )

  it('defaults a pre-stop-point Preset through the live schema', () => {
    const { stopPoint: _stopPoint, ...legacyParams } = toneNeat.params
    const legacy = { ...toneNeat, params: legacyParams }
    const preset = deserialize(legacy)

    expect(preset.params).not.toHaveProperty('stopPoint')
    expect(applyPreset(toneCalibration.schema, preset).params).toEqual({
      ...preset.params,
      stopPoint: 100,
    })
  })
})
