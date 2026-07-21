import { beforeEach, describe, expect, it, vi } from 'vitest'

const stipplingStrategyMock = vi.hoisted(() => vi.fn())

vi.mock('../stipplingStrategy/index', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../stipplingStrategy/index')
  >()
  stipplingStrategyMock.mockImplementation(actual.stipplingStrategy)
  return { ...actual, stipplingStrategy: stipplingStrategyMock }
})

import {
  clipSceneToBounds,
  defaultParams,
  derivePageFramePlotProfile,
  frameScene,
  hiddenLinePass,
  renderPlotterSVG,
  renderToSVG,
  toneCalibration,
  toneCalibrationSchema,
  type PageFrame,
  type PlotProfile,
  type Point,
  type Primitive,
  type Scene,
} from '../index'
import { createStipplingModel } from '../stipplingStrategy/model'
import {
  resolveProductionStipplingExecutionLimits,
  runStipplingStrategyForTesting,
  type StipplingStrategyInput,
} from '../stipplingStrategy/index'

const COMPOSITION = Object.freeze({ width: 20, height: 16 })
const PAGE: PageFrame = Object.freeze({
  x: -1,
  y: -1,
  width: 22,
  height: 18,
})
const FINE_TOOL_MM = 0.4
const BROAD_TOOL_MM = 0.8
const MILLIMETERS_PER_SCENE_UNIT = 2
const PROFILE: PlotProfile = Object.freeze({
  width: 44,
  height: 36,
  insets: { top: 2, right: 2, bottom: 2, left: 2 },
  includeFrame: false,
  toolWidthMillimeters: FINE_TOOL_MM,
})

