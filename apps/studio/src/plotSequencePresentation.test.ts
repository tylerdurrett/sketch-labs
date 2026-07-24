import {
  type PlotSequenceDeclaration,
  type PlotStageGenerator,
  type Primitive,
  type Scene,
} from "@harness/core";
import { describe, expect, it, vi } from "vitest";

import type {
  PlotStagePreparationIdentity,
  PlotStageRegistrationIdentity,
} from "./plotStagePreparationProtocol";
import {
  PHOTO_SCRIBBLE_COMBINED_PRESENTATION,
  defaultPlotSequencePresentation,
  plotSequencePresentation,
  type PlotSequencePresentation,
} from "./plotSequencePresentation";
import type {
  RegisteredStageActivity,
  RegisteredStageFreshness,
  RegisteredStageRecord,
  RegisteredStageRecordMap,
} from "./useRegisteredStagePreparation";

const frame = Object.freeze({ width: 100, height: 80 });
const generate: PlotStageGenerator = () => scene("generated");

function declaration(): PlotSequenceDeclaration {
  return {
    sharedParameters: [],
    // Physical order is deliberately the reverse of the default presentation
    // stack. Both supporting Stages reuse one generator capability.
    stages: [
      {
        id: "watercolor-forms",
        name: "Watercolor Forms",
        source: {
          kind: "generator",
          generatorId: "reused-generator",
          generate,
        },
        parameters: [],
        dependencies: { usesSeed: false, usesTime: false },
      },
      {
        id: "support-copy",
        name: "Support Copy",
        source: {
          kind: "generator",
          generatorId: "reused-generator",
          generate,
        },
        parameters: [],
        dependencies: { usesSeed: false, usesTime: false },
      },
      {
        id: "ink-scribble",
        name: "Ink Scribble",
        source: {
          kind: "primary",
          generatorId: "reused-generator",
        },
        parameters: [],
        dependencies: { usesSeed: true, usesTime: false },
      },
    ],
  };
}

function primitive(label: string, color = label): Primitive {
  return {
    points: [
      [label.length, 1],
      [label.length + 1, 2],
    ],
    stroke: { color, width: 1 },
  };
}

function scene(label: string, color = label): Scene {
  return {
    space: frame,
    primitives: [primitive(label, color)],
  };
}

function registration(
  imageAsset: string,
): PlotStageRegistrationIdentity {
  return {
    params: [{ key: "imageAsset", value: imageAsset }],
    compositionFrame: frame,
  };
}

function preparation(
  stageId: string,
  revision: string,
): PlotStagePreparationIdentity {
  return {
    sketchId: "photo-scribble",
    stageId,
    params: [{ key: "revision", value: revision }],
    compositionFrame: frame,
  };
}

interface RecordOptions {
  readonly registration?: PlotStageRegistrationIdentity | null;
  readonly retained?: Scene | null;
  readonly freshness?: RegisteredStageFreshness;
  readonly activity?: RegisteredStageActivity;
  readonly outputReady?: boolean;
}

function record(
  stageId: string,
  options: RecordOptions = {},
): RegisteredStageRecord {
  const retained =
    options.retained === undefined ? scene(stageId) : options.retained;
  const identity =
    options.registration === undefined
      ? registration("asset-a")
      : options.registration;
  const freshness = options.freshness ?? "current";
  return {
    stageId,
    sourceKind: stageId === "ink-scribble" ? "primary" : "generator",
    registrationIdentity: identity,
    preparationIdentity:
      retained === null ? null : preparation(stageId, "retained"),
    expectedRegistrationIdentity: registration("asset-a"),
    expectedPreparationIdentity: preparation(stageId, "expected"),
    scene: retained,
    freshness,
    activity: options.activity ?? { kind: "idle" },
    outputReady: options.outputReady ?? freshness === "current",
  };
}

function records(
  entries: readonly (readonly [string, RegisteredStageRecord])[],
): RegisteredStageRecordMap {
  return Object.fromEntries(entries);
}

