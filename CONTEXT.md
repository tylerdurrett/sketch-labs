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
The atomic drawable unit of a **Scene** — one styled piece of vector geometry (a polygon or polyline, filled and/or stroked) with a draw order. Its optional `hiddenLineRole` is generic processing intent: `source` emits the path after clipping, `occluder` contributes a filled clipping polygon without emitting a path, and `both` does both. Omission preserves the original contract: a filled Primitive is both, while a stroke-only Primitive is ignored by the Hidden-line pass. This is not a Sketch-domain or pen-layer tag.
_Avoid_: shape, mark, path, glyph, drawable, item

**Scene Renderer**:
A reusable Harness backend that consumes a **Scene** and emits output — e.g. Canvas2D preview or SVG. Because its input is the generic Scene, one Scene Renderer serves every vector Sketch. Plotter _preparation_ is not a distinct renderer: hidden-line removal and simplification are shared `Scene → Scene` passes. The final plot artifact does use a target-specific SVG document serializer over that already-processed Scene because physical paper dimensions, baked millimeter mapping, scaled stroke widths, and path-only/background-free output differ from the ordinary full-color Scene-space SVG document.

**Direct Renderer**:
A Harness backend handed a raw drawing surface + clock that draws whatever it wants (raw Three.js, fullscreen fragment shader). Used by **Sketches** that cannot bake into a **Scene** (e.g. a raymarcher). A one-off render technique is just an unshared Direct Renderer. A future realtime GPU renderer would also be a Direct Renderer, since it consumes a Sketch's own parametric data rather than a Scene.

