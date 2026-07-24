import { describe, expect, expectTypeOf, it } from 'vitest'

import * as core from '../index'
import {
  validatePlotSequenceDeclaration,
  type PlotSequenceDeclaration,
  type PlotStageGenerator,
  type PlotStageGeneratorInput,
} from '../plotSequence'
import type { ParamSchema, StatelessSketch } from '../sketch'

const schema: ParamSchema = {
  image: { kind: 'image-asset', default: 'portrait' },
  watercolorDetail: { kind: 'number', min: 0, max: 1, default: 0.5 },
  inkDensity: { kind: 'number', min: 0, max: 1, default: 0.5 },
}

const supportingGenerator: PlotStageGenerator = ({ frame }) => ({
  space: { width: frame.width, height: frame.height },
  primitives: [],
})

function makeDeclaration(): PlotSequenceDeclaration {
  return {
    sharedParameters: [{ schemaKey: 'image', key: 'image' }],
    stages: [
      {
        id: 'watercolor-forms',
        name: 'Watercolor Forms',
        source: {
          kind: 'generator',
          generatorId: 'watercolor-forms',
          generate: supportingGenerator,
        },
        parameters: [
          { schemaKey: 'watercolorDetail', key: 'formDetail' },
        ],
        dependencies: { usesSeed: false, usesTime: false },
      },
      {
        id: 'ink-scribble',
        name: 'Ink Scribble',
        source: { kind: 'primary', generatorId: 'photo-scribble' },
        parameters: [{ schemaKey: 'inkDensity', key: 'density' }],
        dependencies: { usesSeed: true, usesTime: false },
      },
    ],
  }
}

function malformed(value: unknown): PlotSequenceDeclaration {
  return value as PlotSequenceDeclaration
}

describe('Plot Sequence declaration contract', () => {
  it('is exported from the core entry point', () => {
    expect(core.validatePlotSequenceDeclaration).toBe(
      validatePlotSequenceDeclaration,
    )
    expectTypeOf<core.PlotSequenceDeclaration>().toEqualTypeOf<PlotSequenceDeclaration>()
  })

  it('gives a Stage generator the complete deterministic input and a Scene result', () => {
    expectTypeOf<PlotStageGenerator>().parameter(0).toEqualTypeOf<
      Readonly<PlotStageGeneratorInput>
    >()
    expectTypeOf<PlotStageGenerator>().returns.toMatchTypeOf<core.Scene>()
  })

  it('keeps plotSequence optional for existing Sketch declarations', () => {
    const legacySketch: StatelessSketch = {
      id: 'legacy',
      name: 'Legacy',
      schema: {},
      generate(_params, _seed, _t, frame) {
        return { space: frame, primitives: [] }
      },
    }

    expect(legacySketch.plotSequence).toBeUndefined()
  })

  it('accepts a valid declaration', () => {
    expect(() =>
      validatePlotSequenceDeclaration(makeDeclaration(), schema),
    ).not.toThrow()
  })

  it('accepts non-slug Stage IDs while rejecting whitespace-only IDs', () => {
    const declaration = makeDeclaration()
    const renamed: PlotSequenceDeclaration = {
      ...declaration,
      stages: [
        { ...declaration.stages[0]!, id: 'Watercolor Forms / first pass' },
        declaration.stages[1]!,
      ],
    }
    expect(() =>
      validatePlotSequenceDeclaration(renamed, schema),
    ).not.toThrow()

    const whitespace: PlotSequenceDeclaration = {
      ...declaration,
      stages: [
        { ...declaration.stages[0]!, id: ' \t ' },
        declaration.stages[1]!,
      ],
    }
    expect(() =>
      validatePlotSequenceDeclaration(whitespace, schema),
    ).toThrow(/stages\[0\]\.id must be a nonempty string/)
  })

  it('preserves authored Stage order and accepts frozen declarations', () => {
    const declaration = makeDeclaration()
    const authoredOrder = declaration.stages.map((stage) => stage.id)
    const frozen: PlotSequenceDeclaration = Object.freeze({
      sharedParameters: Object.freeze([...declaration.sharedParameters]),
      stages: Object.freeze([...declaration.stages]),
    })

    validatePlotSequenceDeclaration(frozen, schema)

    expect(frozen.stages.map((stage) => stage.id)).toEqual(authoredOrder)
  })

  it('distinguishes Stage instance identity from reusable generator identity', () => {
    const repeatedSchema: ParamSchema = {
      image: schema.image!,
      firstDetail: schema.watercolorDetail!,
      secondDetail: schema.watercolorDetail!,
      inkDensity: schema.inkDensity!,
    }
    const declaration = makeDeclaration()
    const first = declaration.stages[0]!
    const repeated: PlotSequenceDeclaration = {
      sharedParameters: declaration.sharedParameters,
      stages: [
        {
          ...first,
          id: 'watercolor-light',
          parameters: [{ schemaKey: 'firstDetail', key: 'formDetail' }],
        },
        {
          ...first,
          id: 'watercolor-bold',
          parameters: [{ schemaKey: 'secondDetail', key: 'formDetail' }],
        },
        declaration.stages[1]!,
      ],
    }

    expect(repeated.stages[0]!.source).toMatchObject({
      generatorId: 'watercolor-forms',
      generate: supportingGenerator,
    })
    expect(repeated.stages[1]!.source).toMatchObject({
      generatorId: 'watercolor-forms',
      generate: supportingGenerator,
    })
    expect(() =>
      validatePlotSequenceDeclaration(repeated, repeatedSchema),
    ).not.toThrow()
  })
})

