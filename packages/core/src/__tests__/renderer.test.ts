import { describe, expect, it } from 'vitest'
import type { Canvas2DContext } from '../renderer'
import { drawSceneFitted, renderToCanvas } from '../renderer'
import type { Scene } from '../scene'

/**
 * One recorded interaction with the stub context: either a method call
 * (`method` + `args`) or a style-property assignment (`prop` + `value`). The
 * single ordered log lets a test assert the exact sequence the renderer drives,
 * including how save/restore brackets per-primitive style mutation.
 */
type Event =
  | { method: string; args: number[] }
  | { prop: 'fillStyle' | 'strokeStyle'; value: string }
  | { prop: 'lineWidth'; value: number }

/**
 * A recording {@link Canvas2DContext} stub — no real DOM. Every method call and
 * style assignment is appended to `events` in order, so tests can assert draw
 * order, path shape, conditional fill/stroke, and style values.
 */
function createRecordingContext(): Canvas2DContext & { events: Event[] } {
  const events: Event[] = []
  let fillStyle = ''
  let strokeStyle = ''
  let lineWidth = 0

  const record =
    (method: string) =>
    (...args: number[]) => {
      events.push({ method, args })
    }

  return {
    events,
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    closePath: record('closePath'),
    fill: record('fill'),
    stroke: record('stroke'),
    setTransform: record('setTransform'),
    get fillStyle() {
      return fillStyle
    },
    set fillStyle(value: string) {
      fillStyle = value
      events.push({ prop: 'fillStyle', value })
    },
    get strokeStyle() {
      return strokeStyle
    },
    set strokeStyle(value: string) {
      strokeStyle = value
      events.push({ prop: 'strokeStyle', value })
    },
    get lineWidth() {
      return lineWidth
    },
    set lineWidth(value: number) {
      lineWidth = value
      events.push({ prop: 'lineWidth', value })
    },
  }
}

const space = { width: 100, height: 100 }

/** Names of the method calls recorded, in order (drops style assignments). */
const methodNames = (events: Event[]): string[] =>
  events.flatMap((e) => ('method' in e ? [e.method] : []))

