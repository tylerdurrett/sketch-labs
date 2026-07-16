import { describe, expect, it } from 'vitest'

import { clipSceneToBounds } from '../clipToBounds'
import { resolveCompositionFrame } from '../compositionFrame'
import { hiddenLinePass } from '../hiddenLine'
import type { PlotProfile } from '../plotProfile'
import { renderPlotterSVG } from '../plotterSvg'
import { renderToCanvas, type Canvas2DContext } from '../renderer'
import type { Primitive, Scene } from '../scene'
import { defaultParams } from '../sketch'
import { simplifyPath } from '../simplifyPath'
import type { Point } from '../types'
import { grassHills } from '../sketches/grass-hills'
import { GRASS_HILLS_TOOL_WIDTH_MILLIMETERS } from '../sketches/grass-hills/outline'
import { GRASS_HILLS_FIDELITY_FIXTURES } from './grassHillsFidelityFixtures'
import { compareVisibleContours } from './visibleContourOracle'

type PrimitiveKind = 'blade' | 'hill'

function kindOf(primitive: Primitive): PrimitiveKind {
  return primitive.points.length === 7 ? 'blade' : 'hill'
}

function boundsOf(
  primitive: Primitive,
): readonly [number, number, number, number] {
  const xs = primitive.points.map(([x]) => x)
  const ys = primitive.points.map(([, y]) => y)
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

function overlaps(left: Primitive, right: Primitive): boolean {
  const [leftMinX, leftMinY, leftMaxX, leftMaxY] = boundsOf(left)
  const [rightMinX, rightMinY, rightMaxX, rightMaxY] = boundsOf(right)
  return (
    leftMinX < rightMaxX &&
    leftMaxX > rightMinX &&
    leftMinY < rightMaxY &&
    leftMaxY > rightMinY
  )
}

function painterPairInventory(scene: Scene): ReadonlySet<string> {
  const inventory = new Set<string>()
  for (let farther = 0; farther < scene.primitives.length; farther++) {
    const fartherPrimitive = scene.primitives[farther]!
    if (fartherPrimitive.fill === undefined) continue
    for (let nearer = farther + 1; nearer < scene.primitives.length; nearer++) {
      const nearerPrimitive = scene.primitives[nearer]!
      if (nearerPrimitive.fill === undefined) continue
      if (overlaps(fartherPrimitive, nearerPrimitive)) {
        inventory.add(`${kindOf(fartherPrimitive)}/${kindOf(nearerPrimitive)}`)
      }
    }
  }
  return inventory
}

/**
 * Reconstruct issue #305's six root-to-tip spine from one seven-point Fill
 * silhouette without importing the production spine helper. The symmetric
 * t=.5 flanks recover the bend exponent; the shared apex recovers total lean.
 */
function reconstructIssue305Centerline(blade: Primitive): Point[] {
  if (blade.points.length !== 7) {
    throw new Error('issue-305 reconstruction requires a seven-point blade')
  }
  const root = blade.points[0]!
  const rightHalf = blade.points[1]!
  const tip = blade.points[3]!
  const leftHalf = blade.points[5]!
  const halfCenterX = (rightHalf[0] + leftHalf[0]) / 2
  const tipOffset = tip[0] - root[0]
  const halfOffset = halfCenterX - root[0]
  const exponent =
    Math.abs(tipOffset) < 1e-12 || Math.abs(halfOffset) < 1e-12
      ? 2
      : Math.log(halfOffset / tipOffset) / Math.log(0.5)

  return Array.from({ length: 6 }, (_, index): Point => {
    const t = index / 5
    return [
      root[0] + tipOffset * t ** exponent,
      root[1] + (tip[1] - root[1]) * t,
    ]
  })
}

function reconstructedIssue305Source(fill: Scene): Scene {
  return {
    space: fill.space,
    primitives: fill.primitives
      .filter((primitive) => kindOf(primitive) === 'blade')
      .map((primitive) => ({
        points: reconstructIssue305Centerline(primitive),
        stroke: { color: 'black', width: 1 },
        hiddenLineRole: 'source',
      })),
  }
}

function invokePublicFixture(
  fixture: typeof GRASS_HILLS_FIDELITY_FIXTURES.bounded,
): { fill: Scene; source: Scene; outline: Scene } {
  const fill = grassHills.generate(
    fixture.params,
    fixture.seed,
    fixture.time,
    fixture.frame,
  )
  const source = grassHills.generateOutlineSource!(
    fixture.params,
    fixture.seed,
    fixture.time,
    fixture.frame,
    fixture.target,
  )
  return { fill, source, outline: hiddenLinePass(source) }
}

const FRAME_CASES = [
  ['square', resolveCompositionFrame(1)],
  ['wide', resolveCompositionFrame(16 / 9)],
  ['tall', resolveCompositionFrame(9 / 16)],
] as const

const FRAME_ZOOM_CASES = FRAME_CASES.flatMap(([frameName, frame]) =>
  ([1, 1.75] as const).map((foregroundZoom) => ({
    name: `${frameName}, zoom ${foregroundZoom}`,
    frame,
    foregroundZoom,
  })),
)

/**
 * Default Grass Hills geometry with only density reduced to keep the independent
 * quadratic oracle bounded. Terrain, relief, hill count, blade variation, and
 * wind otherwise exercise the real production defaults.
 */
const FRAME_FIDELITY_PARAMS = Object.freeze({
  ...defaultParams(grassHills.schema),
  bladeDensity: 0.002,
})

const FRAME_FIDELITY_TARGET = Object.freeze({
  toolWidthMillimeters: GRASS_HILLS_TOOL_WIDTH_MILLIMETERS,
  millimetersPerSceneUnit: 0.18,
})

function isBlade(primitive: Primitive): boolean {
  return primitive.points.length === 7
}

function segmentsOf(primitive: Primitive): Array<readonly [Point, Point]> {
  const segments: Array<readonly [Point, Point]> = []
  for (let index = 1; index < primitive.points.length; index++) {
    segments.push([primitive.points[index - 1]!, primitive.points[index]!])
  }
  return segments
}

function isNonDegenerateFrameEdge(
  [start, end]: readonly [Point, Point],
  scene: Scene,
): boolean {
  if (start[0] === end[0] && start[1] === end[1]) return false
  return (
    (start[0] === 0 && end[0] === 0) ||
    (start[0] === scene.space.width && end[0] === scene.space.width) ||
    (start[1] === 0 && end[1] === 0) ||
    (start[1] === scene.space.height && end[1] === scene.space.height)
  )
}

function appendCompositionFrame(scene: Scene): Scene {
  const { width, height } = scene.space
  return {
    ...scene,
    primitives: [
      ...scene.primitives,
      {
        points: [
          [0, 0],
          [width, 0],
          [width, height],
          [0, height],
          [0, 0],
        ],
        stroke: { color: 'black', width: 1 },
      },
    ],
  }
}

function noOpCanvas(): Canvas2DContext {
  return {
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill() {},
    stroke() {},
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    setTransform() {},
    fillRect() {},
    clearRect() {},
  }
}

describe('Grass Hills real-call-site visible-contour fidelity', () => {
  it('covers representative painter visibility in the bounded exact fixture', () => {
    const fixture = GRASS_HILLS_FIDELITY_FIXTURES.bounded
    const fill = grassHills.generate(
      fixture.params,
      fixture.seed,
      fixture.time,
      fixture.frame,
    )
    const faithfulOutline = hiddenLinePass(fill)

    expect(
      fill.primitives.filter(({ points }) => points.length === 7),
    ).toHaveLength(fixture.expectedBladeCount)
    expect(painterPairInventory(fill)).toEqual(
      new Set(['hill/blade', 'hill/hill', 'blade/blade', 'blade/hill']),
    )
    expect(compareVisibleContours(fill, faithfulOutline)).toEqual({
      matches: true,
      missing: [],
      extra: [],
    })
  })

  it('rejects issue #305 centerlines bidirectionally even before root LOD', () => {
    const fixture = GRASS_HILLS_FIDELITY_FIXTURES.bounded
    const fill = grassHills.generate(
      fixture.params,
      fixture.seed,
      fixture.time,
      fixture.frame,
    )
    const reconstructed = reconstructedIssue305Source(fill)
    const comparison = compareVisibleContours(
      fill,
      hiddenLinePass(reconstructed),
    )

    expect(reconstructed.primitives).toHaveLength(fixture.expectedBladeCount)
    expect(comparison.matches).toBe(false)
    expect(comparison.missing.length).toBeGreaterThan(0)
    expect(comparison.extra.length).toBeGreaterThan(0)
  })

  it('faithfully reproduces Fill contours through the public Outline path', () => {
    const fixture = GRASS_HILLS_FIDELITY_FIXTURES.bounded
    const { fill, source, outline } = invokePublicFixture(fixture)
    const comparison = compareVisibleContours(fill, outline)

    expect(comparison).toEqual({ matches: true, missing: [], extra: [] })
    expect(source.primitives).toHaveLength(fill.primitives.length)
    expect(source.primitives.map(({ points }) => points)).toEqual(
      fill.primitives.map(({ points }) => points),
    )
    expect(source.primitives.map(({ closed }) => closed)).toEqual(
      fill.primitives.map(({ closed }) => closed),
    )
    expect(
      source.primitives.every(({ hiddenLineRole }) => hiddenLineRole === 'both'),
    ).toBe(true)
    expect(
      source.primitives.filter(({ points }) => points.length === 7),
    ).toHaveLength(fixture.expectedBladeCount)
    expect(
      source.primitives.some(({ points }) => points.length === 6),
    ).toBe(false)
  })

  it('keeps geometry and complete roots invariant across physical tool widths', () => {
    const fixture = GRASS_HILLS_FIDELITY_FIXTURES.bounded
    const fill = grassHills.generate(
      fixture.params,
      fixture.seed,
      fixture.time,
      fixture.frame,
    )
    const source = grassHills.generateOutlineSource!(
      fixture.params,
      fixture.seed,
      fixture.time,
      fixture.frame,
      { ...fixture.target, millimetersPerSceneUnit: 0.003 },
    )
    const blades = source.primitives.filter(
      ({ points }) => points.length === 7,
    )
    const comparison = compareVisibleContours(fill, hiddenLinePass(source))

    expect(blades).toHaveLength(fixture.expectedBladeCount)
    expect(source.primitives.map(({ points }) => points)).toEqual(
      fill.primitives.map(({ points }) => points),
    )
    expect(comparison).toEqual({ matches: true, missing: [], extra: [] })
  })

  it('pins adopted and ceiling envelopes for scalable fidelity campaigns', () => {
    const { bounded, adopted10k, ceiling50k } = GRASS_HILLS_FIDELITY_FIXTURES

    expect(bounded.oraclePolicy).toBe('exact-now')
    expect(
      [adopted10k, ceiling50k].map((fixture) => ({
        density: fixture.params.bladeDensity,
        expectedBladeCount: fixture.expectedBladeCount,
        oraclePolicy: fixture.oraclePolicy,
      })),
    ).toEqual([
      {
        density: 2,
        expectedBladeCount: 10_000,
        oraclePolicy: 'scalable-campaign',
      },
      {
        density: 10,
        expectedBladeCount: 50_000,
        oraclePolicy: 'scalable-campaign',
      },
    ])
  })

  it.each(FRAME_ZOOM_CASES)(
    'keeps non-flat Fill and tolerance-0 Outline exact after clipping ($name)',
    ({ frame, foregroundZoom }) => {
      const params = { ...FRAME_FIDELITY_PARAMS, foregroundZoom }
      const fill = grassHills.generate(
        params,
        'issue-309-frame-fidelity',
        19,
        frame,
      )
      const repeatedFill = grassHills.generate(
        params,
        'issue-309-frame-fidelity',
        -200,
        frame,
      )
      const source = grassHills.generateOutlineSource!(
        params,
        'issue-309-frame-fidelity',
        19,
        frame,
        FRAME_FIDELITY_TARGET,
      )
      const repeatedSource = grassHills.generateOutlineSource!(
        params,
        'issue-309-frame-fidelity',
        -200,
        frame,
        FRAME_FIDELITY_TARGET,
      )
      const hills = fill.primitives.filter((primitive) => !isBlade(primitive))
      const blades = fill.primitives.filter(isBlade)

      expect(repeatedFill).toEqual(fill)
      expect(repeatedSource).toEqual(source)
      expect(source.primitives).toHaveLength(fill.primitives.length)
      expect(source.primitives.map(({ points }) => points)).toEqual(
        fill.primitives.map(({ points }) => points),
      )
      expect(source.primitives.map(({ closed }) => closed)).toEqual(
        fill.primitives.map(({ closed }) => closed),
      )
      expect(
        source.primitives.every(
          ({ hiddenLineRole }) => hiddenLineRole === 'both',
        ),
      ).toBe(true)

      // The real terrain defaults are active: ridgelines are not flat proxies.
      expect(hills).toHaveLength(FRAME_FIDELITY_PARAMS.hillCount)
      expect(
        hills.every(
          ({ points }) => new Set(points.slice(0, -3).map(([, y]) => y)).size > 2,
        ),
      ).toBe(true)

      // Hill sides and bottoms remain authored rings, but wholly off-frame.
      for (const hill of hills) {
        const first = hill.points[0]!
        const finalRidgePoint = hill.points.at(-4)!
        const rightBottom = hill.points.at(-3)!
        const leftBottom = hill.points.at(-2)!
        expect(hill.closed).toBe(false)
        expect(hill.points.at(-1)).toEqual(first)
        expect(first[0]).toBeLessThan(0)
        expect(finalRidgePoint[0]).toBeGreaterThan(frame.width)
        expect(rightBottom[0]).toBeGreaterThan(frame.width)
        expect(leftBottom[0]).toBeLessThan(0)
        expect(rightBottom[1]).toBeGreaterThan(frame.height)
        expect(leftBottom[1]).toBeGreaterThan(frame.height)
      }

      // Zoom changes only closure metadata; every blade keeps its explicit root
      // repeat, so open zoomed paths and closed identity paths trace one boundary.
      expect(blades.length).toBeGreaterThan(0)
      expect(
        blades.every(({ points }) => {
          const first = points[0]!
          const last = points.at(-1)!
          return first[0] === last[0] && first[1] === last[1]
        }),
      ).toBe(true)
      expect(blades.every(({ closed }) => closed === (foregroundZoom === 1))).toBe(
        true,
      )

      const outline = clipSceneToBounds(
        hiddenLinePass(source, { tolerance: 0 }),
      )
      const comparison = compareVisibleContours(fill, outline)

      expect(comparison).toEqual({ matches: true, missing: [], extra: [] })
      expect(outline.background).toBeUndefined()
      expect(outline.primitives.length).toBeGreaterThan(0)
      for (const primitive of outline.primitives) {
        expect(primitive.closed).toBeUndefined()
        expect(primitive.fill).toBeUndefined()
        expect(
          primitive.points.every(
            ([x, y]) => x >= 0 && x <= frame.width && y >= 0 && y <= frame.height,
          ),
        ).toBe(true)
        expect(
          segmentsOf(primitive).some((segment) =>
            isNonDegenerateFrameEdge(segment, outline),
          ),
        ).toBe(false)
      }

      // Do not mistake all linework above a ridge for invented sky geometry:
      // at least one actual blade tip survives and the bidirectional oracle has
      // already proved it belongs to Fill's visible boundary.
      const outlinePoints = outline.primitives.flatMap(({ points }) => points)
      expect(
        blades.some(({ points }) => {
          const root = points[0]!
          const tip = points[3]!
          return (
            tip[1] < root[1] &&
            tip[0] >= 0 &&
            tip[0] <= frame.width &&
            tip[1] >= 0 &&
            tip[1] <= frame.height &&
            outlinePoints.some(
              ([x, y]) => x === tip[0] && y === tip[1],
            )
          )
        }),
      ).toBe(true)
    },
  )

  it('treats only the optional final output-profile frame as non-sketch geometry', () => {
    const frame = resolveCompositionFrame(16 / 9)
    const params = { ...FRAME_FIDELITY_PARAMS, foregroundZoom: 1.75 }
    const fill = grassHills.generate(params, 'profile-frame', 0, frame)
    const source = grassHills.generateOutlineSource!(
      params,
      'profile-frame',
      0,
      frame,
      FRAME_FIDELITY_TARGET,
    )
    const outline = clipSceneToBounds(
      hiddenLinePass(source, { tolerance: 0 }),
    )
    const framed = appendCompositionFrame(outline)

    expect(compareVisibleContours(fill, outline).matches).toBe(true)
    expect(compareVisibleContours(fill, framed).matches).toBe(false)
    expect(
      compareVisibleContours(fill, framed, {
        excludeCompositionFrame: true,
      }),
    ).toEqual({ matches: true, missing: [], extra: [] })
  })

  it('applies positive tolerance only as final simplification of exact survivors', () => {
    const frame = resolveCompositionFrame(16 / 9)
    const params = { ...FRAME_FIDELITY_PARAMS, foregroundZoom: 1.75 }
    const source = grassHills.generateOutlineSource!(
      params,
      'positive-tolerance',
      0,
      frame,
      FRAME_FIDELITY_TARGET,
    )
    const exact = hiddenLinePass(source, { tolerance: 0 })
    const tolerance = 0.75
    const expected: Scene = {
      space: exact.space,
      primitives: exact.primitives.map((primitive) => ({
        ...primitive,
        points: simplifyPath(primitive.points, tolerance),
      })),
    }
    const simplified = hiddenLinePass(source, { tolerance })

    expect(simplified).toEqual(expected)
    expect(hiddenLinePass(source, { tolerance })).toEqual(simplified)
    expect(simplified.primitives.map(({ stroke }) => stroke)).toEqual(
      exact.primitives.map(({ stroke }) => stroke),
    )
    expect(simplified.primitives.map(({ closed }) => closed)).toEqual(
      exact.primitives.map(({ closed }) => closed),
    )
    expect(simplified.primitives.map(({ fill }) => fill)).toEqual(
      exact.primitives.map(({ fill }) => fill),
    )
    expect(
      simplified.primitives.reduce(
        (count, primitive) => count + primitive.points.length,
        0,
      ),
    ).toBeLessThan(
      exact.primitives.reduce(
        (count, primitive) => count + primitive.points.length,
        0,
      ),
    )

    // This completed value is the reusable Scene boundary. Canvas preview reads
    // it directly; export adds only bounds clipping before physical mapping.
    const beforeConsumers = structuredClone(simplified)
    const profile: PlotProfile = {
      width: 180,
      height: 101.25,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      includeFrame: false,
    }
    renderToCanvas(noOpCanvas(), simplified)
    renderPlotterSVG(clipSceneToBounds(simplified), profile)
    expect(simplified).toEqual(beforeConsumers)
  })
})
