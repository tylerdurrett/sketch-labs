import { describe, expect, it } from 'vitest'

import {
  createRegistry,
  grassHills,
  registry,
  scribbleMoon,
  toneCalibration,
} from '../index'
import { circles } from '../sketches/circles'
import type { Sketch } from '../sketch'

/** A throwaway second Sketch so tests can exercise multi-entry indexing. */
const dummy: Sketch = {
  id: 'dummy',
  name: 'Dummy',
  schema: {},
  generate: () => ({ space: { width: 1, height: 1 }, primitives: [] }),
}

describe('createRegistry', () => {
  it('indexes Sketches by id and resolves them via get', () => {
    const reg = createRegistry([circles, dummy])
    expect(reg.get('circles')).toBe(circles)
    expect(reg.get('dummy')).toBe(dummy)
  })

  it('lists all Sketches in registration order', () => {
    const reg = createRegistry([circles, dummy])
    expect(reg.list()).toEqual([circles, dummy])
  })

  it('throws on an unknown id rather than returning a fallback', () => {
    const reg = createRegistry([circles])
    expect(() => reg.get('does-not-exist')).toThrow(/Unknown Sketch id/)
  })

  it('throws on a duplicate id', () => {
    expect(() => createRegistry([circles, circles])).toThrow(/Duplicate Sketch id/)
  })
})

describe('the default registry', () => {
  it('contains the circles Sketch keyed by its id', () => {
    expect(registry.get('circles')).toBe(circles)
    expect(registry.list()).toContain(circles)
  })

  it('exposes grass hills through the public catalog exactly once', () => {
    expect(grassHills.id).toBe('grass-hills')
    expect(grassHills.name).toBe('Grass Hills')
    expect(registry.get('grass-hills')).toBe(grassHills)
    expect(registry.list().filter((sketch) => sketch === grassHills)).toEqual([grassHills])
  })

  it('exports and registers Scribble Moon exactly once', () => {
    expect(scribbleMoon.id).toBe('scribble-moon')
    expect(scribbleMoon.name).toBe('Scribble Moon')
    expect(registry.get('scribble-moon')).toBe(scribbleMoon)
    expect(
      registry.list().filter((sketch) => sketch === scribbleMoon),
    ).toEqual([scribbleMoon])
  })

  it(
    'exports and registers Tone Calibration exactly once as the newest Sketch',
    () => {
      expect(toneCalibration.id).toBe('tone-calibration')
      expect(toneCalibration.name).toBe('Tone Calibration')
      expect(registry.get('tone-calibration')).toBe(toneCalibration)
      expect(
        registry.list().filter((sketch) => sketch === toneCalibration),
      ).toEqual([toneCalibration])
      expect(registry.list().at(-1)).toBe(toneCalibration)
    },
  )

  it('registers every built-in under a unique id and display name', () => {
    const sketches = registry.list()
    const ids = sketches.map((sketch) => sketch.id)
    const names = sketches.map((sketch) => sketch.name)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(names).size).toBe(names.length)
  })
})
