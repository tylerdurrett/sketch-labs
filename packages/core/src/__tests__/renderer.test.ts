import { describe, expect, it } from 'vitest'
import type { Canvas2DContext } from '../renderer'
import { drawSceneFitted, renderToCanvas } from '../renderer'
import type { Scene } from '../scene'

/**
 * One recorded interaction with the stub context: either a method call
 * (`method` + `args`) or a style-property assignment (`prop` + `value`). The
 * single ordered log lets a test assert the exact sequence the renderer drives,
 * including how save/restore brackets the complete Scene draw.
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
  const stack: Array<{ fillStyle: string; strokeStyle: string; lineWidth: number }> = []

  const record =
    (method: string) =>
    (...args: number[]) => {
      events.push({ method, args })
    }

  return {
    events,
    save() {
      events.push({ method: 'save', args: [] })
      stack.push({ fillStyle, strokeStyle, lineWidth })
    },
    restore() {
      events.push({ method: 'restore', args: [] })
      const state = stack.pop()
      if (state !== undefined) {
        fillStyle = state.fillStyle
        strokeStyle = state.strokeStyle
        lineWidth = state.lineWidth
      }
    },
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    closePath: record('closePath'),
    fill: record('fill'),
    stroke: record('stroke'),
    setTransform: record('setTransform'),
    fillRect: record('fillRect'),
    clearRect: record('clearRect'),
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

  it('restores the caller’s fillStyle, strokeStyle, and lineWidth', () => {
    const ctx = createRecordingContext()
    ctx.fillStyle = 'caller-fill'
    ctx.strokeStyle = 'caller-stroke'
    ctx.lineWidth = 7
    ctx.events.length = 0
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

    expect(ctx.events).toContainEqual({ prop: 'fillStyle', value: '#ff0044' })
    expect(ctx.events).toContainEqual({ prop: 'strokeStyle', value: 'rebeccapurple' })
    expect(ctx.events).toContainEqual({ prop: 'lineWidth', value: 0.5 })
    expect(ctx.fillStyle).toBe('caller-fill')
    expect(ctx.strokeStyle).toBe('caller-stroke')
    expect(ctx.lineWidth).toBe(7)
  })

  it('brackets the complete draw in save/restore so style does not leak', () => {
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
    // One outer state frame is sufficient: each Primitive assigns the styles it
    // uses immediately before painting, and the caller's state is restored once.
    expect(names.filter((n) => n === 'save')).toHaveLength(1)
    expect(names.filter((n) => n === 'restore')).toHaveLength(1)
    expect(names[0]).toBe('save')
    expect(names[names.length - 1]).toBe('restore')
  })

  it('draws nothing for an empty scene', () => {
    const ctx = createRecordingContext()
    renderToCanvas(ctx, { space, primitives: [] })
    expect(ctx.events).toEqual([])
  })
})

describe('drawSceneFitted', () => {
  // A 800x400 (2:1) space into a 1000x1000 surface: contain-fit yields a
  // uniform scale of 1.25 and a 250px vertical letterbox (offsetY), offsetX 0.
  const fitScene: Scene = {
    space: { width: 800, height: 400 },
    primitives: [{ points: [[0, 0]], stroke: { color: 'black', width: 1 } }],
  }

  it('paints the opaque background under identity BEFORE the fit transform', () => {
    const ctx = createRecordingContext()

    drawSceneFitted(ctx, fitScene, 1000, 1000)

    // The background paint is the very first sequence: identity setTransform,
    // then fillStyle=white + fillRect over the full pixel surface (letterbox
    // included), all BEFORE the fit transform and any draw call.
    expect(ctx.events.slice(0, 3)).toEqual([
      { method: 'setTransform', args: [1, 0, 0, 1, 0, 0] },
      { prop: 'fillStyle', value: 'white' },
      { method: 'fillRect', args: [0, 0, 1000, 1000] },
    ])
    // The default paints, never clears.
    expect(methodNames(ctx.events)).not.toContain('clearRect')
  })

  it('applies the contain-fit transform via setTransform BEFORE the draw calls', () => {
    const ctx = createRecordingContext()

    drawSceneFitted(ctx, fitScene, 1000, 1000)

    // The fit transform is the SECOND setTransform (the first is the background's
    // identity reset), carrying the fit's scale/offsets, and precedes every draw.
    const setTransforms = ctx.events.filter(
      (e): e is { method: string; args: number[] } =>
        'method' in e && e.method === 'setTransform',
    )
    expect(setTransforms).toEqual([
      { method: 'setTransform', args: [1, 0, 0, 1, 0, 0] },
      { method: 'setTransform', args: [1.25, 0, 0, 1.25, 0, 250] },
    ])
    const names = methodNames(ctx.events)
    expect(names.lastIndexOf('setTransform')).toBeLessThan(names.indexOf('save'))
    // The scene is still drawn (the renderToCanvas leg ran after the transform).
    expect(names).toContain('stroke')
  })

  it('clears (never fills) the full surface for a transparent background', () => {
    const ctx = createRecordingContext()

    drawSceneFitted(ctx, fitScene, 1000, 1000, 'transparent')

    // Identity reset, then a full-surface clearRect and NO fill of the backdrop.
    expect(ctx.events.slice(0, 2)).toEqual([
      { method: 'setTransform', args: [1, 0, 0, 1, 0, 0] },
      { method: 'clearRect', args: [0, 0, 1000, 1000] },
    ])
    expect(methodNames(ctx.events)).not.toContain('fillRect')
    expect(ctx.events).not.toContainEqual({ prop: 'fillStyle', value: 'transparent' })
  })

  it('honors a custom background color', () => {
    const ctx = createRecordingContext()

    drawSceneFitted(ctx, fitScene, 1000, 1000, '#0a0a0a')

    expect(ctx.events.slice(0, 3)).toEqual([
      { method: 'setTransform', args: [1, 0, 0, 1, 0, 0] },
      { prop: 'fillStyle', value: '#0a0a0a' },
      { method: 'fillRect', args: [0, 0, 1000, 1000] },
    ])
  })

  describe('Scene-declared background precedence (ADR-0009)', () => {
    it('a Scene WITH a background paints it, winning over the caller fallback', () => {
      const ctx = createRecordingContext()
      const scene: Scene = { ...fitScene, background: { color: '#123456' } }

      // The caller's fallback ('#0a0a0a') loses: the Scene-declared background is
      // part of the image, so it is what gets painted over the full surface.
      drawSceneFitted(ctx, scene, 1000, 1000, '#0a0a0a')

      expect(ctx.events.slice(0, 3)).toEqual([
        { method: 'setTransform', args: [1, 0, 0, 1, 0, 0] },
        { prop: 'fillStyle', value: '#123456' },
        { method: 'fillRect', args: [0, 0, 1000, 1000] },
      ])
      expect(ctx.events).not.toContainEqual({ prop: 'fillStyle', value: '#0a0a0a' })
    })

    it('a Scene WITHOUT a background keeps the caller fallback (unchanged behavior)', () => {
      const ctx = createRecordingContext()

      drawSceneFitted(ctx, fitScene, 1000, 1000, '#0a0a0a')

      expect(ctx.events).toContainEqual({ prop: 'fillStyle', value: '#0a0a0a' })
    })

    it("a Scene-declared 'transparent' background clears, exactly like the param form", () => {
      const ctx = createRecordingContext()
      const scene: Scene = { ...fitScene, background: { color: 'transparent' } }

      drawSceneFitted(ctx, scene, 1000, 1000, 'white')

      expect(ctx.events.slice(0, 2)).toEqual([
        { method: 'setTransform', args: [1, 0, 0, 1, 0, 0] },
        { method: 'clearRect', args: [0, 0, 1000, 1000] },
      ])
      expect(methodNames(ctx.events)).not.toContain('fillRect')
    })

    it("the 'transparent' FALLBACK still clears when the Scene declares nothing", () => {
      const ctx = createRecordingContext()

      drawSceneFitted(ctx, fitScene, 1000, 1000, 'transparent')

      expect(ctx.events.slice(0, 2)).toEqual([
        { method: 'setTransform', args: [1, 0, 0, 1, 0, 0] },
        { method: 'clearRect', args: [0, 0, 1000, 1000] },
      ])
    })
  })
})
