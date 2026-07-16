import type { Seed } from '../../sketch'
import { createStableScalarRandom } from './stable-random'

/** One stable cell per root at the adopted per-hill canonical capacity. */
const STRATIFIED_SIDE = 100

/** Inputs that determine one hill's count-independent canonical root bank. */
export interface GrassRootScatterOptions {
  seed: Seed
  /** Reduced rational depth identity supplied by the hill layout. */
  hillKey: string
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
 * Build the adopted 100 x 100 stable-cell bank for one reduced hill identity.
 *
 * Every cell owns independent jitter and priority streams. Sorting once by
 * priority turns every requested density into a prefix operation: increasing
 * density never moves or removes an existing root, and no quadratic farthest-
 * point pass is needed. Terrain geometry and hill count do not participate.
 */
export function scatterGrassRoots({
  seed,
  hillKey,
}: GrassRootScatterOptions): readonly GrassRootCandidate[] {
  const roots: PrioritizedRoot[] = []

  for (let row = 0; row < STRATIFIED_SIDE; row++) {
    for (let column = 0; column < STRATIFIED_SIDE; column++) {
      const cellKey = `${column},${row}`
      const jitter = createStableScalarRandom(
        `${seed}-exact-stratified-root-${hillKey}-${cellKey}`,
      )
      roots.push({
        u: (column + jitter.value()) / STRATIFIED_SIDE,
        v: (row + jitter.value()) / STRATIFIED_SIDE,
        rootKey: `${hillKey}:cell:${cellKey}`,
        cellOrdinal: row * STRATIFIED_SIDE + column,
        priority: createStableScalarRandom(
          `${seed}-exact-stratified-priority-${hillKey}-${cellKey}`,
        ).value(),
      })
    }
  }

  roots.sort(
    (a, b) => a.priority - b.priority || a.cellOrdinal - b.cellOrdinal,
  )
  return Object.freeze(
    roots.map(({ u, v, rootKey }, ordinal) =>
      Object.freeze({ u, v, rootKey, ordinal }),
    ),
  )
}
