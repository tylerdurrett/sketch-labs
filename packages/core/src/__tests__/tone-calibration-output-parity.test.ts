import { beforeEach, describe, expect, it, vi } from 'vitest'

const scribbleStrategyMock = vi.hoisted(() => vi.fn())
const stipplingStrategyMock = vi.hoisted(() => vi.fn())

vi.mock('../scribbleStrategy/index', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../scribbleStrategy/index')
  >()
  scribbleStrategyMock.mockImplementation(actual.scribbleStrategy)
  return { ...actual, scribbleStrategy: scribbleStrategyMock }
})

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
  resizePageFramePlotProfileProportionally,
  toneCalibration,
  toneCalibrationSchema,
  type PageFrame,
  type PlotProfile,
  type Point,
  type Scene,
} from '../index'

const COMPOSITION = Object.freeze({ width: 100, height: 100 })
const PAGE = Object.freeze({ x: 20, y: 20, width: 60, height: 60 })
const FINE_TOOL_MM = 0.3
const BROAD_TOOL_MM = 0.8
const FULL_PROFILE: PlotProfile = deepFreeze({
  width: 120,
  height: 120,
  insets: { top: 10, right: 10, bottom: 10, left: 10 },
  includeFrame: false,
  toolWidthMillimeters: FINE_TOOL_MM,
})

function stipplingParams() {
  return {
    ...defaultParams(toneCalibrationSchema),
    strategy: 'stippling',
    stippleDensity: 0.25,
    distributionFidelity: 0,
  }
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value
  }
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

function snapshot<T>(value: T): { readonly value: T; readonly json: string } {
  return { value: deepFreeze(value), json: JSON.stringify(value) }
}

function expectUnchanged<T>(frozen: {
  readonly value: T
  readonly json: string
}): void {
  expect(JSON.stringify(frozen.value)).toBe(frozen.json)
}

function strategyCallCounts(): readonly [number, number] {
  return [
    scribbleStrategyMock.mock.calls.length,
    stipplingStrategyMock.mock.calls.length,
  ]
}

function expectStrategyCallCounts(expected: readonly [number, number]): void {
  expect(strategyCallCounts()).toEqual(expected)
}

function orderedPoints(scene: Readonly<Scene>): Point[][] {
  return scene.primitives.map((primitive) =>
    primitive.points.map(([x, y]) => [x, y]),
  )
}

function expectOpenTwoPointStipples(
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
    expect(primitive.stroke).toEqual({ color: 'black', width: expectedWidth })
    expect(primitive.hiddenLineRole).toBe(expectedRole)
  })
}

function svgPathElements(svg: string): string[] {
  return svg.match(/<path\b[^>]*\/>/g) ?? []
}

function expectSerializedStipplesRemainOpen(svg: string): void {
  for (const path of svgPathElements(svg)) {
    const coordinates = path.match(
      /\bd="M(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) L(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)"/,
    )
    expect(coordinates, path).not.toBeNull()
    expect(coordinates!.slice(1, 3), path).not.toEqual(
      coordinates!.slice(3, 5),
    )
  }
}

function ordinaryPath(points: readonly Point[], width: number): string {
  const d = points
    .map(
      ([x, y], index) =>
        `${index === 0 ? 'M' : 'L'}${round(x)} ${round(y)}`,
    )
    .join(' ')
  return `<path d="${d}" fill="none" stroke="black" stroke-width="${round(width)}" />`
}

function plotterPath(
  points: readonly Point[],
  scale: number,
  offsetX: number,
  offsetY: number,
  sceneWidth: number,
): string {
  const d = points
    .map(
      ([x, y], index) =>
        `${index === 0 ? 'M' : 'L'}${round(offsetX + x * scale)} ${round(
          offsetY + y * scale,
        )}`,
    )
    .join(' ')
  return `<path d="${d}" fill="none" stroke="black" stroke-width="${round(sceneWidth * scale)}" />`
}

function insidePage(point: Readonly<Point>, frame: PageFrame): boolean {
  return (
    point[0] >= frame.x &&
    point[0] <= frame.x + frame.width &&
    point[1] >= frame.y &&
    point[1] <= frame.y + frame.height
  )
}

