/**
 * Small deterministic scalar generator for stable Grass Hills identities.
 *
 * Grass preparation only needs scalar rolls. The general `createRandom` helper
 * also constructs noise fields, so creating one per blade turns 10k fixed
 * variations into avoidable UI-blocking setup work. FNV-1a seeds one Mulberry32
 * stream here without global state or order coupling.
 */
export function createStableScalarRandom(seed: string): { value(): number } {
  let state = 2_166_136_261
  for (let index = 0; index < seed.length; index++) {
    state ^= seed.charCodeAt(index)
    state = Math.imul(state, 16_777_619)
  }

  return {
    value() {
      state = (state + 0x6d2b79f5) | 0
      let mixed = state
      mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
    },
  }
}
