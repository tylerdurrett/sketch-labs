import type { Canvas2DContext } from '@harness/core'

/**
 * A recording implementation of core's {@link Canvas2DContext} port — the whole
 * headless parity harness. It drives NO real surface; every method call and every
 * style-setter write is appended to an ordered {@link RecordingContext.log} as a
 * single string, so two invocations of the shared `drawSceneFitted` pipeline can
 * be compared BYTE-FOR-BYTE by comparing their logs.
 *
 * The log captures ORDER, not just presence: path ops (`moveTo`, `lineTo`, …),
 * paint ops (`fill`, `stroke`), state ops (`save`, `restore`), the style-property
 * writes (`fillStyle=`, `strokeStyle=`, `lineWidth=`), `setTransform` — the
 * contain-fit transform `drawSceneFitted` establishes before it delegates to
 * `renderToCanvas` — AND the background paint ops (`fillRect`/`clearRect`) that
 * open every draw (issue #92: the opaque backdrop over the full surface).
 * Recording these as ordered events is deliberate (#85 adopted the port-widen
 * path): the fit transform and the background paint are ASSERTED ordered events in
 * the parity log, not invisible glue, so the proof covers the whole
 * background-fit-and-draw pipeline, not just the primitive drawing.
 *
 * It implements the FULL port surface so it is structurally a `Canvas2DContext`
 * with no casts — the same object both callers draw through in the parity test.
 */
export class RecordingContext implements Canvas2DContext {
  /** The ordered draw-call log — one entry per method call or style write. */
  readonly log: string[] = []

  #fillStyle = ''
  #strokeStyle = ''
  #lineWidth = 1

  save(): void {
    this.log.push('save')
  }

  restore(): void {
    this.log.push('restore')
  }

  beginPath(): void {
    this.log.push('beginPath')
  }

  moveTo(x: number, y: number): void {
    this.log.push(`moveTo(${x},${y})`)
  }

  lineTo(x: number, y: number): void {
    this.log.push(`lineTo(${x},${y})`)
  }

  closePath(): void {
    this.log.push('closePath')
  }

  fill(): void {
    this.log.push('fill')
  }

  stroke(): void {
    this.log.push('stroke')
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.log.push(`setTransform(${a},${b},${c},${d},${e},${f})`)
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.log.push(`fillRect(${x},${y},${w},${h})`)
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    this.log.push(`clearRect(${x},${y},${w},${h})`)
  }

  get fillStyle(): string {
    return this.#fillStyle
  }

  set fillStyle(value: string) {
    this.#fillStyle = value
    this.log.push(`fillStyle=${value}`)
  }

  get strokeStyle(): string {
    return this.#strokeStyle
  }

  set strokeStyle(value: string) {
    this.#strokeStyle = value
    this.log.push(`strokeStyle=${value}`)
  }

  get lineWidth(): number {
    return this.#lineWidth
  }

  set lineWidth(value: number) {
    this.#lineWidth = value
    this.log.push(`lineWidth=${value}`)
  }
}
