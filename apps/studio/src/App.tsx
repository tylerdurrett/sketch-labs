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
 *
 * TWO-REGION SHELL (#154): the layout is a canvas region on the left plus a
 * fixed-width right inspector sidebar that houses every per-sketch control.
 * SketchControls owns the shared params/seed/locks state that BOTH regions read,
 * so it renders the whole two-region layout; App hands it the Sketch switcher as
 * a slot (`switcher`) rendered at the sidebar top. The switcher lives ABOVE the
 * keyed remount so selection state survives a Sketch switch.
 */
export function App() {
  const [selectedId, setSelectedId] = useState(defaultSketchId);
  const selected = registry.get(selectedId);

  // The Sketch switcher, owned by App (it drives `selectedId`) but handed to
  // SketchControls as a slot so it can render inside the inspector sidebar.
  const switcher = (
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
  );

  return (
    <main className="app">
      <header className="app__header">
        <h1 className="app__title">Harness Studio</h1>
        {/*
          Toolchain proof for the Tailwind v4 + shadcn (Base UI) foundation
          (ADR-0008): a dark-surface card styled purely with Tailwind utilities +
          the shadcn design tokens, holding a shadcn Button with a lucide-react
          icon. It exercises the whole new stack — Tailwind compile, token
          resolution, cva/cn, Base UI render, and the icon set — without touching
          any existing control/canvas behavior below. Parked in the shell header
          so the two-region layout below fills the remaining height.
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
      </header>
      <SketchControls key={selected.id} sketch={selected} switcher={switcher} />
    </main>
  );
}
