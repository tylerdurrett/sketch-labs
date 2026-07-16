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
A reusable Harness backend that consumes a **Scene** and emits output — e.g. Canvas2D preview or SVG. Because its input is the generic Scene, one Scene Renderer serves every vector Sketch. Plotter _preparation_ is not a distinct renderer: hidden-line removal and simplification are shared `Scene → Scene` passes. The final plot artifact does use a target-specific SVG document serializer over that already-processed Scene because physical paper dimensions, baked millimeter mapping, scaled stroke widths, and path-only/background-free output differ from the ordinary full-color Scene-space SVG document.

**Direct Renderer**:
A Harness backend handed a raw drawing surface + clock that draws whatever it wants (raw Three.js, fullscreen fragment shader). Used by **Sketches** that cannot bake into a **Scene** (e.g. a raymarcher). A one-off render technique is just an unshared Direct Renderer. A future realtime GPU renderer would also be a Direct Renderer, since it consumes a Sketch's own parametric data rather than a Scene.

**Hidden-line pass**:
A pure `Scene → Scene` transform (_not_ a **Scene Renderer**) that removes outline geometry occluded by nearer **Primitive** fills in painter's order and returns a stroke-only Scene of occlusion-clipped outlines. Every filled Primitive plays two roles: an _occluder_ (its fill polygon) and a _line to draw_ (its boundary). Because the output is an ordinary Scene, the same processed geometry feeds both **Outline mode** preview through Canvas2D and plotter SVG export through the physical, path-only document serializer, so preview and export share the geometry-producing pass. Expensive and export-only: it runs on demand, never in the live `generate → draw → painter's render` exploration loop (core invariant). An optional final path-simplification stage (per-path vertex reduction with a tolerance knob) rides _inside_ the pass so it is previewed too. A separate pen-travel-order optimization (TSP-like reordering of whole paths, no visual impact) is a deferred export-only follow-up and would never be previewed.
_Avoid_: hidden-line renderer (it is a pass, not a renderer), HLR-as-renderer.

**Outline mode**:
The Studio preview state that atomically replaces the live painter's-order Fill preview with the current **Hidden-line pass** Scene through the ordinary Canvas2D renderer; its background derivation is cancellable and latest-input-wins, so unfinished or stale work never becomes visible, while plotter SVG export consumes the same completed Scene before applying only its target-specific document contract.

**Tone reference mode**:
A non-persistent Studio diagnostic view that replaces the canvas with a visualization of a tone-aware **Sketch**'s effective mask-weighted target (`Tone Field × Shading Mask`) without changing its artwork, **Preset**, or exports.
_Avoid_: source output, tone export, reference parameter

**Parameter Schema**:
The single declaration a **Sketch** makes of its tweakable knobs. It is the *spine* of the Harness: the control panel, **Lock** toggles, **Randomize**, and **Preset** shape are all derived views over this one schema.
_Avoid_: config, settings

**Composition Frame**:
The scale-independent, aspect-ratio-bearing drawable rectangle a **Sketch** composes into, expressed as a unitless coordinate space normalized to the area of the Harness's `1000 × 1000` square; for a plot it takes the aspect of the paper inside its margins, while physical paper size and pixel resolution belong to the later output mapping.
_Avoid_: paper size (physical output), resolution (pixel output), canvas size (ambiguous between layout and pixels)

**Tone Field**:
A deterministic, resolution-independent sampler over a **Composition Frame** that gives the desired relative ink darkness at any point as a finite value from `0` for paper to `1` for maximum darkness.
_Avoid_: grayscale image (only one possible source), shade map, darkness map

**Shading Mask**:
A deterministic, resolution-independent sampler over a **Composition Frame** that gives how strongly ink is permitted at any point as a finite value from `1` for fully permitted through a soft range that may be crossed to `0` for strictly forbidden.
_Avoid_: shading region (incorrectly implies a binary boundary), clipping region, selection

**Shading Strategy**:
A reusable deterministic generator that samples a **Tone Field** under a **Shading Mask** and produces a **Shading Result** according to its own strategy-specific controls and Seed (ADR-0013).
_Avoid_: shader, fill renderer, shading mode

**Shading Result**:
The minimal outcome of a **Shading Strategy**: generated polylines plus a truthful termination reason distinguishing normal completion from safety-budget exhaustion.
_Avoid_: bare polyline array, generic metrics bag

**Scribble Strategy**:
A **Shading Strategy** that preferentially grows long, chaotic continuous polylines through residual under-shaded areas until their weighted tone error is acceptable, lifting and restarting only when progress, coverage, or a zero-permission barrier requires it.
_Avoid_: single-line strategy (continuity is preferred, not absolute), random walk

**Path density**:
An authored **Scribble Strategy** control that changes how many drawn passes are required to satisfy a given tone without changing relative Tone Field values or consulting physical output dimensions.
_Avoid_: physical ink density, resolution, Tool width

**Scribble scale**:
An authored **Scribble Strategy** control that changes its characteristic spatial detail while keeping segment length, virtual-coverage radius, residual sampling, and mask validation at coherent internal ratios.
_Avoid_: resolution, stroke width, Tool width

**Momentum**:
An authored **Scribble Strategy** control that sets how strongly a growing path prefers directional continuity over turning toward a better local residual.

**Chaos**:
An authored **Scribble Strategy** control that sets how broadly Seeded steering may vary among viable candidate directions without changing the underlying target or permission fields.

**Tone fidelity**:
An authored **Scribble Strategy** control that sets how little permission-weighted residual error may remain before generation is considered converged, independently of path abundance and spatial detail.
_Avoid_: Path density, resolution

**Output Profile**:
The one target-specific artifact description active in a Sketch session and captured by its **Preset**—plot dimensions and margins for paper, or resolution and frame settings for video—whose aspect determines the **Composition Frame** while whose magnitude only controls output mapping; a Sketch may declare its default, otherwise the Harness initially supplies a square `200 × 200 mm` plot profile with linked `10 mm` insets.
_Avoid_: render target (the target is only one field), export options, last-used settings

**Tool width**:
The fixed physical width of a plotter pen or analogous output tool, owned by the plot **Output Profile** rather than the unitless Scene styling, so enlarging artwork does not enlarge the real nib.
_Avoid_: stroke width (a Scene-space style that scales with the artwork), line weight (ambiguous between the two)

**Sketch contract**:
What a Sketch file exports: a **Parameter Schema** plus its frame logic. A *stateless* Sketch exports a pure generation function of params, seed, time, and **Composition Frame**, returning a Scene in that exact frame space. A *stateful* (simulation) Sketch instead exports an `initial` + **Step** + **Draw** triple that the Harness folds into the same deterministic behaviour and frame-space invariant. Either way the author writes only the schema and the frame logic; all chrome (canvas, controls, timeline, presets, navigation, export) is Harness-provided, and the author never owns the animation loop.

**Draw** (verb):
The per-frame projection of a **Sketch**'s private domain structures into a **Scene** of **Primitives** — the `draw(state) → Scene` step. Named after the Processing/p5 per-frame `draw()`. "Draw" is the **Sketch**'s job; the **Scene Renderer** then *renders* that Scene to output.
_Avoid_: bake (now means trajectory precompute — see **Bake**), project (reserved for a future 3D path), emit (particle-system connotation), render (the backend's job)

**Step** (verb):
For a stateful (simulation) **Sketch**, one advance of the private domain state — `step(state, …) → state`, domain → domain, producing no **Scene**. The Harness folds `step` from `initial(params, seed)` to reach time `t`; the author never writes the loop.
_Avoid_: update, tick, simulate

**Bake** (verb):
Precompute a simulation's whole trajectory and cache it (checkpoints across `t`) so scrubbing and export don't re-fold from zero. A Harness optimization invisible to output: keyed on params, seed, and **Composition Frame**, a bake can only change *speed*, never the frame. Matches the Blender/Houdini sense of "bake."
_Avoid_: snapshot (collides with **Preset**), cache (as the verb for this)

**Seed**:
The single value feeding all of a **Sketch**'s internal randomness (which cells get leaves, per-leaf wobble, flow turbulence). Re-rolling the seed keeps every param value identical but produces a different specific arrangement of the same character.

**Randomize (params)**:
An action distinct from re-seeding: it rolls new *values* for every unlocked numeric param within its control bounds, changing the sketch's character. Locked params keep their current value. (Two-axis randomness: **Seed** vs **Randomize** are independent.)

**Lock**:
A per-param flag that pins its value and excludes it from **Randomize**.

**Preset**:
A committed, per-Sketch snapshot that fully reproduces an image and resumes an exploration session — it captures params, seed, locks, one active **Output Profile**, and the selected `t` for a time-driven Sketch. Stored as a JSON file per Sketch under `{sketchesRoot}/{id}/presets/`, colocated with the Sketch's code (a Sketch is a folder, `{sketchesRoot}/{id}/index.ts`). `sketchesRoot` is a single configured knob — today `packages/core/src/sketches` — so sketches and their presets can later move out of the harness by repointing it (ADR-0006). Presets are written in dev via a Vite dev-server middleware plugin (no standalone server) and read by every consumer (studio, Remotion) as a static file at the stable logical URL `/sketches/{id}/presets/{name}.json`.

The serialized record is a self-describing envelope over the studio's live state. In addition to seed, params, and locks, it captures one active **Output Profile**: its aspect supplies the **Composition Frame** needed to reproduce the Scene, while its complete dimensions resume the intended artifact; a timed Preset also captures the selected `t` and reloads paused at that frame; locks resume the session and do _not_ affect the rendered frame. The **Parameter Schema** is authoritative _on read_, not just on write: a Preset is a derived view, so reloading reconciles its `params` against the live schema — keys absent from the schema are dropped, keys missing from the Preset are filled from their spec `default`, and out-of-bounds values load **as-is, unclamped** (exact-image fidelity beats staying in-bounds; a clamp would silently reproduce a different frame). `version` is the migration escape hatch: v1 stores `{ version, sketch, name, seed, params, locks }`; v2 adds the active plot `profile`; the next version adds an optional finite `t`, present when the saved Sketch is time-driven, without changing how v1 or v2 records load.

**Palette swatch**:
A Harness-wide Studio editing shortcut that sets a color param to a fixed hex value without becoming part of the Sketch's **Parameter Schema** or **Preset**.
_Avoid_: preset color, color preset, preset swatch

**Image Asset**:
A project-managed raster source identified by a stable logical ID so Studio, workers, Presets, video, and exports can resolve the same image bytes independently of the importing machine's local path.
_Avoid_: browser File, absolute path, uploaded image (does not state persistence)

**Image Asset parameter**:
A **Parameter Schema** member whose value is a stable **Image Asset** ID and whose derived Studio control imports or selects managed raster sources without participating in **Randomize**.
_Avoid_: file parameter, path parameter, upload state

**Render Settings**:
The resolved per-render execution values a consumer uses when turning a **Sketch** into an artifact, derived from an **Output Profile** or supplied directly by a caller such as Remotion. Their output dimensions' aspect supplies the **Composition Frame** and can therefore regenerate the Scene; their magnitude, frame rate, format, and frame range affect only sampling and output mapping. Frame rate remains outside the Sketch contract because a Sketch is continuous in `t` (ADR-0002). Unlike the persisted authoring intent of an Output Profile, direct Remotion Render Settings arrive as composition input props and are not themselves Preset state.
_Avoid_: config, params, options, export options

## Relationships

- The **Harness** hosts many **Sketches**; each **Sketch** plugs into the Harness through a shared contract.
- A vector **Sketch**'s generator produces private domain structures (e.g. its own leaf instances), then **draws** them into a **Scene** of **Primitives**. Domain types never leave the generator.
- A **Sketch** binds to one or more **Renderers**. Vector Sketches use **Scene Renderers** (and get SVG/plotter/raster export for free); non-vector Sketches use **Direct Renderers**.
- "Can this Sketch bake itself into a **Scene**?" is the dividing line between the two renderer families.
- One active **Output Profile** supplies the **Composition Frame** aspect to generation and the target-specific dimensions to the later output mapping.
- A **Preset**'s Output Profile wins on reload; otherwise a Sketch's declared default wins, with the Harness's square default as the terminal fallback.
- A timed **Preset** restores its selected `t` in a paused state, so the saved frame, **Outline mode**, and plotter export identify the same reveal progress without turning progress into a Sketch parameter.
- When an older **Preset** has no stored `t`, reload pauses a one-shot Sketch at its complete `duration` and a looping Sketch at `t = 0`; these mode-specific defaults keep migration deterministic.
- An **Image Asset parameter** lets the **Parameter Schema** derive managed image selection and lets a **Preset** capture the chosen stable ID; **Randomize** leaves the selection unchanged.
- The default raster adapter maps inverted luminance to a **Tone Field** and alpha to a **Shading Mask**, so opaque photographs use their full fitted extent while transparent and partially transparent pixels provide hard and soft permission respectively.
- Plot profiles store authoritative physical dimensions, not a redundant paper name or orientation; the Harness derives standard-size labels, and its portrait/landscape convenience swaps width and height, regenerating when that changes the Composition Frame aspect.
- A plot profile's margins inset the paper to form its drawable rectangle; that rectangle's aspect supplies the Composition Frame, so a margin change regenerates only when it changes the drawable aspect.
- Plot margins are four physical insets; the initial Harness UI edits them as one linked value, leaving asymmetric plotter-safe regions representable without changing the Preset model later.
- Composition Frames use fixed-area normalization: for aspect `r`, the Harness resolves `width = 1000√r` and `height = 1000/√r`, preserving one million square coordinate units across aspect changes; an Output Profile later supplies the uniform conversion from those unitless coordinates to millimeters or pixels.
- Scene geometry and Scene stroke widths scale through the output mapping; a plotter's physical **Tool width** remains fixed in millimeters and can drive a plot preview independently.
- The Studio exposes the active plot Output Profile in a Paper section near the top of the inspector; it is collapsible and collapsed by default, with its active dimensions retained in the summary.
- A plotter-ready SVG maps artwork into the profile's physical paper and margins but emits only plot paths; paper edges, margin guides, and backgrounds are preview chrome rather than drawable geometry, while the Output Profile remains available as metadata.
- Every generated Scene uses the Composition Frame's exact normalized coordinate space; the Harness therefore knows layout before generation and does not need Sketch-authored fixed-space metadata or a throwaway Scene probe.
- Photographs, analytic gradients, and procedural shapes can each produce a **Tone Field**; a **Shading Strategy** consumes that field and produces a **Shading Result** without knowing its source, while the consuming **Sketch** styles and draws the result's polylines as **Primitives**.
- Procedural field producers evaluate arbitrary Composition Frame coordinates directly; raster producers own coordinate mapping and interpolation so **Shading Strategies** never depend on a source pixel grid or resolution.
- A **Shading Mask** constrains a **Shading Strategy** independently of desired tone: intermediate permission lets a strategy deliberately color outside the lines, while exact zero remains a hard prohibition.
- A **Shading Strategy** enforces zero permission at an explicit working resolution by subdividing candidate segments and validating finished paths; sources with exact boundary geometry may additionally request exact clipping without changing the sampler contract.
- A **Shading Strategy** maps relative **Tone Field** values to geometry through explicit Sketch parameters such as path density; paper size and physical **Tool width** never adjust that geometry automatically.
- **Tone reference mode** may expose the source for comparison, but the finished shading geometry remains part of the artwork and appears alongside every other visible contour in **Outline mode** and plotter export.
- A **Sketch** draws shading polylines as Hidden-line sources in painter's order; the existing **Hidden-line pass**, not the **Shading Strategy**, clips them behind nearer filled occluders alongside the Sketch's other visible contours.
- A **Scribble Strategy** minimizes pen lifts but may return multiple polylines so disconnected or exhausted regions can be shaded without crossing a zero-permission **Shading Mask**.
- A **Scribble Strategy** tracks the virtual coverage deposited by its paths and stops when remaining weighted tone error falls below an explicit tolerance; a maximum path budget is a deterministic safety cap, not the definition of completion.
- A **Scribble Strategy** weights remaining tone error linearly by **Shading Mask** permission for both steering and completion, so low-permission areas exert proportionally less demand while zero-permission areas exert none and remain impassable.
- A **Scribble Strategy** deposits additive virtual coverage with a compact smooth falloff around each segment; explicit Scene-space influence radius and per-pass strength control spacing and repetition without representing physical **Tool width**.
- Increasing **Path density** reduces the virtual coverage satisfied by each pass, producing more path length for the same **Tone Field** while preserving its relative light-dark relationships.
- Decreasing **Scribble scale** produces finer paths and tighter field sampling, while increasing it produces broader, looser paths; low-level sampling and coverage ratios remain internal until hands-on iteration proves a need to expose them separately.
- A **Scribble Strategy** selects starts and restarts through Seeded weighting among high-residual areas, so dark regions tend to appear early without forcing every Seed to begin at the same global maximum.
- A safety-budget-exhausted **Shading Result** remains valid, exportable creative geometry but Studio must identify it truthfully rather than calling it converged; generic path length and pen-lift counts are derived from its polylines, while strategy-specific diagnostics do not widen the shared result.
- Plot dimensions and insets are canonical millimeters; the Paper UI accepts and displays both millimeters and inches by converting at its boundary, while the display-unit choice is a Studio local-storage preference rather than Preset or Sketch state.
- The first Output Profile implementation is plot-focused in Studio; Remotion derives the same fixed-area Composition Frame from its existing pixel width and height while retaining its current resolution/fps inputs, and a Studio Video profile/target switch waits until video authoring moves there.

## Core invariant: a Sketch is a pure function of (params, seed, time, composition frame)

A Sketch's output is deterministic in its params, seed, time, and **Composition Frame** — same inputs, same Scene, always. Changing the Composition Frame's aspect fully regenerates the Scene; changing only physical paper size or pixel resolution does not. This single function has three callers:
- **Exploration** samples it at `t = wall-clock`, as fast as it can, to *feel* realtime while tuning.
- **Remotion** samples it at `t = frame / fps` for deterministic video.
- **Static / plotter export** freezes `t` and exports that frame's vector IR exactly.

There is no separate "realtime mode" vs "render mode" — one function, sampled at different `t`. Expensive, export-only work (hidden-line removal, path simplification, pen ordering) lives *outside* the exploration loop, which is only `generate → draw → painter's-order render`. True 60fps GPU output is explicitly the lowest priority, so the early system keeps a single vector representation rather than a parallel GPU-parametric one.

