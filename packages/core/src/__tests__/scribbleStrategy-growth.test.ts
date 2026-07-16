import { describe, expect, it } from 'vitest'

import { createRandom } from '../random'
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
})