beforeEach(() => {
  scribbleStrategyMock.mockClear()
  stipplingStrategyMock.mockClear()
})

describe('Tone Calibration Stippling output parity', () => {
  it('carries one completed deterministic artwork through every generic output surface', () => {
    const params = stipplingParams()
    const seed = 'tone-calibration-output-parity'
    const prepared = toneCalibration.generateShadingArtwork!(
      params,
      seed,
      COMPOSITION,
    )
    const cold = toneCalibration.generate(params, seed, 73.25, COMPOSITION)

    expect(prepared.diagnostics.termination).toBe('completed')
    expect(cold).toEqual(prepared.scene)
    expect(JSON.stringify(cold)).toBe(JSON.stringify(prepared.scene))
    expectStrategyCallCounts([0, 2])

    const retainedSnapshot = snapshot(prepared.scene)
    const retained = retainedSnapshot.value
    const retainedPoints = orderedPoints(retained)
    expectOpenTwoPointStipples(retained, retainedPoints, 1, 'source')

    const strategyCountsAfterPreparation = strategyCallCounts()
    const fineSourceSnapshot = snapshot(
      toneCalibration.deriveOutlineSource!(retained, {
        toolWidthMillimeters: FINE_TOOL_MM,
        millimetersPerSceneUnit: 1,
      }),
    )
    const broadSourceSnapshot = snapshot(
      toneCalibration.deriveOutlineSource!(retained, {
        toolWidthMillimeters: BROAD_TOOL_MM,
        millimetersPerSceneUnit: 1,
      }),
    )
    const fineSource = fineSourceSnapshot.value
    const broadSource = broadSourceSnapshot.value

    expectStrategyCallCounts(strategyCountsAfterPreparation)
    expectOpenTwoPointStipples(
      fineSource,
      retainedPoints,
      FINE_TOOL_MM,
      'source',
    )
    expectOpenTwoPointStipples(
      broadSource,
      retainedPoints,
      BROAD_TOOL_MM,
      'source',
    )
    expect(fineSource.space).toEqual(COMPOSITION)
    expect(fineSource.space).not.toBe(retained.space)
    expect(fineSource.primitives[0]?.points).not.toBe(
      retained.primitives[0]?.points,
    )
    expect(
      broadSource.primitives.map(({ stroke: _stroke, ...primitive }) =>
        primitive,
      ),
    ).toEqual(
      fineSource.primitives.map(({ stroke: _stroke, ...primitive }) =>
        primitive,
      ),
    )

    const fineOutlineSnapshot = snapshot(hiddenLinePass(fineSource))
    const broadOutlineSnapshot = snapshot(hiddenLinePass(broadSource))
    const fineOutline = fineOutlineSnapshot.value
    const broadOutline = broadOutlineSnapshot.value
    expectStrategyCallCounts(strategyCountsAfterPreparation)
    expectOpenTwoPointStipples(
      fineOutline,
      retainedPoints,
      FINE_TOOL_MM,
      undefined,
    )
    expectOpenTwoPointStipples(
      broadOutline,
      retainedPoints,
      BROAD_TOOL_MM,
      undefined,
    )
    expect(fineOutline).not.toHaveProperty('background')

    const ordinarySVG = renderToSVG(retained)
    expect(ordinarySVG).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 100 100">/,
    )
    expect(ordinarySVG).toContain(
      '<rect x="0" y="0" width="100" height="100" fill="white" />',
    )
    expect(svgPathElements(ordinarySVG)).toEqual(
      retainedPoints.map((points) => ordinaryPath(points, 1)),
    )
    expectSerializedStipplesRemainOpen(ordinarySVG)
    expectStrategyCallCounts(strategyCountsAfterPreparation)

    const plotterSVG = renderPlotterSVG(fineOutline, FULL_PROFILE)
    expect(plotterSVG).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="120mm" height="120mm" viewBox="0 0 120 120" data-paper-extent="paper">/,
    )
    expect(svgPathElements(plotterSVG)).toEqual(
      retainedPoints.map((points) =>
        plotterPath(points, 1, 10, 10, FINE_TOOL_MM),
      ),
    )
    expectSerializedStipplesRemainOpen(plotterSVG)
    expect(plotterSVG).not.toMatch(
      /<(?:rect|g|polyline|circle|clipPath)\b|\b(?:transform|clip-path)=|\sZ(?:"|\s)/,
    )
    expectStrategyCallCounts(strategyCountsAfterPreparation)

    // The crop is deliberately placed in a gap between deterministic Stipples,
    // so Page framing has only its two specified effects: discard outside marks
    // and rebase retained coordinates. It never needs replacement geometry.
    const boundaryCrossers = fineOutline.primitives.filter((primitive) => {
      const inside = primitive.points.map((point) => insidePage(point, PAGE))
      return inside.some(Boolean) && !inside.every(Boolean)
    })
    expect(boundaryCrossers).toEqual([])

    const expectedPagePoints = retainedPoints
      .filter((points) => points.every((point) => insidePage(point, PAGE)))
      .map((points) => points.map(([x, y]): Point => [x - PAGE.x, y - PAGE.y]))
    const framedSnapshot = snapshot(frameScene(fineOutline, PAGE))
    const framed = framedSnapshot.value
    expectStrategyCallCounts(strategyCountsAfterPreparation)
    expect(framed.space).toEqual({ width: 60, height: 60 })
    expectOpenTwoPointStipples(
      framed,
      expectedPagePoints,
      FINE_TOOL_MM,
      undefined,
    )
    expect(framed.primitives.length).toBeLessThan(retained.primitives.length)

    const pageProfileSnapshot = snapshot(
      derivePageFramePlotProfile(
        FULL_PROFILE,
        { x: 0, y: 0, ...COMPOSITION },
        PAGE,
      ),
    )
    const pageProfile = pageProfileSnapshot.value
    expect(pageProfile).toEqual({
      ...FULL_PROFILE,
      width: 80,
      height: 80,
      insets: { top: 10, right: 10, bottom: 10, left: 10 },
    })
    const framedPlotterSVG = renderPlotterSVG(framed, pageProfile)
    expect(svgPathElements(framedPlotterSVG)).toEqual(
      expectedPagePoints.map((points) =>
        plotterPath(points, 1, 10, 10, FINE_TOOL_MM),
      ),
    )
    expectSerializedStipplesRemainOpen(framedPlotterSVG)
    expectStrategyCallCounts(strategyCountsAfterPreparation)

    const doubledProfileSnapshot = snapshot(
      resizePageFramePlotProfileProportionally(
        FULL_PROFILE,
        { x: 0, y: 0, ...COMPOSITION },
        'width',
        220,
      ),
    )
    const doubledProfile = doubledProfileSnapshot.value
    expect(doubledProfile).toEqual({
      ...FULL_PROFILE,
      width: 220,
      height: 220,
      insets: { top: 10, right: 10, bottom: 10, left: 10 },
    })
    const doubledSourceSnapshot = snapshot(
      toneCalibration.deriveOutlineSource!(retained, {
        toolWidthMillimeters: FINE_TOOL_MM,
        millimetersPerSceneUnit: 2,
      }),
    )
    const doubledSource = doubledSourceSnapshot.value
    expectStrategyCallCounts(strategyCountsAfterPreparation)
    const doubledOutlineSnapshot = snapshot(hiddenLinePass(doubledSource))
    const doubledOutline = doubledOutlineSnapshot.value
    expectStrategyCallCounts(strategyCountsAfterPreparation)
    expectOpenTwoPointStipples(
      doubledOutline,
      retainedPoints,
      FINE_TOOL_MM / 2,
      undefined,
    )
    const doubledSVG = renderPlotterSVG(doubledOutline, doubledProfile)
    expect(svgPathElements(doubledSVG)).toEqual(
      retainedPoints.map((points) =>
        plotterPath(points, 2, 10, 10, FINE_TOOL_MM / 2),
      ),
    )
    expectSerializedStipplesRemainOpen(doubledSVG)

    expectStrategyCallCounts(strategyCountsAfterPreparation)
    for (const frozen of [
      retainedSnapshot,
      fineSourceSnapshot,
      broadSourceSnapshot,
      fineOutlineSnapshot,
      broadOutlineSnapshot,
      framedSnapshot,
      pageProfileSnapshot,
      doubledProfileSnapshot,
      doubledSourceSnapshot,
      doubledOutlineSnapshot,
    ]) {
      expectUnchanged(frozen)
    }
  })

  it('clips boundary-crossing Stipples and maps asymmetric Page axes exactly', () => {
    const strategyCountsBeforeOutput = strategyCallCounts()
    const page: PageFrame = deepFreeze({
      x: 20,
      y: 15,
      width: 60,
      height: 40,
    })
    const retainedSnapshot = snapshot<Scene>({
      space: { width: 100, height: 80 },
      primitives: [
        {
          points: [
            [19.95, 25],
            [20.05, 25],
          ],
          closed: false,
          stroke: { color: 'black', width: 1 },
          hiddenLineRole: 'source',
        },
        {
          points: [
            [45, 14.95],
            [45, 15.05],
          ],
          closed: false,
          stroke: { color: 'black', width: 1 },
          hiddenLineRole: 'source',
        },
        {
          points: [
            [79.95, 35],
            [80.05, 35],
          ],
          closed: false,
          stroke: { color: 'black', width: 1 },
          hiddenLineRole: 'source',
        },
        {
          points: [
            [65, 54.95],
            [65, 55.05],
          ],
          closed: false,
          stroke: { color: 'black', width: 1 },
          hiddenLineRole: 'source',
        },
        {
          points: [
            [30, 20],
            [30.2, 20.1],
          ],
          closed: false,
          stroke: { color: 'black', width: 1 },
          hiddenLineRole: 'source',
        },
        {
          points: [
            [5, 5],
            [5.1, 5.1],
          ],
          closed: false,
          stroke: { color: 'black', width: 1 },
          hiddenLineRole: 'source',
        },
      ],
    })
    const sourceProfileSnapshot = snapshot<PlotProfile>({
      width: 220,
      height: 188,
      insets: { top: 11, right: 13, bottom: 17, left: 7 },
      includeFrame: false,
      toolWidthMillimeters: 0.4,
    })

    const outlineSourceSnapshot = snapshot(
      toneCalibration.deriveOutlineSource!(retainedSnapshot.value, {
        toolWidthMillimeters: 0.4,
        millimetersPerSceneUnit: 2,
      }),
    )
    expectStrategyCallCounts(strategyCountsBeforeOutput)
    expectOpenTwoPointStipples(
      outlineSourceSnapshot.value,
      orderedPoints(retainedSnapshot.value),
      0.2,
      'source',
    )

    const hiddenLineSnapshot = snapshot(
      hiddenLinePass(outlineSourceSnapshot.value),
    )
    expectStrategyCallCounts(strategyCountsBeforeOutput)
    expectOpenTwoPointStipples(
      hiddenLineSnapshot.value,
      orderedPoints(retainedSnapshot.value),
      0.2,
      undefined,
    )

    const framedSnapshot = snapshot(frameScene(hiddenLineSnapshot.value, page))
    const framedPoints: Point[][] = [
      [
        [19.95 - page.x, 25 - page.y],
        [20.05 - page.x, 25 - page.y],
      ],
      [
        [45 - page.x, 14.95 - page.y],
        [45 - page.x, 15.05 - page.y],
      ],
      [
        [79.95 - page.x, 35 - page.y],
        [80.05 - page.x, 35 - page.y],
      ],
      [
        [65 - page.x, 54.95 - page.y],
        [65 - page.x, 55.05 - page.y],
      ],
      [
        [30 - page.x, 20 - page.y],
        [30.2 - page.x, 20.1 - page.y],
      ],
    ]
    expectStrategyCallCounts(strategyCountsBeforeOutput)
    expect(framedSnapshot.value.space).toEqual({ width: 60, height: 40 })
    expectOpenTwoPointStipples(
      framedSnapshot.value,
      framedPoints,
      0.2,
      undefined,
    )
    expect(framedSnapshot.value.primitives).toHaveLength(5)

    const clippedSnapshot = snapshot(
      clipSceneToBounds(framedSnapshot.value),
    )
    const clippedPoints: Point[][] = [
      [
        [0, 10],
        [20.05 - page.x, 25 - page.y],
      ],
      [
        [45 - page.x, 0],
        [45 - page.x, 15.05 - page.y],
      ],
      [
        [79.95 - page.x, 35 - page.y],
        [page.width, 35 - page.y],
      ],
      [
        [65 - page.x, 54.95 - page.y],
        [65 - page.x, page.height],
      ],
      [
        [30 - page.x, 20 - page.y],
        [30.2 - page.x, 20.1 - page.y],
      ],
    ]
    expectStrategyCallCounts(strategyCountsBeforeOutput)
    expect(clippedSnapshot.value.space).toEqual({ width: 60, height: 40 })
    expectOpenTwoPointStipples(
      clippedSnapshot.value,
      clippedPoints,
      0.2,
      undefined,
    )

    const pageProfileSnapshot = snapshot(
      derivePageFramePlotProfile(
        sourceProfileSnapshot.value,
        { x: 0, y: 0, width: 100, height: 80 },
        page,
      ),
    )
    expect(pageProfileSnapshot.value).toEqual({
      width: 140,
      height: 108,
      insets: { top: 11, right: 13, bottom: 17, left: 7 },
      includeFrame: false,
      toolWidthMillimeters: 0.4,
    })

    const plotterSVG = renderPlotterSVG(
      clippedSnapshot.value,
      pageProfileSnapshot.value,
    )
    expect(svgPathElements(plotterSVG)).toEqual([
      '<path d="M7 31 L7.1 31" fill="none" stroke="black" stroke-width="0.4" />',
      '<path d="M57 11 L57 11.1" fill="none" stroke="black" stroke-width="0.4" />',
      '<path d="M126.9 51 L127 51" fill="none" stroke="black" stroke-width="0.4" />',
      '<path d="M97 90.9 L97 91" fill="none" stroke="black" stroke-width="0.4" />',
      '<path d="M27 21 L27.4 21.2" fill="none" stroke="black" stroke-width="0.4" />',
    ])
    expect(plotterSVG).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="140mm" height="108mm" viewBox="0 0 140 108" data-paper-extent="paper">/,
    )
    expectStrategyCallCounts(strategyCountsBeforeOutput)

    for (const frozen of [
      retainedSnapshot,
      sourceProfileSnapshot,
      outlineSourceSnapshot,
      hiddenLineSnapshot,
      framedSnapshot,
      clippedSnapshot,
      pageProfileSnapshot,
    ]) {
      expectUnchanged(frozen)
    }
  })

  it('keeps a budget-exhausted prepared result intact across retained and transformed output stages', () => {
    const partialPoints: Point[][] = [
      [
        [19.9, 25],
        [20.1, 25],
      ],
      [
        [30, 20],
        [30.2, 20],
      ],
      [
        [79.9, 35],
        [80.1, 35],
      ],
      [
        [90, 70],
        [90.2, 70],
      ],
    ]
    stipplingStrategyMock.mockReturnValueOnce({
      polylines: partialPoints,
      termination: 'budget-exhausted',
      distributionError: 0.4,
    })

    const prepared = toneCalibration.generateShadingArtwork!(
      stipplingParams(),
      'forced-stipple-output-budget',
      { width: 100, height: 80 },
    )
    expect(prepared.diagnostics).toEqual({
      termination: 'budget-exhausted',
      pathLength: expect.closeTo(0.8),
      polylineCount: 4,
      penLiftCount: 3,
      fidelity: { kind: 'stippling', distributionError: 0.4 },
    })

    const retainedSnapshot = snapshot(prepared.scene)
    const retained = retainedSnapshot.value
    expectOpenTwoPointStipples(retained, partialPoints, 1, 'source')
    const strategyCountsAfterPreparation = strategyCallCounts()

    const ordinarySVG = renderToSVG(retained)
    expect(svgPathElements(ordinarySVG)).toEqual(
      partialPoints.map((points) => ordinaryPath(points, 1)),
    )
    expectStrategyCallCounts(strategyCountsAfterPreparation)

    const outlineSourceSnapshot = snapshot(
      toneCalibration.deriveOutlineSource!(retained, {
        toolWidthMillimeters: 0.4,
        millimetersPerSceneUnit: 2,
      }),
    )
    const outlineSource = outlineSourceSnapshot.value
    expectOpenTwoPointStipples(outlineSource, partialPoints, 0.2, 'source')
    expect(
      outlineSource.primitives.map(({ stroke: _stroke, ...primitive }) =>
        primitive,
      ),
    ).toEqual(
      retained.primitives.map(({ stroke: _stroke, ...primitive }) =>
        primitive,
      ),
    )

    const hiddenLineSnapshot = snapshot(hiddenLinePass(outlineSource))
    const hiddenLine = hiddenLineSnapshot.value
    expectOpenTwoPointStipples(hiddenLine, partialPoints, 0.2, undefined)
    expectStrategyCallCounts(strategyCountsAfterPreparation)

    const page: PageFrame = deepFreeze({
      x: 20,
      y: 15,
      width: 60,
      height: 40,
    })
    const framedSnapshot = snapshot(frameScene(hiddenLine, page))
    const framedPoints: Point[][] = [
      [
        [19.9 - page.x, 25 - page.y],
        [20.1 - page.x, 25 - page.y],
      ],
      [
        [30 - page.x, 20 - page.y],
        [30.2 - page.x, 20 - page.y],
      ],
      [
        [79.9 - page.x, 35 - page.y],
        [80.1 - page.x, 35 - page.y],
      ],
    ]
    expectOpenTwoPointStipples(
      framedSnapshot.value,
      framedPoints,
      0.2,
      undefined,
    )

    const clippedSnapshot = snapshot(
      clipSceneToBounds(framedSnapshot.value),
    )
    const clippedPoints: Point[][] = [
      [
        [0, 10],
        [20.1 - page.x, 10],
      ],
      [
        [10, 5],
        [30.2 - page.x, 5],
      ],
      [
        [79.9 - page.x, 20],
        [60, 20],
      ],
    ]
    expectOpenTwoPointStipples(
      clippedSnapshot.value,
      clippedPoints,
      0.2,
      undefined,
    )
    expectStrategyCallCounts(strategyCountsAfterPreparation)

    const pageProfileSnapshot = snapshot(
      derivePageFramePlotProfile(
        {
          width: 220,
          height: 188,
          insets: { top: 11, right: 13, bottom: 17, left: 7 },
          includeFrame: false,
          toolWidthMillimeters: 0.4,
        },
        { x: 0, y: 0, width: 100, height: 80 },
        page,
      ),
    )
    const plotterSVG = renderPlotterSVG(
      clippedSnapshot.value,
      pageProfileSnapshot.value,
    )
    expect(svgPathElements(plotterSVG)).toEqual([
      '<path d="M7 31 L7.2 31" fill="none" stroke="black" stroke-width="0.4" />',
      '<path d="M27 21 L27.4 21" fill="none" stroke="black" stroke-width="0.4" />',
      '<path d="M126.8 51 L127 51" fill="none" stroke="black" stroke-width="0.4" />',
    ])
    expect(plotterSVG).not.toMatch(
      /<(?:rect|g|polyline|circle|clipPath)\b|\b(?:transform|clip-path)=|\sZ(?:"|\s)/,
    )
    expectStrategyCallCounts(strategyCountsAfterPreparation)

    // Output stages may clone, restyle, rebase, clip, map, and round their own
    // values, but the retained partial artwork remains the frozen source.
    expect(outlineSource).not.toBe(retained)
    expect(hiddenLine).not.toBe(outlineSource)
    expect(framedSnapshot.value).not.toBe(hiddenLine)
    expect(clippedSnapshot.value).not.toBe(framedSnapshot.value)
    for (const frozen of [
      retainedSnapshot,
      outlineSourceSnapshot,
      hiddenLineSnapshot,
      framedSnapshot,
      clippedSnapshot,
      pageProfileSnapshot,
    ]) {
      expectUnchanged(frozen)
    }
  })
})
