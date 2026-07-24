import {
  validateParamSchema,
  validatePlotSequence,
  type ParamSchema,
  type ParamSpec,
  type PlotParameterBinding,
  type PlotSequenceDeclaration,
  type PlotStageDeclaration,
} from "@harness/core";

/** One owning-Sketch ParamSpec paired with its authored schema key. */
export type PlotSchemaEntry = readonly [schemaKey: string, spec: ParamSpec];

/**
 * An ordered Parameter Schema view projected from Plot Sequence bindings.
 *
 * Schema keys remain the owning Sketch's flat keys for Studio controls. The
 * parallel canonical keys are the names used by the Stage-local runtime.
 */
export interface PlotParameterProjection {
  readonly bindings: readonly PlotParameterBinding[];
  readonly schemaKeys: readonly string[];
  readonly canonicalKeys: readonly string[];
  /** The unambiguous iteration path for ordered Studio consumers. */
  readonly schemaEntries: readonly PlotSchemaEntry[];
  readonly schema: Readonly<ParamSchema>;
}

/** All Studio-facing parameter views for one uniquely addressed Stage. */
export interface PlotStageProjection {
  readonly stage: PlotStageDeclaration;
  readonly shared: PlotParameterProjection;
  readonly owned: PlotParameterProjection;
  readonly combined: PlotParameterProjection;
}

const OPERATION = "plotSequenceProjection";

function fail(message: string): never {
  throw new Error(`${OPERATION}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function projectionBindings(
  candidate: unknown,
  location: string,
): readonly PlotParameterBinding[] {
  if (!Array.isArray(candidate)) {
    fail(`${location} must be an array`);
  }

  const bindings = candidate.map((value, index) => {
    const bindingLocation = `${location}[${index}]`;
    if (!isRecord(value)) {
      fail(`${bindingLocation} must be an object`);
    }
    if (
      typeof value.schemaKey !== "string" ||
      value.schemaKey.trim().length === 0
    ) {
      fail(`${bindingLocation}.schemaKey must be a nonempty string`);
    }
    if (typeof value.key !== "string" || value.key.trim().length === 0) {
      fail(`${bindingLocation}.key must be a nonempty string`);
    }
    return value as unknown as PlotParameterBinding;
  });

  return Object.freeze(bindings);
}

function declaredStages(
  declaration: PlotSequenceDeclaration,
): readonly PlotStageDeclaration[] {
  if (!isRecord(declaration) || !Array.isArray(declaration.stages)) {
    fail("declaration.stages must be an array");
  }

  const stageIds = new Set<string>();
  const stages = declaration.stages.map((candidate, index) => {
    if (!isRecord(candidate)) {
      fail(`stages[${index}] must be an object`);
    }
    if (
      typeof candidate.id !== "string" ||
      candidate.id.trim().length === 0
    ) {
      fail(`stages[${index}].id must be a nonempty string`);
    }
    if (stageIds.has(candidate.id)) {
      fail(`duplicate Stage id \`${candidate.id}\``);
    }
    stageIds.add(candidate.id);
    return candidate as unknown as PlotStageDeclaration;
  });

  return Object.freeze(stages);
}

function uniqueStage(
  declaration: PlotSequenceDeclaration,
  stageId: string,
): PlotStageDeclaration {
  if (typeof stageId !== "string" || stageId.trim().length === 0) {
    fail("Stage id must be a nonempty string");
  }

  const stage = declaredStages(declaration).find(
    (candidate) => candidate.id === stageId,
  );
  if (stage === undefined) {
    fail(`missing Stage \`${stageId}\``);
  }
  return stage;
}

function uniqueKeys(
  bindings: readonly PlotParameterBinding[],
  field: "schemaKey" | "key",
): readonly string[] {
  const description = field === "schemaKey" ? "schema" : "canonical";
  const keys: string[] = [];
  const seen = new Set<string>();

  for (const binding of bindings) {
    const key = binding[field];
    if (seen.has(key)) {
      fail(`duplicate ${description} key \`${key}\` in projection`);
    }
    seen.add(key);
    keys.push(key);
  }

  return Object.freeze(keys);
}

/**
 * Resolve the declaration's sole Primary Stage.
 *
 * Stage instance identity is authoritative. Repeated generator IDs are valid
 * and never participate in this lookup.
 */
export function primaryPlotStage(
  declaration: PlotSequenceDeclaration,
): PlotStageDeclaration {
  const primary: PlotStageDeclaration[] = [];
  for (const [index, candidate] of declaredStages(declaration).entries()) {
    if (!isRecord(candidate.source)) {
      fail(`stages[${index}].source must be an object`);
    }
    if (
      candidate.source.kind !== "primary" &&
      candidate.source.kind !== "generator"
    ) {
      fail(
        `stages[${index}].source.kind must be \`primary\` or \`generator\``,
      );
    }
    if (candidate.source.kind === "primary") {
      primary.push(candidate as unknown as PlotStageDeclaration);
    }
  }

  if (primary.length !== 1) {
    fail(`expected exactly one Primary Stage; received ${primary.length}`);
  }
  return primary[0]!;
}

