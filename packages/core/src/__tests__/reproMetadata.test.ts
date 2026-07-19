import { describe, expect, it } from 'vitest'

import type { PlotProfile } from '../plotProfile'
import {
  applyPreset,
  deserialize,
  PRESET_VERSION,
  type PresetFraming,
} from '../preset'
import { buildReproMetadata, reproFilenameStem } from '../reproMetadata'
import type { ParamSchema } from '../sketch'

/**
 * These prove the embedded payload reuses the {@link Preset} envelope (no new
 * schema) plus the frame time `t`, and that `name` carries the export filename
 * STEM. Without an active profile the JSON parses back to the v1 shape;
 * supplying a profile makes it v2, and supplying profile plus framing makes it
 * v3. Frame time remains an optional extension on every version.
 */

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
      version: 2,
      sketch: 'waves',
      name: 'waves-seed123-t2.5',
      seed: 123,
      params: { radius: 10 },
      locks: ['radius'],
      profile,
      t: 2.5,
    })
    expect(PRESET_VERSION).toBe(3)
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

      expect(parsed.version).toBe(2)
      expect(parsed.profile.includeFrame).toBe(includeFrame)
    },
  )

  it('serializes an exact static v3 snapshot when profile and framing are supplied', () => {
    const parsed = JSON.parse(
      buildReproMetadata({
        sketchId: 'circles',
        seed: 42,
        params: { radius: 10 },
        locks: new Set(['radius']),
        profile,
        framing,
      }),
    )

    expect(parsed).toEqual({
      version: PRESET_VERSION,
      sketch: 'circles',
      name: 'circles-seed42',
      seed: 42,
      params: { radius: 10 },
      locks: ['radius'],
      profile,
      framing,
    })
    expect('t' in parsed).toBe(false)
  })

  it('serializes an exact timed v3 snapshot including t', () => {
    expect(
      JSON.parse(
        buildReproMetadata({
          sketchId: 'waves',
          seed: 'framed-seed',
          params: { radius: 10, count: 5 },
          locks: new Set(['radius', 'count']),
          t: 2.5,
          profile,
          framing,
        }),
      ),
    ).toEqual({
      version: PRESET_VERSION,
      sketch: 'waves',
      name: 'waves-seedframed-seed-t2.5',
      seed: 'framed-seed',
      params: { radius: 10, count: 5 },
      locks: ['count', 'radius'],
      profile,
      framing,
      t: 2.5,
    })
  })

  it('round-trips framed metadata through Preset deserialize and apply', () => {
    const schema: ParamSchema = {
      count: { kind: 'number', min: 1, max: 80, default: 24 },
      radius: { kind: 'number', min: 2, max: 100, default: 12 },
    }
    const payload = JSON.parse(
      buildReproMetadata({
        sketchId: 'waves',
        seed: 'framed-seed',
        params: { count: 5, radius: 10 },
        locks: new Set(['radius', 'count']),
        t: 2.5,
        profile,
        framing,
      }),
    )

    expect(applyPreset(schema, deserialize(payload))).toEqual({
      params: { count: 5, radius: 10 },
      seed: 'framed-seed',
      locks: ['count', 'radius'],
      profile,
      framing,
    })
  })

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

  it('captures defensive profile, framing, and Page Frame snapshots', () => {
    const liveProfile: PlotProfile = {
      ...profile,
      insets: { ...profile.insets },
    }
    const liveFraming: PresetFraming = {
      ...framing,
      pageFrame: { ...framing.pageFrame },
    }
    const json = buildReproMetadata({
      sketchId: 'circles',
      seed: 1,
      params: {},
      locks: new Set(),
      profile: liveProfile,
      framing: liveFraming,
    })

    liveProfile.width = 999
    liveProfile.insets.top = 999
    liveFraming.pageFrame.x = 999
    liveFraming.generationAspect = 2
    liveFraming.aspectLocked = false

    const parsed = JSON.parse(json)
    expect(parsed.profile).toEqual(profile)
    expect(parsed.framing).toEqual(framing)
  })

  it('captures an unresolved Image Asset ID as ordinary v2 Preset state that applies exactly', () => {
    const unresolvedImageAsset = 'unresolved/opaque ID?variant=🌲'
    const schema: ParamSchema = {
      imageAsset: {
        kind: 'image-asset',
        default: 'bundled-default-000000000000',
      },
    }
    const payload = JSON.parse(
      buildReproMetadata({
        sketchId: 'photo-scribble',
        seed: 'metadata-asset-seed',
        params: { imageAsset: unresolvedImageAsset },
        locks: new Set(['imageAsset']),
        profile,
      }),
    )

    expect(payload.version).toBe(2)
    expect(payload.params.imageAsset).toBe(unresolvedImageAsset)
    expect(
      applyPreset(schema, deserialize(payload)),
    ).toEqual({
      params: { imageAsset: unresolvedImageAsset },
      seed: 'metadata-asset-seed',
      locks: ['imageAsset'],
      profile,
    })
  })
})