const combined: PlotSequencePresentation = {
  kind: "combined",
  stageIds: ["ink-scribble", "watercolor-forms"],
};

describe("Plot Sequence presentation", () => {
  it("defaults to the unique Primary and keeps Photo stacking separate from physical order", () => {
    const sequence = declaration();

    expect(defaultPlotSequencePresentation(sequence)).toEqual({
      kind: "isolated",
      stageId: "ink-scribble",
    });
    expect(PHOTO_SCRIBBLE_COMBINED_PRESENTATION).toEqual({
      kind: "combined",
      stageIds: ["ink-scribble", "watercolor-forms"],
    });
    expect(sequence.stages.map(({ id }) => id)).toEqual([
      "watercolor-forms",
      "support-copy",
      "ink-scribble",
    ]);
  });

  it.each([
    {
      label: "current",
      options: { freshness: "current" } satisfies RecordOptions,
    },
    {
      label: "stale while preparing",
      options: {
        freshness: "stale",
        activity: {
          kind: "preparing",
          progress: { kind: "indeterminate" },
        },
        outputReady: false,
      } satisfies RecordOptions,
    },
    {
      label: "failed with retained geometry",
      options: {
        freshness: "stale",
        activity: { kind: "failed", error: "watercolor failed" },
        outputReady: false,
      } satisfies RecordOptions,
    },
    {
      label: "unavailable with retained geometry",
      options: {
        freshness: "unavailable",
        outputReady: false,
      } satisfies RecordOptions,
    },
  ])(
    "presents an isolated retained Scene truthfully when $label",
    ({ options }) => {
      const retained = scene("retained");
      const stageRecord = record("watercolor-forms", {
        ...options,
        retained,
      });

      const snapshot = plotSequencePresentation({
        declaration: declaration(),
        records: records([["watercolor-forms", stageRecord]]),
        presentation: { kind: "isolated", stageId: "watercolor-forms" },
      });

      expect(snapshot.scene).toBe(retained);
      expect(snapshot.registrationIdentity).toBe(
        stageRecord.registrationIdentity,
      );
      expect(snapshot.held).toBe(false);
      expect(snapshot.stages).toEqual([
        {
          stageId: "watercolor-forms",
          name: "Watercolor Forms",
          recordPresent: true,
          freshness: stageRecord.freshness,
          activity: stageRecord.activity,
          outputReady: stageRecord.outputReady,
          hasRetainedScene: true,
        },
      ]);
    },
  );

  it("reports absent records and missing retained geometry without fabricating a Scene", () => {
    const missing = record("watercolor-forms", {
      retained: null,
      registration: null,
      freshness: "missing",
      outputReady: false,
    });
    const missingSnapshot = plotSequencePresentation({
      declaration: declaration(),
      records: records([["watercolor-forms", missing]]),
      presentation: { kind: "isolated", stageId: "watercolor-forms" },
    });
    const absentSnapshot = plotSequencePresentation({
      declaration: declaration(),
      records: {},
      presentation: { kind: "isolated", stageId: "watercolor-forms" },
    });

    expect(missingSnapshot.scene).toBeNull();
    expect(missingSnapshot.stages[0]).toMatchObject({
      recordPresent: true,
      freshness: "missing",
      hasRetainedScene: false,
    });
    expect(absentSnapshot.scene).toBeNull();
    expect(absentSnapshot.stages[0]).toEqual({
      stageId: "watercolor-forms",
      name: "Watercolor Forms",
      recordPresent: false,
      freshness: "missing",
      activity: null,
      outputReady: false,
      hasRetainedScene: false,
    });
  });

  it("combines equal registrations only in explicit back-to-front Stage-ID order", () => {
    const ink = scene("ink");
    const watercolor = scene("watercolor");
    const supportCopy = scene("support-copy");
    const snapshot = plotSequencePresentation({
      declaration: declaration(),
      records: records([
        ["watercolor-forms", record("watercolor-forms", { retained: watercolor })],
        ["support-copy", record("support-copy", { retained: supportCopy })],
        ["ink-scribble", record("ink-scribble", { retained: ink })],
      ]),
      presentation: combined,
    });

    expect(snapshot.scene?.primitives).toEqual([
      ink.primitives[0],
      watercolor.primitives[0],
    ]);
    expect(snapshot.scene?.primitives[0]).toBe(ink.primitives[0]);
    expect(snapshot.scene?.primitives[1]).toBe(watercolor.primitives[0]);
    expect(snapshot.stages.map(({ stageId }) => stageId)).toEqual([
      "ink-scribble",
      "watercolor-forms",
    ]);
    expect(snapshot.held).toBe(false);
  });

  it("atomically holds the last coherent Combined snapshot through mixed shared revisions", () => {
    const oldRegistration = registration("asset-a");
    const newRegistration = registration("asset-b");
    const first = plotSequencePresentation({
      declaration: declaration(),
      records: records([
        [
          "ink-scribble",
          record("ink-scribble", {
            retained: scene("old-ink"),
            registration: oldRegistration,
            freshness: "stale",
            outputReady: false,
          }),
        ],
        [
          "watercolor-forms",
          record("watercolor-forms", {
            retained: scene("old-watercolor"),
            registration: oldRegistration,
            freshness: "stale",
            outputReady: false,
          }),
        ],
      ]),
      presentation: combined,
    });
    const mixed = plotSequencePresentation({
      declaration: declaration(),
      records: records([
        [
          "ink-scribble",
          record("ink-scribble", {
            retained: scene("new-ink"),
            registration: newRegistration,
          }),
        ],
        [
          "watercolor-forms",
          record("watercolor-forms", {
            retained: scene("old-watercolor"),
            registration: oldRegistration,
            freshness: "stale",
            activity: { kind: "failed", error: "new watercolor failed" },
            outputReady: false,
          }),
        ],
      ]),
      presentation: combined,
      previous: first,
    });
    const settled = plotSequencePresentation({
      declaration: declaration(),
      records: records([
        [
          "ink-scribble",
          record("ink-scribble", {
            retained: scene("new-ink"),
            registration: newRegistration,
          }),
        ],
        [
          "watercolor-forms",
          record("watercolor-forms", {
            retained: scene("new-watercolor"),
            registration: newRegistration,
          }),
        ],
      ]),
      presentation: combined,
      previous: mixed,
    });

    expect(first.scene?.primitives.map(({ stroke }) => stroke?.color)).toEqual([
      "old-ink",
      "old-watercolor",
    ]);
    expect(mixed.scene).toBe(first.scene);
    expect(mixed.registrationIdentity).toBe(first.registrationIdentity);
    expect(mixed.held).toBe(true);
    expect(mixed.stages[1]).toMatchObject({
      freshness: "stale",
      activity: { kind: "failed", error: "new watercolor failed" },
      outputReady: false,
    });
    expect(settled.held).toBe(false);
    expect(settled.scene?.primitives.map(({ stroke }) => stroke?.color)).toEqual([
      "new-ink",
      "new-watercolor",
    ]);
  });

  it("returns no Combined Scene for a first-load mixed, unavailable, failed, or missing set", () => {
    const cases: readonly RegisteredStageRecordMap[] = [
      records([
        [
          "ink-scribble",
          record("ink-scribble", { registration: registration("asset-a") }),
        ],
        [
          "watercolor-forms",
          record("watercolor-forms", { registration: registration("asset-b") }),
        ],
      ]),
      records([
        ["ink-scribble", record("ink-scribble")],
        [
          "watercolor-forms",
          record("watercolor-forms", {
            retained: null,
            registration: null,
            freshness: "unavailable",
            outputReady: false,
          }),
        ],
      ]),
      records([
        ["ink-scribble", record("ink-scribble")],
        [
          "watercolor-forms",
          record("watercolor-forms", {
            retained: null,
            registration: null,
            freshness: "missing",
            activity: { kind: "failed", error: "first load failed" },
            outputReady: false,
          }),
        ],
      ]),
      records([["ink-scribble", record("ink-scribble")]]),
    ];

    for (const stageRecords of cases) {
      const snapshot = plotSequencePresentation({
        declaration: declaration(),
        records: stageRecords,
        presentation: combined,
      });
      expect(snapshot.scene).toBeNull();
      expect(snapshot.registrationIdentity).toBeNull();
      expect(snapshot.held).toBe(false);
    }
  });

  it("holds a prior coherent Combined Scene while current status reports unavailable geometry", () => {
    const prior = plotSequencePresentation({
      declaration: declaration(),
      records: records([
        ["ink-scribble", record("ink-scribble")],
        ["watercolor-forms", record("watercolor-forms")],
      ]),
      presentation: combined,
    });
    const unavailable = plotSequencePresentation({
      declaration: declaration(),
      records: records([
        ["ink-scribble", record("ink-scribble")],
        [
          "watercolor-forms",
          record("watercolor-forms", {
            retained: null,
            registration: null,
            freshness: "unavailable",
            activity: { kind: "failed", error: "asset unavailable" },
            outputReady: false,
          }),
        ],
      ]),
      presentation: combined,
      previous: prior,
    });

    expect(unavailable.scene).toBe(prior.scene);
    expect(unavailable.held).toBe(true);
    expect(unavailable.stages[1]).toEqual({
      stageId: "watercolor-forms",
      name: "Watercolor Forms",
      recordPresent: true,
      freshness: "unavailable",
      activity: { kind: "failed", error: "asset unavailable" },
      outputReady: false,
      hasRetainedScene: false,
    });
  });

  it("finalizes retained Scenes downstream without mutating cached geometry or identity", () => {
    const rawInk = scene("ink", "raw-ink");
    const rawWatercolor = scene("watercolor", "raw-watercolor");
    const inkRecord = record("ink-scribble", { retained: rawInk });
    const watercolorRecord = record("watercolor-forms", {
      retained: rawWatercolor,
    });
    const finalizeStudioPlotStage = vi.fn(
      (stageId: string, source: Scene): Scene => ({
        ...source,
        primitives: source.primitives.map((sourcePrimitive) => ({
          ...sourcePrimitive,
          stroke: { color: `styled-${stageId}`, width: 2 },
        })),
      }),
    );

    const snapshot = plotSequencePresentation({
      declaration: declaration(),
      records: records([
        ["ink-scribble", inkRecord],
        ["watercolor-forms", watercolorRecord],
      ]),
      presentation: combined,
      finalizeStudioPlotStage,
    });

    expect(finalizeStudioPlotStage.mock.calls).toEqual([
      ["ink-scribble", rawInk],
      ["watercolor-forms", rawWatercolor],
    ]);
    expect(snapshot.scene?.primitives.map(({ stroke }) => stroke?.color)).toEqual([
      "styled-ink-scribble",
      "styled-watercolor-forms",
    ]);
    expect(rawInk.primitives[0]?.stroke?.color).toBe("raw-ink");
    expect(rawWatercolor.primitives[0]?.stroke?.color).toBe("raw-watercolor");
    expect(inkRecord.scene).toBe(rawInk);
    expect(watercolorRecord.scene).toBe(rawWatercolor);
    expect(snapshot.registrationIdentity).toBe(inkRecord.registrationIdentity);
  });

  it("rejects empty, duplicate, or unknown presentation Stage IDs", () => {
    const input = {
      declaration: declaration(),
      records: {},
    } as const;

    expect(() =>
      plotSequencePresentation({
        ...input,
        presentation: { kind: "combined", stageIds: [] },
      }),
    ).toThrow("Combined presentation requires at least one Stage");
    expect(() =>
      plotSequencePresentation({
        ...input,
        presentation: {
          kind: "combined",
          stageIds: ["ink-scribble", "ink-scribble"],
        },
      }),
    ).toThrow("duplicate presented Stage id `ink-scribble`");
    expect(() =>
      plotSequencePresentation({
        ...input,
        presentation: { kind: "isolated", stageId: "missing" },
      }),
    ).toThrow("missing Stage `missing`");
  });
});