function relaxedParams() {
  return {
    ...defaultParams(toneCalibrationSchema),
    strategy: 'stippling',
    stippleDensity: 0.25,
    distributionFidelity: 0.5,
    voronoiRelaxation: 0.5,
  }
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function orderedPoints(scene: Readonly<Scene>): Point[][] {
  return scene.primitives.map((primitive) =>
    primitive.points.map(([x, y]) => [x, y]),
  )
}

function withoutStroke(primitive: Readonly<Primitive>) {
  const { stroke: _stroke, ...rest } = primitive
  return rest
}

function expectOrderedStipples(
  scene: Readonly<Scene>,
  expectedPoints: readonly (readonly Point[])[],
  expectedWidth: number,
  expectedRole: 'source' | undefined,
): void {
  expect(scene.primitives).toHaveLength(expectedPoints.length)
  expect(scene.primitives.length).toBeGreaterThan(0)
  scene.primitives.forEach((primitive, index) => {
    expect(primitive.points).toEqual(expectedPoints[index])
    expect(primitive.points).toHaveLength(2)
    expect(primitive.points[0]).not.toEqual(primitive.points[1])
    expect(primitive.closed).toBe(expectedRole === 'source' ? false : undefined)
    expect(primitive.fill).toBeUndefined()
    expect(primitive.stroke).toEqual({
      color: 'black',
      width: expectedWidth,
      lineCap: 'round',
    })
    expect(primitive.hiddenLineRole).toBe(expectedRole)
  })
}

function svgPathElements(svg: string): string[] {
  return svg.match(/<path\b[^>]*\/>/g) ?? []
}

function svgPath(
  points: readonly Point[],
  width: number,
  scale = 1,
  offsetX = 0,
  offsetY = 0,
): string {
  const d = points
    .map(
      ([x, y], index) =>
        `${index === 0 ? 'M' : 'L'}${round(offsetX + x * scale)} ${round(
          offsetY + y * scale,
        )}`,
    )
    .join(' ')
  return `<path d="${d}" fill="none" stroke="black" stroke-width="${round(
    width * scale,
  )}" stroke-linecap="round" />`
}

function insidePage(point: Readonly<Point>): boolean {
  return (
    point[0] >= PAGE.x &&
    point[0] <= PAGE.x + PAGE.width &&
    point[1] >= PAGE.y &&
    point[1] <= PAGE.y + PAGE.height
  )
}

function expectNoStrategyRerun(callCount: number): void {
  expect(stipplingStrategyMock).toHaveBeenCalledTimes(callCount)
}

beforeEach(() => {
  stipplingStrategyMock.mockClear()
})

describe('Tone Calibration positive-relaxation output parity', () => {
  it('preserves one completed ordered relaxed Scene across Fill, Outline, framing, clipping, and SVG output', () => {
    const prepared = toneCalibration.generateShadingArtwork!(
      relaxedParams(),
      'relaxed-output-parity',
      COMPOSITION,
    )
    expect(prepared.diagnostics.termination).toBe('completed')
    expect(stipplingStrategyMock).toHaveBeenCalledOnce()
    expect(
      (stipplingStrategyMock.mock.calls[0]![0] as StipplingStrategyInput)
        .controls.voronoiRelaxation,
    ).toBe(0.5)

    const fill = prepared.scene
    const retainedPoints = orderedPoints(fill)
    const previewWidth = Math.sqrt(20 * 16) * 0.002
    expectOrderedStipples(fill, retainedPoints, previewWidth, 'source')

    const strategyCallsAfterPreparation =
      stipplingStrategyMock.mock.calls.length
    const ordinarySVG = renderToSVG(fill)
    expect(svgPathElements(ordinarySVG)).toEqual(
      retainedPoints.map((points) => svgPath(points, previewWidth)),
    )
    expectNoStrategyRerun(strategyCallsAfterPreparation)

    const fineSource = toneCalibration.deriveOutlineSource!(fill, {
      toolWidthMillimeters: FINE_TOOL_MM,
      millimetersPerSceneUnit: MILLIMETERS_PER_SCENE_UNIT,
    })
    const broadSource = toneCalibration.deriveOutlineSource!(fill, {
      toolWidthMillimeters: BROAD_TOOL_MM,
      millimetersPerSceneUnit: MILLIMETERS_PER_SCENE_UNIT,
    })
    expectOrderedStipples(fineSource, retainedPoints, 0.2, 'source')
    expectOrderedStipples(broadSource, retainedPoints, 0.4, 'source')
    expect(broadSource.primitives.map(withoutStroke)).toEqual(
      fineSource.primitives.map(withoutStroke),
    )
    expect(fineSource.primitives.map(withoutStroke)).toEqual(
      fill.primitives.map(withoutStroke),
    )
    expectNoStrategyRerun(strategyCallsAfterPreparation)

    const outline = hiddenLinePass(fineSource)
    expectOrderedStipples(outline, retainedPoints, 0.2, undefined)
    expectNoStrategyRerun(strategyCallsAfterPreparation)

    const boundaryCrossers = retainedPoints.filter((points) => {
      const endpointMembership = points.map(insidePage)
      return (
        endpointMembership.some(Boolean) &&
        !endpointMembership.every(Boolean)
      )
    })
    expect(boundaryCrossers).toEqual([])

    const pagePoints = retainedPoints
      .filter((points) => points.every(insidePage))
      .map((points) =>
        points.map(([x, y]): Point => [x - PAGE.x, y - PAGE.y]),
      )
    const framed = frameScene(outline, PAGE)
    expect(framed.space).toEqual({ width: PAGE.width, height: PAGE.height })
    expectOrderedStipples(framed, pagePoints, 0.2, undefined)
    expect(framed.primitives).toHaveLength(fill.primitives.length)

    const clipped = clipSceneToBounds(framed)
    expectOrderedStipples(clipped, pagePoints, 0.2, undefined)
    expectNoStrategyRerun(strategyCallsAfterPreparation)

    const pageProfile = derivePageFramePlotProfile(
      PROFILE,
      { x: 0, y: 0, ...COMPOSITION },
      PAGE,
    )
    expect(pageProfile).toEqual({
      ...PROFILE,
      width: 48,
      height: 40,
    })
    const plotterSVG = renderPlotterSVG(clipped, pageProfile)
    expect(svgPathElements(plotterSVG)).toEqual(
      pagePoints.map((points) => svgPath(points, 0.2, 2, 2, 2)),
    )
    expect(plotterSVG).not.toMatch(
      /<(?:rect|g|polyline|circle|clipPath)\b|\b(?:transform|clip-path)=|\sZ(?:"|\s)/,
    )
    expectNoStrategyRerun(strategyCallsAfterPreparation)

    // Every downstream stage owns a new value; none can mutate or regenerate
    // the authoritative relaxed Fill geometry retained by preparation.
    expect(orderedPoints(fill)).toEqual(retainedPoints)
    expect(fineSource).not.toBe(fill)
    expect(outline).not.toBe(fineSource)
    expect(framed).not.toBe(outline)
    expect(clipped).not.toBe(framed)
  })

  it('keeps complete retained geometry visible and exportable when the relaxation ceiling exhausts', () => {
    stipplingStrategyMock.mockImplementationOnce(
      (input: StipplingStrategyInput) => {
        const model = createStipplingModel(
          input.source,
          input.frame,
          input.controls,
        )
        const result = runStipplingStrategyForTesting(input, {
          ...resolveProductionStipplingExecutionLimits(model),
          maxRelaxationPasses: 0,
        })
        expect(result.termination).toBe('budget-exhausted')
        return result
      },
    )

    const prepared = toneCalibration.generateShadingArtwork!(
      relaxedParams(),
      'relaxed-output-budget',
      COMPOSITION,
    )
    expect(prepared.diagnostics.termination).toBe('budget-exhausted')
    expect(stipplingStrategyMock).toHaveBeenCalledOnce()
    expect(
      (stipplingStrategyMock.mock.calls[0]![0] as StipplingStrategyInput)
        .controls.voronoiRelaxation,
    ).toBe(0.5)

    const retainedPoints = orderedPoints(prepared.scene)
    const previewWidth = Math.sqrt(20 * 16) * 0.002
    expectOrderedStipples(
      prepared.scene,
      retainedPoints,
      previewWidth,
      'source',
    )
    const strategyCallsAfterPreparation =
      stipplingStrategyMock.mock.calls.length

    expect(svgPathElements(renderToSVG(prepared.scene))).toEqual(
      retainedPoints.map((points) => svgPath(points, previewWidth)),
    )
    const source = toneCalibration.deriveOutlineSource!(prepared.scene, {
      toolWidthMillimeters: FINE_TOOL_MM,
      millimetersPerSceneUnit: MILLIMETERS_PER_SCENE_UNIT,
    })
    const outline = hiddenLinePass(source)
    expectOrderedStipples(outline, retainedPoints, 0.2, undefined)
    expect(svgPathElements(renderPlotterSVG(outline, PROFILE))).toEqual(
      retainedPoints.map((points) => svgPath(points, 0.2, 2, 2, 2)),
    )
    expect(orderedPoints(prepared.scene)).toEqual(retainedPoints)
    expectNoStrategyRerun(strategyCallsAfterPreparation)
  })
})
