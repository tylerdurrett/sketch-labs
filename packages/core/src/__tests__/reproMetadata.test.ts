import { describe, expect, it } from 'vitest'

import type { PlotProfile } from '../plotProfile'
import { PRESET_VERSION } from '../preset'
import { buildReproMetadata, reproFilenameStem } from '../reproMetadata'

/**
 * These prove the embedded payload reuses the {@link Preset} envelope (no new
 * schema) plus the frame time `t`, and that `name` carries the export filename
 * STEM. Without an active profile the JSON parses back to the v1 shape
 * `{ version:1, sketch, name, seed, params, locks, t? }`; supplying a profile
 * makes it the v2 shape that also carries `profile`.
 */

/** A valid active Output Profile: A4 landscape with symmetric 10 mm insets. */
const profile: PlotProfile = {
  width: 297,
  height: 210,
  insets: { top: 10, right: 10, bottom: 10, left: 10 },
  includeFrame: true,
  toolWidthMillimeters: 0.3,
}

describe('reproFilenameStem', () => {
  it('omits the -t segment (and the extension) for a static Sketch', () => {
    expect(reproFilenameStem({ sketchId: 'circles', seed: 42 })).toBe(
      'circles-seed42',
    )
  })

  it('includes the -t segment for a time-driven Sketch', () => {
    expect(reproFilenameStem({ sketchId: 'waves', seed: 7, t: 1.5 })).toBe(
      'waves-seed7-t1.5',
    )
  })

  it('includes -t0 (a real captured moment, not the static case)', () => {
    expect(reproFilenameStem({ sketchId: 'waves', seed: 7, t: 0 })).toBe(
      'waves-seed7-t0',
    )
  })
})

describe('buildReproMetadata', () => {
  it('serializes the full v1 Preset envelope plus t for a timed Sketch (no profile)', () => {
    const json = buildReproMetadata({
      sketchId: 'waves',
      seed: 123,
      params: { radius: 10, count: 5 },
      locks: new Set(['count', 'radius']),
      t: 2.5,
    })

    expect(JSON.parse(json)).toEqual({
      version: 1,
      sketch: 'waves',
      name: 'waves-seed123-t2.5',
      seed: 123,
      params: { radius: 10, count: 5 },
      locks: ['count', 'radius'],
      t: 2.5,
    })
  })

  it('omits t for a static Sketch and stems the name without -t', () => {
    const json = buildReproMetadata({
      sketchId: 'circles',
      seed: 42,
      params: { radius: 10 },
      locks: new Set(),
      t: undefined,
    })
    const parsed = JSON.parse(json)

    expect(parsed).toEqual({
      version: 1,
      sketch: 'circles',
      name: 'circles-seed42',
      seed: 42,
      params: { radius: 10 },
      locks: [],
    })
    // The static case carries NO `t` key (absent, not 0).
    expect('t' in parsed).toBe(false)
  })

  it('keeps t=0 (a captured moment) in the payload', () => {
    const parsed = JSON.parse(
      buildReproMetadata({
        sketchId: 'waves',
        seed: 1,
        params: {},
        locks: new Set(),
        t: 0,
      }),
    )
    expect(parsed.t).toBe(0)
    expect(parsed.name).toBe('waves-seed1-t0')
  })

  it('sorts locks (the serialized form is stable/diffable)', () => {
    const parsed = JSON.parse(
      buildReproMetadata({
        sketchId: 'a',
        seed: 1,
        params: { x: 1 },
        locks: new Set(['z', 'a', 'm']),
      }),
    )
    expect(parsed.locks).toEqual(['a', 'm', 'z'])
  })

  it('does not alias the caller’s live params object', () => {
    const params = { radius: 10 }
    const json = buildReproMetadata({
      sketchId: 'circles',
      seed: 1,
      params,
      locks: new Set(),
    })
    params.radius = 999
    expect(JSON.parse(json).params.radius).toBe(10)
  })

  it('embeds a v2 envelope carrying the profile when one is supplied', () => {
    const json = buildReproMetadata({
      sketchId: 'waves',
      seed: 123,
      params: { radius: 10 },
      locks: new Set(['radius']),
      t: 2.5,
      profile,
    })

    expect(JSON.parse(json)).toEqual({
      version: PRESET_VERSION,
      sketch: 'waves',
      name: 'waves-seed123-t2.5',
      seed: 123,
      params: { radius: 10 },
      locks: ['radius'],
      profile,
      t: 2.5,
    })
    expect(PRESET_VERSION).toBe(2)
  })

  it.each([true, false])(
    'embeds the active includeFrame=%s value exactly',
    (includeFrame) => {
      const parsed = JSON.parse(
        buildReproMetadata({
          sketchId: 'waves',
          seed: 123,
          params: { radius: 10 },
          locks: new Set(),
          profile: { ...profile, includeFrame },
        }),
      )

      expect(parsed.version).toBe(PRESET_VERSION)
      expect(parsed.profile.includeFrame).toBe(includeFrame)
    },
  )

  it('stays a v1 envelope with NO profile key when none is supplied', () => {
    const parsed = JSON.parse(
      buildReproMetadata({
        sketchId: 'circles',
        seed: 42,
        params: { radius: 10 },
        locks: new Set(),
      }),
    )
    expect(parsed.version).toBe(1)
    expect('profile' in parsed).toBe(false)
  })

  it('does not alias the caller’s live profile object', () => {
    const live: PlotProfile = {
      width: 297,
      height: 210,
      insets: { top: 10, right: 10, bottom: 10, left: 10 },
      includeFrame: true,
      toolWidthMillimeters: 0.3,
    }
    const json = buildReproMetadata({
      sketchId: 'circles',
      seed: 1,
      params: {},
      locks: new Set(),
      profile: live,
    })
    live.width = 999
    live.insets.top = 999
    expect(JSON.parse(json).profile).toEqual(profile)
  })
})
