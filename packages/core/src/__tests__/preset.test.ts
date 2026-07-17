import { describe, expect, it } from 'vitest'

import type { PlotProfile } from '../plotProfile'
import {
  applyPreset,
  deserialize,
  makePreset,
  PRESET_VERSION,
  serialize,
} from '../preset'
import type { Params, ParamSchema } from '../sketch'
// A real, shipped on-disk v1 record — proves old presets still load unchanged.
import leafFieldV1 from '../sketches/leaf-field/presets/nice1.json'

/** A valid active Output Profile: A4 landscape with symmetric 10 mm insets. */
const profile: PlotProfile = {
  width: 297,
  height: 210,
  insets: { top: 10, right: 10, bottom: 10, left: 10 },
  includeFrame: true,
  toolWidthMillimeters: 0.3,
}

describe('makePreset', () => {
  it('serializes locks as a sorted string array regardless of Set insertion order', () => {
    const preset = makePreset(
      'circles',
      'my-preset',
      { count: 24 },
      42,
      new Set(['radius', 'count', 'alpha']),
    )
    expect(preset.locks).toEqual(['alpha', 'count', 'radius'])
  })

  it('stamps a v1 record with NO profile when none is supplied, and copies (does not alias) params', () => {
    const params: Params = { count: 24 }
    const preset = makePreset('circles', 'p', params, 42, new Set())
    expect(preset.version).toBe(1)
    expect('profile' in preset).toBe(false)
    expect(preset.params).not.toBe(params)
    expect(preset.params).toEqual({ count: 24 })
  })

  it('stamps a v2 record (PRESET_VERSION) carrying the profile when one is supplied', () => {
    const preset = makePreset('circles', 'p', { count: 24 }, 42, new Set(), profile)
    expect(preset.version).toBe(2)
    expect(PRESET_VERSION).toBe(2)
    expect(preset.version).toBe(PRESET_VERSION)
    expect(preset.profile).toEqual(profile)
  })

  it('defensively copies the profile (never aliases the caller’s object or its insets)', () => {
    const live: PlotProfile = {
      width: 297,
      height: 210,
      insets: { top: 10, right: 10, bottom: 10, left: 10 },
      includeFrame: true,
      toolWidthMillimeters: 0.3,
    }
    const preset = makePreset('circles', 'p', {}, 42, new Set(), live)
    expect(preset.profile).not.toBe(live)
    expect(preset.profile?.insets).not.toBe(live.insets)
    live.width = 999
    live.insets.top = 999
    expect(preset.profile).toEqual(profile)
  })
})

