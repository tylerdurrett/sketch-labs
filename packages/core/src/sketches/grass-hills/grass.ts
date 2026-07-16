import { clamp, lerp } from '../../math'
import type { Seed } from '../../sketch'
import type { BladeShape } from './blade'
import { grassScaleAtY } from './depth'
import {
  projectGrassRoot,
  type GrassHillMask,
} from './grass-placement'
import type { GrassRootCandidate } from './grass-scatter'
import { createStableScalarRandom } from './stable-random'

/** Fixed seeded micro-lean selected by the issue-305 architecture decision. */
export const BASELINE_LEAN_VARIATION = 0.32

/** Grass controls that resolve the shape of every selected blade. */
export interface GrassBladeShapeOptions {
  bladeLength: number
  bladeLengthVariance: number
  bladeWidth: number
  stiffnessVariance: number
  windLean: number
}

/** Inputs for projecting and resolving one hill's selected canonical roots. */
export interface BuildGrassBladesOptions extends GrassBladeShapeOptions {
  seed: Seed
  /** Reduced rational identity supplied by the hill layout. */
  hillKey: string
  /** Already-selected canonical roots for this hill. */
  roots: readonly GrassRootCandidate[]
  /** Count-dependent physical mask for this hill. */
  mask: GrassHillMask
}

/** Stable identity retained across count-dependent reprojection. */
export interface GrassBladeIdentity {
  readonly hillKey: string
  readonly rootKey: string
  readonly ordinal: number
}

/** Canonical hill-local coordinates before terrain projection. */
export interface CanonicalGrassCoordinates {
  readonly u: number
  readonly v: number
}

/** Four unconditional random draws consumed for every selected root. */
export interface GrassBladeRolls {
  readonly length: number
  readonly width: number
  readonly stiffness: number
  readonly lean: number
}

/**
 * One immutable, fully resolved blade ready for later Scene composition.
 *
 * MODULE-PRIVATE: grass-hills composition imports these descriptors directly.
 * No Scene state or painter-order policy is owned by this module.
 */
export interface GrassBladeDescriptor {
  readonly identity: GrassBladeIdentity
  readonly canonical: CanonicalGrassCoordinates
  readonly projected: readonly [number, number]
  readonly rolls: GrassBladeRolls
  readonly shape: Readonly<BladeShape>
}

/** Maximum pre-perspective reach supplied when constructing a hill mask. */
export function resolveMaximumUnscaledBladeLength(
  bladeLength: number,
  bladeLengthVariance: number,
): number {
  return clamp(bladeLength + bladeLengthVariance, 1, 120)
}

/**
 * Project selected roots and resolve their stable, root-local blade variation.
 *
 * Each root owns an independent RNG stream. The four draws are deliberately
 * unconditional and ordered length, width, stiffness, lean so collapsing a
 * control's variance never shifts any other property or blade.
 */
export function buildGrassBlades({
  seed,
  hillKey,
  roots,
  mask,
  bladeLength,
  bladeLengthVariance,
  bladeWidth,
  stiffnessVariance,
  windLean,
}: BuildGrassBladesOptions): readonly GrassBladeDescriptor[] {
  return Object.freeze(
    roots.map((root) => {
      const random = createStableScalarRandom(
        `${seed}-grass-blade-${root.rootKey}`,
      )
      const rolls = Object.freeze({
        length: random.value(),
        width: random.value(),
        stiffness: random.value(),
        lean: random.value(),
      })
      const [x, y] = projectGrassRoot(root, mask)
      const unscaledLength = clamp(
        bladeLength + signed(rolls.length) * bladeLengthVariance,
        1,
        120,
      )
      const scale = grassScaleAtY(y, mask.projection)
      const unscaledWidth = clamp(
        bladeWidth * lerp(0.8, 1.2, rolls.width),
        0.1,
        0.8 * unscaledLength,
      )

      return Object.freeze({
        identity: Object.freeze({
          hillKey,
          rootKey: root.rootKey,
          ordinal: root.ordinal,
        }),
        canonical: Object.freeze({ u: root.u, v: root.v }),
        projected: Object.freeze([x, y] as const),
        rolls,
        shape: Object.freeze({
          length: unscaledLength * scale,
          width: unscaledWidth * scale,
          stiffness: clamp(
            2.5 + signed(rolls.stiffness) * stiffnessVariance * 1.5,
            1,
            4,
          ),
          lean:
            signed(rolls.lean) * BASELINE_LEAN_VARIATION +
            windLean * lerp(0.8, 1.2, rolls.lean),
        }),
      })
    }),
  )
}

function signed(roll: number): number {
  return 2 * roll - 1
}