**Hidden-line pass**:
A pure `Scene → Scene` transform (_not_ a **Scene Renderer**) that subtracts nearer filled occluder polygons from source paths in painter's order and returns a stroke-only Scene of occlusion-clipped paths. Legacy Scenes need no annotation: every filled Primitive is both source and occluder, while stroke-only Primitives are ignored. A representation-specific Sketch may instead use the generic `hiddenLineRole` field to retain stroke sources and make selected filled polygons non-emitted occluders; the Harness contains no Sketch-specific branching. Because the output is an ordinary Scene, the same processed geometry feeds both **Outline mode** preview through Canvas2D and plotter SVG export through the physical, path-only document serializer, so preview and export share the geometry-producing pass. Expensive and on-demand: it never runs in the live `generate → draw → painter's render` exploration loop (core invariant). An optional final path-simplification stage (per-path vertex reduction with a tolerance knob) rides _inside_ the pass so it is previewed too. A separate pen-travel-order optimization (TSP-like reordering of whole paths, no visual impact) is a deferred export-only follow-up and would never be previewed.
_Avoid_: hidden-line renderer (it is a pass, not a renderer), HLR-as-renderer.

**Outline mode**:
The Studio preview state that atomically replaces the live painter's-order Fill preview with the current **Hidden-line pass** Scene through the ordinary Canvas2D renderer; its background derivation is cancellable and latest-input-wins, so unfinished or stale work never becomes visible, while plotter SVG export consumes the same completed Scene before applying only its target-specific document contract.

**Tone reference mode**:
A non-persistent Studio diagnostic view that replaces the canvas with a visualization of a tone-aware **Sketch**'s effective mask-weighted target (`Tone Field × Shading Mask`) without changing its artwork, **Preset**, or exports.
_Avoid_: source output, tone export, reference parameter

**Detail reference mode**:
A non-persistent Studio diagnostic view that replaces the canvas with a grayscale visualization of a detail-aware **Sketch**'s normalized, sensitivity-adjusted **Detail Field** without changing its artwork, **Preset**, or exports.
_Avoid_: scale output, edge preview, detail export, reference parameter

**Parameter Schema**:
The single declaration a **Sketch** makes of its tweakable knobs. It is the *spine* of the Harness: the control panel, **Lock** toggles, **Randomize**, and **Preset** shape are all derived views over this one schema.
_Avoid_: config, settings

**Composition Frame**:
The scale-independent, aspect-ratio-bearing drawable rectangle a **Sketch** composes into, expressed as a unitless coordinate space normalized to the area of the Harness's `1000 × 1000` square; an unframed plot initially takes the aspect of the paper inside its margins, while later Page framing leaves this original generation boundary intact as the output page diverges from it.
_Avoid_: paper size (physical output), resolution (pixel output), canvas size (ambiguous between layout and pixels)

**Page Frame**:
The axis-aligned final drawable page boundary positioned in an already-generated **Scene**'s **Composition Frame** coordinates. Ordinary scale-preserving framing changes physical Page extent as the boundary crops inward or adds geometry-free padding; explicit fixed-page framing inversely changes the boundary's proportional extent to uniformly scale and position the frozen Scene behind an unchanged physical Page. Neither operation regenerates the Sketch, mutates the Scene, or changes its Composition Frame (ADR-0015).
_Avoid_: Crop Window (names only the subtractive case), Composition Frame (generation boundary), canvas bounds

**Page Frame edit mode**:
A non-persistent Studio editing view with direct controls over a **Page Frame**. Its ordinary, scale-preserving presentation shows the whole original composition plus cropped or padded extent while the Page boundary is moved or resized. Its fixed-page presentation instead keeps the physical Page viewport stationary and clips or rerasterizes the frozen Scene as it is scaled or panned behind that boundary. Leaving either presentation restores the committed framed result edge-to-edge exactly as output will.
_Avoid_: crop preview (names only the subtractive case), crop parameter

**Tone Field**:
A deterministic, resolution-independent sampler over a **Composition Frame** that gives the desired relative ink darkness at any point as a finite value from `0` for paper to `1` for maximum darkness.
_Avoid_: grayscale image (only one possible source), shade map, darkness map

**Detail Field**:
A deterministic, resolution-independent scalar sampler over a **Composition Frame** that gives local visual complexity from `0` for smooth areas to `1` for the strongest detail, independently of tone and edge direction.
_Avoid_: Tone Field, edge map (only one possible input), Direction Field

**Scribble Scale Field**:
A deterministic, resolution-independent sampler over a **Composition Frame** that gives the local characteristic scale the **Scribble Strategy** must use while preserving its coupled geometric ratios.
_Avoid_: Detail Field (only one possible source), generic parameter field, resolution map

**Shading Mask**:
A deterministic, resolution-independent sampler over a **Composition Frame** that gives how strongly ink is permitted at any point as a finite value from `1` for fully permitted through a soft range that may be crossed to `0` for strictly forbidden.
_Avoid_: shading region (incorrectly implies a binary boundary), clipping region, selection

**Shading Strategy**:
A reusable deterministic generator that samples a **Tone Field** under a **Shading Mask** and produces a **Shading Result** according to its own strategy-specific controls and Seed (ADR-0013).
_Avoid_: shader, fill renderer, shading mode

**Shading Result**:
The minimal outcome of a **Shading Strategy**: generated polylines plus a truthful termination reason distinguishing normal completion, an authored early stop, and safety-budget exhaustion.
_Avoid_: bare polyline array, generic metrics bag

**Shading preparation**:
Harness-owned cancellable background work that prepares an expensive tone-aware Sketch's complete artwork, progress, and typed diagnostics without selecting or executing strategy-specific policy itself.
_Avoid_: Scribble worker, strategy selector

**Shading diagnostics**:
Observations carried by completed prepared artwork as shared lifecycle and geometry metrics plus one exhaustive strategy-specific fidelity variant, never as an untyped metrics bag or cross-strategy score.
_Avoid_: generic metrics bag, universal error score

**Scribble Strategy**:
A **Shading Strategy** that preferentially grows long, chaotic continuous polylines through residual under-shaded areas until their weighted tone error is acceptable, lifting and restarting only when progress, coverage, or a zero-permission barrier requires it.
_Avoid_: single-line strategy (continuity is preferred, not absolute), random walk

**Stipple**:
A very short two-point micro-stroke that reads visually as a dot while remaining reliable plotter path geometry.
_Avoid_: point (not reliably drawable), pen tap, traced circle

**Stippling Strategy**:
A **Shading Strategy** that constructs relative darkness through a deterministic tone-weighted blue-noise distribution of fixed near-dot **Stipples** whose placement and unbiased orientation vary only with Seed.
_Avoid_: dot renderer, point cloud

**Path density**:
A Scribble-specific control that changes how many drawn passes are required to satisfy a given tone without changing relative Tone Field values or consulting physical output dimensions.
_Avoid_: physical ink density, resolution, Tool width

**Stipple density**:
A Stippling-specific control that changes the abundance and spacing of fixed near-dot Stipples without changing their length, the relative Tone Field, or any physical output value.
_Avoid_: Path density, physical ink density, Tool width

**Stop point**:
An authored **Scribble Strategy** control for the artistic look of an unfinished piece. It approximately limits accepted segments to a percentage of the ordinary work allowance without changing path density, tone fidelity, or the Tone Field; `100%` preserves ordinary behavior.
_Avoid_: performance budget, density, convergence threshold

**Scribble scale**:
An authored **Scribble Strategy** control that changes its characteristic spatial detail while keeping segment length, virtual-coverage radius, residual sampling, and mask validation at coherent internal ratios.
_Avoid_: resolution, stroke width, Tool width

**Detail influence**:
An authored Photo Scribble control that sets how strongly its **Detail Field** broadens the resulting **Scribble Scale Field** away from the fine-detail **Scribble scale** anchor, with `0` preserving uniform scale exactly.

**Detail sensitivity**:
An authored Photo Scribble control that sets how readily subtle local complexity in its normalized **Detail Field** retains fine-scale geometry without changing tone.

**Momentum**:
An authored **Scribble Strategy** control that sets how strongly a growing path prefers directional continuity over turning toward a better local residual.

**Chaos**:
An authored **Scribble Strategy** control that sets how broadly Seeded steering may vary among viable candidate directions without changing the underlying target or permission fields.

**Tone fidelity**:
A Scribble-specific control that sets how little permission-weighted residual error may remain before generation is considered converged, independently of path abundance and spatial detail.
_Avoid_: Path density, resolution

**Distribution fidelity**:
A Stippling-specific control that sets how carefully an initial tone-weighted blue-noise placement is refined toward lower local distribution error without changing Stipple abundance or length.
_Avoid_: Tone fidelity, Stipple density, regularity

**Output Profile**:
The one target-specific artifact description active in a Sketch session and captured by its **Preset**—plot dimensions and margins for paper, or resolution and frame settings for video. Before reframing, its aspect determines the **Composition Frame** and its magnitude controls output mapping. Ordinary Page framing derives a new final profile at the preserved Scene-to-physical scale; fixed-page framing instead locks the exact profile and varies only the existing Page Frame. In both cases the original Composition Frame remains independently reproducible. A Sketch may declare its default, otherwise the Harness initially supplies a square `200 × 200 mm` plot profile with linked `10 mm` insets.
_Avoid_: render target (the target is only one field), export options, last-used settings

**Plot Tool**:
The physical mark-making instrument assigned to one **Plot Stage**, represented initially by its Tool width while reusable named tools, selectable colors, and further machine-facing properties remain additive.
_Avoid_: stroke style (Scene appearance), pen layer (artifact routing)

**Tool width**:
The fixed physical width of a **Plot Tool** rather than unitless Scene styling, stored on the ordinary plot **Output Profile** for a one-stage Sketch and independently assignable per **Plot Stage** in a Sequence, so enlarging artwork does not enlarge the real nib.
_Avoid_: stroke width (a Scene-space style that scales with the artwork), line weight (ambiguous between the two)

**Plot Sequence**:
An ordered, Sketch-authored set of plotter assets that gives multiple **Plot Stages** exact digital registration on one final page.
_Avoid_: layer stack, multi-pen layer file

**Plot Stage**:
One named plot-ready artifact in a **Plot Sequence**, generated for a particular tool and artistic purpose at a defined position in the workflow.
_Avoid_: layer (ambiguous with Primitive routing inside one artifact), pass (ambiguous with Scene-to-Scene processing)

**Primary Plot Stage**:
The **Plot Stage** that remains its Sketch's ordinary output and default authoring view when the optional Sequence capability is not being inspected.
_Avoid_: combined output, active layer

**Pencil Contour**:
Sparse line artwork derived from a photograph's strongest structural boundaries—its subject silhouette and major internal landmarks—with noisy fragments removed and paths simplified.
_Avoid_: edge-filter preview, full-detail tracing, pencil shading

**Sketch contract**:
What a Sketch file exports: a **Parameter Schema** plus its frame logic. A *stateless* Sketch exports a pure generation function of params, seed, time, and **Composition Frame**, returning a Scene in that exact frame space. It may additionally expose a pure, on-demand Outline-source generator for a physical tool profile; this returns only generic role-annotated Scene geometry and never enters live Fill sampling. A *stateful* (simulation) Sketch instead exports an `initial` + **Step** + **Draw** triple that the Harness folds into the same deterministic behaviour and frame-space invariant. Either way the author writes only the schema and the frame logic; all chrome (canvas, controls, timeline, presets, navigation, export) is Harness-provided, and the author never owns the animation loop.

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
A committed, per-Sketch snapshot that fully reproduces an image and resumes an exploration session — it captures params, seed, locks, one active **Output Profile**, any active **Page Frame** plus the original **Composition Frame** aspect when the two have diverged, and — once the deferred timed-reveal feature (#327) lands — the selected `t` for a time-driven Sketch. Stored as a JSON file per Sketch under `{sketchesRoot}/{id}/presets/`, colocated with the Sketch's code (a Sketch is a folder, `{sketchesRoot}/{id}/index.ts`). `sketchesRoot` is a single configured knob — today `packages/core/src/sketches` — so sketches and their presets can later move out of the harness by repointing it (ADR-0006). Presets are written in dev via a Vite dev-server middleware plugin (no standalone server) and read by every consumer (studio, Remotion) as a static file at the stable logical URL `/sketches/{id}/presets/{name}.json`.

The serialized record is a self-describing envelope over the studio's live state. In addition to seed, params, and locks, it captures one active **Output Profile**: when unframed, its aspect supplies the **Composition Frame** needed to reproduce the Scene; when reframed, v3 preserves that generation aspect independently and records the exact Page Frame while the profile describes the final artifact. Fixed-page scaling uses this same v3 profile-plus-frame representation: it adds no composition-transform field and no new migration envelope. A timed Preset also captures the selected `t` and reloads paused at that frame (deferred to #327); locks resume the session and do _not_ affect the rendered frame. The **Parameter Schema** is authoritative _on read_, not just on write: a Preset is a derived view, so reloading reconciles its `params` against the live schema — keys absent from the schema are dropped, keys missing from the Preset are filled from their spec `default`, and out-of-bounds values load **as-is, unclamped** (exact-image fidelity beats staying in-bounds; a clamp would silently reproduce a different frame). `version` is the migration escape hatch: v1 stores `{ version, sketch, name, seed, params, locks }`; v2 adds the active plot `profile`; v3 adds the generation aspect and Page Frame without changing how v1 or v2 records load.

**Palette swatch**:
A Harness-wide Studio editing shortcut that sets a color param to a fixed hex value without becoming part of the Sketch's **Parameter Schema** or **Preset**.
_Avoid_: preset color, color preset, preset swatch

**Image Asset**:
A project-managed raster source identified by a stable logical ID so Studio, workers, Presets, video, and exports can resolve the same image bytes independently of the importing machine's local path. The ID joins a human-readable slug with a content-derived suffix, so identical bytes deduplicate to one asset and the bytes behind an ID can never change; re-importing edited bytes creates a new asset rather than mutating an old one. Import normalizes: the picked file is decoded, downscaled to a capped long edge, and re-encoded as PNG, and those normalized bytes are the asset (the original is never stored), bounding decoded memory and repo growth while keeping reproduction exact. Assets live committed in the repo under a configured asset root, presets-style.
_Avoid_: browser File, absolute path, uploaded image (does not state persistence), mutable asset (re-import mints a new ID)

**Image Asset parameter**:
A **Parameter Schema** member whose value is a stable **Image Asset** ID and whose derived Studio control imports or selects managed raster sources without participating in **Randomize**.
_Avoid_: file parameter, path parameter, upload state

**Choice parameter**:
A **Parameter Schema** member whose value is one stable ID from a declared option set and whose deliberate selection is retained by **Randomize** while governing which dependent controls are active.
_Avoid_: enum slider, randomized mode

**Render Settings**:
The resolved per-render execution values a consumer uses when turning a **Sketch** into an artifact, derived from an **Output Profile** or supplied directly by a caller such as Remotion. Their output dimensions' aspect supplies the **Composition Frame** and can therefore regenerate the Scene; their magnitude, frame rate, format, and frame range affect only sampling and output mapping. Frame rate remains outside the Sketch contract because a Sketch is continuous in `t` (ADR-0002). Unlike the persisted authoring intent of an Output Profile, direct Remotion Render Settings arrive as composition input props and are not themselves Preset state.
_Avoid_: config, params, options, export options

## Relationships

- The **Harness** hosts many **Sketches**; each **Sketch** plugs into the Harness through a shared contract.
- A vector **Sketch**'s generator produces private domain structures (e.g. its own leaf instances), then **draws** them into a **Scene** of **Primitives**. Domain types never leave the generator.
- A **Sketch** binds to one or more **Renderers**. Vector Sketches use **Scene Renderers** (and get SVG/plotter/raster export for free); non-vector Sketches use **Direct Renderers**.
- "Can this Sketch bake itself into a **Scene**?" is the dividing line between the two renderer families.
- Before reframing, one active **Output Profile** supplies both the **Composition Frame** aspect to generation and the target-specific dimensions to later output mapping; a committed Page Frame decouples those responsibilities without changing the generated Scene. Ordinary framing changes the profile to preserve Scene-to-physical scale, while fixed-page framing locks the exact profile and inversely changes Page Frame extent.
- A **Preset**'s Output Profile wins on reload; otherwise a Sketch's declared default wins, with the Harness's square default as the terminal fallback.
- A reframed v3 **Preset** preserves both sides of the post-generation boundary: its stored generation aspect regenerates the same Scene, while its exact **Output Profile** and **Page Frame** reproduce the final Page, fixed-page composition scale, and placement. Scale remains derived rather than separately persisted, and Page Frame edits participate in Studio Undo/Redo like other authored session edits.
- _(Deferred to #327.)_ A timed **Preset** restores its selected `t` in a paused state, so the saved frame, **Outline mode**, and plotter export identify the same reveal progress without turning progress into a Sketch parameter.
- _(Deferred to #327.)_ When an older **Preset** has no stored `t`, reload pauses a one-shot Sketch at its complete `duration` and a looping Sketch at `t = 0`; these mode-specific defaults keep migration deterministic.
- An **Image Asset parameter** lets the **Parameter Schema** derive managed image selection and lets a **Preset** capture the chosen stable ID; **Randomize** leaves the selection unchanged, and its spec declares a default asset ID so a consuming Sketch renders from a committed sample out of the box.
- Each resolved **Image Asset parameter** control exposes a Harness-owned "Recompose to this image's aspect" action scoped to that exact row; the selected asset's decoded dimensions provide the aspect, so multiple image fields remain unambiguous and no Sketch-contract hint chooses one for the user.
- Recompose to an image aspect resets Page framing and fits the new drawable aspect inside the current drawable Page without enlarging it—preserving the dimension that already fits, shrinking the other, and retaining physical margins—after which ordinary locked Page resizing may scale the result.
- A missing **Image Asset** fails closed: the parameter keeps the unresolvable ID exactly as captured, Studio shows an explicit missing-asset state rather than substituting other bytes, no background shading work launches, and exports stay disabled until the asset resolves — reproducing a different image would break the **Preset** contract's exact-image fidelity.
- The default raster adapter maps inverted linear relative luminance to a **Tone Field** (sRGB decodes to linear light before weighting, so plotted ink coverage tracks the photograph's physical reflectance rather than on-screen lightness) and straight alpha to a **Shading Mask**, so opaque photographs use their full fitted extent while transparent and partially transparent pixels provide hard and soft permission respectively.
- The default raster adapter fits the whole photograph centered inside the **Composition Frame** (contain, never crop); outside the fitted extent both tone and permission are exactly zero, so a mismatched aspect letterboxes with unplottable bands rather than silently discarding photo content.
- Image Asset resolution is a Harness environment concern: each environment owns async fetch-by-ID plus decode into one core-defined decoded-pixels record, and a Sketch's tone-source generator receives a synchronous pre-resolved asset lookup, staying pure (ADR-0014).
- Plot profiles store authoritative physical dimensions, not a redundant paper name or orientation; the Harness derives standard-size labels, and its portrait/landscape convenience swaps width and height, regenerating when that changes the Composition Frame aspect.
- A plot profile's margins inset the paper to form its drawable rectangle; that rectangle's aspect supplies the Composition Frame, so a margin change regenerates only when it changes the drawable aspect.
- Plot margins are four physical insets; the initial Harness UI edits them as one linked value, leaving asymmetric plotter-safe regions representable without changing the Preset model later.
- Composition Frames use fixed-area normalization: for aspect `r`, the Harness resolves `width = 1000√r` and `height = 1000/√r`, preserving one million square coordinate units across aspect changes; an Output Profile later supplies the uniform conversion from those unitless coordinates to millimeters or pixels.
- A **Page Frame** is downstream of generation: moving or resizing it never changes the **Composition Frame**, reruns the **Sketch**, or alters the generated **Scene**. Fixed-page scaling changes only the final uniform mapping of that frozen Scene.
- Studio enters Page Frame edit mode through the familiar user-facing **Crop** action; the mode is titled **Edit Page Frame** because the same controls can crop inward or enlarge the Page with padding.
- Entering Page Frame edit mode begins as the current page boundary; on first use that is an exact, visually inert full-**Composition Frame** frame, after which the user can resize and reposition it.
- A Page Frame may sit inside its Composition Frame to crop, cross it to combine cropping with padding, or contain it to add padding on any side.
- Ordinary, scale-preserving framing reduces or enlarges physical Page extent with Page Frame extent: a smaller frame removes the corresponding physical page area, while a larger frame adds geometry-free physical extent instead of rescaling generated artwork.
- Explicit fixed-page framing is the inverse operation: the exact physical Page width, height, and four insets remain locked while Page Frame width and height change proportionally, uniformly scaling the frozen Scene behind the stationary Page boundary without distortion.
- Fixed-page `100%` defines absolute Page Frame extents from a centered contain-fit of the full frozen Composition at the locked drawable Page aspect; an aspect mismatch therefore defines geometry-free padding on the expanded axis. The centered position is the Reset target, not a side effect of selecting `100%`: every scale derives extents inversely from this stable fit reference at the frame's current center rather than from the prior draft, so repeated changes do not compound drift.
- Fixed-page panning translates the same Page Frame and moves the stable center used by later scale changes. Returning a panned frame to `100%` retains that current center; Reset Frame is the only fixed-page action that installs the centered reference position, without changing Page dimensions or margins.
- Committing a Page Frame automatically locks the resulting page aspect, so editing either physical paper dimension updates the other and uniformly rescales output without changing the stored **Composition Frame** or regenerating its Scene; the user may explicitly unlock it later.
- Inside Page Frame edit mode, changing Page width, height, or aspect reframes around the frozen Composition without regeneration; outside that mode, an unlocked Paper-aspect edit retains its existing recompose meaning, warns that the Scene will change, and resets the Page Frame, while locked proportional Paper resizing changes magnitude only.
- Page framing applies only to the drawable composition; a plot **Output Profile**'s physical margins remain unchanged around the framed result, and removing that plotter clearance is a separate Paper edit.
- Studio exposes Page Frame position and extent as percentages of the original **Composition Frame**, synchronized with direct manipulation; pixels do not define vector framing geometry, and physical millimeters or inches remain **Output Profile** concerns.
- Page Frame edit mode's compact toolbar exposes percentage `X`, `Y`, `W`, and `H` (including negative origins and extents above `100%` for padding), editable physical Page width/height in the current unit, freeform/common/custom aspect controls with a persistent lock, and Apply/Cancel/Reset Frame. Fixed-page mode locks `W`, `H`, aspect, and physical Page fields while adding synchronized direct/numeric composition-scale control; pixels, resolution, rotation, grids, and automatic content detection remain outside this capability.
- Page Frame resizing is freeform by default; holding Shift while dragging temporarily preserves its current aspect, while choosing a named or custom aspect provides an explicit persistent constraint until the user returns to freeform.
- Dragging inside a Page Frame pans the composition behind its stationary boundary by updating the same Page Frame position inversely; it is an alternate direct manipulation, not a persisted composition transform.
- **Page Frame edit mode** is temporary Studio chrome. Ordinary scale-preserving editing reveals the whole source composition, dims discarded content, shows padded extent with the normal background precedence, and overlays move/resize controls. Fixed-page editing keeps the Page viewport stationary and clips or rerasterizes the frozen Scene behind it while exposing pan and scale controls. Leaving either operation restores the ordinary edge-to-edge framed preview shared by output.
- Final preview and output rebase the committed Page Frame's top-left to the drawable Page origin while leaving the underlying Scene coordinates untouched; Preset framing data reproduces that output-only translation exactly.
- Page framing is the cheap final operation after full-Composition generation and, when requested, Hidden-line derivation: interactive reframing reuses completed Scene, Shading artwork, and Outline results, clips paths exactly at the final Page boundary, and adds any requested plot frame around that final Page rather than the original Composition.
- Physical-tool Outline sources explicitly promise target-invariant Hidden-line geometry, so their immutable completed geometry may be reused across Page and profile changes. The current Tool width is applied as target-dependent artwork styling before Page clipping, and the optional Page outline uses that same current physical width. Legacy Scene outlines do not opt into that contract: their authored stroke widths remain part of strict cache identity and are preserved.
- One committed Page Frame governs Fill preview, Tone reference mode, Outline preview, ordinary PNG/SVG, and plotter SVG; only the ordinary scale-preserving Page Frame editing presentation reveals discarded composition outside it.
- The first Page Frame implementation covers the current Scene-backed Studio workflow and its exports; later video or Direct Renderer consumers may adopt the same persisted model when real consumers establish their output-surface requirements.
- A Page Frame survives params, Seed, Image Asset selection, time, and other content changes made against the same Composition Frame, plus locked proportional Paper resizing; an explicit recompose that changes the Composition Frame aspect resets it because its coordinate basis has changed.
- Canceling Page Frame edit mode restores the complete prior profile/frame state. Apply commits the profile, frame, and frozen generation basis atomically; Undo and Redo restore that same complete result. Ordinary Reset removes framing and restores the full Composition Frame at the represented physical scale, while fixed-page Reset retains the profile and commits its centered `100%` contain-fit; both resets avoid regeneration and are undoable.
- A Scene-authored background retains ADR-0009 precedence under Page Framing: it fills the whole output surface, including padded Page Frame extent; when absent, the caller's Page ground shows through, while a background intended to stop at the Composition Frame edge is bounded Primitive geometry instead.
- Scene geometry and Scene stroke widths scale through the output mapping; a plotter's physical **Tool width** remains fixed in millimeters and can drive a plot preview independently.
- A **Sketch** authors a fixed **Plot Sequence** rather than asking the artist to assemble arbitrary Stages in the Harness; its two or more ordered **Plot Stages** share the Sketch's authored inputs, Seed, time, Composition Frame, Page Frame, the Output Profile's physical page and margins, and exact digital coordinate mapping while allowing each Stage to project different plot geometry for its own tool and artistic purpose.
- A **Plot Stage** reuses a headless artwork generator that may also back an independent **Sketch**; a Sequence composes that generator rather than embedding one registered Sketch inside another.
- Photo Scribble's first **Plot Stage** and an independent Pencil Contour **Sketch** reuse the same headless **Pencil Contour** generator.
- One Photo Scribble **Preset** reproduces the complete **Plot Sequence**: it captures the shared image, Seed, Output Profile, Composition Frame, and Page Frame together with each Stage's own controls, Tool width, and Page-outline choice; the independent Pencil Contour Sketch keeps separate Presets rather than linking them into a Sequence.
- Studio may inspect a **Plot Sequence** as one isolated Stage or as a registered Combined overlay; an isolated view shows shared controls plus that Stage's controls, while Combined shows shared controls plus every Stage's separately identified controls so their relationship can be tuned in place. The view selection is temporary Studio state, defaults to the Primary Plot Stage on reload, and never creates another Stage or export artifact.
- A **Plot Sequence** guarantees digital registration only: reinserting a shifted, rotated, stretched, or water-warped physical sheet remains operator-owned, with a repeatable corner jig or equivalent setup assumed in the first version and no fiducial, camera-alignment, or distortion-compensation feature implied.
- The first **Plot Sequence** export downloads one explicitly selected Plot Stage as its own ordered, plotter-ready SVG; every Stage artifact has the same physical page extent and coordinate mapping, while Combined is preview-only.
- A single portable SVG containing the Sequence's Stages as artifact-internal layers remains a compatible future export, but is not required by the first version.
- A **Plot Sequence** describes and produces plotter assets only; manual artwork, drying, paper handling, and other operator actions between Stages are neither Sequence steps nor Studio instructions.
- Every **Plot Stage** receives the unchanged Sequence Seed when reproducing the Sketch's underlying generated geometry, so a Seed-dependent subject such as hills or a leaf field remains identical across Stages; a Stage may derive a namespaced sub-seed only for additional Stage-local effects that must not perturb that shared geometry.
- The Sketch contract exposes **Plot Sequence** as an optional generic capability; Photo Scribble is its only first-version consumer, while Seed-dependent geometry Sketches adopt it later when each has a concrete tonal Stage design.
- Ink Scribble is Photo Scribble's **Primary Plot Stage**, preserving its existing generated Scene, Preset reproduction, ordinary output, and default creative surface; Pencil Contour is a supporting Stage and Combined is an opt-in inspection view.
- The Harness treats each **Plot Stage** as opaque Sketch-authored Scene output and does not encode what it derives from; a Sketch may derive a Stage from source data, its Primary Scene, or private intermediate geometry without changing the generic Sequence contract.
- Photo Scribble initially derives **Pencil Contour** from the photograph's original luminance and alpha structure after its own gamma, contrast, and pivot shaping, using the same control vocabulary and transformation implementation as Ink Scribble but independent Stage-scoped values; a later authored source choice may add an ink-derived alternative while defaulting older Presets to this original behavior.
- The first **Pencil Contour** analyzes the entire contain-fitted photograph, treats alpha transitions as structural boundaries, and strictly excludes zero-alpha regions; an opaque image provides no semantic subject distinction, and subject detection, a second mask asset, and in-Studio segmentation remain outside version one.
- **Pencil Contour** never treats the contain-fitted source image's rectangular perimeter as image-derived structure; an intentional outer border reuses the Harness's existing optional final-Page outline after framing and clipping.
- Photo Scribble's first **Pencil Contour** receives the Sequence Seed through the generic Stage contract but uses no seeded variation: its geometry is determined by the image, Composition Frame, and independent gamma, contrast, pivot, Contour detail, and Contour smoothing controls, so re-seeding Ink Scribble does not invalidate the pencil asset.
- Each **Plot Stage** has an independent **Plot Tool** assignment and optional final-Page outline while the Sequence's physical paper dimensions and margins remain shared; version one authors only per-Stage Tool width and Page-outline inclusion, leaving named tool libraries, color selection, and authored-versus-Studio tool assignment for later additive work.
- **New seed** changes the one Sequence Seed consumed by every **Plot Stage**, while parameter **Randomize** is exposed per Stage and changes only that Stage's eligible unlocked numeric controls; version one has no whole-Sequence parameter randomization action.
- The Studio exposes the active plot Output Profile in a Paper section near the top of the inspector; it is collapsible and collapsed by default, with its active dimensions retained in the summary.
- A plotter-ready SVG maps artwork into the profile's physical paper and margins but emits only plot paths; paper edges, margin guides, and backgrounds are preview chrome rather than drawable geometry, while the Output Profile remains available as metadata.
- Every generated Scene uses the Composition Frame's exact normalized coordinate space; the Harness therefore knows layout before generation and does not need Sketch-authored fixed-space metadata or a throwaway Scene probe.
- Photographs, analytic gradients, and procedural shapes can each produce a **Tone Field**; a **Shading Strategy** consumes that field and produces a **Shading Result** without knowing its source, while the consuming **Sketch** styles and draws the result's polylines as **Primitives**.
- A **Sketch**, not the **Harness**, chooses which **Shading Strategies** it supports and exposes any authored selection; the Harness prepares and presents expensive shading artwork without owning that artistic choice.
- **Shading preparation** is shared Harness infrastructure, while strategy execution and controls remain typed core and Sketch concerns and **Shading diagnostics** preserve strategy-specific meaning at the presentation boundary.
- When a **Sketch** offers multiple **Shading Strategies**, the Studio shows only the selected strategy's controls while retaining inactive strategies' authored values for later restoration.
- **Randomize** preserves a selected strategy and every inactive strategy-specific value, changing only active numeric controls while honoring their ordinary **Locks**.
- Tone Calibration is the first shared comparison surface for selecting Scribble or Stippling against one fixed tonal target, while strategy-specific Sketches may remain intentionally specialized.
- Image analysis may derive a **Detail Field** from an image's original linear-luminance signal, independently of later Tone contrast or gamma adjustments, desired darkness, and any future directional edge signal.
- An image-derived **Detail Field** normalizes robustly within that image's fitted content after suppressing a fixed noise floor, so subtle photographs retain relative structure while nearly flat images do not amplify numerical or compression noise.
- Its initial multiscale analysis emphasizes fixed fine-to-medium spatial bands and excludes gradual low-frequency lighting changes; band radii remain internal until hands-on evidence justifies another authored control.
- Its initial image signal is linear luminance plus alpha-boundary structure; chromatic-only detail remains deferred behind the same field contracts.
- An alpha-bearing image's **Detail Field** ignores color hidden by zero alpha, treats alpha transitions as structural detail, and remains zero outside the fitted image extent.
- Procedural field producers evaluate arbitrary Composition Frame coordinates directly; raster producers own coordinate mapping and interpolation so **Shading Strategies** never depend on a source pixel grid or resolution.
- A **Shading Mask** constrains a **Shading Strategy** independently of desired tone: intermediate permission lets a strategy deliberately color outside the lines, while exact zero remains a hard prohibition.
- A **Shading Strategy** enforces zero permission at an explicit working resolution by subdividing candidate segments and validating finished paths; sources with exact boundary geometry may additionally request exact clipping without changing the sampler contract.
- A **Shading Strategy** maps relative **Tone Field** values to geometry through explicit Sketch parameters such as path density; paper size and physical **Tool width** never adjust that geometry automatically.
- **Tone reference mode** may expose the source for comparison, but the finished shading geometry remains part of the artwork and appears alongside every other visible contour in **Outline mode** and plotter export.
- A **Sketch** draws shading polylines as Hidden-line sources in painter's order; the existing **Hidden-line pass**, not the **Shading Strategy**, clips them behind nearer filled occluders alongside the Sketch's other visible contours.
- A **Scribble Strategy** minimizes pen lifts but may return multiple polylines so disconnected or exhausted regions can be shaded without crossing a zero-permission **Shading Mask**.
- A **Scribble Strategy** tracks the virtual coverage deposited by its paths and stops when remaining weighted tone error falls below an explicit tolerance; a maximum path budget is a deterministic safety cap, not the definition of completion.
- **Stop point** remains a Scribble-specific authored early-stop cap for deliberate unfinishedness; it is distinct from convergence and safety-budget exhaustion, and its partial geometry remains valid artwork.
- A **Scribble Strategy** weights remaining tone error linearly by **Shading Mask** permission for both steering and completion, so low-permission areas exert proportionally less demand while zero-permission areas exert none and remain impassable.
- A **Scribble Strategy** deposits additive virtual coverage with a compact smooth falloff around each segment; explicit Scene-space influence radius and per-pass strength control spacing and repetition without representing physical **Tool width**.
- Increasing **Path density** reduces the virtual coverage satisfied by each pass, producing more path length for the same **Tone Field** while preserving its relative light-dark relationships.
- A **Stippling Strategy** uses **Stipple density** to determine mark abundance, then uses **Distribution fidelity** to refine an initially tone-weighted blue-noise distribution toward lower local distribution error without changing micro-stroke length or permitting pathological clumps.
- Scribble and Stippling share no authored sliders: similarly directed controls retain independent values, ranges, defaults, diagnostics, and names rather than implying cross-strategy numerical equivalence.
- A **Stippling Strategy** preserves deterministic mark order but does not promise pen-travel optimization; downstream plotter software owns that optimization until the Harness gains a general export-stage solution.
- Decreasing **Scribble scale** produces finer paths and tighter field sampling, while increasing it produces broader, looser paths; low-level sampling and coverage ratios remain internal until hands-on iteration proves a need to expose them separately.
- When a **Detail Field** modulates local Scribble scale, the authored **Scribble scale** remains the fine-detail anchor and only smoother regions broaden; zero modulation preserves uniform-scale behavior exactly.
- Detail-driven local scale varies segment length, virtual-coverage radius, and mask-check spacing at coherent ratios, while the global residual lattice stays fixed at the authored fine-detail scale and safely oversamples broader regions.
- Detail-driven scale changes remain spatially continuous and never force a pen lift; candidate segments sample ahead at fine-safe intervals and shorten conservatively rather than crossing a region that requires finer geometry at a coarse scale.
- Local scale interpolates multiplicatively as `Scribble scale × broadening^(1 − detail)`: strongest detail stays at the authored anchor, smoothest content reaches the **Detail influence** broadening factor, and the initial maximum factor is `4×` pending browser tuning.
- **Detail sensitivity** applies an identity-centered power curve to normalized detail: center is exact identity, higher settings retain subtler structure as fine detail, lower settings reserve fine scale for stronger structure, and the initial reciprocal exponent range is `4` through `1/4` pending browser tuning.
- The **Scribble Strategy** accepts an optional **Scribble Scale Field** separately from its Tone Source; Photo Scribble derives the first one from its **Detail Field**, while an absent field or zero **Detail influence** preserves every existing consumer's uniform-scale output.
- Photo Scribble's **Detail reference mode** shows the sensitivity-adjusted **Detail Field** from paper through strongest detail, updates without Scribble generation, and is neither persisted nor exportable.
- Image-derived **Detail Field** analysis is cancellable background preparation keyed to the exact Image Asset and analysis definition; Detail reference mode shows an honest loading state rather than a stale field from another asset, while sensitivity remapping stays cheap after preparation.
- When **Detail influence** is enabled, failed Detail Field preparation retains only visibly stale prior artwork and disables export rather than silently substituting uniform scale; when influence is `0`, ordinary Photo Scribble generation does not depend on detail preparation.
- **Detail influence** defaults to `0` so schema reconciliation preserves existing Photo Scribble Presets exactly; an enabled bundled Preset demonstrates the capability instead of changing prior artwork by default.
- A **Scribble Strategy** selects starts and restarts through Seeded weighting among high-residual areas, so dark regions tend to appear early without forcing every Seed to begin at the same global maximum.
- A safety-budget-exhausted **Shading Result** remains valid, exportable creative geometry but Studio must identify it truthfully rather than calling it converged; generic path length and pen-lift counts are derived from its polylines, while strategy-specific diagnostics do not widen the shared result.
- **Shading diagnostics** share termination, progress and ETA, compute time, generated-path count, total path length, and pen lifts; Scribble adds residual error while Stippling adds distribution error, and the Studio labels each variant without inferring it from current controls.
- Plot dimensions and insets are canonical millimeters; the Paper UI accepts and displays both millimeters and inches by converting at its boundary, while the display-unit choice is a Studio local-storage preference rather than Preset or Sketch state.
- The first Output Profile implementation is plot-focused in Studio; Remotion derives the same fixed-area Composition Frame from its existing pixel width and height while retaining its current resolution/fps inputs, and a Studio Video profile/target switch waits until video authoring moves there.

## Core invariant: a Sketch is a pure function of (params, seed, time, composition frame)

A Sketch's output is deterministic in its params, seed, time, and **Composition Frame** — same inputs, same Scene, always. Changing the Composition Frame's aspect fully regenerates the Scene; changing only physical paper size, pixel resolution, or a downstream **Page Frame** does not. This single function has three callers:
- **Exploration** samples it at `t = wall-clock`, as fast as it can, to *feel* realtime while tuning.
- **Remotion** samples it at `t = frame / fps` for deterministic video.
- **Static / plotter export** freezes `t` and exports that frame's vector IR exactly.

There is no separate "realtime mode" vs "render mode" — one function, sampled at different `t`. Expensive, export-only work (hidden-line removal, path simplification, pen ordering) lives *outside* the exploration loop, which is only `generate → draw → painter's-order render`. True 60fps GPU output is explicitly the lowest priority, so the early system keeps a single vector representation rather than a parallel GPU-parametric one.

