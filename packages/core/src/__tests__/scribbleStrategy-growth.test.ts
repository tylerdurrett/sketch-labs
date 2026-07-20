import { describe, expect, it } from 'vitest'

import { createRandom } from '../random'
import { createScribbleScaleField } from '../scribbleScaleField'
import { createShadingMask, createToneField } from '../shadingFields'
import { chooseScribbleGrowthStep } from '../scribbleStrategy/growth'
import { createScribbleModel } from '../scribbleStrategy/model'
import type { ScribbleControls } from '../scribbleStrategy/types'
import type { Point } from '../types'

const FRAME = { width: 100, height: 100 }

function model(
  controls: Partial<ScribbleControls> = {},
  mask = createShadingMask(() => 1),
) {
  return createScribbleModel(
    { toneField: createToneField(() => 1), shadingMask: mask },
    FRAME,
    controls,
  )
}

function fieldModel(
  sample: (point: Readonly<Point>) => number,
  mask = createShadingMask(() => 1),
) {
  return createScribbleModel(
    { toneField: createToneField(() => 1), shadingMask: mask },
    FRAME,
    {},
    createScribbleScaleField(1, sample),
  )
}

function segmentLength(
  current: Readonly<Point>,
  step: ReturnType<typeof chooseScribbleGrowthStep>,
): number {
  expect(step.kind).toBe('advanced')
  return step.kind === 'advanced'
    ? Math.hypot(step.point[0] - current[0], step.point[1] - current[1])
    : 0
}

function growHeadings(
  seed: string,
  controls: Partial<ScribbleControls> = {},
  count = 20,
): number[] {
  const residual = model(controls)
  const rng = createRandom(seed)
  let current: Point = [50, 50]
  let heading: number | undefined
  const headings: number[] = []

  for (let step = 0; step < count; step++) {
    const next = chooseScribbleGrowthStep({
      model: residual,
      rng,
      current,
      heading,
    })
    if (next.kind === 'stagnated') break
    residual.depositSegment(current, next.point)
    current = next.point
    heading = next.heading
    headings.push(next.heading)
  }

  return headings
}

function totalTurning(headings: readonly number[]): number {
  let total = 0
  for (let index = 1; index < headings.length; index++) {
    const delta = headings[index]! - headings[index - 1]!
    total += Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta)))
  }
  return total
}

