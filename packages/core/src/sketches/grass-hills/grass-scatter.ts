import type { Seed } from '../../sketch'
import { createStableScalarRandom } from './stable-random'

/** One stable cell per root in each canonical density layer. */
const STRATIFIED_SIDE = 100
const ROOTS_PER_LAYER = STRATIFIED_SIDE ** 2
const MAX_CANONICAL_ROOT_COUNT = 50_000

/** Inputs that determine one hill's count-independent canonical root bank. */
export interface GrassRootScatterOptions {
  seed: Seed
  /** Reduced rational depth identity supplied by the hill layout. */
  hillKey: string
  /** Minimum prefix capacity needed by this hill. Defaults to the adopted bank. */
  minimumCount?: number
}

/**
 * One immutable root candidate in the hill-local unit square.
 *
 * MODULE-PRIVATE: grass-hills composition consumes these descriptors through a
 * relative import. They are intentionally absent from the package barrel.
 */
export interface GrassRootCandidate {
  readonly u: number
  readonly v: number
  /** Rank in the hill's stable priority order. */
  readonly ordinal: number
  /** Stable per-hill cell identity used to seed later per-blade variation. */
  readonly rootKey: string
}

interface PrioritizedRoot {
  readonly u: number
  readonly v: number
  readonly rootKey: string
  readonly cellOrdinal: number
  readonly priority: number
}

/**
 * Build the layered stable-cell bank for one reduced hill identity.
 *
 * Layer zero is exactly the adopted 100 x 100 bank. Higher densities append
 * independently jittered 100 x 100 layers, so existing roots retain their
 * coordinates, keys, ranks, and selection order. Each layer is sorted by its
 * own stable priority stream before it is appended. Increasing density is
 * therefore still a prefix operation, while ordinary scenes never prepare
 * extension layers they do not need. Terrain geometry and hill count do not
 * participate.
 */
export function scatterGrassRoots({
  seed,
  hillKey,
  minimumCount = ROOTS_PER_LAYER,
}: GrassRootScatterOptions): readonly GrassRootCandidate[] {
  if (
    !Number.isInteger(minimumCount) ||
    minimumCount < 0 ||
    minimumCount > MAX_CANONICAL_ROOT_COUNT
  ) {
    throw new RangeError(
      `minimum root count must be an integer between 0 and ${MAX_CANONICAL_ROOT_COUNT}`,
    )
  }

  const layerCount = Math.max(1, Math.ceil(minimumCount / ROOTS_PER_LAYER))
  const roots: GrassRootCandidate[] = []

  for (let layer = 0; layer < layerCount; layer++) {
    const layerRoots: PrioritizedRoot[] = []

    for (let row = 0; row < STRATIFIED_SIDE; row++) {
      for (let column = 0; column < STRATIFIED_SIDE; column++) {
        const cellKey = `${column},${row}`
        const streamKey =
          layer === 0 ? cellKey : `layer-${layer}-${cellKey}`
        const jitter = createStableScalarRandom(
          `${seed}-exact-stratified-root-${hillKey}-${streamKey}`,
        )
        layerRoots.push({
          u: (column + jitter.value()) / STRATIFIED_SIDE,
          v: (row + jitter.value()) / STRATIFIED_SIDE,
          rootKey:
            layer === 0
              ? `${hillKey}:cell:${cellKey}`
              : `${hillKey}:layer:${layer}:cell:${cellKey}`,
          cellOrdinal: row * STRATIFIED_SIDE + column,
          priority: createStableScalarRandom(
            `${seed}-exact-stratified-priority-${hillKey}-${streamKey}`,
          ).value(),
        })
      }
    }

    layerRoots.sort(
      (a, b) => a.priority - b.priority || a.cellOrdinal - b.cellOrdinal,
    )
    roots.push(
      ...layerRoots.map(({ u, v, rootKey }, index) =>
        Object.freeze({
          u,
          v,
          rootKey,
          ordinal: layer * ROOTS_PER_LAYER + index,
        }),
      ),
    )
  }

  return Object.freeze(roots)
}
