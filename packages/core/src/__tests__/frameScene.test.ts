import { describe, expect, it } from 'vitest'

import { frameScene } from '../frameScene'
import type { PageFrame } from '../pageFrame'
import type { Primitive, Scene } from '../scene'

const composition = { width: 100, height: 80 }
const crop: PageFrame = { x: 20, y: 10, width: 60, height: 50 }

function sceneOf(...primitives: Primitive[]): Scene {
  return { space: composition, primitives }
}

function expectInsidePage(scene: Scene): void {
  for (const primitive of scene.primitives) {
    for (const [x, y] of primitive.points) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(scene.space.width)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(scene.space.height)
    }
  }
}

describe('frameScene', () => {
  it.each([
    [
      'left',
      [
        [0, 30],
        [40, 30],
      ],
      [
        [0, 20],
        [20, 20],
      ],
    ],
    [
      'right',
      [
        [60, 30],
        [100, 30],
      ],
      [
        [40, 20],
        [60, 20],
      ],
    ],
    [
      'top',
      [
        [40, 0],
        [40, 30],
      ],
      [
        [20, 0],
        [20, 20],
      ],
    ],
    [
      'bottom',
      [
        [40, 40],
        [40, 80],
      ],
      [
        [20, 30],
        [20, 50],
      ],
    ],
  ] as const)(
    'clips and rebases a stroke crossing the %s edge',
    (_edge, points, expected) => {
      const result = frameScene(
        sceneOf({ points: [...points], stroke: { color: 'black', width: 3 } }),
        crop,
      )

      expect(result.primitives).toHaveLength(1)
      expect(result.primitives[0]!.points).toEqual(expected)
      expect(result.primitives[0]!.stroke).toEqual({
        color: 'black',
        width: 3,
      })
    },
  )

  it('clips one stroke across multiple edges and a corner without drawing Page edges', () => {
    const result = frameScene(
      sceneOf({
        points: [
          [0, 30],
          [40, 30],
          [100, 80],
          [40, 40],
        ],
        closed: false,
        stroke: { color: 'red', width: 2 },
      }),
      crop,
    )

    expect(result.primitives).toHaveLength(2)
    expect(result.primitives[0]!.points).toEqual([
      [0, 20],
      [20, 20],
      [56, 50],
    ])
    expect(result.primitives[1]!.points).toEqual([
      [50, 50],
      [20, 30],
    ])
    expect(result.primitives.every(({ closed }) => closed === false)).toBe(true)
    expectInsidePage(result)
  })

  it('drops geometry wholly outside the Page Frame', () => {
    const result = frameScene(
      sceneOf(
        {
          points: [
            [0, 0],
            [10, 5],
          ],
          stroke: { color: 'black', width: 1 },
        },
        {
          points: [
            [85, 65],
            [95, 65],
            [95, 75],
            [85, 75],
          ],
          closed: true,
          fill: { color: 'blue' },
        },
      ),
      crop,
    )

    expect(result.primitives).toEqual([])
  })

  it('clips a fill to the viewport intersection, including required Page-boundary geometry', () => {
    const result = frameScene(
      sceneOf({
        points: [
          [0, 0],
          [50, 0],
          [50, 40],
          [0, 40],
        ],
        closed: true,
        fill: { color: 'blue' },
      }),
      crop,
    )

    expect(result.primitives).toEqual([
      {
        points: [
          [0, 0],
          [30, 0],
          [30, 30],
          [0, 30],
        ],
        closed: true,
        fill: { color: 'blue' },
      },
    ])
  })

  it('clips a fill surrounding the Page at all four edges and corners', () => {
    const result = frameScene(
      sceneOf({
        points: [
          [0, 0],
          [100, 0],
          [100, 80],
          [0, 80],
        ],
        closed: true,
        fill: { color: 'green' },
      }),
      crop,
    )

    expect(result.primitives).toEqual([
      {
        points: [
          [0, 50],
          [0, 0],
          [60, 0],
          [60, 50],
        ],
        closed: true,
        fill: { color: 'green' },
      },
    ])
  })

  it('treats an open filled path as implicitly closed while keeping closed absent', () => {
    const result = frameScene(
      sceneOf({
        points: [
          [0, 0],
          [100, 0],
          [50, 80],
        ],
        fill: { color: 'gold' },
      }),
      crop,
    )

    expect(result.primitives).toHaveLength(1)
    expect(result.primitives[0]!.fill).toEqual({ color: 'gold' })
    expect('closed' in result.primitives[0]!).toBe(false)
    expect(result.primitives[0]!.points).toEqual([
      [17.5, 50],
      [0, 22],
      [0, 0],
      [60, 0],
      [60, 22],
      [42.5, 50],
    ])
  })

  it('separates clipped fill from original stroked perimeter and never strokes the Page boundary', () => {
    const role = 'both' as const
    const result = frameScene(
      sceneOf({
        points: [
          [0, 0],
          [100, 0],
          [100, 40],
          [0, 40],
        ],
        closed: true,
        fill: { color: 'papayawhip' },
        stroke: { color: 'purple', width: 4 },
        hiddenLineRole: role,
      }),
      crop,
    )

    expect(result.primitives).toHaveLength(2)
    const [fill, stroke] = result.primitives
    expect(fill).toEqual({
      points: [
        [0, 0],
        [60, 0],
        [60, 30],
        [0, 30],
      ],
      closed: true,
      fill: { color: 'papayawhip' },
      hiddenLineRole: role,
    })
    expect(stroke).toEqual({
      points: [
        [60, 30],
        [0, 30],
      ],
      closed: false,
      stroke: { color: 'purple', width: 4 },
      hiddenLineRole: role,
    })
  })

  it('does not synthesize a stroke when a closed stroked perimeter surrounds the Page', () => {
    const result = frameScene(
      sceneOf({
        points: [
          [0, 0],
          [100, 0],
          [100, 80],
          [0, 80],
        ],
        closed: true,
        stroke: { color: 'black', width: 2 },
      }),
      crop,
    )

    expect(result.primitives).toEqual([])
  })

  it('keeps each split Primitive together in painter order, fill before its stroke survivors', () => {
    const result = frameScene(
      sceneOf(
        {
          points: [
            [0, 20],
            [40, 20],
            [100, 50],
            [40, 50],
          ],
          closed: true,
          fill: { color: 'red' },
          stroke: { color: 'darkred', width: 1 },
          hiddenLineRole: 'source',
        },
        {
          points: [
            [30, 20],
            [70, 20],
          ],
          stroke: { color: 'blue', width: 1 },
          hiddenLineRole: 'occluder',
        },
      ),
      crop,
    )

    expect(
      result.primitives.map(({ fill, stroke }) => [fill?.color, stroke?.color]),
    ).toEqual([
      ['red', undefined],
      [undefined, 'darkred'],
      [undefined, 'darkred'],
      [undefined, 'blue'],
    ])
    expect(
      result.primitives.slice(0, 3).map(({ hiddenLineRole }) => hiddenLineRole),
    ).toEqual(['source', 'source', 'source'])
    expect(result.primitives[3]!.hiddenLineRole).toBe('occluder')
  })

  it.each([
    ['asymmetric crop', { x: 10, y: 20, width: 70, height: 30 }],
    ['outward padding', { x: -20, y: -10, width: 140, height: 100 }],
    ['mixed crop and padding', { x: 20, y: -10, width: 100, height: 70 }],
  ] satisfies Array<[string, PageFrame]>)(
    'uses only the %s extent and top-left rebase',
    (_name, frame) => {
      const source = sceneOf({
        points: [
          [20, 20],
          [80, 60],
        ],
        stroke: { color: 'black', width: 1 },
      })
      const result = frameScene(source, frame)

      expect(result.space).toEqual({
        width: frame.width,
        height: frame.height,
      })
      expectInsidePage(result)
      if (_name === 'outward padding') {
        expect(result.primitives[0]!.points).toEqual([
          [40, 30],
          [100, 70],
        ])
      }
    },
  )

  it('padding adds extent only and carries an authored background across it', () => {
    const scene: Scene = {
      space: composition,
      primitives: [{ points: [[10, 10]], fill: { color: 'ink' } }],
      background: { color: 'paper' },
    }
    const result = frameScene(scene, {
      x: -20,
      y: -10,
      width: 140,
      height: 100,
    })

    expect(result).toEqual({
      space: { width: 140, height: 100 },
      primitives: [{ points: [[30, 20]], fill: { color: 'ink' } }],
      background: { color: 'paper' },
    })
  })

  it('preserves absent optional fields and the absence of a Scene background', () => {
    const result = frameScene(
      sceneOf({
        points: [
          [0, 30],
          [40, 30],
        ],
        stroke: { color: 'black', width: 1 },
      }),
      crop,
    )
    const output = result.primitives[0]!

    expect('closed' in output).toBe(false)
    expect('fill' in output).toBe(false)
    expect('hiddenLineRole' in output).toBe(false)
    expect('background' in result).toBe(false)
  })

  it('is pure and does not alias output geometry to Scene or Page Frame inputs', () => {
    const scene = sceneOf({
      points: [
        [30, 20],
        [70, 50],
      ],
      closed: false,
      stroke: { color: 'black', width: 1 },
      hiddenLineRole: 'source',
    })
    const frame = { ...crop }
    const originalScene = structuredClone(scene)
    const originalFrame = structuredClone(frame)

    const result = frameScene(scene, frame)

    expect(scene).toEqual(originalScene)
    expect(frame).toEqual(originalFrame)
    expect(result.space).not.toBe(frame)
    expect(result.primitives[0]!.points).not.toBe(scene.primitives[0]!.points)
    expect(result.primitives[0]!.points[0]).not.toBe(
      scene.primitives[0]!.points[0],
    )
  })
})
