/**
 * Grass Hills' production Outline representation (issue #305).
 *
 * Fill and Outline intentionally use different geometry derived from the same
 * immutable prepared descriptors. Fill traces seven-point closed silhouettes;
 * this module traces six-point spines, applies deterministic physical-tool LOD,
 * and marks only nearer hill polygons as occluders. The returned value is a raw
 * generic Hidden-line source Scene. Studio's existing on-demand worker turns it
 * into the one processed stroke-only Scene shared by Canvas and plotter SVG.
 *
 * This is a sketch-local representation decision under ADR-0007. The Harness
 * only sees the optional generic `generateOutlineSource` Sketch capability and
 * ordinary `hiddenLineRole` values; it contains no Grass-specific branch.
 */

import type { OutlineTarget } from '../../sketch'
import type { CoordinateSpace, Primitive, Scene } from '../../scene'
import type { Point } from '../../types'
import type { GrassBladeDescriptor } from './grass'

/** The physical fineliner width pinned by the approved issue-305 reference. */
export const GRASS_HILLS_TOOL_WIDTH_MILLIMETERS = 0.3

const OUTLINE_COLOR = '#111111'

export interface PreparedOutlineHill {
  readonly ridge: ReadonlyArray<readonly [number, number]>
  readonly blades: ReadonlyArray<GrassBladeDescriptor>
}

/**
 * Build the role-annotated source Scene consumed by the generic Hidden-line pass.
 *
 * Each hill mask precedes its own ridge and blades. It therefore clips sources
 * belonging to farther hills while never clipping the sources rooted on itself;
 * later masks are precisely the nearer-hill-only perceptual occlusion contract.
 */
export function grassHillsOutlineSource(
  frame: CoordinateSpace,
  hills: readonly PreparedOutlineHill[],
  target: OutlineTarget,
): Scene {
  validateGrassHillsOutlineTarget(target)
  const toolWidthSceneUnits =
    target.toolWidthMillimeters / target.millimetersPerSceneUnit
  const selected = selectToolReadableBlades(hills, toolWidthSceneUnits)
  const primitives: Primitive[] = []

  for (const hill of hills) {
    primitives.push({
      points: hill.ridge.map(copyPoint),
      closed: false,
      fill: { color: OUTLINE_COLOR },
      hiddenLineRole: 'occluder',
    })
    primitives.push({
      points: visibleRidge(hill.ridge),
      closed: false,
      stroke: { color: OUTLINE_COLOR, width: toolWidthSceneUnits },
      hiddenLineRole: 'source',
    })

    for (const descriptor of hill.blades) {
      if (!selected.has(descriptor)) continue
      primitives.push({
        points: bladeSpine(descriptor),
        closed: false,
        stroke: { color: OUTLINE_COLOR, width: toolWidthSceneUnits },
        hiddenLineRole: 'source',
      })
    }
  }

  return {
    space: { width: frame.width, height: frame.height },
    primitives,
  }
}

/** Six stations over the exact prepared length, stiffness, root, and lean. */
export function bladeSpine(descriptor: GrassBladeDescriptor): Point[] {
  const [rootX, rootY] = descriptor.projected
  const { lean, length, stiffness } = descriptor.shape
  return Array.from({ length: 6 }, (_, index): Point => {
    const t = index / 5
    return [
      rootX + lean * length * t ** (stiffness + 1),
      rootY - length * t,
    ]
  })
}

/**
 * Select a deterministic global subset whose roots are at least one tool width
 * apart. Priority follows stable per-hill root rank, the already-pinned width
 * roll, then root identity, so identical prepared inputs always select the same
 * physical subset.
 */
export function selectToolReadableBlades(
  hills: readonly PreparedOutlineHill[],
  toolWidthSceneUnits: number,
): ReadonlySet<GrassBladeDescriptor> {
  if (!Number.isFinite(toolWidthSceneUnits) || toolWidthSceneUnits <= 0) {
    throw new RangeError('tool width in Scene units must be finite and positive')
  }

  const priority = hills
    .flatMap((hill) => hill.blades)
    .sort(compareDescriptorPriority)
  const cells = new Map<string, Array<readonly [number, number]>>()
  const selected = new Set<GrassBladeDescriptor>()

  for (const descriptor of priority) {
    const [x, y] = descriptor.projected
    const cellX = Math.floor(x / toolWidthSceneUnits)
    const cellY = Math.floor(y / toolWidthSceneUnits)
    let blocked = false

    for (let dx = -1; dx <= 1 && !blocked; dx++) {
      for (let dy = -1; dy <= 1 && !blocked; dy++) {
        for (const [otherX, otherY] of
          cells.get(cellKey(cellX + dx, cellY + dy)) ?? []) {
          if (Math.hypot(x - otherX, y - otherY) < toolWidthSceneUnits) {
            blocked = true
            break
          }
        }
      }
    }
    if (blocked) continue

    selected.add(descriptor)
    const key = cellKey(cellX, cellY)
    const bucket = cells.get(key)
    if (bucket === undefined) cells.set(key, [[x, y]])
    else bucket.push([x, y])
  }

  return selected
}

function visibleRidge(
  ridge: ReadonlyArray<readonly [number, number]>,
): Point[] {
  // buildRidgeBands appends right-bottom, left-bottom, and repeated first.
  return ridge.slice(0, -3).map(copyPoint)
}

function compareDescriptorPriority(
  left: GrassBladeDescriptor,
  right: GrassBladeDescriptor,
): number {
  return (
    left.identity.ordinal - right.identity.ordinal ||
    left.rolls.width - right.rolls.width ||
    compareString(left.identity.rootKey, right.identity.rootKey)
  )
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function cellKey(x: number, y: number): string {
  return `${x}:${y}`
}

function copyPoint([x, y]: readonly [number, number]): Point {
  return [x, y]
}

export function validateGrassHillsOutlineTarget(target: OutlineTarget): void {
  if (
    !Number.isFinite(target.toolWidthMillimeters) ||
    target.toolWidthMillimeters <= 0
  ) {
    throw new RangeError('toolWidthMillimeters must be finite and positive')
  }
  if (
    !Number.isFinite(target.millimetersPerSceneUnit) ||
    target.millimetersPerSceneUnit <= 0
  ) {
    throw new RangeError(
      'millimetersPerSceneUnit must be finite and positive',
    )
  }
}
