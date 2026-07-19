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
    const strokeRadius = (primitive.stroke?.width ?? 0) / 2
    for (const [x, y] of primitive.points) {
      expect(x).toBeGreaterThanOrEqual(-strokeRadius)
      expect(x).toBeLessThanOrEqual(scene.space.width + strokeRadius)
      expect(y).toBeGreaterThanOrEqual(-strokeRadius)
      expect(y).toBeLessThanOrEqual(scene.space.height + strokeRadius)
      if (primitive.fill !== undefined) {
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(scene.space.width)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(scene.space.height)
      }
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
        [-1.5, 20],
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
        [61.5, 20],
      ],
    ],
    [
      'top',
      [
        [40, 0],
        [40, 30],
      ],
      [
        [20, -1.5],
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
        [20, 51.5],
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
      [-1, 20],
      [20, 20],
      [57.2, 51],
    ])
    expect(result.primitives[1]!.points).toEqual([
      [51.5, 51],
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
        [62, 30],
        [-2, 30],
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

  it.each([
    [
      'left',
      [
        [19, 20],
        [19, 50],
      ],
      [-1, 10],
    ],
    [
      'right',
      [
        [81, 20],
        [81, 50],
      ],
      [61, 10],
    ],
    [
      'top',
      [
        [30, 9],
        [70, 9],
      ],
      [10, -1],
    ],
    [
      'bottom',
      [
        [30, 61],
        [70, 61],
      ],
      [10, 51],
    ],
  ] as const)(
    'retains a thick stroke parallel just outside the %s edge when its footprint enters the Page',
    (_edge, points, expectedFirst) => {
      const result = frameScene(
        sceneOf({
          points: [...points],
          stroke: { color: 'black', width: 4 },
        }),
        crop,
      )

      expect(result.primitives).toHaveLength(1)
      expect(result.primitives[0]!.points[0]).toEqual(expectedFirst)
      expect(result.primitives[0]!.stroke?.width).toBe(4)
    },
  )

  it('preserves thick stroke footprints at every edge of the full-Composition identity frame', () => {
    const result = frameScene(
      sceneOf(
        {
          points: [
            [-1, 10],
            [-1, 70],
          ],
          stroke: { color: 'left', width: 4 },
        },
        {
          points: [
            [101, 10],
            [101, 70],
          ],
          stroke: { color: 'right', width: 4 },
        },
        {
          points: [
            [10, -1],
            [90, -1],
          ],
          stroke: { color: 'top', width: 4 },
        },
        {
          points: [
            [10, 81],
            [90, 81],
          ],
          stroke: { color: 'bottom', width: 4 },
        },
      ),
      { x: 0, y: 0, width: 100, height: 80 },
    )

    expect(result.primitives.map(({ stroke }) => stroke?.color)).toEqual([
      'left',
      'right',
      'top',
      'bottom',
    ])
    expect(result.primitives.map(({ points }) => points[0])).toEqual([
      [-1, 10],
      [101, 10],
      [10, -1],
      [10, 81],
    ])
  })

  it.each([
    [
      'left edge',
      [
        [0, 20],
        [40, 40],
      ],
      [-2, 19],
    ],
    [
      'right edge',
      [
        [60, 40],
        [100, 20],
      ],
      [62, 19],
    ],
    [
      'top edge',
      [
        [30, 0],
        [50, 20],
      ],
      [18, -2],
    ],
    [
      'bottom edge',
      [
        [30, 50],
        [50, 70],
      ],
      [22, 52],
    ],
    [
      'top-left corner',
      [
        [0, -10],
        [40, 30],
      ],
      [-2, -2],
    ],
    [
      'top-right corner',
      [
        [60, 30],
        [100, -10],
      ],
      [62, -2],
    ],
    [
      'bottom-left corner',
      [
        [0, 80],
        [40, 40],
      ],
      [-2, 52],
    ],
    [
      'bottom-right corner',
      [
        [60, 40],
        [100, 80],
      ],
      [62, 52],
    ],
  ] as const)(
    'keeps an oblique %s crossing beyond the Page so its synthetic cap remains outside',
    (_boundary, points, expectedOutside) => {
      const result = frameScene(
        sceneOf({
          points: [...points],
          stroke: { color: 'black', width: 4 },
        }),
        crop,
      )

      expect(result.primitives).toHaveLength(1)
      expect(result.primitives[0]!.points).toContainEqual(expectedOutside)
      expect(result.primitives[0]!.closed).toBeUndefined()
    },
  )

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

  it('canonicalizes fractional right and bottom fill boundaries to the exact output extent', () => {
    const result = frameScene(
      sceneOf({
        points: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        closed: true,
        fill: { color: 'blue' },
      }),
      { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    )
    const points = result.primitives[0]!.points

    expect(result.space).toEqual({ width: 0.2, height: 0.2 })
    expect(Math.max(...points.map(([x]) => x))).toBe(result.space.width)
    expect(Math.max(...points.map(([, y]) => y))).toBe(result.space.height)
    expect(
      points.every(
        ([x, y]) =>
          x >= 0 &&
          x <= result.space.width &&
          y >= 0 &&
          y <= result.space.height,
      ),
    ).toBe(true)
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
