# ADRs record system decisions; sketch-level decisions live with the sketch

ADRs in `docs/adr/` capture decisions about the **system** — the Harness, the Sketch contract, the renderers, the determinism spine, the tracker/workflow process. A decision that is local to a single **Sketch** (how one sketch opens its negative space, what a particular generator's knobs mean, why a mechanism was picked over another) does **not** get an ADR; its rationale lives in that sketch's own module header comments, colocated with the code it explains.

Sketches are creative artifacts that get reworked and discarded — an implied-sphere mechanism chosen this week can be superseded the next (see the leaf-field's move from a density mask to a painter's-order occluder). Routing that churn through the ADR log would bury the durable system decisions the log exists to preserve, and would separate the rationale from the code a reader is actually looking at. The canonical example of where sketch-level rationale belongs is the heavy explanatory header on `packages/core/src/sketches/leaf-field/*.ts`.

The ADR test still applies (hard to reverse · surprising without context · a real trade-off); this ADR just scopes *which* surface a passing decision lands on — `docs/adr/` for the system, the sketch's module header for the sketch.