/** Return the Sequence's shared bindings in exact authored order. */
export function sharedPlotStageBindings(
  declaration: PlotSequenceDeclaration,
): readonly PlotParameterBinding[] {
  if (!isRecord(declaration)) {
    fail("declaration must be an object");
  }
  return projectionBindings(
    declaration.sharedParameters,
    "sharedParameters",
  );
}

/** Return one Stage's owned bindings in exact authored order. */
export function ownedPlotStageBindings(
  declaration: PlotSequenceDeclaration,
  stageId: string,
): readonly PlotParameterBinding[] {
  const stage = uniqueStage(declaration, stageId);
  return projectionBindings(stage.parameters, `Stage \`${stageId}\`.parameters`);
}

/**
 * Return shared bindings followed by one Stage's owned bindings.
 *
 * Shared bindings appear exactly once. Neither source array nor schema-object
 * order is used to infer or sort the result.
 */
export function plotStageBindings(
  declaration: PlotSequenceDeclaration,
  stageId: string,
): readonly PlotParameterBinding[] {
  const bindings = Object.freeze([
    ...sharedPlotStageBindings(declaration),
    ...ownedPlotStageBindings(declaration, stageId),
  ]);
  uniqueKeys(bindings, "schemaKey");
  uniqueKeys(bindings, "key");
  return bindings;
}

/** Project owning-Sketch schema keys in exact binding order. */
export function plotSchemaKeys(
  bindings: readonly PlotParameterBinding[],
): readonly string[] {
  return uniqueKeys(projectionBindings(bindings, "bindings"), "schemaKey");
}

/** Project Stage-runtime canonical keys in exact binding order. */
export function plotCanonicalKeys(
  bindings: readonly PlotParameterBinding[],
): readonly string[] {
  return uniqueKeys(projectionBindings(bindings, "bindings"), "key");
}

/**
 * Project an ordered Studio schema view from owning-Sketch binding aliases.
 *
 * Values remain the exact ParamSpec declarations from the owning schema.
 */
export function plotSchemaView(
  schema: ParamSchema,
  bindings: readonly PlotParameterBinding[],
): Readonly<ParamSchema> {
  const entries = plotSchemaEntries(schema, bindings);
  const keys = entries.map(([key]) => key);
  const view: ParamSchema = {};

  for (const [key, spec] of entries) {
    Object.defineProperty(view, key, {
      value: spec,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }

  Object.freeze(view);
  return new Proxy(view, {
    // Ordinary objects reorder array-index keys numerically. Bindings, not
    // ECMAScript property buckets, are the Studio ordering authority.
    ownKeys: () => [...keys],
  });
}

/**
 * Project exact ParamSpec entries in authored binding order.
 *
 * Ordered consumers should prefer these entries to reconstructing order from a
 * schema object's property buckets.
 */
export function plotSchemaEntries(
  schema: ParamSchema,
  bindings: readonly PlotParameterBinding[],
): readonly PlotSchemaEntry[] {
  validateParamSchema(schema);
  const keys = plotSchemaKeys(bindings);
  const entries = keys.map((key): PlotSchemaEntry => {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      fail(`binding references unknown schema key \`${key}\``);
    }
    const spec = schema[key];
    if (spec === undefined) {
      fail(`binding references unknown schema key \`${key}\``);
    }
    return Object.freeze([key, spec] as const);
  });
  return Object.freeze(entries);
}

function parameterProjection(
  schema: ParamSchema,
  bindings: readonly PlotParameterBinding[],
): PlotParameterProjection {
  return Object.freeze({
    bindings,
    schemaKeys: plotSchemaKeys(bindings),
    canonicalKeys: plotCanonicalKeys(bindings),
    schemaEntries: plotSchemaEntries(schema, bindings),
    schema: plotSchemaView(schema, bindings),
  });
}

/**
 * Resolve all ordered parameter views for one Stage instance.
 *
 * Full Sequence validation keeps malformed ownership and projection aliases
 * from reaching Studio controls.
 */
export function plotStageProjection(
  schema: ParamSchema,
  declaration: PlotSequenceDeclaration,
  stageId: string,
): PlotStageProjection {
  validatePlotSequence(declaration, schema);
  const stage = uniqueStage(declaration, stageId);
  const sharedBindings = sharedPlotStageBindings(declaration);
  const ownedBindings = ownedPlotStageBindings(declaration, stageId);
  const combinedBindings = Object.freeze([
    ...sharedBindings,
    ...ownedBindings,
  ]);

  return Object.freeze({
    stage,
    shared: parameterProjection(schema, sharedBindings),
    owned: parameterProjection(schema, ownedBindings),
    combined: parameterProjection(schema, combinedBindings),
  });
}

/**
 * Resolve the complete Stage control schema, or the full schema for a Sketch
 * that does not declare a Plot Sequence.
 */
export function plotStageSchemaView(
  schema: ParamSchema,
  declaration: PlotSequenceDeclaration | undefined,
  stageId?: string,
): Readonly<ParamSchema> {
  if (declaration === undefined) {
    if (stageId !== undefined) {
      fail("a Stage id requires a Plot Sequence declaration");
    }
    validateParamSchema(schema);
    return schema;
  }
  if (stageId === undefined) {
    fail("a Plot Sequence declaration requires a Stage id");
  }
  return plotStageProjection(schema, declaration, stageId).combined.schema;
}
