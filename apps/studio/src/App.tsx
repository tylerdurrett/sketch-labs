import { Sparkles } from "lucide-react";
import { useState } from "react";

import { registry } from "@harness/core";

import { SketchControls } from "./SketchControls";
import { Button } from "./components/ui/button";
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
 * `selectedId` state and re-renders {@link SketchControls} with the
 * registry-resolved Sketch. SketchControls is mounted with `key={selected.id}`,
 * so switching Sketch REMOUNTS it — its params reset to the new Sketch's
 * {@link defaultParams} (the key remount is the reset mechanism, not any manual
 * logic). SketchControls owns the live, schema-derived params and feeds them to
 * both the control panel and {@link LiveCanvas}, so tweaking a control updates
 * the live canvas in real time.
 */
export function App() {
  const [selectedId, setSelectedId] = useState(defaultSketchId);
  const selected = registry.get(selectedId);

  return (
    <main className="app">
      <h1>Harness Studio</h1>
      {/*
        Toolchain proof for the Tailwind v4 + shadcn (Base UI) foundation
        (ADR-0008): a dark-surface card styled purely with Tailwind utilities +
        the shadcn design tokens, holding a shadcn Button with a lucide-react
        icon. It exercises the whole new stack — Tailwind compile, token
        resolution, cva/cn, Base UI render, and the icon set — without touching
        any existing control/canvas behavior below.
      */}
      <div className="flex items-center justify-between gap-4 rounded-lg border bg-card p-4 text-card-foreground">
        <div className="flex items-center gap-2">
          <Sparkles className="text-muted-foreground" aria-hidden />
          <span className="text-sm text-muted-foreground">
            Tailwind v4 + shadcn (Base UI) foundation
          </span>
        </div>
        <Button type="button" size="sm">
          Styled with shadcn
        </Button>
      </div>
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
      <SketchControls key={selected.id} sketch={selected} />
    </main>
  );
}
