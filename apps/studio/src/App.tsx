import { circles } from "@harness/core";

import { LiveCanvas } from "./LiveCanvas";
import "./App.css";

/**
 * The studio shell.
 *
 * For this slice the circles Sketch is HARDCODED — the Sketch registry and
 * navigation are the next task (#35), and controls/scrubber are #7. The
 * {@link LiveCanvas} gets a large CSS box so the demo checkpoint reads as a large
 * live canvas; `params` is left empty so circles falls back to its schema
 * defaults.
 */
export function App() {
  return (
    <main className="app">
      <h1>Harness Studio</h1>
      <LiveCanvas sketch={circles} params={{}} seed="circles-demo" />
    </main>
  );
}