A stateless Sketch may optionally expose caller-owned **frame preparation** as an optimization of that same function. The returned sampler may retain immutable data derived from params, seed, and Composition Frame, but it remains pure in `t` and carries no accumulated frame state. `generate` stays the public random-access contract and is derived from the same preparation implementation; sequential Harness callers may retain one sampler only until params, seed, Composition Frame, or Sketch identity changes. This is not a second realtime mode and not a hidden Sketch cache. See ADR-0012.

### Time semantics

In `generate(params, seed, t, compositionFrame)`, **`t` is in seconds** uniformly across every mode; only *how the Harness drives `t`* varies, declared by optional time metadata (a duration, and whether it loops) alongside the **Parameter Schema**. No time metadata ⇒ static. A Sketch that wants normalized progress derives it itself as `t / duration` (e.g. circles computes its loop phase this way) — the contract never hands the Sketch a normalized `t`.

- **Static** — output is constant in `t`; the Harness hides the scrubber. Not a "paused" mode — `t` is simply unused.
- **Loop** — `t` wraps `0 → duration → 0` (seconds); periodic (use periodic noise for seamless loops). Any frame is a valid export.
- **One-shot / reveal** — `t` runs `0 → duration` once and clamps at `duration` (seconds); the drawing reveals over time. `t = duration` is the default complete state, but every scrubbed `t` is a valid frame: **Outline mode** processes that displayed partial geometry and plotter export uses the same selected result. For a plotter Sketch, `t` *is* pen-path progress — the time axis and the draw-over-time axis are one and the same. (A Sketch wanting `0 → 1` reveal progress computes `t / duration`.)

