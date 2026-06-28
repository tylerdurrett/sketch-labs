import { useState } from "react";

import { registry, type Params } from "@harness/core";

import { LiveCanvas } from "./LiveCanvas";
import "./App.css";

/** The Sketches the navigation lists, in registration order. */
const sketches = registry.list();

/**
 * A referentially-stable empty params object.
 *
 * Passed to {@link LiveCanvas} instead of an inline `{}` literal: a fresh literal
 * is a new identity every render, which would churn any LiveCanvas effect keyed
 * on `params` (issue #40). One module-level constant keeps that identity stable
 * across re-renders so only a genuine input change is observed.
 */
const EMPTY_PARAMS: Params = {};

/** The id selected on first load — the registry's first entry. */
function defaultSketchId(): string {
  const first = sketches[0];
  if (first === undefined) {
    throw new Error("Sketch registry is empty: nothing to render.");
  }
  return first.id;
}

/**
 * The studio shell.
 *
 * Navigation lists every registered Sketch by `name`; selecting one updates the
 * `selectedId` state and re-renders {@link LiveCanvas} with the registry-resolved
 * Sketch. Because LiveCanvas keys its animation loop on the `sketch` prop (an
 * effect dependency), the live canvas swaps to the selection WITHOUT a page
 * reload. The Sketch is no longer hardcoded to circles — it defaults to the
 * registry's first Sketch. `params` is the stable {@link EMPTY_PARAMS} constant
 * so the Sketch falls back to its schema defaults (controls/scrubber are #7).
 */
export function App() {
  const [selectedId, setSelectedId] = useState(defaultSketchId);
  const selected = registry.get(selectedId);

  return (
    <main className="app">
      <h1>Harness Studio</h1>
      <nav className="sketch-nav" aria-label="Sketches">
        {sketches.map((sketch) => (
          <button
            key={sketch.id}
            type="button"
            className="sketch-nav__item"
            aria-current={sketch.id === selectedId}
            onClick={() => setSelectedId(sketch.id)}
          >
            {sketch.name}
          </button>
        ))}
      </nav>
      <LiveCanvas
        sketch={selected}
        params={EMPTY_PARAMS}
        seed={`${selected.id}-demo`}
      />
    </main>
  );
}
