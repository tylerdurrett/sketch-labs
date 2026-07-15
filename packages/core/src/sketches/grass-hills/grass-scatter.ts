import { samplePoissonDisk } from '../../poisson'
import type { Seed } from '../../sketch'

/** Poisson spacing at the neutral blade-density setting. */
const BASE_CANONICAL_RADIUS = 0.12

/** Inputs that determine one hill's canonical, count-independent root field. */
export interface GrassRootScatterOptions {
  seed: Seed
  /** Reduced rational depth identity supplied by the hill layout. */
  hillKey: string
  /** Relative areal density. Zero returns an empty field. */
  bladeDensity: number
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
  /** Identity-preserving index in the completed canonical sampler output. */
  readonly ordinal: number
  /** Stable per-hill identity used to seed later per-blade variation. */
  readonly rootKey: string
}

/**
 * Sample a stable canonical root field for one reduced-depth hill identity.
 *
 * Sampling happens entirely in a fixed unit square. Neither terrain geometry
 * nor hill count participates, so the same reduced `hillKey` retains the same
 * candidates when the set of visible bands changes. The completed Poisson
 * array is mapped without filtering: its array index is the canonical ordinal.
 * Count-dependent selection and projection belong to the composition layer.
 */
export function scatterGrassRoots({
  seed,
  hillKey,
  bladeDensity,
}: GrassRootScatterOptions): readonly GrassRootCandidate[] {
  if (!Number.isFinite(bladeDensity) || bladeDensity < 0) {
    throw new RangeError('bladeDensity must be a finite non-negative number')
  }
  if (bladeDensity === 0) return Object.freeze([])

  const canonicalRadius = BASE_CANONICAL_RADIUS / Math.sqrt(bladeDensity)
  const points = samplePoissonDisk({
    width: 1,
    height: 1,
    radius: () => canonicalRadius,
    minRadius: canonicalRadius,
    seed: `${seed}-grass-roots-${hillKey}`,
  })

  return Object.freeze(
    points.map(([u, v], ordinal) =>
      Object.freeze({
        u,
        v,
        ordinal,
        rootKey: `${hillKey}:${ordinal}`,
      }),
    ),
  )
}
