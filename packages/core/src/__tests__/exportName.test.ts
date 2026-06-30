import { describe, expect, it } from 'vitest'

import { exportFilename } from '../exportName'

describe('exportFilename', () => {
  it('omits the -t segment for a static Sketch (no t supplied)', () => {
    expect(exportFilename({ sketchId: 'circles', seed: 42 }, 'png')).toBe(
      'circles-seed42.png',
    )
  })

  it('includes the -t segment for a time-driven Sketch (t supplied)', () => {
    expect(
      exportFilename({ sketchId: 'circles', seed: 42, t: 1.5 }, 'png'),
    ).toBe('circles-seed42-t1.5.png')
  })

  it('includes the -t segment even when the captured t is 0', () => {
    // A time-driven Sketch paused at the start still carries its time segment —
    // an OMITTED t is the static case, t = 0 is a real captured moment.
    expect(exportFilename({ sketchId: 'circles', seed: 7, t: 0 }, 'png')).toBe(
      'circles-seed7-t0.png',
    )
  })

  it('accepts a string seed verbatim', () => {
    expect(exportFilename({ sketchId: 'waves', seed: 'abc' }, 'png')).toBe(
      'waves-seedabc.png',
    )
  })

  it('appends the given extension (reused by other export paths)', () => {
    expect(exportFilename({ sketchId: 'circles', seed: 1 }, 'svg')).toBe(
      'circles-seed1.svg',
    )
  })
})
