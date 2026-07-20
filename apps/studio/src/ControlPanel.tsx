import {
  isParamActive,
  validateChoiceParamValue,
  validateParamSchema,
  type ParamSchema,
  type Params,
  type ParamSpec,
} from "@harness/core";

import { ChoiceControl } from "./ChoiceControl";
import { ColorControl } from "./ColorControl";
import type { EditTransactionLifecycle } from "./editHistory";
import {
  ImageAssetControl,
  type ImageAssetControlDimensions,
  type ImageAssetControlRecomposeRequest,
  type ImageAssetControlResolution,
} from "./ImageAssetControl";
import { NumberControl } from "./NumberControl";
import { STUDIO_IMAGE_ASSET_LONG_EDGE_CAP } from "./studioConfig";

/**
 * Props for {@link ControlPanel}.
 *
 * Pure presentation over props: the panel holds NO state. The current `params`
 * and the `onChange` setter both come from the keyed wrapper above it (the
 * single owner of the param map), so a Sketch switch resets the controls by
 * remounting that wrapper — not by anything in here.
 */
export interface ControlPanelProps {
  /** The Sketch's Parameter Schema — one control is rendered per active entry. */
  schema: ParamSchema;
  /** The current value of every param, keyed as in `schema`. */
  params: Params;
  /**
   * The generic set of locked param keys. Numeric controls expose Lock as a
   * Randomize-exclusion affordance; persisted color keys may remain in this set
   * but are inert and render no Lock. This set NEVER gates a control's input.
   */
  locks: ReadonlySet<string>;
  /**
   * Update a single param by key when no transaction lifecycle is supplied.
   * The value type widens with the `ParamSpec`
   * union: `number` from a NumberControl, a hex color `string` from a
   * ColorControl, an Image Asset ID from ImageAssetControl, or a stable Choice
   * value from ChoiceControl. The owner's params state is already
   * `Record<string, unknown>`,
   * so this widening is purely at the handler seam.
   */
  onChange: (key: string, value: number | string) => void;
  /** Shared transaction lifecycle, adapted to each schema key automatically. */
  editHistory?: EditTransactionLifecycle<Params> | undefined;
  /** Optional key-aware begin seam for params with cheaper preview ownership. */
  onParamEditBegin?: ((key: string) => void) | undefined;
  /** Toggle a numeric param's lock membership. */
  onToggleLock: (key: string) => void;
  /** Longest normalized source edge for Image Asset imports. */
  imageAssetLongEdgeCap?: number;
  /** Exact-resolution lifecycle shared by schema-declared Image Assets. */
  imageAssetResolution?: ImageAssetControlResolution;
  /** Look up decoded dimensions for one exact selected Image Asset ID. */
  getImageAssetDimensions?: (
    imageAssetId: string,
  ) => ImageAssetControlDimensions | undefined;
  /** Route a row-scoped request to recompose to its selected image aspect. */
  onRecomposeToImageAspect?: (
    request: ImageAssetControlRecomposeRequest,
  ) => void;
}

/**
 * Render one control for a single schema entry, switching on `spec.kind`.
 *
 * `kind: 'number'` → a lock-aware {@link NumberControl}; `kind: 'color'` → a
 * lock-free {@link ColorControl}; `kind: 'image-asset'` → a lock-free,
 * reusable picker/import {@link ImageAssetControl}; `kind: 'choice'` → a
 * lock-free {@link ChoiceControl}. An UNKNOWN kind renders a LOUD, visible
 * fallback (never a silent skip) so an unsupported control surfaces in the UI
 * as a defect to fix rather than vanishing. As the open `ParamSpec` union widens
 * further (boolean, enum, …) this switch grows a case per kind; the `default`
 * branch is the safety net for any kind not yet handled.
 */
