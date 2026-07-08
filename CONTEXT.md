# Sketch Labs

A browser-based studio for building generative-graphics **Sketches**: each Sketch is a parametric, seedable generative image or animation that can be previewed live and rendered through multiple output backends (raster, vector/SVG, plotter, video, and eventually realtime GPU). The first real Sketch is a flowing field of overlapping leaves/petals.

## Language

**Sketch**:
A single self-contained generative experiment — a parametric scene definition plus the metadata needed to drive, preview, and export it.
_Avoid_: experiment (casual synonym only — "Sketch" is canonical in code and docs), demo, sandbox

**Harness**:
The shared studio shell and core libraries that host Sketches — navigation, parameter controls, presets, and the renderer backends — everything that is _not_ a specific Sketch.
_Avoid_: framework, app

**Scene**:
The generic, renderer-agnostic intermediate representation a vector **Sketch** bakes itself into: a coordinate space plus a draw-ordered collection of **Primitives**, plus an optional Sketch-declared background (a fill for the whole output surface, letterbox included, that wins over the caller's fallback backdrop — ADR-0009). Renderers consume Scenes and never know which domain produced them (a Scene is not leaf-aware).
_Avoid_: scene graph (no nesting/transforms implied), model

**Primitive**:
The atomic drawable unit of a **Scene** — one styled piece of vector geometry (a polygon or polyline, filled and/or stroked) with a draw order. Its exact record shape is intentionally left to emerge during implementation (see _Deliberately deferred_).
_Avoid_: shape, mark, path, glyph, drawable, item

**Scene Renderer**:
A reusable Harness backend that consumes a **Scene** and emits output — e.g. Canvas2D preview, SVG, or plotter/hidden-line SVG. Because its input is the generic Scene, one Scene Renderer serves every vector Sketch.

**Direct Renderer**:
A Harness backend handed a raw drawing surface + clock that draws whatever it wants (raw Three.js, fullscreen fragment shader). Used by **Sketches** that cannot bake into a **Scene** (e.g. a raymarcher). A one-off render technique is just an unshared Direct Renderer. A future realtime GPU renderer would also be a Direct Renderer, since it consumes a Sketch's own parametric data rather than a Scene.

**Parameter Schema**:
The single declaration a **Sketch** makes of its tweakable knobs. It is the *spine* of the Harness: the control panel, **Lock** toggles, **Randomize**, and **Preset** shape are all derived views over this one schema.
_Avoid_: config, settings

**Sketch contract**:
What a Sketch file exports: a **Parameter Schema** plus its frame logic. A *stateless* Sketch exports a pure `generate(params, seed, t)`. A *stateful* (simulation) Sketch instead exports an `initial(params, seed)` + **Step** + **Draw** triple that the Harness folds into the same `(params, seed, t) → Scene` behaviour. Either way the author writes only the schema and the frame logic; all chrome (canvas, controls, timeline, presets, navigation, export) is Harness-provided, and the author never owns the animation loop.

**Draw** (verb):
The per-frame projection of a **Sketch**'s private domain structures into a **Scene** of **Primitives** — the `draw(state) → Scene` step. Named after the Processing/p5 per-frame `draw()`. "Draw" is the **Sketch**'s job; the **Scene Renderer** then *renders* that Scene to output.
_Avoid_: bake (now means trajectory precompute — see **Bake**), project (reserved for a future 3D path), emit (particle-system connotation), render (the backend's job)

**Step** (verb):
For a stateful (simulation) **Sketch**, one advance of the private domain state — `step(state, …) → state`, domain → domain, producing no **Scene**. The Harness folds `step` from `initial(params, seed)` to reach time `t`; the author never writes the loop.
_Avoid_: update, tick, simulate

**Bake** (verb):
Precompute a simulation's whole trajectory and cache it (checkpoints across `t`) so scrubbing and export don't re-fold from zero. A Harness optimization invisible to output: keyed on `(params, seed)`, a bake can only change *speed*, never the frame. Matches the Blender/Houdini sense of "bake."
_Avoid_: snapshot (collides with **Preset**), cache (as the verb for this)

**Seed**:
The single value feeding all of a **Sketch**'s internal randomness (which cells get leaves, per-leaf wobble, flow turbulence). Re-rolling the seed keeps every param value identical but produces a different specific arrangement of the same character.

**Randomize (params)**:
An action distinct from re-seeding: it rolls new *values* for every unlocked numeric param within its control bounds, changing the sketch's character. Locked params keep their current value. (Two-axis randomness: **Seed** vs **Randomize** are independent.)

**Lock**:
A per-param flag that pins its value and excludes it from **Randomize**.

**Preset**:
A committed, per-Sketch snapshot that fully reproduces an image and resumes an exploration session — it captures the param values, the seed, and which params were locked. Stored as a JSON file per Sketch under `{sketchesRoot}/{id}/presets/`, colocated with the Sketch's code (a Sketch is a folder, `{sketchesRoot}/{id}/index.ts`). `sketchesRoot` is a single configured knob — today `packages/core/src/sketches` — so sketches and their presets can later move out of the harness by repointing it (ADR-0006). Presets are written in dev via a Vite dev-server middleware plugin (no standalone server) and read by every consumer (studio, Remotion) as a static file at the stable logical URL `/sketches/{id}/presets/{name}.json`.

The serialized record is a self-describing envelope over the studio's live state: `{ version, sketch, name, seed, params, locks }` — `seed` + `params` reproduce the image (the ADR-0002 determinism spine), `locks` (a sorted array of param keys) resume the session and do _not_ affect the rendered frame. The **Parameter Schema** is authoritative _on read_, not just on write: a Preset is a derived view, so reloading reconciles its `params` against the live schema — keys absent from the schema are dropped, keys missing from the Preset are filled from their spec `default`, and out-of-bounds values load **as-is, unclamped** (exact-image fidelity beats staying in-bounds; a clamp would silently reproduce a different frame). `version` is the migration escape hatch: v1 stores `1` and does presence-only reconciliation; a future breaking change bumps it and branches the loader.

**Render Settings**:
The per-render output configuration a consumer chooses when turning a **Sketch** into a concrete artifact — frame rate and pixel dimensions today, format and frame range later. Orthogonal to the three determinism inputs: Render Settings are _not_ **Params** (Sketch knobs), _not_ the **Seed**, and _not_ captured in a **Preset**; they change how a frame is _sampled and sized_, never which frame `generate(params, seed, t)` produces. Because a Sketch is continuous in `t` (ADR-0002), frame rate is a caller concern — the same `generate` sampled at any fps serves every caller — so fps lives here, never in the **Sketch contract**. In the Remotion consumer they arrive as composition input props (a default set plus per-render overrides); the same concept covers export dimensions for the **Scene Renderer** paths.
_Avoid_: config, params, options, export options

## Relationships

- The **Harness** hosts many **Sketches**; each **Sketch** plugs into the Harness through a shared contract.
- A vector **Sketch**'s generator produces private domain structures (e.g. its own leaf instances), then **draws** them into a **Scene** of **Primitives**. Domain types never leave the generator.
- A **Sketch** binds to one or more **Renderers**. Vector Sketches use **Scene Renderers** (and get SVG/plotter/raster export for free); non-vector Sketches use **Direct Renderers**.
- "Can this Sketch bake itself into a **Scene**?" is the dividing line between the two renderer families.

## Core invariant: a Sketch is a pure function of (params, seed, time)

A Sketch's output is deterministic in `(params, seed, t)` — same inputs, same frame, always. This single function has three callers:
- **Exploration** samples it at `t = wall-clock`, as fast as it can, to *feel* realtime while tuning.
- **Remotion** samples it at `t = frame / fps` for deterministic video.
- **Static / plotter export** freezes `t` and exports that frame's vector IR exactly.

There is no separate "realtime mode" vs "render mode" — one function, sampled at different `t`. Expensive, export-only work (hidden-line removal, path simplification, pen ordering) lives *outside* the exploration loop, which is only `generate → draw → painter's-order render`. True 60fps GPU output is explicitly the lowest priority, so the early system keeps a single vector representation rather than a parallel GPU-parametric one.

### Time semantics

`generate` is always `(params, seed, t)`, where **`t` is in seconds** uniformly across every mode; only *how the Harness drives `t`* varies, declared by optional time metadata (a duration, and whether it loops) alongside the **Parameter Schema**. No time metadata ⇒ static. A Sketch that wants normalized progress derives it itself as `t / duration` (e.g. circles computes its loop phase this way) — the contract never hands the Sketch a normalized `t`.

- **Static** — output is constant in `t`; the Harness hides the scrubber. Not a "paused" mode — `t` is simply unused.
- **Loop** — `t` wraps `0 → duration → 0` (seconds); periodic (use periodic noise for seamless loops). Any frame is a valid export.
- **One-shot / reveal** — `t` runs `0 → duration` once and clamps at `duration` (seconds); the drawing reveals over time. Canonical export frame is `t = duration`. For a plotter Sketch, `t` *is* pen-path progress — the time axis and the draw-over-time axis are one and the same. (A Sketch wanting `0 → 1` reveal progress computes `t / duration`.)

## Deliberately deferred

These are intentionally **not** pinned here — they are implementation specifics meant to emerge while executing the dev plan, not frozen in high-level planning:

- The exact record shape of a **Primitive** (how fill vs stroke is modeled — a tagged union vs an SVG-path-style record carrying optional fill and stroke; how layering and source-tagging are represented).
- The exact shape of the **Scene** container beyond "coordinate space + draw-ordered Primitives."
- The concrete field format of the **Parameter Schema**'s remaining _non-numeric_ specs (boolean / enum / … members of the open `ParamSpec` union). The numeric spec is frozen: `NumberParamSpec = { kind: 'number'; min; max; default; step?; integer? }` (issue #47). The color spec is now frozen too: `ColorParamSpec = { kind: 'color'; default }` with a hex-string value domain, never rolled by **Randomize** (ADR-0010). The serialized **Preset** object is no longer deferred — its shape and read-reconciliation policy are pinned in the **Preset** glossary entry above (issue #8).
- Any GPU / instance-model data structures (the realtime GPU path is deferred entirely).
- A **cross-param constraint** model — inter-param relationships the single-param **Parameter Schema** cannot express (e.g. `minRadius ≤ maxRadius`, params that only apply when another is enabled, sum-to-one groups). v1 **Randomize** rolls each unlocked numeric param independently within *its own* bounds, so it can hand a Sketch any in-bounds combination; a Sketch owns its own inter-param coherence inside `generate` (e.g. circles taking `Math.min`/`Math.max` of its two radii). A real constraint language is future work and deserves its own grilling before it is built.

## Flagged ambiguities

- "experiment" vs "sketch" — same concept. Resolved: **Sketch** is the canonical term everywhere (code, docs, UI); "experiment" is only an informal synonym. The project is named **Sketch Labs** (repo `tylerdurrett/sketch-labs`).
- Umbrella term for an IR geometry unit — was briefly "Mark", then "Shape" (rejected: not a real umbrella term in any reference library, and connotes closed geometry). Resolved: **Primitive** (Houdini lineage), "prim" as casual short form.

## Build strategy (decided)

Greenfield in `sketch-labs`. Lift the proven, renderer-agnostic pure libraries from the `plotter` repo (seeded random + simplex noise, vec/math, polyline geometry, clipping, SVG serialization, paper sizes) and its Vite preset plugin. Drop the `plotter` repo's `maps`/Python image-analysis pipeline entirely. Redesign the Sketch contract and the app shell rather than porting them.

Workspace layout (pnpm workspaces from day one, so Remotion is a first-class consumer): `packages/core` (headless engine + sketches), `packages/video` (Remotion compositions), `apps/studio` (React studio). The only package boundary that earns its keep now is headless-core vs studio; further splits wait for a real second consumer.

Task running stays plain `pnpm -r` — no turborepo/nx/other orchestrator. A handful of packages consumed as TypeScript source with a single test command does not earn a task graph or build cache; revisit only if build/test times demand it.
