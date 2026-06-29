import { describe, expect, it } from 'vitest'

import {
  applyPreset,
  deserialize,
  makePreset,
  PRESET_VERSION,
  serialize,
} from '../preset'
import type { Params, ParamSchema } from '../sketch'

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

  it('stamps the current PRESET_VERSION and copies (does not alias) params', () => {
    const params: Params = { count: 24 }
    const preset = makePreset('circles', 'p', params, 42, new Set())
    expect(preset.version).toBe(PRESET_VERSION)
    expect(preset.params).not.toBe(params)
    expect(preset.params).toEqual({ count: 24 })
  })
})

describe('deserialize', () => {
  it('round-trips a serialized Preset', () => {
    const preset = makePreset('circles', 'p', { count: 24 }, 42, new Set(['count']))
    expect(deserialize(serialize(preset))).toEqual(preset)
  })

  it('rejects a non-1 version', () => {
    const bad = { ...makePreset('circles', 'p', {}, 1, new Set()), version: 2 }
    expect(() => deserialize(bad)).toThrow(/version/)
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

  it('throws on a wrong-version preset even when reached directly', () => {
    const bad = { ...makePreset('circles', 'p', {}, 1, new Set()), version: 2 as 1 }
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
