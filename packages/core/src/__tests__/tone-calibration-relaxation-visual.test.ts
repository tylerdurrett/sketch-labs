import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { renderToSVG } from '../renderer'
import { createScene, type CoordinateSpace } from '../scene'
import { createShadingMask, type ToneSource } from '../shadingFields'
import {
  stipplingStrategy,
  type StipplingResult,
} from '../stipplingStrategy/index'
import type { StipplingControls } from '../stipplingStrategy/types'
import type { Point, Polyline } from '../types'
import {
  constantTone,
  horizontalGradientTone,
} from './shadingFieldFixtures'

const FRAME: Readonly<CoordinateSpace> = Object.freeze({
  width: 100,
  height: 100,
})
const FULL_MASK = createShadingMask(() => 1)
const FIXTURE_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'tone-calibration-relaxation',
)
const UPDATE_FIXTURES =
  process.env.UPDATE_TONE_CALIBRATION_RELAXATION_VISUAL_FIXTURES === '1'

const PREVIEW_STROKE = Object.freeze({
  color: 'black',
  width: Math.sqrt(FRAME.width * FRAME.height) * 0.002,
  lineCap: 'round' as const,
})

interface VisualCase {
  readonly name: 'flat' | 'ramp'
  readonly source: ToneSource
  readonly seed: string
  readonly controls: Omit<StipplingControls, 'voronoiRelaxation'>
  readonly checksums: Readonly<{
    before: string
    after: string
  }>
}

const VISUAL_CASES: readonly VisualCase[] = Object.freeze([
  Object.freeze({
    name: 'flat',
    source: Object.freeze({
      toneField: constantTone(0.75),
      shadingMask: FULL_MASK,
    }),
    seed: 'quantitative-flat',
    controls: Object.freeze({
      stippleDensity: 0.25,
      distributionFidelity: 0.5,
    }),
    checksums: Object.freeze({
      // Relaxation zero is the pre-slice ordinary-SVG checksum.
      before: 'acad3f7a4a203e883daa24ec716ba526e587d34d83c950d98af434faf28d69ab',
      after: '26cac73beea261ff6356ea3964103f5cea2fce772845fcb8fcd8c47c5a46792d',
    }),
  }),
  Object.freeze({
    name: 'ramp',
    source: Object.freeze({
      toneField: horizontalGradientTone(FRAME),
      shadingMask: FULL_MASK,
    }),
    seed: 'ramp-c',
    controls: Object.freeze({
      stippleDensity: 1,
      distributionFidelity: 0.5,
    }),
    checksums: Object.freeze({
      // Relaxation zero is the pre-slice ordinary-SVG checksum.
      before: '3a371a78f0fb748d5db8a48f459a0364636ec2ed17d1429182d373fcf2e68cc2',
      after: '216ca53878e058fbcc119af23ccca420a0e6e5012aeeb7d463ea1501a089120b',
    }),
  }),
])

function checksum(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function center(polyline: Readonly<Polyline>): Point {
  return [
    (polyline[0]![0] + polyline[1]![0]) / 2,
    (polyline[0]![1] + polyline[1]![1]) / 2,
  ]
}

function length(polyline: Readonly<Polyline>): number {
  return Math.hypot(
    polyline[1]![0] - polyline[0]![0],
    polyline[1]![1] - polyline[0]![1],
  )
}

function execute(
  visualCase: Readonly<VisualCase>,
  voronoiRelaxation: 0 | 1,
): StipplingResult {
  return stipplingStrategy({
    source: visualCase.source,
    frame: FRAME,
    seed: visualCase.seed,
    controls: { ...visualCase.controls, voronoiRelaxation },
  })
}

function executePreSliceInput(
  visualCase: Readonly<VisualCase>,
): StipplingResult {
  return stipplingStrategy({
    source: visualCase.source,
    frame: FRAME,
    seed: visualCase.seed,
    // This deliberately models the two-control object persisted before #389.
    controls: visualCase.controls as StipplingControls,
  })
}

/** Serialize through the same Scene and ordinary-SVG path as Tone Calibration. */
function ordinarySvg(result: Readonly<StipplingResult>): string {
  const builder = createScene(FRAME)
  for (const polyline of result.polylines) {
    builder.addPath(polyline, {
      closed: false,
      stroke: PREVIEW_STROKE,
      hiddenLineRole: 'source',
    })
  }
  return `${renderToSVG(builder.build())}\n`
}

function fixturePath(name: VisualCase['name'], state: 'before' | 'after') {
  return join(FIXTURE_DIRECTORY, `${name}-${state}.svg`)
}

function expectFixedOrderedShape(
  before: Readonly<StipplingResult>,
  after: Readonly<StipplingResult>,
): void {
  expect(after.polylines).toHaveLength(before.polylines.length)
  for (let index = 0; index < before.polylines.length; index++) {
    const beforePolyline = before.polylines[index]!
    const afterPolyline = after.polylines[index]!
    expect(afterPolyline).toHaveLength(2)
    expect(length(afterPolyline)).toBeCloseTo(length(beforePolyline), 10)

    const beforeDirection: Point = [
      beforePolyline[1]![0] - beforePolyline[0]![0],
      beforePolyline[1]![1] - beforePolyline[0]![1],
    ]
    const afterDirection: Point = [
      afterPolyline[1]![0] - afterPolyline[0]![0],
      afterPolyline[1]![1] - afterPolyline[0]![1],
    ]
    expect(afterDirection[0]).toBeCloseTo(beforeDirection[0], 10)
    expect(afterDirection[1]).toBeCloseTo(beforeDirection[1], 10)
  }
}

describe('Tone Calibration Stippling relaxation visual oracle', () => {
  it.each(VISUAL_CASES)(
    'pins deterministic ordinary-SVG before/after fixtures for $name tone',
    (visualCase) => {
      const before = execute(visualCase, 0)
      const after = execute(visualCase, 1)
      const svgs = {
        before: ordinarySvg(before),
        after: ordinarySvg(after),
      } as const

      expect(before.termination).toBe('completed')
      expect(after.termination).toBe('completed')
      expectFixedOrderedShape(before, after)
      expect(executePreSliceInput(visualCase)).toEqual(before)
      expect(execute(visualCase, 1)).toEqual(after)

      for (const state of ['before', 'after'] as const) {
        const path = fixturePath(visualCase.name, state)
        if (UPDATE_FIXTURES) writeFileSync(path, svgs[state])

        expect(svgs[state]).toBe(readFileSync(path, 'utf8'))
        expect(checksum(svgs[state])).toBe(visualCase.checksums[state])
      }

      if (visualCase.name === 'ramp') {
        for (const result of [before, after]) {
          expect(
            result.polylines.every(
              (polyline) =>
                visualCase.source.toneField.sample(center(polyline)) > 0,
            ),
          ).toBe(true)
        }
      }
    },
  )
})
