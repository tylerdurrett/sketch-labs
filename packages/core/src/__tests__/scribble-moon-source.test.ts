import { describe, expect, it } from 'vitest'

import { resolveCompositionFrame } from '../compositionFrame'
import type { CoordinateSpace } from '../scene'
import { sampleEffectiveTone } from '../shadingFields'
import {
  pointOnCircle,
  pointOnEllipseArc,
  type ScribbleMoonPoint,
} from '../sketches/scribble-moon/geometry'
import {
  createScribbleMoonSource,
  type ScribbleMoonControls,
  type ScribbleMoonSource,
} from '../sketches/scribble-moon/source'

const CONTROLS: ScribbleMoonControls = Object.freeze({
  lightAngle: 25,
  terminatorSoftness: 0.4,
  toneContrast: 0.55,
  maskFeather: 0.5,
})

function source(
  overrides: Partial<ScribbleMoonControls> = {},
  frame: CoordinateSpace = resolveCompositionFrame(1),
): ScribbleMoonSource {
  return createScribbleMoonSource({ ...CONTROLS, ...overrides }, frame)
}

function expectBounded(value: number): void {
  expect(Number.isFinite(value)).toBe(true)
  expect(value).toBeGreaterThanOrEqual(0)
  expect(value).toBeLessThanOrEqual(1)
}

function samplePair(
  candidate: ScribbleMoonSource,
  point: ScribbleMoonPoint,
): readonly [number, number] {
  return [
    candidate.toneField.sample(point),
    candidate.shadingMask.sample(point),
  ]
}

function allSampleBytes(candidate: ScribbleMoonSource): Uint8Array {
  const values: number[] = []
  const { frame } = candidate.layout

  for (let row = 0; row <= 24; row += 1) {
    for (let column = 0; column <= 31; column += 1) {
      const point = [
        (column / 31) * frame.width,
        (row / 24) * frame.height,
      ] as const
      values.push(...samplePair(candidate, point))
    }
  }

  const samples = new Float64Array(values)
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
}

describe('Scribble Moon frame-relative layout', () => {
  it.each([
    ['square', 1],
    ['portrait', 2 / 3],
    ['landscape', 3 / 2],
  ])(
    'names and composes every recognizable element in a %s frame',
    (_name, aspect) => {
      const candidate = source({}, resolveCompositionFrame(aspect))
      const { layout } = candidate
      const { frame } = layout

      expect(layout.craters.map((crater) => crater.id)).toEqual([
        'mare-west',
        'mare-southeast',
        'mare-northeast',
        'mare-south',
      ])
      expect(layout.brokenRingSegments.map((segment) => segment.id)).toEqual([
        'ring-north',
        'ring-south',
      ])
      expect(layout.satellites.map((satellite) => satellite.id)).toEqual([
        'satellite-northwest',
        'satellite-southeast',
      ])
      expect(layout.structuralContours.map((contour) => contour.id)).toEqual([
        'contour-northwest',
        'contour-east',
        'contour-south',
      ])

      const contained = (point: ScribbleMoonPoint, margin = 0): void => {
        expect(point[0] - margin).toBeGreaterThanOrEqual(0)
        expect(point[0] + margin).toBeLessThanOrEqual(frame.width)
        expect(point[1] - margin).toBeGreaterThanOrEqual(0)
        expect(point[1] + margin).toBeLessThanOrEqual(frame.height)
      }

      contained(layout.sphere.center, layout.sphere.radius)
      contained(layout.halo.center, layout.halo.radius + layout.halo.width / 2)
      for (const crater of layout.craters)
        contained(crater.center, crater.radius)
      for (const satellite of layout.satellites) {
        contained(satellite.center, satellite.radius)
      }
      for (const ring of layout.brokenRingSegments) {
        for (let step = 0; step <= 180; step += 1) {
          const angle =
            ring.startAngle + (ring.endAngle - ring.startAngle) * (step / 180)
          contained(pointOnEllipseArc(ring, angle), ring.width / 2)
        }
      }
      for (const contour of layout.structuralContours) {
        contained(pointOnCircle(contour, contour.startAngle), contour.width / 2)
        contained(pointOnCircle(contour, contour.endAngle), contour.width / 2)
      }

      expect(Object.isFrozen(layout)).toBe(true)
      expect(Object.isFrozen(layout.frame)).toBe(true)
      expect(Object.isFrozen(layout.sphere)).toBe(true)
      expect(Object.isFrozen(layout.craters)).toBe(true)
      expect(Object.isFrozen(layout.brokenRingSegments[0])).toBe(true)
    },
  )

  it('places target tone and permission at every recognizable feature', () => {
    const candidate = source()
    const { layout } = candidate
    const featurePoints = [
      layout.sphere.center,
      ...layout.craters.map((crater) => crater.center),
      pointOnCircle(layout.halo, Math.PI / 2),
      ...layout.brokenRingSegments.map((ring) =>
        pointOnEllipseArc(ring, (ring.startAngle + ring.endAngle) / 2),
      ),
      ...layout.satellites.map((satellite) => satellite.center),
      ...layout.structuralContours.map((contour) =>
        pointOnCircle(contour, (contour.startAngle + contour.endAngle) / 2),
      ),
    ]

    for (const point of featurePoints) {
      expect(candidate.toneField.sample(point)).toBeGreaterThan(0)
      expect(candidate.shadingMask.sample(point)).toBe(1)
    }
  })

  it('adds crater darkness beyond the local sphere lighting baseline', () => {
    const candidate = source({ lightAngle: 90, toneContrast: 0 })
    const { sphere } = candidate.layout
    const crater = candidate.layout.craters[0]
    const sameLightingBaseline = [
      sphere.center[0] + (sphere.center[0] - crater.center[0]),
      crater.center[1],
    ] as const

    expect(candidate.toneField.sample(crater.center)).toBeGreaterThan(
      candidate.toneField.sample(sameLightingBaseline),
    )
  })

  it('adds structural-contour tone beyond nearby unmarked sphere tone', () => {
    const contour = source().layout.structuralContours.find(
      ({ id }) => id === 'contour-east',
    )!
    const contourAngle = (contour.startAngle + contour.endAngle) / 2
    const candidate = source({
      lightAngle: contourAngle * (180 / Math.PI),
      toneContrast: 0,
    })
    const onContour = pointOnCircle(contour, contourAngle)
    const offContour = pointOnCircle(
      { center: contour.center, radius: contour.radius - contour.width * 1.5 },
      contourAngle,
    )
    const outerBaseline = pointOnCircle(
      { center: contour.center, radius: contour.radius + contour.width * 1.5 },
      contourAngle,
    )

    expect(candidate.toneField.sample(onContour)).toBeGreaterThan(
      candidate.toneField.sample(offContour),
    )
    expect(candidate.toneField.sample(onContour)).toBeGreaterThan(
      candidate.toneField.sample(outerBaseline),
    )
  })
})

