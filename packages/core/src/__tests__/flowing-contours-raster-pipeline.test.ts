import { describe, expect, it } from 'vitest'

import { createFlowingContoursAccounting } from '../sketches/flowing-contours/accounting'
import { buildFlowingContoursField } from '../sketches/flowing-contours/field'
import { createFlowingContoursTestLimits } from '../sketches/flowing-contours/limits'
import { runFlowingContoursPipeline } from '../sketches/flowing-contours/pipeline'
import type { PreparedFlowingContoursRaster } from '../sketches/flowing-contours/raster'
import type {
  AcceptedFlowingTrajectory,
  FlowingContoursField,
} from '../sketches/flowing-contours/types'

const CONTROLS = Object.freeze({
  curveDetail: 1,
  continuity: 0.6,
  flowSmoothing: 0.8,
  minimumStrokeLength: 0.005,
})

function preparedRaster(
  width: number,
  height: number,
  luminanceAt: (x: number, y: number) => number,
): PreparedFlowingContoursRaster {
  const luminance = new Array<number>(width * height)
  const alpha = new Array<number>(width * height).fill(1)
  const positiveSupport = new Array<boolean>(width * height).fill(true)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      luminance[y * width + x] = luminanceAt(x, y)
    }
  }
  return {
    sourceWidth: width,
    sourceHeight: height,
    width,
    height,
    luminance,
    alpha,
    positiveSupport,
  }
}

function build(
  width: number,
  height: number,
  luminanceAt: (x: number, y: number) => number,
): Readonly<FlowingContoursField> {
  const accounting = createFlowingContoursAccounting()
  return buildFlowingContoursField(
    preparedRaster(width, height, luminanceAt),
    accounting,
  )
}

function isClosed(
  trajectory: Readonly<AcceptedFlowingTrajectory>,
): boolean {
  const first = trajectory.samples[0]!.point
  const last = trajectory.samples.at(-1)!.point
  return first[0] === last[0] && first[1] === last[1]
}

function longestLength(
  trajectories: readonly Readonly<AcceptedFlowingTrajectory>[],
): number {
  return Math.max(0, ...trajectories.map((trajectory) => trajectory.length))
}

