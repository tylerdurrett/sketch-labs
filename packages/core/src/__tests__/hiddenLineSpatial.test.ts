import { describe, expect, it } from 'vitest'

import {
  analyzeHiddenLinePlan,
  analyzeHiddenLineWorkload,
  hiddenLinePass,
} from '../hiddenLine'
import type { HiddenLineProgress } from '../hiddenLine'
import type { HiddenLineRole, Primitive, Scene } from '../scene'
import type { Polyline } from '../types'
import { quadraticHiddenLineReference } from './helpers/quadraticHiddenLineReference'

const space = { width: 120, height: 80 }
const fill = { color: 'paper' }

function rectangle(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  role?: HiddenLineRole,
): Primitive {
  const primitive: Primitive = {
    points: [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ],
    closed: true,
    fill,
  }
  if (role !== undefined) primitive.hiddenLineRole = role
  return primitive
}

function expectQuadraticParity(scene: Scene, tolerance = 0) {
  const before = structuredClone(scene)
  const expected = quadraticHiddenLineReference(scene, tolerance)
  const progress: HiddenLineProgress[] = []
  const actual = hiddenLinePass(scene, {
    tolerance,
    observer: (snapshot) => progress.push(snapshot),
  })
  const analysis = analyzeHiddenLinePlan(scene)

  expect(actual).toEqual(expected.scene)
  expect(analyzeHiddenLineWorkload(scene)).toEqual(expected.workload)
  expect(analysis.workload).toEqual(expected.workload)
  expect(analysis.broadPhase.trueOverlappingPairCount).toBe(
    expected.candidatePairs.length,
  )
  expect(
    analysis.broadPhase.enumeratedCandidatePairCount,
  ).toBeGreaterThanOrEqual(expected.candidatePairs.length)
  expect(analysis.broadPhase.enumeratedCandidatePairCount).toBeLessThanOrEqual(
    analysis.broadPhase.eligiblePainterPairCount,
  )
  expect(progress).toEqual(expected.progress)
  expect(scene).toEqual(before)
}

describe('Hidden-line spatial planner differential parity', () => {
  it('matches the quadratic reference for legacy fills and concave polygons', () => {
    const concave: Primitive = {
      points: [
        [20, 10],
        [65, 10],
        [65, 20],
        [35, 20],
        [35, 55],
        [20, 55],
      ],
      closed: true,
      fill,
      stroke: { color: 'authored', width: 2.5 },
    }
    expectQuadraticParity({
      space,
      background: { color: 'sky' },
      primitives: [
        rectangle(0, 0, 50, 50),
        { ...rectangle(70, 0, 90, 20), closed: false },
        concave,
        rectangle(90, 60, 110, 75),
      ],
    })
  })

  it('matches explicit source/occluder roles and open/closed source paths', () => {
    const openSource: Primitive = {
      points: [
        [0, 30],
        [90, 30],
        [90, 60],
      ],
      stroke: { color: 'red', width: 3 },
      hiddenLineRole: 'source',
    }
    const closedSource: Primitive = {
      points: [
        [5, 5],
        [100, 5],
        [100, 70],
      ],
      closed: true,
      stroke: { color: 'blue', width: 4 },
      hiddenLineRole: 'source',
    }
    const ineffectiveOccluder: Primitive = {
      points: [
        [0, 0],
        [120, 80],
      ],
      stroke: { color: 'ignored', width: 9 },
      hiddenLineRole: 'occluder',
    }

    expectQuadraticParity(
      {
        space,
        primitives: [
          openSource,
          ineffectiveOccluder,
          rectangle(15, 20, 45, 45, 'occluder'),
          closedSource,
          rectangle(75, 0, 110, 40, 'both'),
          { points: [], fill, hiddenLineRole: 'both' },
        ],
      },
      0.25,
    )
  })

  it('keeps oversized finite boxes on the conservative overflow path', () => {
    const huge = Number.MAX_SAFE_INTEGER
    const scene: Scene = {
      space,
      primitives: [
        rectangle(0, 0, 40, 40),
        rectangle(-huge, 10, huge, 20, 'occluder'),
        rectangle(20, 5, 30, 25),
        rectangle(100, 60, 110, 70),
      ],
    }

    expectQuadraticParity(scene)
    const { broadPhase } = analyzeHiddenLinePlan(scene)
    expect(broadPhase.index.overflowEntryCount).toBeGreaterThan(0)
    expect(broadPhase.index.cellCapOverflowEntryCount).toBeGreaterThan(0)
    expect(broadPhase.enumeratedCandidatePairCount).toBeGreaterThanOrEqual(
      broadPhase.trueOverlappingPairCount,
    )
  })

  it('matches deterministic randomized small generic Scenes', () => {
    let state = 0x6d2b79f5
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state / 0x1_0000_0000
    }
    const roles: Array<HiddenLineRole | undefined> = [
      undefined,
      'source',
      'occluder',
      'both',
    ]

    for (let sceneIndex = 0; sceneIndex < 24; sceneIndex++) {
      const primitives: Primitive[] = []
      const primitiveCount = 4 + Math.floor(random() * 8)
      for (
        let primitiveIndex = 0;
        primitiveIndex < primitiveCount;
        primitiveIndex++
      ) {
        const x = random() * 105 - 5
        const y = random() * 65 - 5
        const width = 3 + random() * 25
        const height = 3 + random() * 20
        const role = roles[Math.floor(random() * roles.length)]
        const points: Polyline = random() < 0.3
          ? [
              [x, y],
              [x + width, y],
              [x + width, y + height * 0.4],
              [x + width * 0.45, y + height * 0.4],
              [x + width * 0.45, y + height],
              [x, y + height],
            ]
          : [
              [x, y],
              [x + width, y],
              [x + width, y + height],
              [x, y + height],
            ]
        const primitive: Primitive = {
          points,
          closed: random() < 0.8,
          stroke: { color: 'authored', width: 0.5 + random() * 3 },
        }
        if (role !== undefined) primitive.hiddenLineRole = role
        if (role !== 'source' || random() < 0.5) primitive.fill = fill
        primitives.push(primitive)
      }
      expectQuadraticParity(
        { space, primitives },
        sceneIndex % 3 === 0 ? 0.1 : 0,
      )
    }
  })

  it('exposes bounded spatial-enumeration evidence without changing workload', () => {
    const primitives = Array.from({ length: 400 }, (_, index) => {
      const x = (index % 20) * 6
      const y = Math.floor(index / 20) * 4
      return rectangle(x, y, x + 1, y + 1)
    })
    const scene = { space, primitives }
    const analysis = analyzeHiddenLinePlan(scene)

    expect(analysis.workload).toEqual(analyzeHiddenLineWorkload(scene))
    expect(analysis.broadPhase).toMatchObject({
      queriedSourceCount: 400,
      occluderCount: 400,
      eligiblePainterPairCount: 79_800,
      enumeratedCandidatePairCount: 0,
      trueOverlappingPairCount: 0,
      index: {
        entryCount: 400,
        indexedEntryCount: 400,
        overflowEntryCount: 0,
      },
    })
    expect(Object.isFrozen(analysis)).toBe(true)
    expect(Object.isFrozen(analysis.broadPhase)).toBe(true)
    expect(analysis.broadPhase.cellSize).toBeGreaterThan(0)
  })
})
