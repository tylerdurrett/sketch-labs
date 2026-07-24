import { describe, expect, it, vi } from 'vitest'

import type { SketchEnvironment } from '../imageAssets'
import {
  createPlotStageGeneratorInput,
  invokePlotStageGenerator,
  projectPlotSequenceRegistrationIdentity,
  projectPlotStageParams,
  projectPlotStagePreparationIdentity,
  type PlotSequenceDeclaration,
  type PlotStageGenerator,
  type PlotStageGeneratorInput,
} from '../plotSequence'
import type { CoordinateSpace, Scene } from '../scene'
import type { Params, ParamSchema } from '../sketch'

const schema: ParamSchema = {
  image: { kind: 'image-asset', default: 'default-image' },
  commonTone: { kind: 'number', min: 0, max: 1, default: 0.4 },
  firstDetail: { kind: 'number', min: 0, max: 1, default: 0.5 },
  secondDetail: { kind: 'number', min: 0, max: 1, default: 0.7 },
  inkDensity: { kind: 'number', min: 0, max: 1, default: 0.8 },
}

const frame: CoordinateSpace = { width: 1200, height: 800 }

function sceneFor(input: Readonly<PlotStageGeneratorInput>): Scene {
  return { space: input.frame, primitives: [] }
}

function makeDeclaration(
  generate: PlotStageGenerator = sceneFor,
): PlotSequenceDeclaration {
  return {
    sharedParameters: [
      { schemaKey: 'image', key: 'source' },
      { schemaKey: 'commonTone', key: 'tone' },
    ],
    stages: [
      {
        id: 'first-pass',
        name: 'First Pass',
        source: {
          kind: 'generator',
          generatorId: 'reusable-generator',
          generate,
        },
        parameters: [{ schemaKey: 'firstDetail', key: 'detail' }],
        dependencies: { usesSeed: false, usesTime: false },
      },
      {
        id: 'second-pass',
        name: 'Second Pass',
        source: {
          kind: 'generator',
          generatorId: 'reusable-generator',
          generate,
        },
        parameters: [{ schemaKey: 'secondDetail', key: 'detail' }],
        dependencies: { usesSeed: true, usesTime: true },
      },
      {
        id: 'primary',
        name: 'Primary',
        source: { kind: 'primary', generatorId: 'owning-sketch' },
        parameters: [{ schemaKey: 'inkDensity', key: 'density' }],
        dependencies: { usesSeed: true, usesTime: false },
      },
    ],
  }
}

