import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { registry } from "@harness/core";

import { SketchControls } from "./SketchControls";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import "./App.css";

/** The Sketches the navigation lists, in registration order. */
const sketches = registry.list();

/**
 * The id selected on first load — the registry's LAST entry, i.e. the most
 * recently added Sketch. New Sketches join the registry list at the end (see
 * `registry.ts`), so the newest one shows by default when the page loads.
 */
function defaultSketchId(): string {
  const latest = sketches[sketches.length - 1];
  if (latest === undefined) {
    throw new Error("Sketch registry is empty: nothing to render.");
  }
  return latest.id;
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
 *
 * COLLAPSE (#154): the inspector sidebar hides via a toggle (in the canvas
 * region, so it stays reachable while collapsed) and a keyboard shortcut
 * (`[`). Both the `collapsed` flag and the shortcut effect live HERE, above the
 * keyed SketchControls remount, so the collapsed state persists across Sketch
 * switches. Collapsing hands the canvas the full width; toggling restores the
 * sidebar.
 */
export function App() {
  const [selectedId, setSelectedId] = useState(defaultSketchId);
  const selected = registry.get(selectedId);

  const [collapsed, setCollapsed] = useState(false);
  const toggleCollapsed = useCallback(() => setCollapsed((prev) => !prev), []);

  // FOCUS RETENTION ACROSS THE SWITCH REMOUNT (#165). Picking a Sketch re-keys
  // SketchControls (`key={selected.id}` below), remounting the whole subtree —
  // including the switcher's DOM, which lives in the inspector INSIDE that keyed
  // instance — so the trigger loses keyboard focus even though `selectedId`
  // (owned here, above the remount) survives. The fix must live here, in the
  // stable parent: keep a ref to the trigger, and after the remount return focus
  // to it. `triggerRef` is threaded onto the SelectTrigger (Base UI's Trigger is
  // a forwardRef over its `<button>`, and our wrapper spreads `...props` — incl.
  // `ref` in React 19 — straight through). `restoreFocus` records that the
  // pending selectedId change came from the switcher, so we only refocus on a
  // real selection and never steal focus on first load.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  // Runs AFTER the keyed remount, BEFORE paint, so the refocus is invisible.
  // Gated on `restoreFocus`: false on mount (so first load never steals focus)
  // and only set true by the switcher's onValueChange.
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    triggerRef.current?.focus();
  }, [selectedId]);

  // The keyboard shortcut for the collapse toggle: `[` toggles the inspector.
  // Bound once on `window` (empty deps; the functional `setCollapsed` needs no
  // dependency), and ignored while typing in a form field or with a modifier
  // held so it never hijacks text entry or a browser/OS chord.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target !== null &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }
      if (event.key === "[") {
        event.preventDefault();
        setCollapsed((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // The Sketch switcher, owned by App (it drives `selectedId`) but handed to
  // SketchControls as a slot so it can render inside the inspector sidebar. It is
  // a shadcn Select (on Base UI): the registry-order items populate the popup,
  // the current Sketch shows in the trigger, and picking one drives
  // `setSelectedId` — which the App-level `key={selected.id}` turns into the
  // remount that resets that Sketch's params/seed/locks. The switcher lives
  // ABOVE that keyed remount, so its own selection survives a switch. A real
  // Select expresses the current choice through its value/aria-selected (not the
  // old button-row aria-current), and `aria-label="Sketches"` keeps the control
  // named.
  const switcher = (
    <Select
      value={selectedId}
      onValueChange={(value: string | null) => {
        if (value === null) return;
        // Record that this change came from the switcher so the post-remount
        // layout effect restores focus to the trigger (see `restoreFocus`).
        restoreFocus.current = true;
        setSelectedId(value);
      }}
      items={sketches.map((sketch) => ({
        value: sketch.id,
        label: sketch.name,
      }))}
    >
      <SelectTrigger ref={triggerRef} aria-label="Sketches">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {sketches.map((sketch) => (
          <SelectItem key={sketch.id} value={sketch.id}>
            {sketch.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <main className="app">
      <SketchControls
        key={selected.id}
        sketch={selected}
        switcher={switcher}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapsed}
      />
    </main>
  );
}