describe('validatePlotSequenceDeclaration', () => {
  it('requires the declaration arrays', () => {
    expect(() =>
      validatePlotSequenceDeclaration(
        malformed({ sharedParameters: {}, stages: [] }),
        schema,
      ),
    ).toThrow(/sharedParameters must be an array/)
    expect(() =>
      validatePlotSequenceDeclaration(
        malformed({ sharedParameters: [], stages: {} }),
        schema,
      ),
    ).toThrow(/stages must be an array/)
  })

  it('rejects missing and duplicate Stage IDs', () => {
    const declaration = makeDeclaration()
    expect(() =>
      validatePlotSequenceDeclaration(
        {
          ...declaration,
          stages: [
            { ...declaration.stages[0]!, id: '' },
            declaration.stages[1]!,
          ],
        },
        schema,
      ),
    ).toThrow(/id must be a nonempty string/)

    expect(() =>
      validatePlotSequenceDeclaration(
        {
          ...declaration,
          stages: [
            declaration.stages[0]!,
            { ...declaration.stages[1]!, id: declaration.stages[0]!.id },
          ],
        },
        schema,
      ),
    ).toThrow(/duplicate Stage id `watercolor-forms`/)
  })

  it('rejects empty Stage names and generator IDs', () => {
    const declaration = makeDeclaration()
    expect(() =>
      validatePlotSequenceDeclaration(
        {
          ...declaration,
          stages: [
            { ...declaration.stages[0]!, name: ' ' },
            declaration.stages[1]!,
          ],
        },
        schema,
      ),
    ).toThrow(/name must be a nonempty string/)

    expect(() =>
      validatePlotSequenceDeclaration(
        {
          ...declaration,
          stages: [
            {
              ...declaration.stages[0]!,
              source: {
                ...declaration.stages[0]!.source,
                generatorId: '',
              },
            },
            declaration.stages[1]!,
          ],
        },
        schema,
      ),
    ).toThrow(/generatorId must be a nonempty string/)
  })

  it('requires exactly one Primary source using source.kind alone', () => {
    const declaration = makeDeclaration()
    const noPrimary: PlotSequenceDeclaration = {
      ...declaration,
      stages: [
        declaration.stages[0]!,
        {
          ...declaration.stages[1]!,
          source: {
            kind: 'generator',
            generatorId: 'photo-scribble',
            generate: supportingGenerator,
          },
        },
      ],
    }
    expect(() =>
      validatePlotSequenceDeclaration(noPrimary, schema),
    ).toThrow(/exactly one Primary Stage, found 0/)

    const twoPrimary: PlotSequenceDeclaration = {
      ...declaration,
      stages: [
        {
          ...declaration.stages[0]!,
          source: { kind: 'primary', generatorId: 'watercolor-forms' },
        },
        declaration.stages[1]!,
      ],
    }
    expect(() =>
      validatePlotSequenceDeclaration(twoPrimary, schema),
    ).toThrow(/exactly one Primary Stage, found 2/)
  })

  it('rejects an unknown source kind and a non-callable generated source', () => {
    const declaration = makeDeclaration()
    expect(() =>
      validatePlotSequenceDeclaration(
        malformed({
          ...declaration,
          stages: [
            {
              ...declaration.stages[0],
              source: {
                kind: 'supporting',
                generatorId: 'watercolor-forms',
              },
            },
            declaration.stages[1],
          ],
        }),
        schema,
      ),
    ).toThrow(/source\.kind must be `primary` or `generator`/)

    expect(() =>
      validatePlotSequenceDeclaration(
        malformed({
          ...declaration,
          stages: [
            {
              ...declaration.stages[0],
              source: {
                kind: 'generator',
                generatorId: 'watercolor-forms',
                generate: 'not callable',
              },
            },
            declaration.stages[1],
          ],
        }),
        schema,
      ),
    ).toThrow(/source\.generate must be callable/)
  })

  it('requires explicit boolean Seed and time participation', () => {
    const declaration = makeDeclaration()
    expect(() =>
      validatePlotSequenceDeclaration(
        malformed({
          ...declaration,
          stages: [
            {
              ...declaration.stages[0],
              dependencies: { usesSeed: 'no', usesTime: false },
            },
            declaration.stages[1],
          ],
        }),
        schema,
      ),
    ).toThrow(/usesSeed must be a boolean/)

    expect(() =>
      validatePlotSequenceDeclaration(
        malformed({
          ...declaration,
          stages: [
            {
              ...declaration.stages[0],
              dependencies: { usesSeed: false },
            },
            declaration.stages[1],
          ],
        }),
        schema,
      ),
    ).toThrow(/usesTime must be a boolean/)
  })

  it('rejects unknown, multiply owned, and unowned schema keys', () => {
    const declaration = makeDeclaration()
    expect(() =>
      validatePlotSequenceDeclaration(
        {
          ...declaration,
          stages: [
            {
              ...declaration.stages[0]!,
              parameters: [{ schemaKey: 'missing', key: 'detail' }],
            },
            declaration.stages[1]!,
          ],
        },
        schema,
      ),
    ).toThrow(/unknown schema key `missing`/)

    expect(() =>
      validatePlotSequenceDeclaration(
        {
          ...declaration,
          stages: [
            {
              ...declaration.stages[0]!,
              parameters: [{ schemaKey: 'image', key: 'otherImage' }],
            },
            declaration.stages[1]!,
          ],
        },
        schema,
      ),
    ).toThrow(/schema key `image` has more than one parameter owner/)

    expect(() =>
      validatePlotSequenceDeclaration(
        {
          ...declaration,
          stages: [
            { ...declaration.stages[0]!, parameters: [] },
            declaration.stages[1]!,
          ],
        },
        schema,
      ),
    ).toThrow(/missing `watercolorDetail`/)
  })

  it('rejects empty canonical keys and collisions in a Stage projection', () => {
    const declaration = makeDeclaration()
    expect(() =>
      validatePlotSequenceDeclaration(
        {
          ...declaration,
          stages: [
            {
              ...declaration.stages[0]!,
              parameters: [
                { schemaKey: 'watercolorDetail', key: ' \n ' },
              ],
            },
            declaration.stages[1]!,
          ],
        },
        schema,
      ),
    ).toThrow(/\.key must be a nonempty string/)

    expect(() =>
      validatePlotSequenceDeclaration(
        {
          ...declaration,
          stages: [
            {
              ...declaration.stages[0]!,
              parameters: [
                { schemaKey: 'watercolorDetail', key: 'image' },
              ],
            },
            declaration.stages[1]!,
          ],
        },
        schema,
      ),
    ).toThrow(/collides on canonical key `image`/)
  })

  it('rejects collisions between two shared or two Stage-owned bindings', () => {
    const declaration = makeDeclaration()
    expect(() =>
      validatePlotSequenceDeclaration(
        {
          sharedParameters: [
            { schemaKey: 'image', key: 'shared' },
            { schemaKey: 'watercolorDetail', key: 'shared' },
          ],
          stages: [
            { ...declaration.stages[0]!, parameters: [] },
            declaration.stages[1]!,
          ],
        },
        schema,
      ),
    ).toThrow(/collides on canonical key `shared`/)

    expect(() =>
      validatePlotSequenceDeclaration(
        {
          sharedParameters: declaration.sharedParameters,
          stages: [
            {
              ...declaration.stages[0]!,
              parameters: [
                { schemaKey: 'watercolorDetail', key: 'control' },
                { schemaKey: 'inkDensity', key: 'control' },
              ],
            },
            { ...declaration.stages[1]!, parameters: [] },
          ],
        },
        schema,
      ),
    ).toThrow(/collides on canonical key `control`/)
  })

  it('names the validator in malformed-declaration diagnostics', () => {
    expect(() =>
      validatePlotSequenceDeclaration(
        malformed(null),
        schema,
      ),
    ).toThrow('validatePlotSequenceDeclaration')
  })
})