describe('Plot Sequence parameter projection', () => {
  it('resolves defaults into fresh read-only canonical shared and owned records', () => {
    const declaration = makeDeclaration()
    const params: Params = {
      image: 'chosen-image',
      firstDetail: 0.2,
      secondDetail: 0.9,
      inkDensity: 0.3,
      unknown: 'do not leak',
      source: 'flat alias does not win',
      detail: 'flat alias does not win',
    }
    const original = { ...params }

    const first = projectPlotStageParams(
      schema,
      declaration,
      'first-pass',
      params,
    )
    const again = projectPlotStageParams(
      schema,
      declaration,
      'first-pass',
      params,
    )

    expect(first).toEqual({
      source: 'chosen-image',
      tone: 0.4,
      detail: 0.2,
    })
    expect(Object.keys(first)).toEqual(['source', 'tone', 'detail'])
    expect(first).not.toBe(again)
    expect(Object.isFrozen(first)).toBe(true)
    expect(() => {
      ;(first as Params).detail = 1
    }).toThrow()
    expect(params).toEqual(original)
  })

  it('does not leak sibling-owned values and resolves every missing value independently', () => {
    const declaration = makeDeclaration()

    expect(
      projectPlotStageParams(schema, declaration, 'first-pass', {}),
    ).toEqual({
      source: 'default-image',
      tone: 0.4,
      detail: 0.5,
    })
    expect(
      projectPlotStageParams(schema, declaration, 'second-pass', {
        firstDetail: 0.1,
      }),
    ).toEqual({
      source: 'default-image',
      tone: 0.4,
      detail: 0.7,
    })
  })

  it('projects __proto__ as a frozen own data property without replacing the record prototype', () => {
    const protoSchema: ParamSchema = {
      dangerous: {
        kind: 'image-asset',
        default: 'default-value',
      },
    }
    const protoDeclaration: PlotSequenceDeclaration = {
      sharedParameters: [
        { schemaKey: 'dangerous', key: '__proto__' },
      ],
      stages: [
        {
          id: 'primary',
          name: 'Primary',
          source: { kind: 'primary', generatorId: 'owning-sketch' },
          parameters: [],
          dependencies: { usesSeed: false, usesTime: false },
        },
      ],
    }
    const objectValue = { shouldNotBecomePrototype: true }

    const projected = projectPlotStageParams(
      protoSchema,
      protoDeclaration,
      'primary',
      { dangerous: objectValue },
    )
    const projectedDefault = projectPlotStageParams(
      protoSchema,
      protoDeclaration,
      'primary',
      {},
    )

    expect(Object.getPrototypeOf(projected)).toBe(Object.prototype)
    expect(
      Object.prototype.hasOwnProperty.call(projected, '__proto__'),
    ).toBe(true)
    expect(Object.keys(projected)).toEqual(['__proto__'])
    expect(projected['__proto__']).toBe(objectValue)
    expect(projectedDefault['__proto__']).toBe('default-value')
    expect(Object.isFrozen(projected)).toBe(true)
  })

  it('rejects inherited schema keys and never reads inherited parameter values', () => {
    const inheritedSchema = Object.create({
      inherited: {
        kind: 'image-asset',
        default: 'inherited-default',
      },
    }) as ParamSchema
    const inheritedDeclaration: PlotSequenceDeclaration = {
      sharedParameters: [
        { schemaKey: 'inherited', key: 'source' },
      ],
      stages: [
        {
          id: 'primary',
          name: 'Primary',
          source: { kind: 'primary', generatorId: 'owning-sketch' },
          parameters: [],
          dependencies: { usesSeed: false, usesTime: false },
        },
      ],
    }

    expect(() =>
      projectPlotStageParams(
        inheritedSchema,
        inheritedDeclaration,
        'primary',
        {},
      ),
    ).toThrow(
      'projectPlotStageParams: binding references unknown schema key `inherited`',
    )

    const inheritedParams = Object.create({
      image: 'prototype-image',
      commonTone: 1,
      firstDetail: 1,
    }) as Params
    expect(
      projectPlotStageParams(
        schema,
        makeDeclaration(),
        'first-pass',
        inheritedParams,
      ),
    ).toEqual({
      source: 'default-image',
      tone: 0.4,
      detail: 0.5,
    })
  })

  it('rejects a missing Stage by instance ID', () => {
    expect(() =>
      projectPlotStageParams(schema, makeDeclaration(), 'reusable-generator', {}),
    ).toThrow(
      'projectPlotStageParams: missing Stage `reusable-generator`',
    )
  })
})

