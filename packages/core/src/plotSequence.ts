/**
 * The authored declaration for a Sketch's optional Plot Sequence.
 *
 * A Stage ID identifies one authored Stage instance. It is deliberately
 * separate from `generatorId`, which identifies reusable generation code and
 * may therefore repeat across multiple independently authored Stages.
 */

import type { SketchEnvironment } from './imageAssets'
import type { CoordinateSpace, Scene } from './scene'
import type { ParamSchema, Params, Seed } from './sketch'

/** Map one owning-Sketch schema key to its canonical Stage-runtime key. */
export interface PlotParameterBinding {
  /** The exact key owned by the Sketch's flat Parameter Schema. */
  readonly schemaKey: string
  /** The canonical key exposed in a Stage-local parameter record. */
  readonly key: string
}

/** Explicit generation inputs that participate in one Stage's identity. */
export interface PlotStageDependencies {
  readonly usesSeed: boolean
  readonly usesTime: boolean
}

/** Complete deterministic input supplied to a reusable Stage generator. */
export interface PlotStageGeneratorInput {
  readonly params: Readonly<Params>
  readonly seed: Seed
  readonly t: number
  readonly frame: Readonly<CoordinateSpace>
  readonly environment?: SketchEnvironment
}

/** Shared inputs that make independently prepared Stages registration-compatible. */
export interface PlotSequenceRegistrationIdentity {
  readonly params: Readonly<Params>
  readonly frame: Readonly<CoordinateSpace>
}

/**
 * Inputs that make one Stage's retained generated geometry current.
 *
 * Seed and time are present only when the Stage explicitly declares that they
 * affect its output. The generator invocation still receives both values.
 */
export interface PlotStagePreparationIdentity {
  readonly params: Readonly<Params>
  readonly frame: Readonly<CoordinateSpace>
  readonly seed?: Seed
  readonly t?: number
}

/** A reusable, headless Scene-producing capability with no Stage identity. */
export type PlotStageGenerator = (
  input: Readonly<PlotStageGeneratorInput>,
) => Scene

/**
 * How an authored Stage obtains its Scene.
 *
 * `kind` is the sole Primary marker. The Primary source remains the owning
 * Sketch's ordinary output, while a generator source carries the reusable
 * callback that produces its own Scene.
 */
export type PlotStageSource =
  | {
      readonly kind: 'primary'
      readonly generatorId: string
    }
  | {
      readonly kind: 'generator'
      readonly generatorId: string
      readonly generate: PlotStageGenerator
    }

/** One uniquely identified, named Stage instance in authored execution order. */
export interface PlotStageDeclaration {
  readonly id: string
  readonly name: string
  readonly source: PlotStageSource
  /** Stage-owned bindings, combined with the Sequence's shared bindings. */
  readonly parameters: readonly PlotParameterBinding[]
  readonly dependencies: PlotStageDependencies
}

/** A Sketch-authored physical execution sequence and its parameter ownership. */
export interface PlotSequenceDeclaration {
  /** Bindings projected into every Stage. */
  readonly sharedParameters: readonly PlotParameterBinding[]
  /** Authored physical execution order. Validation never sorts this array. */
  readonly stages: readonly PlotStageDeclaration[]
}

function findStage(
  declaration: PlotSequenceDeclaration,
  stageId: string,
  operation: string,
): PlotStageDeclaration {
  const stage = declaration.stages.find((candidate) => candidate.id === stageId)
  if (stage === undefined) {
    throw new Error(`${operation}: missing Stage \`${stageId}\``)
  }
  return stage
}

function projectBindings(
  schema: ParamSchema,
  bindings: readonly PlotParameterBinding[],
  params: Readonly<Params>,
  operation: string,
): Readonly<Params> {
  const projected: Params = {}

  for (const binding of bindings) {
    const spec = schema[binding.schemaKey]
    if (spec === undefined) {
      throw new Error(
        `${operation}: binding references unknown schema key \`${binding.schemaKey}\``,
      )
    }
    projected[binding.key] = Object.prototype.hasOwnProperty.call(
      params,
      binding.schemaKey,
    )
      ? params[binding.schemaKey]
      : spec.default
  }

  return Object.freeze(projected)
}

function projectStageParams(
  schema: ParamSchema,
  declaration: PlotSequenceDeclaration,
  stage: PlotStageDeclaration,
  params: Readonly<Params>,
  operation: string,
): Readonly<Params> {
  return projectBindings(
    schema,
    [...declaration.sharedParameters, ...stage.parameters],
    params,
    operation,
  )
}