function renderControl(
  key: string,
  spec: ParamSpec,
  value: unknown,
  locked: boolean,
  params: Params,
  onChange: (key: string, value: number | string) => void,
  onToggleLock: (key: string) => void,
  imageAssetLongEdgeCap: number,
  imageAssetResolution?: ImageAssetControlResolution,
  getImageAssetDimensions?: (
    imageAssetId: string,
  ) => ImageAssetControlDimensions | undefined,
  onRecomposeToImageAspect?: (
    request: ImageAssetControlRecomposeRequest,
  ) => void,
  editHistory?: EditTransactionLifecycle<Params>,
  onParamEditBegin?: (key: string) => void,
) {
  const rowHistory = editHistory
    ? {
        onBegin: () =>
          onParamEditBegin === undefined
            ? editHistory.onBegin()
            : onParamEditBegin(key),
        onPreview: (next: number | string) =>
          editHistory.onPreview({ ...params, [key]: next }),
        onCommit: editHistory.onCommit,
        onCancel: editHistory.onCancel,
      }
    : undefined;

  switch (spec.kind) {
    case "number":
      return (
        <NumberControl
          key={key}
          paramKey={key}
          spec={spec}
          value={typeof value === "number" ? value : spec.default}
          locked={locked}
          onChange={(next) => onChange(key, next)}
          editHistory={rowHistory}
          onToggleLock={() => onToggleLock(key)}
        />
      );
    case "color":
      return (
        <ColorControl
          key={key}
          paramKey={key}
          spec={spec}
          value={typeof value === "string" ? value : spec.default}
          onChange={(next) => onChange(key, next)}
          editHistory={rowHistory}
        />
      );
    case "image-asset": {
      const imageAssetId =
        typeof value === "string" ? value : spec.default;
      return (
        <ImageAssetControl
          key={key}
          paramKey={key}
          value={imageAssetId}
          onChange={(next) => onChange(key, next)}
          imageAssetLongEdgeCap={imageAssetLongEdgeCap}
          resolution={imageAssetResolution}
          imageDimensions={getImageAssetDimensions?.(imageAssetId)}
          onRecomposeToImageAspect={onRecomposeToImageAspect}
        />
      );
    }
    case "choice":
      return (
        <ChoiceControl
          key={key}
          paramKey={key}
          spec={spec}
          value={value as string}
          onChange={(next) => onChange(key, next)}
          editHistory={rowHistory}
        />
      );
    default:
      return (
        <div
          key={key}
          role="alert"
          className="rounded-md border-2 border-destructive bg-destructive/10 px-3 py-2 text-sm font-semibold text-destructive"
        >
          unsupported control kind: {String((spec as ParamSpec).kind)} (param
          &ldquo;{key}&rdquo;)
        </div>
      );
  }
}

/**
 * The schema-driven control surface: one control per active declared param,
 * derived ENTIRELY from the Sketch's {@link ParamSchema} and complete current
 * Params — no bespoke per-Sketch UI.
 *
 * It iterates the schema entries in declaration order and delegates each to
 * {@link renderControl}, which switches on `spec.kind`. Applicability affects
 * presentation only: an inactive row is omitted without changing its value,
 * default, or Lock state, so it reappears with prior tuning when its controller
 * switches back. Every active param therefore gets a working control (or a loud
 * fallback for an unsupported kind) with zero per-Sketch code.
 */
export function ControlPanel({
  schema,
  params,
  locks,
  onChange,
  editHistory,
  onToggleLock,
  imageAssetLongEdgeCap = STUDIO_IMAGE_ASSET_LONG_EDGE_CAP,
  imageAssetResolution,
  getImageAssetDimensions,
  onRecomposeToImageAspect,
  onParamEditBegin,
}: ControlPanelProps) {
  validateParamSchema(schema);
  const choiceValues = new Map<string, string>();
  for (const [key, spec] of Object.entries(schema)) {
    if (spec.kind !== "choice") continue;
    choiceValues.set(
      key,
      Object.prototype.hasOwnProperty.call(params, key)
        ? validateChoiceParamValue(spec, params[key], key)
        : spec.default,
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {Object.entries(schema).map(([key, spec]) => {
        if (!isParamActive(schema, params, key)) return null;
        return renderControl(
          key,
          spec,
          spec.kind === "choice" ? choiceValues.get(key) : params[key],
          locks.has(key),
          params,
          onChange,
          onToggleLock,
          imageAssetLongEdgeCap,
          imageAssetResolution,
          getImageAssetDimensions,
          onRecomposeToImageAspect,
          editHistory,
          onParamEditBegin,
        );
      })}
    </div>
  );
}