describe('Flowing Contours raster-to-pipeline integration', () => {
  it.each([
    { size: 31, radius: 8, transition: 'hard' as const },
    { size: 41, radius: 12, transition: 'smooth' as const },
    { size: 72, radius: 23, transition: 'hard' as const },
  ])(
    'traces a $transition $size px radial edge as an authentic closed loop',
    ({ size, radius, transition }) => {
      const center = (size - 1) / 2
      const field = build(size, size, (x, y) => {
        const signedDistance = Math.hypot(x - center, y - center) - radius
        if (transition === 'hard') return signedDistance <= 0 ? 0.1 : 0.9
        return 0.1 + 0.8 / (1 + Math.exp(-signedDistance / 1.25))
      })
      const first = runFlowingContoursPipeline(field, CONTROLS)
      const second = runFlowingContoursPipeline(field, CONTROLS)
      const closed = first.acceptedTrajectories.filter(isClosed)

      expect(first).toEqual(second)
      expect(first.diagnostics.termination).toBe('complete')
      expect(closed.length).toBeGreaterThan(0)
      expect(longestLength(closed)).toBeGreaterThan(2 * Math.PI * radius * 0.8)
      expect(
        closed.every(
          (trajectory) =>
            trajectory.startEndpointReason === 'represented-collision' &&
            trajectory.endEndpointReason === 'represented-collision',
        ),
      ).toBe(true)
      expect(first.fittedCurves).toHaveLength(
        first.acceptedTrajectories.length,
      )
    },
    20_000,
  )

  it.each([
    {
      name: 'vertical',
      width: 80,
      height: 40,
      luminanceAt: (x: number) => (x < 40 ? 0.1 : 0.9),
      expectedLength: 39,
    },
    {
      name: 'vertical reverse contrast',
      width: 80,
      height: 40,
      luminanceAt: (x: number) => (x < 40 ? 0.9 : 0.1),
      expectedLength: 39,
    },
    {
      name: 'horizontal',
      width: 40,
      height: 80,
      luminanceAt: (_x: number, y: number) => (y < 40 ? 0.1 : 0.9),
      expectedLength: 39,
    },
    {
      name: 'vertical subpixel',
      width: 80,
      height: 40,
      luminanceAt: (x: number) =>
        0.1 + 0.8 / (1 + Math.exp(-(x - 39.25) / 0.75)),
      expectedLength: 39,
    },
    {
      name: 'horizontal subpixel',
      width: 40,
      height: 80,
      luminanceAt: (_x: number, y: number) =>
        0.1 + 0.8 / (1 + Math.exp(-(y - 39.25) / 0.75)),
      expectedLength: 39,
    },
  ])(
    'traces a long whole $name step instead of anchor stumps',
    ({ width, height, luminanceAt, expectedLength }) => {
      const output = runFlowingContoursPipeline(
        build(width, height, luminanceAt),
        CONTROLS,
      )

      expect(output.diagnostics.termination).toBe('complete')
      expect(output.acceptedTrajectories.length).toBeGreaterThan(0)
      expect(longestLength(output.acceptedTrajectories)).toBeGreaterThan(
        expectedLength * 0.9,
      )
      expect(
        output.acceptedTrajectories.every(
          (trajectory) => trajectory.samples.length >= 3,
        ),
      ).toBe(true)
      expect(output.diagnostics.directionalTraceCount).toBeGreaterThanOrEqual(2)
      expect(output.diagnostics.searchStepCount).toBeGreaterThan(2)
    },
  )

  it('keeps slight rotations length-equivalent instead of preferring grid axes', () => {
    const lengths = [-0.12, 0, 0.12].map((slope) => {
      const output = runFlowingContoursPipeline(
        build(64, 64, (x, y) =>
          x < 31.5 + slope * (y - 31.5) ? 0.1 : 0.9,
        ),
        CONTROLS,
      )
      expect(output.diagnostics.termination).toBe('complete')
      return longestLength(output.acceptedTrajectories)
    })

    expect(Math.min(...lengths)).toBeGreaterThan(55)
    expect(Math.max(...lengths) / Math.min(...lengths)).toBeLessThan(1.04)
  })

  it('keeps flat opaque controls empty and bounded', () => {
    const output = runFlowingContoursPipeline(
      build(80, 40, () => 0.5),
      CONTROLS,
    )

    expect(output.acceptedTrajectories).toEqual([])
    expect(output.fittedCurves).toEqual([])
    expect(output.diagnostics).toMatchObject({
      termination: 'complete',
      limitedBy: null,
      correctedRidgeSampleCount: 0,
      directionalTraceCount: 0,
      searchStepCount: 0,
      candidateCount: 0,
    })
  })

  it('reports a fitted-point cap without discarding prior pipeline diagnostics', () => {
    const field = build(72, 52, (x, y) =>
      x < 34 + 6 * Math.sin(y / 8) ? 0.1 : 0.9,
    )
    const limits = createFlowingContoursTestLimits({
      'fitted-curve-point-count': 1,
    })!
    const output = runFlowingContoursPipeline(field, CONTROLS, limits)

    expect(output.acceptedTrajectories).toEqual([])
    expect(output.fittedCurves).toEqual([])
    expect(output.diagnostics).toMatchObject({
      termination: 'limit-reached',
      limitedBy: 'fitted-curve-point-count',
      processedAnchorCount: 1,
      candidateCount: 1,
      acceptedCandidateCount: 0,
      rejectedCandidateCount: 1,
      rawTrajectoryCount: 0,
      fittedCurveCount: 0,
      primitiveCount: 0,
    })
    expect(output.diagnostics.correctedRidgeSampleCount).toBeGreaterThan(0)
    expect(output.diagnostics.directionalTraceCount).toBe(2)
    expect(output.diagnostics.searchStepCount).toBeGreaterThan(2)
  })
})