describe('Scribble Moon source controls', () => {
  it('rotates the sphere lit/dark relationship with Light angle', () => {
    const angleZero = source({ lightAngle: 0, terminatorSoftness: 0.2 })
    const angleHalfTurn = source({ lightAngle: 180, terminatorSoftness: 0.2 })
    const { sphere } = angleZero.layout
    const left = [
      sphere.center[0] - sphere.radius * 0.72,
      sphere.center[1],
    ] as const
    const right = [
      sphere.center[0] + sphere.radius * 0.72,
      sphere.center[1],
    ] as const

    expect(angleZero.toneField.sample(left)).toBeGreaterThan(
      angleZero.toneField.sample(right),
    )
    expect(angleHalfTurn.toneField.sample(right)).toBeGreaterThan(
      angleHalfTurn.toneField.sample(left),
    )
  })

  it('broadens the continuously softened terminator slope', () => {
    const crisp = source({ lightAngle: 0, terminatorSoftness: 0 })
    const soft = source({ lightAngle: 0, terminatorSoftness: 1 })
    const { sphere } = crisp.layout
    const darkSide = [
      sphere.center[0] - sphere.radius * 0.68,
      sphere.center[1],
    ] as const
    const lightSide = [
      sphere.center[0] - sphere.radius * 0.48,
      sphere.center[1],
    ] as const
    const crispSeparation =
      crisp.toneField.sample(darkSide) - crisp.toneField.sample(lightSide)
    const softSeparation =
      soft.toneField.sample(darkSide) - soft.toneField.sample(lightSide)

    expect(crispSeparation).toBeGreaterThan(softSeparation)
    expect(softSeparation).toBeGreaterThan(0)
  })

  it('increases tonal separation with Tone contrast', () => {
    const subdued = source({ toneContrast: 0 })
    const strong = source({ toneContrast: 1 })
    const { sphere } = subdued.layout
    const darker = [
      sphere.center[0] - sphere.radius * 0.76,
      sphere.center[1],
    ] as const
    const lighter = [
      sphere.center[0] + sphere.radius * 0.76,
      sphere.center[1],
    ] as const
    const subduedSeparation =
      subdued.toneField.sample(darker) - subdued.toneField.sample(lighter)
    const strongSeparation =
      strong.toneField.sample(darker) - strong.toneField.sample(lighter)

    expect(strongSeparation).toBeGreaterThan(subduedSeparation)
  })

  it('changes only the permission transition with Mask feather', () => {
    const hard = source({ maskFeather: 0 })
    const soft = source({ maskFeather: 1 })
    const { sphere } = hard.layout
    const transitionPoint = [
      sphere.center[0],
      sphere.center[1] - sphere.radius + soft.maskFeatherWidth / 2,
    ] as const
    const tonePoints = [
      sphere.center,
      transitionPoint,
      [
        hard.layout.frame.width * 0.13,
        hard.layout.frame.height * 0.87,
      ] as const,
    ]

    expect(JSON.stringify(hard.layout)).toBe(JSON.stringify(soft.layout))
    expect(tonePoints.map((point) => hard.toneField.sample(point))).toEqual(
      tonePoints.map((point) => soft.toneField.sample(point)),
    )
    expect(hard.toneField.sample(transitionPoint)).toBeGreaterThan(0)
    expect(hard.shadingMask.sample(transitionPoint)).toBe(1)
    expect(soft.shadingMask.sample(transitionPoint)).toBeGreaterThan(0)
    expect(soft.shadingMask.sample(transitionPoint)).toBeLessThan(1)
    expect(sampleEffectiveTone(soft, transitionPoint)).toBeLessThan(
      sampleEffectiveTone(hard, transitionPoint),
    )
  })
})

