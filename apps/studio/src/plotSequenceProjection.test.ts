import {
  createScene,
  type ParamSchema,
  type PlotSequenceDeclaration,
  type PlotStageGenerator,
} from "@harness/core";
import { describe, expect, it } from "vitest";
import {
  ownedPlotStageBindings,
  plotCanonicalKeys,
  plotSchemaEntries,
  plotSchemaKeys,
  plotSchemaView,
  plotStageBindings,
  plotStageProjection,
  plotStageSchemaView,
  primaryPlotStage,
  sharedPlotStageBindings,
} from "./plotSequenceProjection";

const generate: PlotStageGenerator = ({ frame }) => createScene(frame).build();

const schema = {
  image: { kind: "image-asset", default: "" },
  supportDetail: {
    kind: "number",
    default: 5,
    min: 1,
    max: 10,
    step: 1,
  },
  inkDensity: {
    kind: "number",
    default: 20,
    min: 1,
    max: 100,
    step: 1,
  },
  inkChaos: {
    kind: "number",
    default: 0.2,
    min: 0,
    max: 1,
    step: 0.1,
  },
} satisfies ParamSchema;

function declaration(): PlotSequenceDeclaration {
  return {
    sharedParameters: [{ schemaKey: "image", key: "imageAsset" }],
    stages: [
      {
        id: "support-a",
        name: "Support A",
        source: {
          kind: "generator",
          generatorId: "reused-generator",
          generate,
        },
        parameters: [
          { schemaKey: "supportDetail", key: "detail" },
        ],
        dependencies: { usesSeed: false, usesTime: false },
      },
      {
        id: "ink",
        name: "Ink",
        source: {
          kind: "primary",
          generatorId: "reused-generator",
        },
        parameters: [
          { schemaKey: "inkChaos", key: "chaos" },
          { schemaKey: "inkDensity", key: "density" },
        ],
        dependencies: { usesSeed: true, usesTime: false },
      },
    ],
  };
}

