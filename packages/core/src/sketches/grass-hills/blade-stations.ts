import { clamp } from '../../math'
import { FLANK_STATIONS } from './blade'

/**
 * Adaptive flank-station resolution for the `bladeDetail` control.
 *
 * MODULE-PRIVATE: the grass-hills sketch consumes this module through a
 * relative import. It is intentionally absent from the package's public barrel.
 *
 * Stations resolve ONCE per descriptor, before Fill and Outline diverge, so
 * both consumers always trace the identical tessellation. This is
 * resolution-proportional detail, not the prohibited outline-only LOD: nothing
 * downstream may ever re-tessellate.
 */

/**
 * Tip-weighting exponent pinned by the issue-315 adaptive-detail decision.
 * The blade spine is a power curve that bends hardest near the tip, so station
 * spacing tightens there; 1.7 keeps the root region sparse without starving
 * the mid-blade of stations at low counts.
 */
const TIP_WEIGHT_EXPONENT = 1.7

/**
 * Resolve the flank stations one blade descriptor will be traced with.
 *
 * The station budget scales the public `bladeDetail` ceiling by the blade's
 * perspective scale times the active foreground zoom (capped at the full
 * budget), clamped to [4, bladeDetail]: distant blades stay at the four-station
 * floor while near or magnified blades spend the whole budget. The floor
 * result IS the pinned legacy `FLANK_STATIONS` array — returned directly, not
 * reproduced by formula — so the default `bladeDetail` 4 stays byte-identical
 * to the pre-adaptive sketch. Denser counts place stations by
 * `1 - (1 - i/(count-1)) ** TIP_WEIGHT_EXPONENT`: the endpoints stay exactly
 * 0 and 1 and the gaps strictly shrink toward the tip.
 */
export function resolveFlankStations(
  bladeDetail: number,
  scale: number,
  foregroundZoom: number,
): readonly number[] {
  const count = clamp(
    Math.round(bladeDetail * Math.min(1, scale * foregroundZoom)),
    4,
    bladeDetail,
  )
  if (count === 4) return FLANK_STATIONS

  return Array.from(
    { length: count },
    (_, index) => 1 - (1 - index / (count - 1)) ** TIP_WEIGHT_EXPONENT,
  )
}