## Deliberately deferred

These are intentionally **not** pinned here — they are implementation specifics meant to emerge while executing the dev plan, not frozen in high-level planning:

- The exact record shape of a **Primitive** (how fill vs stroke is modeled — a tagged union vs an SVG-path-style record carrying optional fill and stroke; how layering and source-tagging are represented).
- The exact shape of the **Scene** container beyond "coordinate space + draw-ordered Primitives."
- The concrete field format of the **Parameter Schema**'s remaining _non-numeric_ specs (boolean / enum / … members of the open `ParamSpec` union). The numeric spec is frozen: `NumberParamSpec = { kind: 'number'; min; max; default; step?; integer? }` (issue #47). The color spec is now frozen too: `ColorParamSpec = { kind: 'color'; default }` with a hex-string value domain, never rolled by **Randomize** (ADR-0010). The serialized **Preset** object is no longer deferred — its shape and read-reconciliation policy are pinned in the **Preset** glossary entry above (issue #8).
- Any GPU / instance-model data structures (the realtime GPU path is deferred entirely).
- A **cross-param constraint** model — inter-param relationships the single-param **Parameter Schema** cannot express (e.g. `minRadius ≤ maxRadius`, params that only apply when another is enabled, sum-to-one groups). v1 **Randomize** rolls each unlocked numeric param independently within *its own* bounds, so it can hand a Sketch any in-bounds combination; a Sketch owns its own inter-param coherence inside `generate` (e.g. circles taking `Math.min`/`Math.max` of its two radii). A real constraint language is future work and deserves its own grilling before it is built.
- A cross-strategy registry, runtime selector, and normalized control model. The first scribble implementation establishes only the minimal **Shading Strategy** boundary with its own typed controls. The second strategy is the explicit trigger to compare both real configurations, promote only proven shared controls, retain genuinely strategy-specific controls, and add runtime selection without changing Tone Field or Shading Mask producers.
- Raster photograph ingestion as a **Tone Field** producer. The first scribble Sketch uses a procedural tone test composition so the field and strategy contracts can be tuned independently of asset handling. The next source milestone adds managed import of arbitrary local images into a configured project asset root, assigns each **Image Asset** a stable logical ID captured by Presets, and resolves identical bytes across Studio, workers, and video before decoding and sampling them behind the existing Tone Field contract; it must not expose machine-local paths or change Shading Strategy consumers.
- A Scribble-side boundary-adherence control that remaps **Shading Mask** values. The first implementation interprets mask permission consistently and exposes softness/bleed through the procedural mask producer instead of adding a second overlapping knob. Reconsider strategy-side remapping at the first browser iteration checkpoint or when imported masks make source editing impractical.
- A mask-only Studio diagnostic alongside **Tone reference mode**. The initial reference shows the effective target because that is what the solver matches; reconsider a separate permission visualization when browser iteration makes mask behavior difficult to understand or imported masks arrive.
- Alternate raster-to-field interpretations beyond the default luminance-plus-alpha adapter: channel selection, independent mask assets, color-aware tone models, thresholding, levels/gamma, inversion, edge-aware preprocessing, and fit/crop policy remain source-side concerns to refine with real photograph experiments; none may leak into **Shading Strategy** consumers.