describe('deserialize', () => {
  it('round-trips a serialized v1 Preset (no profile)', () => {
    const preset = makePreset('circles', 'p', { count: 24 }, 42, new Set(['count']))
    expect(deserialize(serialize(preset))).toEqual(preset)
  })

  it('round-trips a serialized v2 Preset carrying the profile', () => {
    const preset = makePreset(
      'circles',
      'p',
      { count: 24 },
      42,
      new Set(['count']),
      profile,
    )
    const back = deserialize(serialize(preset))
    expect(back).toEqual(preset)
    expect(back.version).toBe(2)
    expect(back.profile).toEqual(profile)
  })

  it.each([true, false])(
    'round-trips an explicit includeFrame=%s without changing preset version',
    (includeFrame) => {
      const preset = makePreset(
        'circles',
        'p',
        { count: 24 },
        42,
        new Set(['count']),
        { ...profile, includeFrame },
      )

      const serialized = serialize(preset)
      const back = deserialize(serialized)

      expect(serialized.version).toBe(PRESET_VERSION)
      expect(serialized.profile?.includeFrame).toBe(includeFrame)
      expect(back.version).toBe(PRESET_VERSION)
      expect(back.profile?.includeFrame).toBe(includeFrame)
    },
  )

  it('defaults a legacy v2 profile with no includeFrame field to true', () => {
    const legacyProfile = {
      width: 297,
      height: 210,
      insets: { top: 10, right: 10, bottom: 10, left: 10 },
    }
    const loaded = deserialize({
      version: 2,
      sketch: 'circles',
      name: 'legacy-v2',
      seed: 42,
      params: { count: 24 },
      locks: [],
      profile: legacyProfile,
    })

    expect(loaded.version).toBe(PRESET_VERSION)
    expect(loaded.profile).toEqual(profile)
    expect(loaded.profile).not.toBe(legacyProfile)
    expect(loaded.profile?.insets).not.toBe(legacyProfile.insets)
  })

  it('serializes a defensive profile copy including the active frame flag', () => {
    const source = makePreset(
      'circles',
      'p',
      {},
      42,
      new Set(),
      { ...profile, includeFrame: false },
    )
    const serialized = serialize(source)

    expect(serialized.profile).not.toBe(source.profile)
    expect(serialized.profile?.insets).not.toBe(source.profile?.insets)
    expect(serialized.profile?.includeFrame).toBe(false)
  })

  it('rejects a v2 profile with a present non-boolean includeFrame value', () => {
    expect(() =>
      deserialize({
        version: 2,
        sketch: 'circles',
        name: 'bad-frame-option',
        seed: 42,
        params: {},
        locks: [],
        profile: { ...profile, includeFrame: 'yes' },
      }),
    ).toThrow(/normalizePlotProfile: includeFrame must be a boolean/)
  })

  it('accepts both a v1 record (no profile) and a v2 record (with profile)', () => {
    const v1 = makePreset('circles', 'p', { count: 24 }, 42, new Set())
    const v2 = makePreset('circles', 'p', { count: 24 }, 42, new Set(), profile)
    expect(deserialize(serialize(v1)).version).toBe(1)
    expect(deserialize(serialize(v2)).version).toBe(2)
  })

  it('rejects an unsupported version (not 1 or 2)', () => {
    const bad = { ...serialize(makePreset('circles', 'p', {}, 1, new Set())), version: 3 }
    expect(() => deserialize(bad)).toThrow(/version/)
  })

  it('rejects a v1 record that carries a profile (invariant: profile ⇔ v2)', () => {
    const bad = {
      version: 1,
      sketch: 'circles',
      name: 'p',
      seed: 1,
      params: {},
      locks: [],
      profile,
    }
    expect(() => deserialize(bad)).toThrow(/version 1 record must not carry a `profile`/)
  })

  it('rejects a v2 record missing its profile (invariant: profile ⇔ v2)', () => {
    const bad = {
      version: 2,
      sketch: 'circles',
      name: 'p',
      seed: 1,
      params: {},
      locks: [],
    }
    expect(() => deserialize(bad)).toThrow(/version 2 record must carry a `profile`/)
  })

  it('loudly rejects a structurally-broken v2 profile', () => {
    const bad = {
      version: 2,
      sketch: 'circles',
      name: 'p',
      seed: 1,
      params: {},
      locks: [],
      // insets exhaust the sheet — validatePlotProfile throws.
      profile: {
        width: 100,
        height: 100,
        insets: { top: 60, right: 0, bottom: 60, left: 0 },
        includeFrame: true,
      },
    }
    expect(() => deserialize(bad)).toThrow(/validatePlotProfile/)
  })

  it('rejects a non-object value', () => {
    expect(() => deserialize(null)).toThrow()
    expect(() => deserialize('not-a-preset')).toThrow()
  })

  it('re-sorts locks so the validated record is canonical', () => {
    const wireShape = {
      version: 1,
      sketch: 'circles',
      name: 'p',
      seed: 7,
      params: { count: 24 },
      locks: ['radius', 'count'],
    }
    expect(deserialize(wireShape).locks).toEqual(['count', 'radius'])
  })

  it('loads a real on-disk v1 preset: params/seed/locks preserved, profile absent', () => {
    const loaded = deserialize(leafFieldV1)
    expect(loaded.version).toBe(1)
    expect(loaded.profile).toBeUndefined()
    expect('profile' in loaded).toBe(false)
    expect(loaded.seed).toBe(leafFieldV1.seed)
    expect(loaded.locks).toEqual(leafFieldV1.locks)
    expect(loaded.params).toEqual(leafFieldV1.params)
  })
})

