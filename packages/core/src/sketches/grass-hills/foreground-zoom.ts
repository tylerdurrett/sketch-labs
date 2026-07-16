import type { CoordinateSpace } from '../../scene'
import type { GrassBladeDescriptor } from './grass'

export interface ForegroundZoomHill {
  readonly ridge: ReadonlyArray<readonly [number, number]>
  readonly blades: ReadonlyArray<GrassBladeDescriptor>
}

export interface ForegroundZoomOptions {
  readonly frame: CoordinateSpace
  /** Top-origin horizon position as a fraction of frame height. */
  readonly horizonHeight: number
  /** Uniform scale around the horizon-center anchor. */
  readonly zoom: number
}

/**
 * Uniformly magnify completed Grass Hills geometry around the horizon center.
 *
 * This pass deliberately runs after terrain projection and blade resolution:
 * complete ridge rings, projected roots, blade lengths, and blade widths all
 * move through one shared composition transform. Stable identity, canonical
 * coordinates, random rolls, lean, and stiffness remain unchanged. The fixed
 * Composition Frame is not part of the returned value and therefore remains a
 * caller-owned clip boundary rather than becoming an authored crop edge.
 *
 * `zoom === 1` is an exact identity fast path. Other values are intentionally
 * not clamped here; the Parameter Schema owns the public range while this pure
 * geometry operation stays literal and independently testable.
 */
export function applyForegroundZoom<T extends readonly ForegroundZoomHill[]>(
  hills: T,
  { frame, horizonHeight, zoom }: ForegroundZoomOptions,
): T | readonly ForegroundZoomHill[] {
  if (zoom === 1) return hills

  const anchorX = frame.width / 2
  const anchorY = frame.height * horizonHeight

  return Object.freeze(
    hills.map((hill) =>
      Object.freeze({
        ridge: Object.freeze(
          hill.ridge.map(([x, y]) =>
            Object.freeze(
              [
                anchorX + zoom * (x - anchorX),
                anchorY + zoom * (y - anchorY),
              ] as const,
            ),
          ),
        ),
        blades: Object.freeze(
          hill.blades.map((descriptor) =>
            Object.freeze({
              identity: Object.freeze({ ...descriptor.identity }),
              canonical: Object.freeze({ ...descriptor.canonical }),
              projected: Object.freeze([
                anchorX + zoom * (descriptor.projected[0] - anchorX),
                anchorY + zoom * (descriptor.projected[1] - anchorY),
              ] as const),
              rolls: Object.freeze({ ...descriptor.rolls }),
              shape: Object.freeze({
                length: descriptor.shape.length * zoom,
                width: descriptor.shape.width * zoom,
                stiffness: descriptor.shape.stiffness,
                lean: descriptor.shape.lean,
              }),
            }),
          ),
        ),
      }),
    ),
  )
}