## Example dialogue

> **Sketch author:** “Can the same scribble strategy shade both a photograph and a radial gradient?”
> **Domain expert:** “Yes. Each source produces a **Tone Field**, and the strategy consumes that field without knowing how its darkness values were derived.”
>
> **Sketch author:** “Can the scribble stray beyond the subject without entering the margin?”
> **Domain expert:** “Yes. Give the subject's edge a soft **Shading Mask**, but keep the margin at zero permission.”
>
> **Sketch author:** “Should switching from A4 to A2 add lines to preserve physical ink coverage?”
> **Domain expert:** “No. Path density is an explicit Sketch choice; output size and **Tool width** do not silently regenerate the composition.”
>
> **Sketch author:** “Does every **Shading Strategy** have to expose one universal density control?”
> **Domain expert:** “Not yet. The first strategy keeps its own controls; the second strategy gives us enough evidence to introduce selection and promote only controls the two genuinely share.”
>
> **Sketch author:** “Does viewing the source tone replace the scribble in my exported plot?”
> **Domain expert:** “No. **Tone reference mode** is diagnostic only; **Outline mode** still shows the complete plot geometry, including the finished shading.”

## Flagged ambiguities

- "experiment" vs "sketch" — same concept. Resolved: **Sketch** is the canonical term everywhere (code, docs, UI); "experiment" is only an informal synonym. The project is named **Sketch Labs** (repo `tylerdurrett/sketch-labs`).
- Umbrella term for an IR geometry unit — was briefly "Mark", then "Shape" (rejected: not a real umbrella term in any reference library, and connotes closed geometry). Resolved: **Primitive** (Houdini lineage), "prim" as casual short form.
- "preset color swatch" collided with the existing full-session **Preset**. Resolved: **Palette swatch** is the canonical term for a color-choice shortcut.
- "shades-of-darkness-to-path" mixed the source, strategy, and Scene output. Resolved: a **Tone Field** is the shared source abstraction; shading strategies produce polyline geometry that a **Sketch** draws as **Primitives**.
- "shading region" implied ink was either allowed or forbidden. Resolved: a **Shading Mask** carries soft permission above zero and reserves exact zero for a hard prohibition.

## Build strategy (decided)

Greenfield in `sketch-labs`. Lift the proven, renderer-agnostic pure libraries from the `plotter` repo (seeded random + simplex noise, vec/math, polyline geometry, clipping, SVG serialization, paper sizes) and its Vite preset plugin. Drop the `plotter` repo's `maps`/Python image-analysis pipeline entirely. Redesign the Sketch contract and the app shell rather than porting them.

Workspace layout (pnpm workspaces from day one, so Remotion is a first-class consumer): `packages/core` (headless engine + sketches), `packages/video` (Remotion compositions), `apps/studio` (React studio). The only package boundary that earns its keep now is headless-core vs studio; further splits wait for a real second consumer.

Task running stays plain `pnpm -r` — no turborepo/nx/other orchestrator. A handful of packages consumed as TypeScript source with a single test command does not earn a task graph or build cache; revisit only if build/test times demand it.