/**
 * Project only the resolved shared values that register every Stage to the same
 * source and coordinate basis.
 *
 * The canonical parameter record and outer identity are fresh and frozen. The
 * exact caller-owned Composition Frame is retained rather than cloned.
 */
export function projectPlotSequenceRegistrationIdentity(
  schema: ParamSchema,
  declaration: PlotSequenceDeclaration,
  params: Readonly<Params>,
  frame: Readonly<CoordinateSpace>,
): Readonly<PlotSequenceRegistrationIdentity> {
  const operation = 'projectPlotSequenceRegistrationIdentity'
  return Object.freeze({
    params: projectBindings(
      schema,
      declaration.sharedParameters,
      params,
      operation,
    ),
    frame,
  })
}

/**
 * Project resolved shared and Stage-owned values into canonical runtime keys.
 *
 * Flat owning-Sketch aliases, unknown values, and sibling-owned values are not
 * exposed. Missing own values resolve through their Parameter Schema defaults.
 */
export function projectPlotStageParams(
  schema: ParamSchema,
  declaration: PlotSequenceDeclaration,
  stageId: string,
  params: Readonly<Params>,
): Readonly<Params> {
  const operation = 'projectPlotStageParams'
  const stage = findStage(declaration, stageId, operation)
  return projectStageParams(schema, declaration, stage, params, operation)
}

/**
 * Build the retained preparation identity for one uniquely addressed Stage.
 *
 * Seed and time participate only when declared by that Stage. The Composition
 * Frame always participates and is retained by exact reference.
 */
export function projectPlotStagePreparationIdentity(
  schema: ParamSchema,
  declaration: PlotSequenceDeclaration,
  stageId: string,
  params: Readonly<Params>,
  seed: Seed,
  t: number,
  frame: Readonly<CoordinateSpace>,
): Readonly<PlotStagePreparationIdentity> {
  const operation = 'projectPlotStagePreparationIdentity'
  const stage = findStage(declaration, stageId, operation)
  const identity: PlotStagePreparationIdentity = {
    params: projectStageParams(
      schema,
      declaration,
      stage,
      params,
      operation,
    ),
    frame,
    ...(stage.dependencies.usesSeed ? { seed } : {}),
    ...(stage.dependencies.usesTime ? { t } : {}),
  }
  return Object.freeze(identity)
}

/**
 * Build the complete deterministic input for a Stage generator.
 *
 * Dependency flags control retained identity only: every actual invocation gets
 * the unchanged Sequence Seed and time, exact frame, and identical environment.
 */
export function createPlotStageGeneratorInput(
  schema: ParamSchema,
  declaration: PlotSequenceDeclaration,
  stageId: string,
  params: Readonly<Params>,
  seed: Seed,
  t: number,
  frame: Readonly<CoordinateSpace>,
  environment?: SketchEnvironment,
): Readonly<PlotStageGeneratorInput> {
  const operation = 'createPlotStageGeneratorInput'
  const stage = findStage(declaration, stageId, operation)
  return Object.freeze({
    params: projectStageParams(
      schema,
      declaration,
      stage,
      params,
      operation,
    ),
    seed,
    t,
    frame,
    ...(environment === undefined ? {} : { environment }),
  })
}

/**
 * Invoke the declared generated source for one Stage instance.
 *
 * Addressing is by Stage instance ID, never reusable generator ID. Primary
 * remains the owning Sketch's ordinary output and therefore has no callback to
 * invoke through this seam.
 */
export function invokePlotStageGenerator(
  schema: ParamSchema,
  declaration: PlotSequenceDeclaration,
  stageId: string,
  params: Readonly<Params>,
  seed: Seed,
  t: number,
  frame: Readonly<CoordinateSpace>,
  environment?: SketchEnvironment,
): Scene {
  const operation = 'invokePlotStageGenerator'
  const stage = findStage(declaration, stageId, operation)
  if (stage.source.kind === 'primary') {
    throw new Error(
      `${operation}: Stage \`${stageId}\` is Primary and has no declared generator callback`,
    )
  }

  return stage.source.generate(
    Object.freeze({
      params: projectStageParams(
        schema,
        declaration,
        stage,
        params,
        operation,
      ),
      seed,
      t,
      frame,
      ...(environment === undefined ? {} : { environment }),
    }),
  )
}

const OPERATION = 'validatePlotSequence'

function fail(message: string): never {
  throw new Error(`${OPERATION}: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function requireNonWhitespaceString(
  value: unknown,
  description: string,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${description} must be a nonempty string`)
  }
  return value
}

