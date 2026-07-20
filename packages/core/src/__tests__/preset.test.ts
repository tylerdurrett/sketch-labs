import { describe, expect, it } from 'vitest'

import type { PlotProfile } from '../plotProfile'
import {
  applyPreset,
  deserialize,
  makePreset,
  PRESET_VERSION,
  serialize,
  type PresetFraming,
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

const framing: PresetFraming = {
  pageFrame: { x: -20, y: 10, width: 320, height: 180 },
  generationAspect: 4 / 3,
  aspectLocked: true,
}

const fixedPageProfile: PlotProfile = {
  width: 333.125,
  height: 241.75,
  insets: { top: 11, right: 19, bottom: 23, left: 7 },
  includeFrame: false,
  toolWidthMillimeters: 0.45,
}

const fixedPageFraming: PresetFraming = {
  pageFrame: {
    x: 18.75,
    y: -8,
    width: 600 / 7,
    height: 415.5 / 7,
  },
  generationAspect: 3 / 2,
  aspectLocked: true,
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
    expect('framing' in preset).toBe(false)
    expect(preset.params).not.toBe(params)
    expect(preset.params).toEqual({ count: 24 })
  })

  it('stamps a v2 record carrying only the profile when one is supplied', () => {
    const preset = makePreset('circles', 'p', { count: 24 }, 42, new Set(), profile)
    expect(preset.version).toBe(2)
    expect(PRESET_VERSION).toBe(3)
    expect(preset.profile).toEqual(profile)
    expect('framing' in preset).toBe(false)
  })

  it('stamps a v3 record carrying profile and framing when both are supplied', () => {
    const preset = makePreset(
      'circles',
      'p',
      { count: 24 },
      42,
      new Set(),
      profile,
      framing,
    )
    expect(preset.version).toBe(PRESET_VERSION)
    expect(preset.profile).toEqual(profile)
    expect(preset.framing).toEqual(framing)
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

  it('validates and defensively copies framing and its Page Frame', () => {
    const live = {
      pageFrame: { ...framing.pageFrame },
      generationAspect: framing.generationAspect,
      aspectLocked: framing.aspectLocked,
    }
    const preset = makePreset('circles', 'p', {}, 42, new Set(), profile, live)

    expect(preset.framing).not.toBe(live)
    expect(preset.framing?.pageFrame).not.toBe(live.pageFrame)
    live.pageFrame.x = 999
    live.generationAspect = 2
    live.aspectLocked = false
    expect(preset.framing).toEqual(framing)
  })

  it('rejects framing without the required final profile', () => {
    expect(() =>
      makePreset('circles', 'p', {}, 42, new Set(), undefined, framing),
    ).toThrow(/framing.*requires.*profile/)
  })

  it.each([
    [{ ...framing, generationAspect: 0 }, /generationAspect/],
    [{ ...framing, generationAspect: Number.NaN }, /generationAspect/],
    [{ ...framing, aspectLocked: 'yes' }, /aspectLocked/],
    [{ ...framing, pageFrame: { ...framing.pageFrame, width: 0 } }, /width/],
  ])('rejects invalid framing at creation', (invalid, message) => {
    expect(() =>
      makePreset(
        'circles',
        'p',
        {},
        42,
        new Set(),
        profile,
        invalid as PresetFraming,
      ),
    ).toThrow(message)
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

  it('round-trips a serialized v3 Preset carrying the profile and framing exactly', () => {
    const preset = makePreset(
      'circles',
      'p',
      { count: 24 },
      42,
      new Set(['count']),
      profile,
      framing,
    )
    const serialized = serialize(preset)
    const back = deserialize(serialized)

    expect(back).toEqual(preset)
    expect(back.version).toBe(PRESET_VERSION)
    expect(back.profile).not.toBe(serialized.profile)
    expect(back.profile?.insets).not.toBe(serialized.profile?.insets)
    expect(back.framing).not.toBe(serialized.framing)
    expect(back.framing?.pageFrame).not.toBe(serialized.framing?.pageFrame)
  })

  it.each([true, false])(
    'round-trips the v3 aspect-lock state when aspectLocked=%s',
    (aspectLocked) => {
      const preset = makePreset(
        'circles',
        'p',
        {},
        42,
        new Set(),
        profile,
        { ...framing, aspectLocked },
      )

      expect(deserialize(serialize(preset)).framing?.aspectLocked).toBe(
        aspectLocked,
      )
    },
  )

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

      expect(serialized.version).toBe(2)
      expect(serialized.profile?.includeFrame).toBe(includeFrame)
      expect(back.version).toBe(2)
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

    expect(loaded.version).toBe(2)
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

  it('serializes defensive framing and Page Frame copies', () => {
    const source = makePreset(
      'circles',
      'p',
      {},
      42,
      new Set(),
      profile,
      framing,
    )
    const serialized = serialize(source)

    expect(serialized.framing).toEqual(framing)
    expect(serialized.framing).not.toBe(source.framing)
    expect(serialized.framing?.pageFrame).not.toBe(source.framing?.pageFrame)
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

  it('accepts v1 without profile/framing, v2 with profile only, and v3 with both', () => {
    const v1 = makePreset('circles', 'p', { count: 24 }, 42, new Set())
    const v2 = makePreset('circles', 'p', { count: 24 }, 42, new Set(), profile)
    const v3 = makePreset(
      'circles',
      'p',
      { count: 24 },
      42,
      new Set(),
      profile,
      framing,
    )
    expect(deserialize(serialize(v1)).version).toBe(1)
    expect(deserialize(serialize(v2)).version).toBe(2)
    expect(deserialize(serialize(v3)).version).toBe(3)
  })

  it('rejects an unsupported version (not 1, 2, or 3)', () => {
    const bad = { ...serialize(makePreset('circles', 'p', {}, 1, new Set())), version: 4 }
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

  it('rejects a v1 record that carries framing', () => {
    expect(() =>
      deserialize({
        version: 1,
        sketch: 'circles',
        name: 'p',
        seed: 1,
        params: {},
        locks: [],
        framing,
      }),
    ).toThrow(/version 1 record must not carry `framing`/)
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

  it('rejects a v2 record that carries framing', () => {
    expect(() =>
      deserialize({
        version: 2,
        sketch: 'circles',
        name: 'p',
        seed: 1,
        params: {},
        locks: [],
        profile,
        framing,
      }),
    ).toThrow(/version 2 record must not carry `framing`/)
  })

  it('rejects a v3 record missing either its profile or framing', () => {
    const base = {
      version: 3,
      sketch: 'circles',
      name: 'p',
      seed: 1,
      params: {},
      locks: [],
    }
    expect(() => deserialize({ ...base, framing })).toThrow(/carry a `profile`/)
    expect(() => deserialize({ ...base, profile })).toThrow(/carry `framing`/)
  })

  it.each([
    [{ ...framing, generationAspect: Number.POSITIVE_INFINITY }, /generationAspect/],
    [{ ...framing, generationAspect: -1 }, /generationAspect/],
    [{ ...framing, aspectLocked: null }, /aspectLocked/],
    [{ ...framing, pageFrame: { ...framing.pageFrame, height: 0 } }, /height/],
  ])('rejects malformed v3 framing', (invalid, message) => {
    expect(() =>
      deserialize({
        version: 3,
        sketch: 'circles',
        name: 'p',
        seed: 1,
        params: {},
        locks: [],
        profile,
        framing: invalid,
      }),
    ).toThrow(message)
  })

  it.each([
    [{ version: 1, profile }, /version 1.*not.*profile/],
    [{ version: 2 }, /version 2.*carry.*profile/],
    [{ version: 2, profile, framing }, /version 2.*not.*framing/],
    [{ version: 3, profile }, /version 3.*carry.*framing/],
  ])('rejects invalid version/field combinations during serialize', (fields, message) => {
    const base = makePreset('circles', 'p', {}, 1, new Set())
    expect(() => serialize({ ...base, ...fields } as never)).toThrow(message)
  })

  it('rejects malformed framing during serialize', () => {
    const preset = makePreset(
      'circles',
      'p',
      {},
      1,
      new Set(),
      profile,
      framing,
    )
    expect(() =>
      serialize({
        ...preset,
        framing: { ...framing, generationAspect: 0 },
      }),
    ).toThrow(/generationAspect/)
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

  const conditionalSchema: ParamSchema = {
    strategy: {
      kind: 'choice',
      default: 'scribble',
      options: [
        { value: 'scribble', label: 'Scribble' },
        { value: 'stipple', label: 'Stippling' },
      ],
    },
    pathDensity: {
      kind: 'number',
      min: 0,
      max: 1,
      default: 0.4,
      activeWhen: { key: 'strategy', equals: 'scribble' },
    },
    stippleDensity: {
      kind: 'number',
      min: 0,
      max: 1,
      default: 0.6,
      activeWhen: { key: 'strategy', equals: 'stipple' },
    },
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

  it('defaults missing Choice and dependent fields from the complete live schema', () => {
    const preset = makePreset('tone-calibration', 'legacy', {}, 1, new Set())

    expect(applyPreset(conditionalSchema, preset).params).toEqual({
      strategy: 'scribble',
      pathDensity: 0.4,
      stippleDensity: 0.6,
    })
  })

  it('preserves stored active and inactive authored values through reconciliation', () => {
    const preset = makePreset(
      'tone-calibration',
      'stippled',
      {
        strategy: 'stipple',
        pathDensity: 0.17,
        stippleDensity: 0.83,
        removed: 'drop-me',
      },
      'choice-seed',
      new Set(['strategy', 'pathDensity']),
    )

    const state = applyPreset(conditionalSchema, preset)

    expect(state.params).toEqual({
      strategy: 'stipple',
      pathDensity: 0.17,
      stippleDensity: 0.83,
    })
    expect(state.seed).toBe('choice-seed')
    expect(state.locks).toEqual(['pathDensity', 'strategy'])
  })

  it('keeps a stored dependent value while defaulting its missing Choice controller', () => {
    const preset = makePreset(
      'tone-calibration',
      'missing-controller',
      { stippleDensity: 0.91 },
      1,
      new Set(),
    )

    expect(applyPreset(conditionalSchema, preset).params).toEqual({
      strategy: 'scribble',
      pathDensity: 0.4,
      stippleDensity: 0.91,
    })
  })

  it.each([
    ['an undeclared string', 'unknown'],
    ['a non-string value', 7],
  ])('rejects %s for a stored Choice', (_description, strategy) => {
    const preset = makePreset(
      'tone-calibration',
      'malformed-choice',
      { strategy },
      1,
      new Set(),
    )

    expect(() => applyPreset(conditionalSchema, preset)).toThrow(
      /Choice param `strategy` value must be one of its declared option values/,
    )
  })

  it('validates Choice and applicability declarations at the apply boundary', () => {
    const malformedSchema = {
      ...conditionalSchema,
      stippleDensity: {
        ...conditionalSchema.stippleDensity!,
        activeWhen: { key: 'strategy', equals: 'missing-option' },
      },
    } as ParamSchema
    const preset = makePreset('tone-calibration', 'p', {}, 1, new Set())

    expect(() => applyPreset(malformedSchema, preset)).toThrow(
      /activeWhen equals must be a declared option/,
    )
  })

  it('preserves unclamped numeric values even when their controls are inactive', () => {
    const preset = makePreset(
      'tone-calibration',
      'unclamped-inactive',
      {
        strategy: 'stipple',
        pathDensity: 9999,
        stippleDensity: -50,
      },
      1,
      new Set(),
    )

    expect(applyPreset(conditionalSchema, preset).params).toEqual({
      strategy: 'stipple',
      pathDensity: 9999,
      stippleDensity: -50,
    })
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
    expect(state.locks).not.toBe(preset.locks)
  })

  it('surfaces a defensive copy of the stored profile for a v2 preset', () => {
    const preset = makePreset('circles', 'p', { count: 30 }, 1, new Set(), profile)
    const state = applyPreset(schema, preset)
    expect(state.profile).toEqual(profile)
    expect(state.profile).not.toBe(preset.profile)
    expect(state.profile?.insets).not.toBe(preset.profile?.insets)
    expect('framing' in state).toBe(false)
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
    expect(state.framing).toBeUndefined()
  })

  it('applies a validated defensive framing snapshot for a v3 preset', () => {
    const preset = makePreset(
      'circles',
      'p',
      { count: 30 },
      1,
      new Set(),
      profile,
      framing,
    )
    const state = applyPreset(schema, preset)

    expect(state.framing).toEqual(framing)
    expect(state.framing).not.toBe(preset.framing)
    expect(state.framing?.pageFrame).not.toBe(preset.framing?.pageFrame)
  })

  it('throws on a wrong-version preset even when reached directly', () => {
    const bad = { ...makePreset('circles', 'p', {}, 1, new Set()), version: 4 as 1 }
    expect(() => applyPreset(schema, bad)).toThrow(/version/)
  })

  it.each([
    [{ version: 1, profile }, /version 1.*not.*profile/],
    [{ version: 2 }, /version 2.*carry.*profile/],
    [{ version: 3, profile }, /version 3.*carry.*framing/],
  ])('rejects invalid version/field combinations during apply', (fields, message) => {
    const base = makePreset('circles', 'p', {}, 1, new Set())
    expect(() => applyPreset(schema, { ...base, ...fields } as never)).toThrow(
      message,
    )
  })

  it('rejects malformed framing during apply', () => {
    const preset = makePreset(
      'circles',
      'p',
      {},
      1,
      new Set(),
      profile,
      framing,
    )
    expect(() =>
      applyPreset(schema, {
        ...preset,
        framing: { ...framing, aspectLocked: 'yes' as never },
      }),
    ).toThrow(/aspectLocked/)
  })
})

describe('round-trip fidelity (no-drift case)', () => {
  it('round-trips Choice and inactive values without changing the Preset envelope', () => {
    const schema: ParamSchema = {
      strategy: {
        kind: 'choice',
        default: 'scribble',
        options: [
          { value: 'scribble', label: 'Scribble' },
          { value: 'stipple', label: 'Stippling' },
        ],
      },
      pathDensity: {
        kind: 'number',
        min: 0,
        max: 1,
        default: 0.4,
        activeWhen: { key: 'strategy', equals: 'scribble' },
      },
      stippleDensity: {
        kind: 'number',
        min: 0,
        max: 1,
        default: 0.6,
        activeWhen: { key: 'strategy', equals: 'stipple' },
      },
    }
    const params = {
      strategy: 'stipple',
      pathDensity: 0.19,
      stippleDensity: 0.81,
    }
    const wireValue = JSON.parse(
      JSON.stringify(
        serialize(
          makePreset(
            'tone-calibration',
            'choice-round-trip',
            params,
            9,
            new Set(['strategy']),
          ),
        ),
      ),
    )

    expect(wireValue.version).toBe(1)
    expect(Object.keys(wireValue).sort()).toEqual([
      'locks',
      'name',
      'params',
      'seed',
      'sketch',
      'version',
    ])
    expect(applyPreset(schema, deserialize(wireValue))).toEqual({
      params,
      seed: 9,
      locks: ['strategy'],
      profile: undefined,
    })
  })

  it('round-trips a fixed-page result exactly in v3 without persisting transient edit state', () => {
    const schema: ParamSchema = {
      count: { kind: 'number', min: 1, max: 80, default: 24 },
    }
    const saved = makePreset(
      'circles',
      'fixed-page',
      { count: 30 },
      'fixed-page-seed',
      new Set(['count']),
      fixedPageProfile,
      fixedPageFraming,
    )
    const wireValue = JSON.parse(JSON.stringify(serialize(saved)))
    const state = applyPreset(schema, deserialize(wireValue))

    expect(PRESET_VERSION).toBe(3)
    expect(wireValue.version).toBe(3)
    expect(Object.keys(wireValue).sort()).toEqual([
      'framing',
      'locks',
      'name',
      'params',
      'profile',
      'seed',
      'sketch',
      'version',
    ])
    expect(Object.keys(wireValue.framing).sort()).toEqual([
      'aspectLocked',
      'generationAspect',
      'pageFrame',
    ])
    expect(Object.keys(wireValue.framing.pageFrame).sort()).toEqual([
      'height',
      'width',
      'x',
      'y',
    ])
    for (const field of [
      'scale',
      'center',
      'fitReference',
      'editMode',
      'compositionTransform',
    ]) {
      expect(field in wireValue).toBe(false)
      expect(field in wireValue.framing).toBe(false)
    }
    expect(state).toEqual({
      params: { count: 30 },
      seed: 'fixed-page-seed',
      locks: ['count'],
      profile: fixedPageProfile,
      framing: fixedPageFraming,
    })
  })

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

  it('round-trips an authored Image Asset ID through the existing v2 envelope without interpreting it', () => {
    const imageAssetDefault = 'bundled-default-000000000000'
    const authoredImageAsset = 'missing/opaque ID?variant=🌲'
    const schema: ParamSchema = {
      imageAsset: { kind: 'image-asset', default: imageAssetDefault },
      toneGamma: { kind: 'number', min: 0, max: 1, default: 0.5 },
    }
    const liveParams: Params = {
      imageAsset: authoredImageAsset,
      toneGamma: 0.75,
    }

    const saved = makePreset(
      'photo-scribble',
      'opaque-asset',
      liveParams,
      'asset-roundtrip-seed',
      new Set(['imageAsset']),
      profile,
    )
    const wireValue = JSON.parse(JSON.stringify(serialize(saved)))
    const loaded = deserialize(wireValue)
    const state = applyPreset(schema, loaded)

    expect(saved.version).toBe(2)
    expect(saved.params.imageAsset).toBe(authoredImageAsset)
    expect(wireValue.params.imageAsset).toBe(authoredImageAsset)
    expect(loaded.params.imageAsset).toBe(authoredImageAsset)
    expect(state).toEqual({
      params: liveParams,
      seed: 'asset-roundtrip-seed',
      locks: ['imageAsset'],
      profile,
    })
  })

  it('defaults only an absent Image Asset key after a v2 transport round-trip', () => {
    const schema: ParamSchema = {
      imageAsset: {
        kind: 'image-asset',
        default: 'bundled-default-000000000000',
      },
    }
    const loaded = deserialize(
      JSON.parse(
        JSON.stringify(
          serialize(
            makePreset(
              'photo-scribble',
              'legacy-without-image',
              {},
              7,
              new Set(),
              profile,
            ),
          ),
        ),
      ),
    )

    expect(loaded.version).toBe(2)
    expect('imageAsset' in loaded.params).toBe(false)
    expect(applyPreset(schema, loaded).params.imageAsset).toBe(
      'bundled-default-000000000000',
    )
  })
})
