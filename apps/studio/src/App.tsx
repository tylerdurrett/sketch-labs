import { useState } from "react";

import { registry } from "@harness/core";

import { LiveCanvas } from "./LiveCanvas";
import "./App.css";

/** The Sketches the navigation lists, in registration order. */
const sketches = registry.list();

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
 * Sketch. Because LiveCanvas keys its render loop on the `sketch` prop (an effect
 * dependency), the live canvas swaps to the selection WITHOUT a page reload. The
 * Sketch is no longer hardcoded to circles — it defaults to the registry's first
 * Sketch. `params` is left empty so the Sketch falls back to its schema defaults
 * (controls/scrubber are #7).
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
      <LiveCanvas sketch={selected} params={{}} seed={`${selected.id}-demo`} />
    </main>
  );
}
