import { describe, expect, it } from 'vitest'

import { defaultParams } from '../sketch'
import type { ParamSchema } from '../sketch'

describe('defaultParams', () => {
  it('returns an empty params object for an empty schema', () => {
    expect(defaultParams({})).toEqual({})
  })

  it('returns the single key set to its spec default', () => {
    const schema: ParamSchema = {
      count: { kind: 'number', min: 1, max: 80, default: 24 },
    }
    expect(defaultParams(schema)).toEqual({ count: 24 })
  })

  it('returns every key of a multi-key schema set to its spec default', () => {
    const schema: ParamSchema = {
      count: { kind: 'number', min: 1, max: 80, default: 24 },
      minRadius: { kind: 'number', min: 2, max: 100, default: 12 },
      maxRadius: { kind: 'number', min: 2, max: 200, default: 60 },
    }
    expect(defaultParams(schema)).toEqual({
      count: 24,
      minRadius: 12,
      maxRadius: 60,
    })
  })

  it('returns the raw default for an integer-marked param (no rounding/coercion)', () => {
    const schema: ParamSchema = {
      sides: { kind: 'number', min: 3, max: 12, default: 6, integer: true },
    }
    expect(defaultParams(schema)).toEqual({ sides: 6 })
  })
})