describe('Scribble Moon field contract', () => {
  it('distinguishes fully permitted, soft, and exact-zero regions', () => {
    const candidate = source({ maskFeather: 1 })
    const { sphere } = candidate.layout
    const featherPoint = [
      sphere.center[0],
      sphere.center[1] - sphere.radius + candidate.maskFeatherWidth / 2,
    ] as const
    const exterior = [0, 0] as const
    const justExterior = [
      sphere.center[0],
      sphere.center[1] - sphere.radius * 1.05,
    ] as const

    expect(candidate.shadingMask.sample(sphere.center)).toBe(1)
    expect(candidate.shadingMask.sample(featherPoint)).toBeGreaterThan(0)
    expect(candidate.shadingMask.sample(featherPoint)).toBeLessThan(1)
    expect(candidate.shadingMask.sample(exterior)).toBe(0)
    expect(candidate.shadingMask.sample(justExterior)).toBe(0)
    expect(Object.is(candidate.shadingMask.sample(exterior), 0)).toBe(true)
  })

  it.each([
    ['square', 1],
    ['portrait', 2 / 3],
    ['landscape', 3 / 2],
  ])(
    'keeps a dense fixed lattice finite and bounded in a %s frame',
    (_name, aspect) => {
      const candidate = source({}, resolveCompositionFrame(aspect))
      const { frame } = candidate.layout

      for (let row = 0; row <= 50; row += 1) {
        for (let column = 0; column <= 50; column += 1) {
          const point = [
            (column / 50) * frame.width,
            (row / 50) * frame.height,
          ] as const
          expectBounded(candidate.toneField.sample(point))
          expectBounded(candidate.shadingMask.sample(point))
        }
      }
    },
  )

  it('preserves samples at the same authored-layout point across frame aspects', () => {
    const samples = [1, 2 / 3, 3 / 2].map((aspect) => {
      const candidate = source({}, resolveCompositionFrame(aspect))
      const { sphere } = candidate.layout
      const point = [
        sphere.center[0] + sphere.radius * 0.37,
        sphere.center[1] - sphere.radius * 0.19,
      ] as const
      return samplePair(candidate, point)
    })

    expect(samples[1][0]).toBeCloseTo(samples[0][0], 14)
    expect(samples[1][1]).toBeCloseTo(samples[0][1], 14)
    expect(samples[2][0]).toBeCloseTo(samples[0][0], 14)
    expect(samples[2][1]).toBeCloseTo(samples[0][1], 14)
  })

  it('reconstructs byte-identical layout JSON and sampled scalar arrays', () => {
    const first = source({}, resolveCompositionFrame(16 / 9))
    const second = source({}, resolveCompositionFrame(16 / 9))

    expect(JSON.stringify(second.layout)).toBe(JSON.stringify(first.layout))
    expect(allSampleBytes(second)).toEqual(allSampleBytes(first))
  })

  it('fails loudly for invalid Composition Frames', () => {
    expect(() => source({}, { width: 0, height: 1000 })).toThrow(
      /finite positive dimensions/,
    )
    expect(() => source({}, { width: 1000, height: Number.NaN })).toThrow(
      /finite positive dimensions/,
    )
  })
})