describe("Plot Sequence Studio projection", () => {
  it("resolves the unique Primary by Stage identity, not generator identity", () => {
    const sequence = declaration();

    expect(primaryPlotStage(sequence)).toBe(sequence.stages[1]);
    expect(primaryPlotStage(sequence).id).toBe("ink");
  });

  it("preserves exact shared, owned, and combined binding order", () => {
    const sequence = declaration();
    const shared = sharedPlotStageBindings(sequence);
    const owned = ownedPlotStageBindings(sequence, "ink");
    const combined = plotStageBindings(sequence, "ink");

    expect(shared.map(({ schemaKey }) => schemaKey)).toEqual(["image"]);
    expect(owned.map(({ schemaKey }) => schemaKey)).toEqual([
      "inkChaos",
      "inkDensity",
    ]);
    expect(combined.map(({ schemaKey }) => schemaKey)).toEqual([
      "image",
      "inkChaos",
      "inkDensity",
    ]);
    expect(combined.filter(({ schemaKey }) => schemaKey === "image")).toHaveLength(
      1,
    );
  });

  it("projects schema and canonical key aliases without order inference", () => {
    const bindings = plotStageBindings(declaration(), "ink");

    expect(plotSchemaKeys(bindings)).toEqual([
      "image",
      "inkChaos",
      "inkDensity",
    ]);
    expect(plotCanonicalKeys(bindings)).toEqual([
      "imageAsset",
      "chaos",
      "density",
    ]);

    const view = plotSchemaView(schema, bindings);
    expect(Object.keys(view)).toEqual(["image", "inkChaos", "inkDensity"]);
    expect(view.image).toBe(schema.image);
    expect(view.inkChaos).toBe(schema.inkChaos);
    expect(view.inkDensity).toBe(schema.inkDensity);
  });

  it("returns complete ordered shared, Stage-owned, and combined views", () => {
    const projection = plotStageProjection(schema, declaration(), "ink");

    expect(projection.stage.id).toBe("ink");
    expect(projection.shared.schemaKeys).toEqual(["image"]);
    expect(projection.shared.canonicalKeys).toEqual(["imageAsset"]);
    expect(projection.shared.schemaEntries).toEqual([
      ["image", schema.image],
    ]);
    expect(Object.keys(projection.shared.schema)).toEqual(["image"]);

    expect(projection.owned.schemaKeys).toEqual([
      "inkChaos",
      "inkDensity",
    ]);
    expect(projection.owned.canonicalKeys).toEqual(["chaos", "density"]);
    expect(projection.owned.schemaEntries).toEqual([
      ["inkChaos", schema.inkChaos],
      ["inkDensity", schema.inkDensity],
    ]);
    expect(Object.keys(projection.owned.schema)).toEqual([
      "inkChaos",
      "inkDensity",
    ]);

    expect(projection.combined.schemaKeys).toEqual([
      "image",
      "inkChaos",
      "inkDensity",
    ]);
    expect(projection.combined.canonicalKeys).toEqual([
      "imageAsset",
      "chaos",
      "density",
    ]);
    expect(Object.keys(projection.combined.schema)).toEqual([
      "image",
      "inkChaos",
      "inkDensity",
    ]);
  });

  it("keeps the ordinary non-Sequence path on the full owning schema", () => {
    expect(plotStageSchemaView(schema, undefined)).toBe(schema);
    expect(Object.keys(plotStageSchemaView(schema, undefined))).toEqual([
      "image",
      "supportDetail",
      "inkDensity",
      "inkChaos",
    ]);
    expect(Object.keys(plotStageSchemaView(schema, declaration(), "ink"))).toEqual(
      ["image", "inkChaos", "inkDensity"],
    );
  });

  it("keeps authored order when schema keys look like array indexes", () => {
    const indexedSchema = {
      "2": {
        kind: "number",
        default: 2,
        min: 0,
        max: 10,
        step: 1,
      },
      "10": {
        kind: "number",
        default: 10,
        min: 0,
        max: 10,
        step: 1,
      },
      alpha: {
        kind: "number",
        default: 1,
        min: 0,
        max: 10,
        step: 1,
      },
    } satisfies ParamSchema;
    const indexedDeclaration: PlotSequenceDeclaration = {
      sharedParameters: [],
      stages: [
        {
          id: "indexed",
          name: "Indexed",
          source: { kind: "primary", generatorId: "indexed" },
          parameters: [
            { schemaKey: "10", key: "ten" },
            { schemaKey: "2", key: "two" },
            { schemaKey: "alpha", key: "alpha" },
          ],
          dependencies: { usesSeed: false, usesTime: false },
        },
      ],
    };

    const projection = plotStageProjection(
      indexedSchema,
      indexedDeclaration,
      "indexed",
    ).combined;

    expect(projection.schemaKeys).toEqual(["10", "2", "alpha"]);
    expect(projection.schemaEntries.map(([key]) => key)).toEqual([
      "10",
      "2",
      "alpha",
    ]);
    expect(
      plotSchemaEntries(indexedSchema, projection.bindings).map(([key]) => key),
    ).toEqual(["10", "2", "alpha"]);
    expect(Object.entries(projection.schema).map(([key]) => key)).toEqual([
      "10",
      "2",
      "alpha",
    ]);
    expect(
      Object.entries(
        plotStageSchemaView(
          indexedSchema,
          indexedDeclaration,
          "indexed",
        ),
      ).map(([key]) => key),
    ).toEqual(["10", "2", "alpha"]);
  });

  it("fails loudly for unknown or duplicate Stage ids", () => {
    expect(() => plotStageBindings(declaration(), "missing")).toThrow(
      "plotSequenceProjection: missing Stage `missing`",
    );

    const original = declaration();
    const duplicate: PlotSequenceDeclaration = {
      ...original,
      stages: [
        original.stages[0]!,
        { ...original.stages[1]!, id: "support-a" },
      ],
    };
    expect(() => plotStageBindings(duplicate, "support-a")).toThrow(
      "plotSequenceProjection: duplicate Stage id `support-a`",
    );
  });

  it("fails loudly for malformed Primary and binding projections", () => {
    const original = declaration();
    const noPrimary: PlotSequenceDeclaration = {
      ...original,
      stages: [
        original.stages[0]!,
        {
          ...original.stages[1]!,
          source: {
            kind: "generator",
            generatorId: "reused-generator",
            generate,
          },
        },
      ],
    };
    expect(() => primaryPlotStage(noPrimary)).toThrow(
      "expected exactly one Primary Stage; received 0",
    );

    const malformed: PlotSequenceDeclaration = {
      ...declaration(),
      sharedParameters: [
        { schemaKey: "image", key: "imageAsset" },
        { schemaKey: "image", key: "duplicate" },
      ],
    };
    expect(() => plotSchemaKeys(sharedPlotStageBindings(malformed))).toThrow(
      "duplicate schema key `image` in projection",
    );

    expect(() =>
      plotSchemaView(schema, [
        { schemaKey: "unknown", key: "unknown" },
      ]),
    ).toThrow("binding references unknown schema key `unknown`");
  });

  it("requires coherent Sequence and Stage arguments", () => {
    expect(() => plotStageSchemaView(schema, undefined, "ink")).toThrow(
      "a Stage id requires a Plot Sequence declaration",
    );
    expect(() => plotStageSchemaView(schema, declaration())).toThrow(
      "a Plot Sequence declaration requires a Stage id",
    );
  });
});