describe('Plot Sequence registration and preparation identity', () => {
  it('registers only shared projected values with the exact Composition Frame', () => {
    const declaration = makeDeclaration()
    const identity = projectPlotSequenceRegistrationIdentity(
      schema,
      declaration,
      {
        image: 'chosen-image',
        commonTone: 0.6,
        firstDetail: 0.1,
        secondDetail: 0.9,
        inkDensity: 0.2,
        unknown: 'do not leak',
      },
      frame,
    )
    const onlyStageValueChanged =
      projectPlotSequenceRegistrationIdentity(
        schema,
        declaration,
        {
          image: 'chosen-image',
          commonTone: 0.6,
          firstDetail: 1,
          secondDetail: 0,
          inkDensity: 1,
        },
        frame,
      )

    expect(identity).toEqual({
      params: { source: 'chosen-image', tone: 0.6 },
      frame,
    })
    expect(identity).toEqual(onlyStageValueChanged)
    expect(identity.frame).toBe(frame)
    expect(Object.isFrozen(identity)).toBe(true)
    expect(Object.isFrozen(identity.params)).toBe(true)
    expect(identity.params).not.toBe(onlyStageValueChanged.params)
    expect(
      projectPlotSequenceRegistrationIdentity(
        schema,
        declaration,
        { image: 'other-image', commonTone: 0.6 },
        frame,
      ),
    ).not.toEqual(identity)
    expect(
      projectPlotSequenceRegistrationIdentity(
        schema,
        declaration,
        { image: 'chosen-image', commonTone: 0.6 },
        { width: frame.width + 1, height: frame.height },
      ),
    ).not.toEqual(identity)
  })

  it('includes Seed and time only according to the addressed Stage flags', () => {
    const declaration = makeDeclaration()
    const params = {
      image: 'chosen-image',
      commonTone: 0.6,
      firstDetail: 0.2,
      secondDetail: 0.9,
      inkDensity: 0.3,
    }

    const unseeded = projectPlotStagePreparationIdentity(
      schema,
      declaration,
      'first-pass',
      params,
      'seed-a',
      1.25,
      frame,
    )
    const unseededWithOtherEphemera =
      projectPlotStagePreparationIdentity(
        schema,
        declaration,
        'first-pass',
        params,
        'seed-b',
        9,
        frame,
      )
    const seededAndTimed = projectPlotStagePreparationIdentity(
      schema,
      declaration,
      'second-pass',
      params,
      'seed-a',
      1.25,
      frame,
    )
    const seededOnly = projectPlotStagePreparationIdentity(
      schema,
      declaration,
      'primary',
      params,
      'seed-a',
      1.25,
      frame,
    )

    expect(unseeded).toEqual({
      params: { source: 'chosen-image', tone: 0.6, detail: 0.2 },
      frame,
    })
    expect(unseeded).toEqual(unseededWithOtherEphemera)
    expect(seededAndTimed).toEqual({
      params: { source: 'chosen-image', tone: 0.6, detail: 0.9 },
      seed: 'seed-a',
      t: 1.25,
      frame,
    })
    expect(seededOnly).toEqual({
      params: { source: 'chosen-image', tone: 0.6, density: 0.3 },
      seed: 'seed-a',
      frame,
    })
    expect('t' in seededOnly).toBe(false)
    expect(seededAndTimed.frame).toBe(frame)
    expect(Object.isFrozen(seededAndTimed)).toBe(true)
  })

  it('is sensitive to projected shared, owned, frame, and declared ephemeral inputs only', () => {
    const declaration = makeDeclaration()
    const baseParams = {
      image: 'chosen-image',
      commonTone: 0.6,
      secondDetail: 0.9,
      firstDetail: 0.1,
      unknown: 'ignored',
    }
    const identity = projectPlotStagePreparationIdentity(
      schema,
      declaration,
      'second-pass',
      baseParams,
      42,
      1.25,
      frame,
    )

    const project = (
      params: Params,
      seed: string | number = 42,
      t = 1.25,
      nextFrame: CoordinateSpace = frame,
    ) =>
      projectPlotStagePreparationIdentity(
        schema,
        declaration,
        'second-pass',
        params,
        seed,
        t,
        nextFrame,
      )

    expect(project({ ...baseParams, firstDetail: 0.8, unknown: 'other' })).toEqual(
      identity,
    )
    expect(project({ ...baseParams, image: 'other-image' })).not.toEqual(identity)
    expect(project({ ...baseParams, secondDetail: 0.8 })).not.toEqual(identity)
    expect(project(baseParams, 43)).not.toEqual(identity)
    expect(project(baseParams, 42, 1.5)).not.toEqual(identity)
    expect(
      project(baseParams, 42, 1.25, { width: 800, height: 1200 }),
    ).not.toEqual(identity)
  })
})

