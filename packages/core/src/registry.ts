/**
 * The Sketch registry — what makes Sketches discoverable and navigable.
 *
 * A registry collects the available Sketches and indexes them by their stable
 * `id` (the same slug that names `sketches/{id}/presets/` and the navigation/URL
 * — see {@link SketchBase}). The Studio lists Sketches by `name` via {@link
 * SketchRegistry.list} and resolves the selected one via {@link
 * SketchRegistry.get}.
 *
 * Lookup is deliberately strict: {@link SketchRegistry.get} THROWS on an unknown
 * `id` rather than silently returning a default/wrong Sketch, so a stale slug
 * (e.g. an old URL) fails loudly instead of quietly rendering the wrong thing.
 */

import type { Sketch } from './sketch'
import { circles } from './sketches/circles'
import { scatter } from './sketches/scatter'
import { flowField } from './sketches/flow-field'
import { grassHills } from './sketches/grass-hills'
import { leafField } from './sketches/leaf-field'
import { scribbleMoon } from './sketches/scribble-moon'

/** A read-only index of Sketches keyed by their stable {@link Sketch.id}. */
export interface SketchRegistry {
  /**
   * All registered Sketches, in registration order — the list the navigation
   * UI renders (by `name`).
   */
  list(): readonly Sketch[]
  /**
   * Resolve a Sketch by its `id`.
   *
   * @throws if no Sketch is registered under `id` — never returns a fallback.
   */
  get(id: string): Sketch
}

/**
 * Build a {@link SketchRegistry} from the given Sketches, indexed by `id`.
 *
 * @throws if two Sketches share an `id` (ids must be unique — they double as
 *   preset-folder names and navigation slugs, so a collision is a contract bug).
 */
export function createRegistry(sketches: readonly Sketch[]): SketchRegistry {
  const byId = new Map<string, Sketch>()
  for (const sketch of sketches) {
    if (byId.has(sketch.id)) {
      throw new Error(`Duplicate Sketch id in registry: "${sketch.id}"`)
    }
    byId.set(sketch.id, sketch)
  }

  const ordered = [...sketches]

  return {
    list() {
      return ordered
    },
    get(id) {
      const sketch = byId.get(id)
      if (sketch === undefined) {
        throw new Error(`Unknown Sketch id: "${id}"`)
      }
      return sketch
    },
  }
}

/**
 * The default registry of built-in Sketches — what the Studio navigates over.
 * Holds {@link circles}, {@link scatter}, {@link flowField}, {@link leafField},
 * {@link grassHills}, and {@link scribbleMoon}; new Sketches join this list as
 * they land. Scribble Moon is intentionally last: the Studio treats the newest
 * registered Sketch as its default selection.
 */
export const registry: SketchRegistry = createRegistry([
  circles,
  scatter,
  flowField,
  leafField,
  grassHills,
  scribbleMoon,
])
