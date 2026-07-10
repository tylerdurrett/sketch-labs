import { describe, expect, it } from 'vitest'

import { createRegistry, registry } from '../registry'
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

  it('registers every built-in under a unique id', () => {
    const ids = registry.list().map((sketch) => sketch.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