function validateBinding(
  binding: unknown,
  location: string,
  schema: ParamSchema,
  ownedSchemaKeys: Set<string>,
  canonicalKeys: Set<string>,
): void {
  if (!isRecord(binding)) fail(`${location} must be an object`)

  const schemaKey = requireNonWhitespaceString(
    binding.schemaKey,
    `${location}.schemaKey`,
  )
  const key = requireNonWhitespaceString(binding.key, `${location}.key`)

  if (!Object.prototype.hasOwnProperty.call(schema, schemaKey)) {
    fail(`${location} references unknown schema key \`${schemaKey}\``)
  }
  if (ownedSchemaKeys.has(schemaKey)) {
    fail(`schema key \`${schemaKey}\` has more than one parameter owner`)
  }
  if (canonicalKeys.has(key)) {
    fail(`${location} collides on canonical key \`${key}\``)
  }

  ownedSchemaKeys.add(schemaKey)
  canonicalKeys.add(key)
}

function validateBindingArray(
  bindings: unknown,
  location: string,
  schema: ParamSchema,
  ownedSchemaKeys: Set<string>,
  canonicalKeys: Set<string>,
): void {
  if (!Array.isArray(bindings)) fail(`${location} must be an array`)
  for (const [index, binding] of bindings.entries()) {
    validateBinding(
      binding,
      `${location}[${index}]`,
      schema,
      ownedSchemaKeys,
      canonicalKeys,
    )
  }
}

/**
 * Validate a Plot Sequence declaration against its one owning Parameter Schema.
 *
 * Every schema key must have exactly one owner across shared and Stage-owned
 * bindings. Each Stage's projected record combines shared and local bindings,
 * so canonical keys must be unique within that combined projection; the same
 * Stage-local canonical key may still appear in two different Stages.
 *
 * Generator IDs and callbacks are intentionally not unique constraints:
 * reusable generators do not own Stage instance identity.
 *
 * @throws For malformed identities, sources, dependency declarations, parameter
 *   ownership/projection, or a Primary Stage count other than exactly one.
 */
export function validatePlotSequence(
  declaration: PlotSequenceDeclaration,
  schema: ParamSchema,
): void {
  if (!isRecord(declaration)) fail('declaration must be an object')
  if (!isRecord(schema) || Array.isArray(schema)) {
    fail('schema must be an object')
  }

  const ownedSchemaKeys = new Set<string>()
  const sharedCanonicalKeys = new Set<string>()
  validateBindingArray(
    declaration.sharedParameters,
    'sharedParameters',
    schema,
    ownedSchemaKeys,
    sharedCanonicalKeys,
  )

  if (!Array.isArray(declaration.stages)) fail('stages must be an array')

  const stageIds = new Set<string>()
  let primaryCount = 0

  for (const [index, candidate] of declaration.stages.entries()) {
    const location = `stages[${index}]`
    if (!isRecord(candidate)) fail(`${location} must be an object`)

    const id = requireNonWhitespaceString(candidate.id, `${location}.id`)
    if (stageIds.has(id)) fail(`duplicate Stage id \`${id}\``)
    stageIds.add(id)

    requireNonWhitespaceString(candidate.name, `${location}.name`)

    if (!isRecord(candidate.source)) fail(`${location}.source must be an object`)
    const source = candidate.source
    requireNonWhitespaceString(
      source.generatorId,
      `${location}.source.generatorId`,
    )
    if (source.kind === 'primary') {
      primaryCount += 1
    } else if (source.kind === 'generator') {
      if (typeof source.generate !== 'function') {
        fail(`${location}.source.generate must be callable`)
      }
    } else {
      fail(`${location}.source.kind must be \`primary\` or \`generator\``)
    }

    if (!isRecord(candidate.dependencies)) {
      fail(`${location}.dependencies must be an object`)
    }
    if (typeof candidate.dependencies.usesSeed !== 'boolean') {
      fail(`${location}.dependencies.usesSeed must be a boolean`)
    }
    if (typeof candidate.dependencies.usesTime !== 'boolean') {
      fail(`${location}.dependencies.usesTime must be a boolean`)
    }

    validateBindingArray(
      candidate.parameters,
      `${location}.parameters`,
      schema,
      ownedSchemaKeys,
      new Set(sharedCanonicalKeys),
    )
  }

  if (primaryCount !== 1) {
    fail(`expected exactly one Primary Stage, found ${primaryCount}`)
  }

  const missingSchemaKeys = Object.keys(schema).filter(
    (key) => !ownedSchemaKeys.has(key),
  )
  if (missingSchemaKeys.length > 0) {
    fail(
      `schema keys must each have exactly one parameter owner; missing ${missingSchemaKeys
        .map((key) => `\`${key}\``)
        .join(', ')}`,
    )
  }
}