describe('renderToCanvas', () => {
  it('draws primitives in strict array order (painter’s order)', () => {
    const ctx = createRecordingContext()
    const scene: Scene = {
      space,
      primitives: [
        { points: [[0, 0]], stroke: { color: 'first', width: 1 } },
        { points: [[1, 1]], stroke: { color: 'second', width: 1 } },
        { points: [[2, 2]], stroke: { color: 'third', width: 1 } },
      ],
    }

    renderToCanvas(ctx, scene)

    const strokeColors = ctx.events.flatMap((e) =>
      'prop' in e && e.prop === 'strokeStyle' ? [e.value] : [],
    )
    expect(strokeColors).toEqual(['first', 'second', 'third'])
  })

  it('builds a path with moveTo for the first point and lineTo for the rest', () => {
    const ctx = createRecordingContext()
    const scene: Scene = {
      space,
      primitives: [
        {
          points: [
            [0, 0],
            [10, 0],
            [10, 10],
          ],
          stroke: { color: 'black', width: 1 },
        },
      ],
    }

    renderToCanvas(ctx, scene)

    const pathCalls = ctx.events.filter(
      (e): e is { method: string; args: number[] } =>
        'method' in e && (e.method === 'moveTo' || e.method === 'lineTo'),
    )
    expect(pathCalls).toEqual([
      { method: 'moveTo', args: [0, 0] },
      { method: 'lineTo', args: [10, 0] },
      { method: 'lineTo', args: [10, 10] },
    ])
  })

  it('calls closePath when the primitive is closed', () => {
    const ctx = createRecordingContext()
    const scene: Scene = {
      space,
      primitives: [
        {
          points: [
            [0, 0],
            [10, 0],
          ],
          closed: true,
          stroke: { color: 'black', width: 1 },
        },
      ],
    }

    renderToCanvas(ctx, scene)

    expect(methodNames(ctx.events)).toContain('closePath')
  })

  it('does not call closePath when the primitive is open', () => {
    const ctx = createRecordingContext()
    const scene: Scene = {
      space,
      primitives: [
        {
          points: [
            [0, 0],
            [10, 0],
          ],
          stroke: { color: 'black', width: 1 },
        },
      ],
    }

    renderToCanvas(ctx, scene)

    expect(methodNames(ctx.events)).not.toContain('closePath')
  })

  it('applies fill only when fill is present', () => {
    const ctx = createRecordingContext()
    const scene: Scene = {
      space,
      primitives: [
        {
          points: [
            [0, 0],
            [10, 10],
          ],
          fill: { color: 'red' },
        },
      ],
    }

    renderToCanvas(ctx, scene)

    expect(methodNames(ctx.events)).toContain('fill')
    expect(methodNames(ctx.events)).not.toContain('stroke')
    expect(ctx.events).toContainEqual({ prop: 'fillStyle', value: 'red' })
  })

  it('applies stroke only when stroke is present', () => {
    const ctx = createRecordingContext()
    const scene: Scene = {
      space,
      primitives: [
        {
          points: [
            [0, 0],
            [10, 10],
          ],
          stroke: { color: 'blue', width: 2 },
        },
      ],
    }

    renderToCanvas(ctx, scene)

    expect(methodNames(ctx.events)).toContain('stroke')
    expect(methodNames(ctx.events)).not.toContain('fill')
    expect(ctx.events).toContainEqual({ prop: 'strokeStyle', value: 'blue' })
    expect(ctx.events).toContainEqual({ prop: 'lineWidth', value: 2 })
  })

  it('applies both fill and stroke when both are present', () => {
    const ctx = createRecordingContext()
    const scene: Scene = {
      space,
      primitives: [
        {
          points: [
            [0, 0],
            [10, 0],
            [10, 10],
          ],
          closed: true,
          fill: { color: 'green' },
          stroke: { color: 'black', width: 3 },
        },
      ],
    }

    renderToCanvas(ctx, scene)

    const names = methodNames(ctx.events)
    expect(names).toContain('fill')
    expect(names).toContain('stroke')
    expect(ctx.events).toContainEqual({ prop: 'fillStyle', value: 'green' })
    expect(ctx.events).toContainEqual({ prop: 'strokeStyle', value: 'black' })
    expect(ctx.events).toContainEqual({ prop: 'lineWidth', value: 3 })
  })

  it('sets fillStyle, strokeStyle, and lineWidth from the primitive style', () => {
    const ctx = createRecordingContext()
    const scene: Scene = {
      space,
      primitives: [
        {
          points: [[5, 5]],
          fill: { color: '#ff0044' },
          stroke: { color: 'rebeccapurple', width: 0.5 },
        },
      ],
    }

    renderToCanvas(ctx, scene)

    expect(ctx.fillStyle).toBe('#ff0044')
    expect(ctx.strokeStyle).toBe('rebeccapurple')
    expect(ctx.lineWidth).toBe(0.5)
  })

  it('brackets each primitive in save/restore so style does not leak', () => {
    const ctx = createRecordingContext()
    const scene: Scene = {
      space,
      primitives: [
        { points: [[0, 0]], fill: { color: 'a' } },
        { points: [[1, 1]], stroke: { color: 'b', width: 1 } },
      ],
    }

    renderToCanvas(ctx, scene)

    const names = methodNames(ctx.events)
    // Each primitive opens with save and closes with restore, balanced.
    expect(names.filter((n) => n === 'save')).toHaveLength(2)
    expect(names.filter((n) => n === 'restore')).toHaveLength(2)
    expect(names[0]).toBe('save')
    expect(names[names.length - 1]).toBe('restore')
    // restore for the first primitive precedes save for the second — no overlap.
    expect(names.indexOf('restore')).toBeLessThan(names.lastIndexOf('save'))
  })

  it('draws nothing for an empty scene', () => {
    const ctx = createRecordingContext()
    renderToCanvas(ctx, { space, primitives: [] })
    expect(ctx.events).toEqual([])
  })
})

describe('drawSceneFitted', () => {
  it('applies the contain-fit transform via setTransform BEFORE the draw calls', () => {
    const ctx = createRecordingContext()
    // A 800x400 (2:1) space into a 1000x1000 surface: contain-fit yields a
    // uniform scale of 1.25 and a 250px vertical letterbox (offsetY), offsetX 0.
    const scene: Scene = {
      space: { width: 800, height: 400 },
      primitives: [{ points: [[0, 0]], stroke: { color: 'black', width: 1 } }],
    }

    drawSceneFitted(ctx, scene, 1000, 1000)

    // setTransform is the very first recorded event, carrying the fit's
    // scale/offsets, and precedes every renderToCanvas draw call.
    expect(ctx.events[0]).toEqual({
      method: 'setTransform',
      args: [1.25, 0, 0, 1.25, 0, 250],
    })
    const names = methodNames(ctx.events)
    expect(names.indexOf('setTransform')).toBeLessThan(names.indexOf('save'))
    // The scene is still drawn (the renderToCanvas leg ran after the transform).
    expect(names).toContain('stroke')
  })
})
