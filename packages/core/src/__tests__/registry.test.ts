import { describe, expect, it } from 'vitest'

import {
  createRegistry,
  createScribbleMoonStructuralScene,
  defaultParams,
  grassHills,
  pencilContour,
  photoScribble,
  registry,
  scribbleMoon,
  toneCalibration,
  watercolorForms,
} from '../index'
import { circles } from '../sketches/circles'
import type { OutlineTarget, Sketch } from '../sketch'
import type { Scene } from '../scene'

/** A throwaway second Sketch so tests can exercise multi-entry indexing. */
const dummy: Sketch = {
  id: 'dummy',
  name: 'Dummy',
  schema: {},
  generate: () => ({ space: { width: 1, height: 1 }, primitives: [] }),
}

describe('createRegistry', () => {
  it('indexes Sketches by id and resolves them via get', () => {
    const reg = createRegistry([circles, dummy])
    expect(reg.get('circles')).toBe(circles)
    expect(reg.get('dummy')).toBe(dummy)
  })

  it('lists all Sketches in registration order', () => {
    const reg = createRegistry([circles, dummy])
    expect(reg.list()).toEqual([circles, dummy])
  })

  it('throws on an unknown id rather than returning a fallback', () => {
    const reg = createRegistry([circles])
    expect(() => reg.get('does-not-exist')).toThrow(/Unknown Sketch id/)
  })

  it('throws on a duplicate id', () => {
    expect(() => createRegistry([circles, circles])).toThrow(/Duplicate Sketch id/)
  })
})

describe('the default registry', () => {
  it('contains the circles Sketch keyed by its id', () => {
    expect(registry.get('circles')).toBe(circles)
    expect(registry.list()).toContain(circles)
  })

  it('exposes grass hills through the public catalog exactly once', () => {
    expect(grassHills.id).toBe('grass-hills')
    expect(grassHills.name).toBe('Grass Hills')
    expect(registry.get('grass-hills')).toBe(grassHills)
    expect(registry.list().filter((sketch) => sketch === grassHills)).toEqual([grassHills])
  })

  it('exports and registers Scribble Moon exactly once', () => {
    expect(scribbleMoon.id).toBe('scribble-moon')
    expect(scribbleMoon.name).toBe('Scribble Moon')
    expect(registry.get('scribble-moon')).toBe(scribbleMoon)
    expect(
      registry.list().filter((sketch) => sketch === scribbleMoon),
    ).toEqual([scribbleMoon])
  })

  it(
    'exports and registers Tone Calibration exactly once',
    () => {
      expect(toneCalibration.id).toBe('tone-calibration')
      expect(toneCalibration.name).toBe('Tone Calibration')
      expect(registry.get('tone-calibration')).toBe(toneCalibration)
      expect(
        registry.list().filter((sketch) => sketch === toneCalibration),
      ).toEqual([toneCalibration])
    },
  )

  it('exports and registers Photo Scribble exactly once', () => {
    expect(photoScribble.id).toBe('photo-scribble')
    expect(photoScribble.name).toBe('Photo Scribble')
    expect(registry.get('photo-scribble')).toBe(photoScribble)
    expect(
      registry.list().filter((sketch) => sketch === photoScribble),
    ).toEqual([photoScribble])
  })

  it('exports and registers Pencil Contour exactly once', () => {
    expect(pencilContour.id).toBe('pencil-contour')
    expect(pencilContour.name).toBe('Pencil Contour')
    expect(registry.get('pencil-contour')).toBe(pencilContour)
    expect(
      registry.list().filter((sketch) => sketch === pencilContour),
    ).toEqual([pencilContour])
  })

  it('exports and registers Watercolor Forms exactly once as the newest Sketch', () => {
    expect(watercolorForms.id).toBe('watercolor-forms')
    expect(watercolorForms.name).toBe('Watercolor Forms')
    expect(registry.get('watercolor-forms')).toBe(watercolorForms)
    expect(
      registry.list().filter((sketch) => sketch === watercolorForms),
    ).toEqual([watercolorForms])
    expect(registry.list().at(-1)).toBe(watercolorForms)
  })

  it('registers every built-in under a unique id and display name', () => {
    const sketches = registry.list()
    const ids = sketches.map((sketch) => sketch.id)
    const names = sketches.map((sketch) => sketch.name)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(names).size).toBe(names.length)
  })

  it('keeps every registered physical-tool Outline source invariant across targets', () => {
    const frame = { width: 100, height: 100 }
    const targets = [
      { toolWidthMillimeters: 0.3, millimetersPerSceneUnit: 0.2 },
      { toolWidthMillimeters: 0.9, millimetersPerSceneUnit: 0.1 },
    ] as const satisfies readonly OutlineTarget[]
    const optIn = registry
      .list()
      .filter(
        (sketch) =>
          sketch.generateOutlineSource !== undefined ||
          sketch.deriveOutlineSource !== undefined,
      )

    expect(optIn.map(({ id }) => id)).toEqual([
      'grass-hills',
      'scribble-moon',
      'tone-calibration',
      'watercolor-forms',
    ])

    for (const sketch of optIn) {
      const completed: Scene =
        sketch.id === scribbleMoon.id
          ? createScribbleMoonStructuralScene(frame)
          : {
              space: frame,
              primitives: [
                {
                  points: [
                    [10, 10],
                    [90, 90],
                  ],
                  stroke: { color: 'authored', width: 7 },
                  hiddenLineRole: 'source',
                },
              ],
              background: { color: 'paper' },
            }
      const sourceFor = (target: OutlineTarget): Scene => {
        if (sketch.generateOutlineSource !== undefined) {
          return sketch.generateOutlineSource(
            defaultParams(sketch.schema),
            'outline-target-contract',
            0,
            frame,
            target,
          )
        }
        return sketch.deriveOutlineSource!(completed, target)
      }
      const withoutTargetWidth = (scene: Scene) => ({
        ...scene,
        primitives: scene.primitives.map(({ stroke, ...primitive }) =>
          stroke === undefined
            ? primitive
            : { ...primitive, stroke: { color: stroke.color } },
        ),
      })
      const [first, second] = targets.map(sourceFor)

      expect(withoutTargetWidth(second)).toEqual(withoutTargetWidth(first))
      for (const [index, scene] of [first, second].entries()) {
        const expectedWidth =
          targets[index]!.toolWidthMillimeters /
          targets[index]!.millimetersPerSceneUnit
        const strokes = scene.primitives.flatMap(({ stroke }) =>
          stroke === undefined ? [] : [stroke],
        )

        expect(strokes.length).toBeGreaterThan(0)
        expect(strokes.every(({ width }) => width === expectedWidth)).toBe(true)
      }
    }
  })
})
