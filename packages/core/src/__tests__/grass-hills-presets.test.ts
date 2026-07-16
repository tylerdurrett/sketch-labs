import { describe, expect, it } from 'vitest'

import { resolveCompositionFrame } from '../compositionFrame'
import { plotDrawableRectangle } from '../plotProfile'
import { applyPreset, deserialize } from '../preset'
import { grassHills } from '../sketches/grass-hills'
import denseGrassValue from '../sketches/grass-hills/presets/dense-grass.json'

describe('Grass Hills production presets', () => {
  it('reconciles dense-grass without changing its pinned production inputs', () => {
    const preset = deserialize(denseGrassValue)
    const reconciled = applyPreset(grassHills.schema, preset)

    expect(preset).toMatchObject({
      version: 2,
      sketch: 'grass-hills',
      name: 'dense-grass',
      seed: 12345,
      params: { hillCount: 10, bladeDensity: 2 },
      profile: {
        width: 200,
        height: 200,
        insets: { top: 10, right: 10, bottom: 10, left: 10 },
        includeFrame: true,
      },
    })
    expect(preset.params).not.toHaveProperty('foregroundZoom')
    expect(reconciled.params).toEqual({
      ...preset.params,
      foregroundZoom: 1,
    })
    expect(reconciled.seed).toBe(preset.seed)
    expect(reconciled.profile).toEqual(preset.profile)
  })

  it('reproduces the full-density 10,000-blade Fill deterministically', () => {
    const preset = deserialize(denseGrassValue)
    const reconciled = applyPreset(grassHills.schema, preset)
    const drawable = plotDrawableRectangle(reconciled.profile!)
    const frame = resolveCompositionFrame(drawable.width / drawable.height)
    const first = grassHills.generate(
      reconciled.params,
      reconciled.seed,
      0,
      frame,
    )
    const second = grassHills.generate(
      reconciled.params,
      reconciled.seed,
      0,
      frame,
    )

    expect(first).toEqual(second)
    expect(first.primitives.filter(({ closed }) => closed === true)).toHaveLength(
      10_000,
    )
    expect(first.background?.color).toBe('#f7f4e8')
    expect(first.primitives.at(-1)?.fill?.color).toBe('#24643a')
  })
})