describe('Plot Stage generator input and invocation', () => {
  it('always carries unchanged Seed/time plus exact frame and environment', () => {
    const declaration = makeDeclaration()
    const environment: SketchEnvironment = {
      imageAssets: () => undefined,
    }
    const input = createPlotStageGeneratorInput(
      schema,
      declaration,
      'first-pass',
      { image: 'chosen-image', firstDetail: 0.2 },
      'unchanged-seed',
      3.5,
      frame,
      environment,
    )

    expect(input).toEqual({
      params: { source: 'chosen-image', tone: 0.4, detail: 0.2 },
      seed: 'unchanged-seed',
      t: 3.5,
      frame,
      environment,
    })
    expect(input.frame).toBe(frame)
    expect(input.environment).toBe(environment)
    expect(Object.isFrozen(input)).toBe(true)
    expect(Object.isFrozen(input.params)).toBe(true)
  })

  it('invokes the declared callback with complete projected input and returns its Scene', () => {
    const returned: Scene = {
      space: frame,
      primitives: [
        {
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
          stroke: { color: 'black', width: 1 },
        },
      ],
    }
    const generate = vi.fn<PlotStageGenerator>(() => returned)
    const declaration = makeDeclaration(generate)
    const environment: SketchEnvironment = {
      imageAssets: () => undefined,
    }

    const scene = invokePlotStageGenerator(
      schema,
      declaration,
      'first-pass',
      {
        image: 'chosen-image',
        firstDetail: 0.2,
        secondDetail: 0.9,
        unknown: 'do not leak',
      },
      'unchanged-seed',
      3.5,
      frame,
      environment,
    )

    expect(scene).toBe(returned)
    expect(generate).toHaveBeenCalledOnce()
    const input = generate.mock.calls[0]![0]
    expect(input).toEqual({
      params: { source: 'chosen-image', tone: 0.4, detail: 0.2 },
      seed: 'unchanged-seed',
      t: 3.5,
      frame,
      environment,
    })
    expect(input.frame).toBe(frame)
    expect(input.environment).toBe(environment)
  })

  it('addresses duplicate reusable generators by Stage instance without changing authored order', () => {
    const generate = vi.fn<PlotStageGenerator>(sceneFor)
    const declaration = makeDeclaration(generate)
    const authoredOrder = declaration.stages.map((stage) => stage.id)

    invokePlotStageGenerator(
      schema,
      declaration,
      'second-pass',
      { image: 'image', firstDetail: 0.2, secondDetail: 0.9 },
      10,
      2,
      frame,
    )
    invokePlotStageGenerator(
      schema,
      declaration,
      'first-pass',
      { image: 'image', firstDetail: 0.2, secondDetail: 0.9 },
      10,
      2,
      frame,
    )

    expect(generate.mock.calls[0]![0].params.detail).toBe(0.9)
    expect(generate.mock.calls[1]![0].params.detail).toBe(0.2)
    expect(declaration.stages.map((stage) => stage.id)).toEqual(authoredOrder)
    expect(declaration.stages[0]!.source.generatorId).toBe(
      declaration.stages[1]!.source.generatorId,
    )
  })

  it('clearly rejects Primary invocation and a missing Stage instance', () => {
    const declaration = makeDeclaration()

    expect(() =>
      invokePlotStageGenerator(
        schema,
        declaration,
        'primary',
        {},
        1,
        0,
        frame,
      ),
    ).toThrow(
      'invokePlotStageGenerator: Stage `primary` is Primary and has no declared generator callback',
    )
    expect(() =>
      invokePlotStageGenerator(
        schema,
        declaration,
        'reusable-generator',
        {},
        1,
        0,
        frame,
      ),
    ).toThrow(
      'invokePlotStageGenerator: missing Stage `reusable-generator`',
    )
  })
})