A stateless Sketch may optionally expose caller-owned **frame preparation** as an optimization of that same function. The returned sampler may retain immutable data derived from params, seed, and Composition Frame, but it remains pure in `t` and carries no accumulated frame state. `generate` stays the public random-access contract and is derived from the same preparation implementation; sequential Harness callers may retain one sampler only until params, seed, Composition Frame, or Sketch identity changes. This is not a second realtime mode and not a hidden Sketch cache. See ADR-0012.

### Time semantics

In `generate(params, seed, t, compositionFrame)`, **`t` is in seconds** uniformly across every mode; only *how the Harness drives `t`* varies, declared by optional time metadata (a duration, and whether it loops) alongside the **Parameter Schema**. No time metadata ⇒ static. A Sketch that wants normalized progress derives it itself as `t / duration` (e.g. circles computes its loop phase this way) — the contract never hands the Sketch a normalized `t`.

- **Static** — output is constant in `t`; the Harness hides the scrubber. Not a "paused" mode — `t` is simply unused.
- **Loop** — `t` wraps `0 → duration → 0` (seconds); periodic (use periodic noise for seamless loops). Any frame is a valid export.
- **One-shot / reveal** — `t` runs `0 → duration` once and clamps at `duration` (seconds); the drawing reveals over time. `t = duration` is the default complete state, but every scrubbed `t` is a valid frame: **Outline mode** processes that displayed partial geometry and plotter export uses the same selected result (this reveal/partial-frame behavior is deferred to #327; the first shading feature, #312, ships the complete `t = duration` frame only). For a plotter Sketch, `t` *is* pen-path progress — the time axis and the draw-over-time axis are one and the same. (A Sketch wanting `0 → 1` reveal progress computes `t / duration`.)

## Deliberately deferred

These are intentionally **not** pinned here — they are implementation specifics meant to emerge while executing the dev plan, not frozen in high-level planning:

- Further **Primitive** layering or domain/source metadata beyond its current SVG-path-style geometry, optional fill/stroke, and generic `hiddenLineRole`. The role controls only Hidden-line source/occluder participation; it is not a general tagging system.
- The exact shape of the **Scene** container beyond "coordinate space + draw-ordered Primitives."
- The concrete field format of the **Parameter Schema**'s remaining uninhabited specs (boolean and later members of the open `ParamSpec` union). The current members are frozen as `NumberParamSpec = { kind: 'number'; min; max; default; step?; integer? }`, `ColorParamSpec = { kind: 'color'; default }`, `ImageAssetParamSpec = { kind: 'image-asset'; default }`, and `ChoiceParamSpec = { kind: 'choice'; default; options: readonly { value; label }[] }`; any member may carry the narrow `activeWhen?: { key; equals }` applicability rule. The serialized **Preset** shape and read-reconciliation policy are pinned in the **Preset** glossary entry above.
- Any GPU / instance-model data structures (the realtime GPU path is deferred entirely).
- A general **cross-param constraint** model remains deferred for relationships such as `minRadius ≤ maxRadius` and sum-to-one groups. Strategy-dependent control visibility is the narrow established exception: inactive controls remain valid persisted values but are hidden from the active editing surface; broader validation and inter-param coherence stay owned by the Sketch.
- A global cross-strategy registry remains deferred until a second real Sketch repeats Tone Calibration's explicit strategy-dispatch wiring; this second strategy establishes runtime selection while recording that Scribble and Stippling share no authored sliders, without prematurely standardizing execution metadata or diagnostics.
- Collapsible Parameter groups remain a separate Studio-layout feature; strategy-dependent applicability lands independently so later grouping does not redefine parameter values, Presets, or Randomize behavior.
- Removing the Scribble-specific **Stop point** control remains separate follow-up work; adding Stippling neither reuses nor removes it.
- Raster photograph ingestion as a **Tone Field** producer. The first scribble Sketch uses a procedural tone test composition so the field and strategy contracts can be tuned independently of asset handling. The next source milestone adds managed import of arbitrary local images into a configured project asset root, assigns each **Image Asset** a stable logical ID captured by Presets, and resolves identical bytes across Studio, workers, and video before decoding and sampling them behind the existing Tone Field contract; it must not expose machine-local paths or change Shading Strategy consumers.
- The Node/Remotion **Image Asset** loader. Core's decoded-pixels record (ADR-0014) is the seam; a pure-JS decoder joins when video first consumes a photo-backed Sketch, honoring the glossary's cross-consumer resolution promise as direction rather than as the first photographic feature's obligation.
- Alternate raster-to-field interpretations beyond the default luminance-plus-alpha adapter: channel selection, independent mask assets, color-aware tone models, thresholding, inversion, edge-aware preprocessing, and fit/crop policy remain source-side concerns to refine with real photograph experiments; none may leak into **Shading Strategy** consumers. Tone contrast and Tone gamma graduated out of this deferral into the first photo Sketch's source controls — applied on the tone domain, exact-zero-preserving, composed inside the source adapter.

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
>
> **Sketch author:** “I like this exact square drawing, but can I tighten the Page around it without generating a different portrait composition?”
> **Domain expert:** “Yes. Move or resize its **Page Frame** to crop or pad the frozen **Composition Frame**; use Recompose only when you want the Sketch to respond to the Page's new aspect.”

## Flagged ambiguities

- "experiment" vs "sketch" — same concept. Resolved: **Sketch** is the canonical term everywhere (code, docs, UI); "experiment" is only an informal synonym. The project is named **Sketch Labs** (repo `tylerdurrett/sketch-labs`).
- Umbrella term for an IR geometry unit — was briefly "Mark", then "Shape" (rejected: not a real umbrella term in any reference library, and connotes closed geometry). Resolved: **Primitive** (Houdini lineage), "prim" as casual short form.
- "preset color swatch" collided with the existing full-session **Preset**. Resolved: **Palette swatch** is the canonical term for a color-choice shortcut.
- "shades-of-darkness-to-path" mixed the source, strategy, and Scene output. Resolved: a **Tone Field** is the shared source abstraction; shading strategies produce polyline geometry that a **Sketch** draws as **Primitives**.
- "shading region" implied ink was either allowed or forbidden. Resolved: a **Shading Mask** carries soft permission above zero and reserves exact zero for a hard prohibition.
- "crop" named only shrinking the output boundary even though the same mechanism can enlarge it with padding. Resolved: **Page Frame** is the persisted domain concept and **Crop** remains the familiar Studio action that enters Page Frame edit mode.
- "layer" conflated an ordered physical workflow with Primitive routing inside one SVG artifact. Resolved: **Plot Sequence** and **Plot Stage** name the physical workflow; layer remains available for artifact-internal routing.
- "Pencil Contour" could mean a dense pixel-edge rendering. Resolved: it means sparse structural linework for guiding later hand-applied media.
- Reusing Photo Scribble's tone controls could mean one linked value set or duplicated UI. Resolved: Pencil and Ink use the same tone vocabulary and math with independent persisted values, shown in separately identified Stage sections and both available in Combined view.

## Build strategy (decided)

Greenfield in `sketch-labs`. Lift the proven, renderer-agnostic pure libraries from the `plotter` repo (seeded random + simplex noise, vec/math, polyline geometry, clipping, SVG serialization, paper sizes) and its Vite preset plugin. Drop the `plotter` repo's `maps`/Python image-analysis pipeline entirely. Redesign the Sketch contract and the app shell rather than porting them.

Workspace layout (pnpm workspaces from day one, so Remotion is a first-class consumer): `packages/core` (headless engine + sketches), `packages/video` (Remotion compositions), `apps/studio` (React studio). The only package boundary that earns its keep now is headless-core vs studio; further splits wait for a real second consumer.

Task running stays plain `pnpm -r` — no turborepo/nx/other orchestrator. A handful of packages consumed as TypeScript source with a single test command does not earn a task graph or build cache; revisit only if build/test times demand it.
