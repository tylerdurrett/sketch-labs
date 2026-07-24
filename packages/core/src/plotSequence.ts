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

const OPERATION = 'validatePlotSequenceDeclaration'

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
export function validatePlotSequenceDeclaration(
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