describe('Scribble candidate growth', () => {
  it('repeats the exact heading sequence for the same inputs and Seed', () => {
    const first = growHeadings('same-growth-seed')
    const second = growHeadings('same-growth-seed')

    expect(first.length).toBeGreaterThan(5)
    expect(second).toEqual(first)
  })

  it('uses Seeded weighted routing to break a symmetric target differently', () => {
    const routes = ['route-a', 'route-b', 'route-c', 'route-d'].map((seed) =>
      growHeadings(seed, { chaos: 0.5 }, 12),
    )

    expect(
      new Set(routes.map((route) => JSON.stringify(route))).size,
    ).toBeGreaterThan(1)
  })

  it('makes high Momentum reduce aggregate turning', () => {
    const seeds = Array.from({ length: 16 }, (_, index) => `momentum-${index}`)
    const lowTurning = seeds.reduce(
      (sum, seed) =>
        sum + totalTurning(growHeadings(seed, { momentum: 0, chaos: 0.7 })),
      0,
    )
    const highTurning = seeds.reduce(
      (sum, seed) =>
        sum + totalTurning(growHeadings(seed, { momentum: 1, chaos: 0.7 })),
      0,
    )

    expect(highTurning).toBeLessThan(lowTurning)
  })

  it('lets Chaos widen viable variation without mutating source/model samples', () => {
    const low = model({ momentum: 0, chaos: 0 })
    const high = model({ momentum: 0, chaos: 1 })
    const lowSamples = low.samples()
    const highSamples = high.samples()
    const seeds = Array.from({ length: 24 }, (_, index) => `chaos-${index}`)

    function selectedTurns(residual: ReturnType<typeof model>): number[] {
      return seeds.map((seed) => {
        const next = chooseScribbleGrowthStep({
          model: residual,
          rng: createRandom(seed),
          current: [50, 50],
          heading: 0,
        })
        expect(next.kind).toBe('advanced')
        return next.kind === 'advanced' ? Math.abs(next.heading) : 0
      })
    }

    const lowTurns = selectedTurns(low)
    const highTurns = selectedTurns(high)

    expect(Math.max(...highTurns)).toBeGreaterThan(Math.max(...lowTurns))
    expect(low.samples()).toEqual(lowSamples)
    expect(high.samples()).toEqual(highSamples)
    expect(highSamples).toEqual(lowSamples)
  })

  it('steers from linearly permission-weighted residual without squaring permission', () => {
    const softRight = createShadingMask(([x]) => (x > 50 ? 0.5 : 1))
    const controlled = {
      ...model({ momentum: 0, chaos: 0 }, softRight),
      // Right-side demand wins when these already-weighted residuals are used
      // directly (0.5 > 0.4). Multiplying permission again would reverse the
      // ranking (0.25 < 0.4) and choose the left side with this scripted draw.
      residualAt([x]: Readonly<Point>): number {
        return x > 50 ? 0.5 : 0.4
      },
    }
    const fallback = createRandom('linear-permission-fallback')
    const next = chooseScribbleGrowthStep({
      model: controlled,
      rng: {
        ...fallback,
        range(min: number, max: number): number {
          return (min + max) / 2
        },
        value(): number {
          return 0.3
        },
      },
      current: [50, 50],
    })

    expect(next.kind).toBe('advanced')
    if (next.kind === 'advanced') expect(next.point[0]).toBeGreaterThan(50)
  })

  it('never considers a segment that crosses an exact-zero barrier', () => {
    const barrier = createShadingMask(([x]) => (x >= 50 && x <= 51 ? 0 : 1))
    const residual = createScribbleModel(
      {
        toneField: createToneField(([x]) => (x > 50 ? 1 : 0)),
        shadingMask: barrier,
      },
      FRAME,
      { chaos: 1 },
    )

    for (let index = 0; index < 100; index++) {
      const next = chooseScribbleGrowthStep({
        model: residual,
        rng: createRandom(`barrier-${index}`),
        current: [49.5, 50],
        heading: 0,
      })
      expect(next).toEqual({
        kind: 'stagnated',
        reason: 'no-viable-candidate',
      })
    }
  })

  it('reports deterministic local stagnation when no candidate is viable', () => {
    const isolated = createShadingMask(([x, y]) =>
      Math.hypot(x - 50, y - 50) < 0.25 ? 1 : 0,
    )
    const input = {
      model: model({ chaos: 1 }, isolated),
      current: [50, 50] as Point,
      heading: 0,
    }
    const first = chooseScribbleGrowthStep({
      ...input,
      rng: createRandom('stagnation'),
    })
    const second = chooseScribbleGrowthStep({
      ...input,
      rng: createRandom('stagnation'),
    })

    expect(first).toEqual({
      kind: 'stagnated',
      reason: 'no-viable-candidate',
    })
    expect(second).toEqual(first)
  })

  it('uses a constant broad field as the local candidate length', () => {
    const current: Point = [50, 50]
    const residual = fieldModel(() => 2)
    const next = chooseScribbleGrowthStep({
      model: residual,
      rng: createRandom('constant-broad-field'),
      current,
      heading: 0,
    })

    expect(segmentLength(current, next)).toBeCloseTo(
      residual.scales.segmentLength * 2,
      12,
    )
  })

  it('responds continuously to broad local scale values', () => {
    const current: Point = [50, 50]
    const scales = [1.1, 1.35, 1.7, 2].map((scale) => {
      const residual = fieldModel(() => scale)
      return segmentLength(
        current,
        chooseScribbleGrowthStep({
          model: residual,
          rng: createRandom('continuous-field-response'),
          current,
          heading: 0,
        }),
      )
    })

    expect(scales).toEqual([...scales].sort((a, b) => a - b))
    expect(scales).toEqual([
      expect.closeTo(1.32, 12),
      expect.closeTo(1.62, 12),
      expect.closeTo(2.04, 12),
      expect.closeTo(2.4, 12),
    ])
  })

  it('detects a narrow fine band between broad ray endpoints', () => {
    const current: Point = [50, 50]
    const residual = fieldModel((point) => {
      const radius = Math.hypot(point[0] - current[0], point[1] - current[1])
      return radius >= 1.7 && radius <= 2 ? 1 : 3
    })
    const next = chooseScribbleGrowthStep({
      model: residual,
      rng: createRandom('narrow-fine-band'),
      current,
      heading: 0,
    })

    expect(segmentLength(current, next)).toBeCloseTo(
      residual.scales.segmentLength,
      12,
    )
    if (next.kind === 'advanced') {
      expect(
        Math.hypot(next.point[0] - current[0], next.point[1] - current[1]),
      ).toBeLessThan(1.7)
    }
  })

  it('does not stagnate solely because a field ray contains fine scale', () => {
    const current: Point = [50, 50]
    const residual = fieldModel((point) => {
      const radius = Math.hypot(point[0] - current[0], point[1] - current[1])
      return radius >= 1.7 && radius <= 2 ? 1 : 3
    })

    for (let index = 0; index < 40; index++) {
      expect(
        chooseScribbleGrowthStep({
          model: residual,
          rng: createRandom(`scale-only-${index}`),
          current,
          heading: 0,
        }).kind,
      ).toBe('advanced')
    }
  })

  it('does not consume shared RNG draws while profiling a field', () => {
    function callsFor(residual: ReturnType<typeof model>) {
      const source = createRandom('profile-rng-count')
      let rangeCalls = 0
      let valueCalls = 0
      const next = chooseScribbleGrowthStep({
        model: residual,
        rng: {
          ...source,
          range(min: number, max: number): number {
            rangeCalls++
            return source.range(min, max)
          },
          value(): number {
            valueCalls++
            return source.value()
          },
        },
        current: [50, 50],
        heading: 0,
      })

      expect(next.kind).toBe('advanced')
      return { rangeCalls, valueCalls }
    }

    expect(callsFor(fieldModel(() => 2))).toEqual(callsFor(model()))
    expect(callsFor(fieldModel(() => 2))).toEqual({
      rangeCalls: 17,
      valueCalls: 1,
    })
  })

  it('shortens demand look-ahead through the same field-safe path', () => {
    const current: Point = [50, 50]
    const demandSamples: Point[] = []
    const base = fieldModel((point) => {
      const radius = Math.hypot(point[0] - current[0], point[1] - current[1])
      return radius >= 2.9 && radius <= 3.2 ? 1 : 3
    })
    const residual = {
      ...base,
      residualAt(point: Readonly<Point>): number {
        demandSamples.push([point[0], point[1]])
        return 1
      },
    }

    const next = chooseScribbleGrowthStep({
      model: residual,
      rng: createRandom('field-look-ahead'),
      current,
      heading: 0,
    })

    expect(next.kind).toBe('advanced')
    expect(
      Math.max(
        ...demandSamples.map((point) =>
          Math.hypot(point[0] - current[0], point[1] - current[1]),
        ),
      ),
    ).toBeCloseTo(base.scales.segmentLength * 2, 12)
  })

  it('keeps field sampling and seeded routing deterministic without model mutation', () => {
    function run(seed: string) {
      const sampledPoints: Point[] = []
      const residual = fieldModel((point) => {
        sampledPoints.push([point[0], point[1]])
        return 1.5 + (point[0] >= 50 ? 0.5 : 0)
      })
      const samplesBefore = residual.samples()
      const next = chooseScribbleGrowthStep({
        model: residual,
        rng: createRandom(seed),
        current: [50, 50],
      })

      return {
        next,
        sampledPoints,
        samplesAfter: residual.samples(),
        samplesBefore,
      }
    }

    const first = run('field-route-a')
    const repeated = run('field-route-a')
    const changed = run('field-route-b')

    expect(repeated).toEqual(first)
    expect(changed.next).not.toEqual(first.next)
    expect(first.samplesAfter).toEqual(first.samplesBefore)
    expect(changed.samplesAfter).toEqual(first.samplesBefore)
  })

  it('checks a field-aware candidate against mask barriers', () => {
    const current: Point = [50, 50]
    const barrier = createShadingMask((point) => {
      const radius = Math.hypot(point[0] - current[0], point[1] - current[1])
      return radius >= 0.22 && radius <= 0.32 ? 0 : 1
    })
    const residual = fieldModel((point) => {
      const radius = Math.hypot(point[0] - current[0], point[1] - current[1])
      return radius >= 0.5 && radius <= 0.8 ? 1 : 3
    }, barrier)

    expect(
      chooseScribbleGrowthStep({
        model: residual,
        rng: createRandom('field-mask-barrier'),
        current,
        heading: 0,
      }),
    ).toEqual({ kind: 'stagnated', reason: 'no-viable-candidate' })
  })
})
