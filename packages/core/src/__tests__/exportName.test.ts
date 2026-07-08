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

  it('caps the precision of a long-fraction t (rounds, no trailing-zero pad)', () => {
    // A noisy float must not bloat the name: round to a few decimals and trim
    // the padding so the segment stays compact and stable.
    expect(
      exportFilename({ sketchId: 'circles', seed: 42, t: 2.5000000001 }, 'png'),
    ).toBe('circles-seed42-t2.5.png')
    expect(
      exportFilename({ sketchId: 'circles', seed: 42, t: 1 / 3 }, 'png'),
    ).toBe('circles-seed42-t0.333.png')
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

  it('appends the -{variant} segment after the seed for a static Sketch', () => {
    expect(
      exportFilename(
        { sketchId: 'circles', seed: 42, variant: 'hidden-line' },
        'svg',
      ),
    ).toBe('circles-seed42-hidden-line.svg')
  })

  it('appends the -{variant} segment AFTER the -t{t} segment', () => {
    expect(
      exportFilename(
        { sketchId: 'waves', seed: 7, t: 2.5, variant: 'hidden-line' },
        'svg',
      ),
    ).toBe('waves-seed7-t2.5-hidden-line.svg')
  })

  it('leaves the name byte-for-byte unchanged when no variant is supplied', () => {
    // The no-variant path (explicit undefined or omitted) must match the plain
    // name exactly — the variant segment is purely additive.
    expect(
      exportFilename(
        { sketchId: 'circles', seed: 42, variant: undefined },
        'svg',
      ),
    ).toBe('circles-seed42.svg')
    expect(
      exportFilename(
        { sketchId: 'waves', seed: 7, t: 2.5, variant: undefined },
        'svg',
      ),
    ).toBe('waves-seed7-t2.5.svg')
  })
})
