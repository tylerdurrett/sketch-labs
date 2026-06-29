import type { ParamSchema, Params, ParamSpec } from "@harness/core";

import { NumberControl } from "./NumberControl";

/**
 * Props for {@link ControlPanel}.
 *
 * Pure presentation over props: the panel holds NO state. The current `params`
 * and the `onChange` setter both come from the keyed wrapper above it (the
 * single owner of the param map), so a Sketch switch resets the controls by
 * remounting that wrapper — not by anything in here.
 */
export interface ControlPanelProps {
  /** The Sketch's Parameter Schema — one control is rendered per entry. */
  schema: ParamSchema;
  /** The current value of every param, keyed as in `schema`. */
  params: Params;
  /**
   * The set of locked param keys. Lock is Randomize-EXCLUSION only: a locked
   * control is excluded from a roll but stays fully hand-editable — this set
   * NEVER gates a control's input.
   */
  locks: ReadonlySet<string>;
  /** Update a single param by key. */
  onChange: (key: string, value: number) => void;
  /** Toggle a single param's lock membership. */
  onToggleLock: (key: string) => void;
}

/**
 * Render one control for a single schema entry, switching on `spec.kind`.
 *
 * `kind: 'number'` → a {@link NumberControl}. An UNKNOWN kind renders a LOUD,
 * visible fallback (never a silent skip) so an unsupported control surfaces in
 * the UI as a defect to fix rather than vanishing. As the open `ParamSpec`
 * union widens (boolean, color, enum, …) this switch grows a case per kind; the
 * `default` branch is the safety net for any kind not yet handled.
 */
function renderControl(
  key: string,
  spec: ParamSpec,
  value: unknown,
  locked: boolean,
  onChange: (key: string, value: number) => void,
  onToggleLock: (key: string) => void,
) {
  switch (spec.kind) {
    case "number":
      return (
        <NumberControl
          paramKey={key}
          spec={spec}
          value={typeof value === "number" ? value : spec.default}
          locked={locked}
          onChange={(next) => onChange(key, next)}
          onToggleLock={() => onToggleLock(key)}
        />
      );
    default:
      return (
        <div className="control control--unsupported" role="alert">
          unsupported control kind: {String((spec as ParamSpec).kind)} (param
          &ldquo;{key}&rdquo;)
        </div>
      );
  }
}

/**
 * The schema-driven control surface: one control per declared param, derived
 * ENTIRELY from the Sketch's {@link ParamSchema} — no bespoke per-Sketch UI.
 *
 * It iterates the schema entries in declaration order and delegates each to
 * {@link renderControl}, which switches on `spec.kind`. Every param therefore
 * gets a working control (or a loud fallback for an unsupported kind) with zero
 * per-Sketch code.
 */
export function ControlPanel({
  schema,
  params,
  locks,
  onChange,
  onToggleLock,
}: ControlPanelProps) {
  return (
    <div className="control-panel">
      {Object.entries(schema).map(([key, spec]) => (
        <div key={key} className="control-panel__row">
          {renderControl(
            key,
            spec,
            params[key],
            locks.has(key),
            onChange,
            onToggleLock,
          )}
        </div>
      ))}
    </div>
  );
}