describe('applyPreset', () => {
  const schema: ParamSchema = {
    count: { kind: 'number', min: 1, max: 80, default: 24 },
    radius: { kind: 'number', min: 2, max: 100, default: 12 },
  }

  it('drops a key present in the preset but absent from the schema', () => {
    const preset = makePreset(
      'circles',
      'p',
      { count: 30, radius: 40, gone: 'drop-me' },
      1,
      new Set(),
    )
    const state = applyPreset(schema, preset)
    expect(state.params).toEqual({ count: 30, radius: 40 })
    expect('gone' in state.params).toBe(false)
  })

  it('fills a schema key missing from the preset with its spec default', () => {
    const preset = makePreset('circles', 'p', { count: 30 }, 1, new Set())
    const state = applyPreset(schema, preset)
    expect(state.params).toEqual({ count: 30, radius: 12 })
  })

  it('preserves a stored Image Asset ID and defaults only an absent one', () => {
    const assetSchema: ParamSchema = {
      image: { kind: 'image-asset', default: 'portrait-default' },
    }
    const stored = makePreset(
      'photo-scribble',
      'stored',
      { image: 'missing-but-authored-id' },
      1,
      new Set(),
    )
    const absent = makePreset('photo-scribble', 'absent', {}, 1, new Set())

    expect(applyPreset(assetSchema, stored).params).toEqual({
      image: 'missing-but-authored-id',
    })
    expect(applyPreset(assetSchema, absent).params).toEqual({
      image: 'portrait-default',
    })
  })

  it('loads an out-of-bounds value AS-IS, unclamped', () => {
    const preset = makePreset(
      'circles',
      'p',
      { count: 9999, radius: -50 },
      1,
      new Set(),
    )
    const state = applyPreset(schema, preset)
    expect(state.params).toEqual({ count: 9999, radius: -50 })
  })

  it('passes seed and the sorted locks array through unchanged', () => {
    const preset = makePreset(
      'circles',
      'p',
      { count: 30, radius: 40 },
      'seed-7',
      new Set(['radius', 'count']),
    )
    const state = applyPreset(schema, preset)
    expect(state.seed).toBe('seed-7')
    expect(state.locks).toEqual(['count', 'radius'])
  })

  it('surfaces the stored profile VERBATIM for a v2 preset (no fallback resolution)', () => {
    const preset = makePreset('circles', 'p', { count: 30 }, 1, new Set(), profile)
    const state = applyPreset(schema, preset)
    expect(state.profile).toEqual(profile)
    // Passed through as-is — the same reference the record holds, un-resolved.
    expect(state.profile).toBe(preset.profile)
  })

  it.each([true, false])(
    'applies a loaded v2 profile with includeFrame=%s unchanged',
    (includeFrame) => {
      const preset = deserialize(
        serialize(
          makePreset(
            'circles',
            'p',
            { count: 30 },
            1,
            new Set(),
            { ...profile, includeFrame },
          ),
        ),
      )

      expect(applyPreset(schema, preset).profile?.includeFrame).toBe(includeFrame)
    },
  )

  it('surfaces an undefined profile for a v1 preset', () => {
    const preset = makePreset('circles', 'p', { count: 30 }, 1, new Set())
    const state = applyPreset(schema, preset)
    expect(state.profile).toBeUndefined()
  })

  it('throws on a wrong-version preset even when reached directly', () => {
    const bad = { ...makePreset('circles', 'p', {}, 1, new Set()), version: 3 as 1 }
    expect(() => applyPreset(schema, bad)).toThrow(/version/)
  })
})

describe('round-trip fidelity (no-drift case)', () => {
  it('applyPreset(schema, deserialize(serialize(makePreset(...)))) equals the input params/seed/locks', () => {
    const schema: ParamSchema = {
      count: { kind: 'number', min: 1, max: 80, default: 24 },
      radius: { kind: 'number', min: 2, max: 100, default: 12 },
    }
    // No schema-absent keys, no preset-missing keys, all in-bounds.
    const params: Params = { count: 30, radius: 40 }
    const seed = 12345
    const locks = new Set(['count'])

    const state = applyPreset(
      schema,
      deserialize(serialize(makePreset('circles', 'p', params, seed, locks))),
    )

    expect(state.params).toEqual(params)
    expect(state.seed).toBe(seed)
    expect(state.locks).toEqual(['count'])
  })
})
