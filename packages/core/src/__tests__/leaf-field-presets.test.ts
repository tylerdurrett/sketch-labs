import { describe, expect, it } from 'vitest'

import {
  DEFAULT_COMPOSITION_FRAME,
  resolveCompositionFrame,
} from '../compositionFrame'
import { applyPreset, deserialize } from '../preset'
import { leafField } from '../sketches/leaf-field'
import crazy1 from '../sketches/leaf-field/presets/crazy1.json'
import nice1 from '../sketches/leaf-field/presets/nice1.json'
import prettyGood43 from '../sketches/leaf-field/presets/pretty-good-4-3.json'
import towns from '../sketches/leaf-field/presets/towns.json'
import trees from '../sketches/leaf-field/presets/trees.json'
import waves from '../sketches/leaf-field/presets/waves.json'

const COLOR_KEYS = [
  'backgroundColor',
  'discColor',
  'discStrokeColor',
  'leafColor',
  'leafStrokeColor',
] as const

/** The shared circle helper emits its 64 segments plus a closing duplicate. */
const DISC_POINT_COUNT = 65

const savedPresets: unknown[] = [nice1, crazy1, prettyGood43, towns, trees, waves]

describe('leaf-field saved-preset color fidelity', () => {
  it.each(savedPresets.map((value) => [deserialize(value).name, value] as const))(
    '%s keeps all five explicit colors when reconciled against the new defaults',
    (_name, value) => {
      const preset = deserialize(value)
      const reconciled = applyPreset(leafField.schema, preset)

      for (const key of COLOR_KEYS) {
        expect(reconciled.params[key]).toBe(preset.params[key])
      }
    },
  )

  it.each([
    ['existing v1 nice1', nice1],
    ['new v2 pretty-good-4-3', prettyGood43],
  ] as const)('%s generates a Scene with its stored palette', (_name, value) => {
    const preset = deserialize(value)
    const reconciled = applyPreset(leafField.schema, preset)
    const frame = reconciled.profile === undefined
      ? DEFAULT_COMPOSITION_FRAME
      : resolveCompositionFrame(reconciled.profile.width / reconciled.profile.height)
    const scene = leafField.generate(reconciled.params, reconciled.seed, 0, frame)
    const discs = scene.primitives.filter(
      (primitive) => primitive.points.length === DISC_POINT_COUNT,
    )
    const leaves = scene.primitives.filter(
      (primitive) => primitive.points.length !== DISC_POINT_COUNT,
    )

    expect(scene.background?.color).toBe(preset.params.backgroundColor)
    expect(discs).toHaveLength(preset.params.sphereCount)
    expect(leaves.length).toBeGreaterThan(0)
    for (const disc of discs) {
      expect(disc.fill?.color).toBe(preset.params.discColor)
      expect(disc.stroke?.color).toBe(preset.params.discStrokeColor)
    }
    for (const leaf of leaves) {
      expect(leaf.fill?.color).toBe(preset.params.leafColor)
      expect(leaf.stroke?.color).toBe(preset.params.leafStrokeColor)
    }
  })
})
