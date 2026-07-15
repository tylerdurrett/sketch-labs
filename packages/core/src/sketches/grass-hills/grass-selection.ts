import { createRandom } from '../../random'
import type { Seed } from '../../sketch'
import { grassScaleAtDepth } from './depth'
import type { GrassRootCandidate } from './grass-scatter'

const BASE_HILL_CAP = 20
const MIN_HILL_CAP = 4
const MAX_HILL_CAP = 40

/** Inputs that select a bounded, evenly distributed subset for one hill. */
export interface GrassRootSelectionOptions {
  seed: Seed
  /** Canonical hill depth: 0 is foreground and 1 is the horizon. */
  depth: number
  /** Relative areal density. */
  bladeDensity: number
  /** The completed, deterministic canonical scatter for this hill. */
  candidates: readonly GrassRootCandidate[]
}

interface PrioritizedCandidate {
  readonly candidate: GrassRootCandidate
  readonly priority: number
}

/** The perspective scale used for count-independent canonical selection. */
export function canonicalScale(depth: number): number {
  return grassScaleAtDepth(depth)
}

/**
 * Bound one hill's selected roots while increasing detail toward the horizon.
 *
 * `Math.round` is deliberate: JavaScript rounds exact positive half-steps
 * toward +Infinity. Density is linear so the schema maximum retains at least
 * forty roots per hill, while the per-hill clamp keeps extreme hill counts
 * bounded independently and preserves count-stable hill selection.
 */
export function hillCap(depth: number, bladeDensity: number): number {
  const rawCap = (BASE_HILL_CAP * bladeDensity) / canonicalScale(depth)
  return Math.max(MIN_HILL_CAP, Math.min(MAX_HILL_CAP, Math.round(rawCap)))
}

/**
 * Select a deterministic blue-noise subset from one completed hill scatter.
 *
 * A root-local seeded priority chooses the first root without depending on
 * candidate iteration or any other hill. Each later root is the candidate
 * farthest from its nearest already-selected neighbour in canonical `(u, v)`
 * space. Seeded priority, then canonical ordinal, resolve exact distance ties.
 */
export function selectGrassRoots({
  seed,
  depth,
  bladeDensity,
  candidates,
}: GrassRootSelectionOptions): readonly GrassRootCandidate[] {
  const remaining: PrioritizedCandidate[] = candidates.map((candidate) => ({
    candidate,
    priority: createRandom(
      `${seed}-grass-priority-${candidate.rootKey}`,
    ).value(),
  }))
  const targetCount = Math.min(hillCap(depth, bladeDensity), remaining.length)
  const selected: GrassRootCandidate[] = []

  while (selected.length < targetCount) {
    let bestIndex = 0
    let bestDistance = selected.length === 0 ? Infinity : -Infinity

    for (let index = 0; index < remaining.length; index++) {
      const contender = remaining[index]!
      const distance = minimumDistance(contender.candidate, selected)
      const best = remaining[bestIndex]!

      if (
        distance > bestDistance ||
        (distance === bestDistance &&
          comparePriority(contender, best) < 0)
      ) {
        bestIndex = index
        bestDistance = distance
      }
    }

    selected.push(remaining[bestIndex]!.candidate)
    remaining.splice(bestIndex, 1)
  }

  return Object.freeze(selected)
}

function minimumDistance(
  candidate: GrassRootCandidate,
  selected: readonly GrassRootCandidate[],
): number {
  if (selected.length === 0) return Infinity

  let minimum = Infinity
  for (const existing of selected) {
    minimum = Math.min(
      minimum,
      Math.hypot(candidate.u - existing.u, candidate.v - existing.v),
    )
  }
  return minimum
}

function comparePriority(
  a: PrioritizedCandidate,
  b: PrioritizedCandidate,
): number {
  return a.priority - b.priority || a.candidate.ordinal - b.candidate.ordinal
}
