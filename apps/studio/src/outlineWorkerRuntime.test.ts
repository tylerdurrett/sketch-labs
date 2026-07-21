import { describe, expect, it, vi } from "vitest";

import {
  clipSceneToBounds,
  createScribbleMoonStructuralScene,
  DEFAULT_COMPOSITION_FRAME,
  defaultParams,
  grassHills,
  hiddenLinePass,
  registry,
  renderPlotterSVG,
  scribbleMoon,
  toneCalibration,
  type PageFrame,
  type ParamSchema,
  type PlotProfile,
  type Scene,
} from "@harness/core";

import {
  createHiddenLineExportSnapshot,
  createOutlineComputeIdentity,
  outlineComputeIdentitiesEqual,
  type OutlineComputeIdentity,
} from "./outlineComputeProtocol";
import { finalizeOutlineScene, outlineScene } from "./outlineScene";
import {
  handleHiddenLineWorkerMessage,
  handleOutlineWorkerMessage,
} from "./outlineWorkerRuntime";
import {
  FIXED_PAGE_PARITY_COMPOSITION,
  FIXED_PAGE_PARITY_FRAME,
  FIXED_PAGE_PARITY_PROFILE,
  fixedPageParityScene,
} from "./fixedPageOutputParity.test-support";

const source: Scene = {
  space: { width: 40, height: 30 },
  background: { color: "paper" },
  primitives: [
    {
      points: [
        [1, 1],
        [20, 1],
        [10, 20],
      ],
      closed: true,
      fill: { color: "red" },
    },
  ],
};
const schema: ParamSchema = {};

const hybridSource: Scene = {
  space: { width: 40, height: 30 },
  primitives: [
    {
      points: [
        [0, 15],
        [40, 15],
      ],
      stroke: { color: "green", width: 1 },
      hiddenLineRole: "source",
    },
    {
      points: [
        [10, 10],
        [20, 10],
        [20, 20],
        [10, 20],
      ],
      closed: true,
      fill: { color: "gray" },
      hiddenLineRole: "occluder",
    },
  ],
};

const completedToneCalibration: Scene = {
  space: DEFAULT_COMPOSITION_FRAME,
  primitives: [
    {
      points: [
        [5, 8],
        [12, 8.02],
        [19, 7.98],
        [26, 8],
      ],
      closed: false,
      stroke: { color: "navy", width: 0.75 },
      hiddenLineRole: "source",
    },
  ],
};

const completedStippling: Scene = {
  space: { width: 1_000, height: 1_000 },
  primitives: [
    {
      points: [[150, 250], [150.5, 250]],
      closed: false,
      stroke: { color: "black", width: 1 },
      hiddenLineRole: "source",
    },
    {
      points: [[400, 300], [400, 300.5]],
      closed: false,
      stroke: { color: "black", width: 1 },
      hiddenLineRole: "source",
    },
    {
      points: [[800, 700], [799.5, 700]],
      closed: false,
      stroke: { color: "black", width: 1 },
      hiddenLineRole: "source",
    },
  ],
};

const completedScribbleMoon: Scene = (() => {
  const structural = createScribbleMoonStructuralScene(
    DEFAULT_COMPOSITION_FRAME,
  );
  return {
    space: structural.space,
    primitives: [
      ...structural.primitives,
      {
        points: [
          [5, 8],
          [12, 8.02],
          [19, 7.98],
          [26, 8],
        ],
        closed: false,
        stroke: { color: "navy", width: 0.75 },
        hiddenLineRole: "source",
      },
    ],
  };
})();

function request(tolerance = 0) {
  return {
    type: "compute" as const,
    jobId: 7,
    identity: createOutlineComputeIdentity({
      sketchId: "test",
      schema,
      params: {},
      seed: 1,
      sampledT: 0,
      compositionFrame: source.space,
      tolerance,
      sourceScene: source,
    }),
  };
}

describe("outline worker runtime", () => {
  it("returns direct outlineScene parity, including background and tolerance", () => {
    const response = handleOutlineWorkerMessage(request(0.5));
    expect(response).toMatchObject({ type: "success", jobId: 7 });
    if (response?.type !== "success") throw new Error("expected success");
    expect(response.scene).toEqual(outlineScene(source, 0.5));
    expect(response.scene).toEqual(hiddenLinePass(source, { tolerance: 0.5 }));
    expect(response.scene.background).toBeUndefined();
  });

  it("keeps expensive derivation identity free of Page finalization inputs", () => {
    expect(request().identity).not.toHaveProperty("includeFrame");
    expect(request().identity).not.toHaveProperty("pageFrame");
  });

  it("preserves source and occluder roles through worker identity restoration", () => {
    const hybridRequest = {
      type: "compute" as const,
      jobId: 8,
      identity: createOutlineComputeIdentity({
        sketchId: "hybrid",
        schema,
        params: {},
        seed: 1,
        sampledT: 0,
        compositionFrame: hybridSource.space,
        tolerance: 0,
        sourceScene: hybridSource,
      }),
    };

    const response = handleOutlineWorkerMessage(hybridRequest);

    expect(response).toMatchObject({ type: "success", jobId: 8 });
    if (response?.type !== "success") throw new Error("expected success");
    expect(response.scene).toEqual(hiddenLinePass(hybridSource));
    expect(response.scene.primitives.map(({ points }) => points)).toEqual([
      [
        [0, 15],
        [10, 15],
      ],
      [
        [20, 15],
        [40, 15],
      ],
    ]);
  });

  it("hands the full faithful 10k Fill geometry to specialized derivation", () => {
    const params = {
      ...defaultParams(grassHills.schema),
      bladeDensity: 2,
    };
    const compositionFrame = { width: 1_000, height: 1_000 };
    const identity = createOutlineComputeIdentity({
      sketchId: grassHills.id,
      schema: grassHills.schema,
      params,
      seed: 12345,
      sampledT: 1.25,
      compositionFrame,
      tolerance: 0.4,
      outlineTarget: {
        toolWidthMillimeters: 0.3,
        millimetersPerSceneUnit: 0.18,
      },
    });
    const completed: Scene = {
      space: compositionFrame,
      primitives: [
        {
          points: [[10, 20], [30, 40]],
          stroke: { color: "black", width: 1 },
        },
      ],
    };
    const derive = vi.fn((..._args: Parameters<typeof outlineScene>) =>
      completed,
    );

    const response = handleOutlineWorkerMessage(
      { type: "compute", jobId: 9, identity },
      derive as typeof outlineScene,
    );

    expect(response).toMatchObject({
      type: "success",
      jobId: 9,
      scene: completed,
    });
    expect(identity.sourceKind).toBe("specialized-sketch");
    expect("sourceScene" in identity).toBe(false);
    const specialized = derive.mock.calls[0]![0];
    const fill = grassHills.generate(
      params,
      identity.seed,
      identity.sampledT,
      compositionFrame,
    );
    expect(
      fill.primitives.filter(({ closed }) => closed === true),
    ).toHaveLength(10_000);
    expect(specialized.primitives).toHaveLength(fill.primitives.length);
    expect(
      specialized.primitives.map(({ points, closed, fill: primitiveFill }) => ({
        points,
        closed,
        fill: primitiveFill,
      })),
    ).toEqual(
      fill.primitives.map(({ points, closed, fill: primitiveFill }) => ({
        points,
        closed,
        fill: primitiveFill,
      })),
    );
    expect(
      specialized.primitives.every(
        ({ hiddenLineRole }) => hiddenLineRole === "both",
      ),
    ).toBe(true);
    expect(
      specialized.primitives.every(
        ({ stroke }) => stroke?.width === 5 / 3,
      ),
    ).toBe(true);
    expect(derive).toHaveBeenCalledWith(specialized, 0.4, undefined);
  });

  it("dispatches completed artwork to Scene-based specialization without regeneration", () => {
    const completed: Scene = {
      space: { width: 40, height: 30 },
      primitives: [
        {
          points: [
            [2, 3],
            [11, 13],
            [17, 19],
          ],
          closed: false,
          stroke: { color: "navy", width: 0.75 },
          hiddenLineRole: "source",
        },
        {
          points: [
            [23, 5],
            [29, 7],
          ],
          closed: false,
          stroke: { color: "green", width: 1.25 },
          hiddenLineRole: "source",
        },
      ],
    };
    const specialized: Scene = {
      space: { width: 40, height: 30 },
      primitives: completed.primitives.map((primitive) => ({
        points: primitive.points.map(([x, y]) => [x, y]),
        ...(primitive.closed === undefined
          ? {}
          : { closed: primitive.closed }),
        stroke: { color: "black", width: 5 / 3 },
        hiddenLineRole: "source",
      })),
    };
    const generate = vi.fn(toneCalibration.generate);
    const registryGet = vi
      .spyOn(registry, "get")
      .mockReturnValue({ ...toneCalibration, generate });
    const target = {
      toolWidthMillimeters: 0.3,
      millimetersPerSceneUnit: 0.18,
    };
    const identity = createOutlineComputeIdentity({
      sketchId: toneCalibration.id,
      schema: toneCalibration.schema,
      params: defaultParams(toneCalibration.schema),
      seed: "prepared-seed",
      sampledT: 0,
      compositionFrame: completed.space,
      tolerance: 0.2,
      sourceScene: completed,
      outlineTarget: target,
    });
    const derive = vi.fn((..._args: Parameters<typeof outlineScene>) =>
      specialized,
    );

    const response = handleOutlineWorkerMessage(
      { type: "compute", jobId: 12, identity },
      derive,
    );

    expect(response).toMatchObject({ type: "success", jobId: 12 });
    expect(identity.sourceKind).toBe("completed-scene-sketch");
    expect(generate).not.toHaveBeenCalled();
    expect(derive).toHaveBeenCalledWith(specialized, 0.2, undefined);
    expect(derive.mock.calls[0]?.[0]).toEqual(specialized);
    expect(derive.mock.calls[0]?.[0]).not.toBe(completed);
    expect(derive.mock.calls[0]?.[0].primitives).toHaveLength(2);
    expect(derive.mock.calls[0]?.[0]).not.toHaveProperty("background");
    expect(
      derive.mock.calls[0]?.[0].primitives.every(
        (primitive) => primitive.fill === undefined,
      ),
    ).toBe(true);
    registryGet.mockRestore();
  });

  it("rejects completed-Scene specialization mismatches without regeneration fallback", () => {
    const identity = createOutlineComputeIdentity({
      sketchId: "circles",
      schema,
      params: {},
      seed: 1,
      sampledT: 0,
      compositionFrame: source.space,
      tolerance: 0,
      sourceScene: source,
      outlineTarget: {
        toolWidthMillimeters: 0.3,
        millimetersPerSceneUnit: 0.18,
      },
    });
    const derive = vi.fn();

    expect(
      handleOutlineWorkerMessage(
        { type: "compute", jobId: 13, identity },
        derive,
      ),
    ).toMatchObject({
      type: "failure",
      jobId: 13,
      error: "Sketch circles has no completed-Scene Outline source",
    });
    expect(derive).not.toHaveBeenCalled();
  });

  it("surfaces a specialized-source mismatch without legacy fallback", () => {
    const identity = createOutlineComputeIdentity({
      sketchId: "circles",
      schema,
      params: {},
      seed: 1,
      sampledT: 0,
      compositionFrame: source.space,
      tolerance: 0,
      outlineTarget: {
        toolWidthMillimeters: 0.3,
        millimetersPerSceneUnit: 0.18,
      },
    });
    const derive = vi.fn();

    expect(
      handleOutlineWorkerMessage(
        { type: "compute", jobId: 10, identity },
        derive,
      ),
    ).toMatchObject({
      type: "failure",
      jobId: 10,
      error: "Sketch circles has no specialized Outline source",
    });
    expect(derive).not.toHaveBeenCalled();
  });

  it("surfaces specialized generation failures without downgrading to Fill input", () => {
    const identity = createOutlineComputeIdentity({
      sketchId: grassHills.id,
      schema: grassHills.schema,
      params: {
        ...defaultParams(grassHills.schema),
        bladeDensity: 11,
      },
      seed: 12345,
      sampledT: 0,
      compositionFrame: { width: 1_000, height: 1_000 },
      tolerance: 0,
      outlineTarget: {
        toolWidthMillimeters: 0.3,
        millimetersPerSceneUnit: 0.18,
      },
    });
    const derive = vi.fn();

    expect(
      handleOutlineWorkerMessage(
        { type: "compute", jobId: 11, identity },
        derive,
      ),
    ).toMatchObject({
      type: "failure",
      jobId: 11,
      error: "bladeDensity must be between 0 and 10",
    });
    expect(derive).not.toHaveBeenCalled();
  });

  it("emits compact terminal progress before success for zero work", () => {
    const empty: Scene = { space: source.space, primitives: [] };
    const emptyRequest = {
      ...request(),
      identity: createOutlineComputeIdentity({
        sketchId: "empty",
        schema,
        params: {},
        seed: 1,
        sampledT: 0,
        compositionFrame: empty.space,
        tolerance: 0,
        sourceScene: empty,
      }),
    };
    const events: unknown[] = [];

    const response = handleOutlineWorkerMessage(
      emptyRequest,
      outlineScene,
      (progress) => events.push(progress),
      () => 0,
    );
    events.push(response);

    expect(events).toEqual([
      {
        type: "progress",
        jobId: 7,
        snapshot: {
          completedWorkUnits: 0,
          totalWorkUnits: 0,
          terminal: true,
        },
      },
      expect.objectContaining({ type: "success", jobId: 7 }),
    ]);
    expect(Object.keys(events[0] as object)).toEqual([
      "type",
      "jobId",
      "snapshot",
    ]);
  });

  it("emits an initial update, at most one per elapsed interval, and terminal", () => {
    const emitted: unknown[] = [];
    const clock = [0, 25, 99, 100, 150];
    const derive: typeof outlineScene = (scene, _tolerance, observer) => {
      for (const completedWorkUnits of [10, 20, 30, 40, 50]) {
        observer?.({
          completedWorkUnits,
          totalWorkUnits: 100,
          terminal: false,
        });
      }
      observer?.({
        completedWorkUnits: 100,
        totalWorkUnits: 100,
        terminal: true,
      });
      return scene;
    };

    const response = handleOutlineWorkerMessage(
      request(),
      derive,
      (progress) => emitted.push(progress),
      () => clock.shift() ?? 150,
    );

    expect(emitted).toHaveLength(3);
    expect(emitted).toEqual([
      expect.objectContaining({
        snapshot: expect.objectContaining({ completedWorkUnits: 10 }),
      }),
      expect.objectContaining({
        snapshot: expect.objectContaining({ completedWorkUnits: 40 }),
      }),
      expect.objectContaining({
        snapshot: expect.objectContaining({
          completedWorkUnits: 100,
          terminal: true,
        }),
      }),
    ]);
    expect(response).toMatchObject({ type: "success", jobId: 7 });
  });

  it.each([null, {}, { type: "compute" }, { type: "compute", jobId: 1 }])(
    "rejects malformed input before geometry: %o",
    (candidate) => {
      const derive = vi.fn();
      expect(handleOutlineWorkerMessage(candidate, derive)).toBeNull();
      expect(derive).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown roles before either worker runtime reaches geometry", () => {
    const malformed = structuredClone({
      type: "compute",
      jobId: 8,
      identity: createOutlineComputeIdentity({
        sketchId: "hybrid",
        schema,
        params: {},
        seed: 1,
        sampledT: 0,
        compositionFrame: hybridSource.space,
        tolerance: 0,
        sourceScene: hybridSource,
      }),
    }) as Record<string, any>;
    malformed.identity.sourceScene.primitives[0].hiddenLineRole = "unknown";
    const derive = vi.fn();

    expect(handleOutlineWorkerMessage(malformed, derive)).toBeNull();
    expect(
      handleHiddenLineWorkerMessage(
        {
          type: "preview",
          jobKind: "preview",
          owner: "outline-preview",
          jobId: 9,
          identity: malformed.identity,
        },
        { derive },
      ),
    ).toBeNull();
    expect(derive).not.toHaveBeenCalled();
  });

  it("turns thrown geometry errors into safe domain failures", () => {
    const response = handleOutlineWorkerMessage(request(), () => {
      throw new Error("geometry exploded");
    });
    expect(response).toMatchObject({
      type: "failure",
      jobId: 7,
      error: "geometry exploded",
    });
  });
});

const plotProfile: PlotProfile = {
  width: 220,
  height: 170,
  insets: { top: 10, right: 10, bottom: 10, left: 10 },
  includeFrame: true,
  toolWidthMillimeters: 0.3,
};

function exportIdentity(
  overrides: Partial<{
    tolerance: number;
    seed: number;
  }> = {},
): OutlineComputeIdentity {
  return createOutlineComputeIdentity({
    sketchId: "test",
    schema,
    params: {},
    seed: overrides.seed ?? 1,
    sampledT: 0,
    compositionFrame: source.space,
    tolerance: overrides.tolerance ?? 0,
    sourceScene: source,
  });
}

function physicalExportIdentity(
  sourceKind: "specialized-sketch" | "completed-scene-sketch",
  target = {
    toolWidthMillimeters: 0.5,
    millimetersPerSceneUnit: 5,
  },
): OutlineComputeIdentity {
  const sketch =
    sourceKind === "specialized-sketch" ? grassHills : toneCalibration;
  return createOutlineComputeIdentity({
    sketchId: sketch.id,
    schema: sketch.schema,
    params: defaultParams(sketch.schema),
    seed: "physical-target",
    sampledT: 0.75,
    compositionFrame: source.space,
    tolerance: 0.2,
    ...(sourceKind === "completed-scene-sketch"
      ? { sourceScene: source }
      : {}),
    outlineTarget: target,
  });
}

function exportRequest({
  identity = exportIdentity(),
  profile = plotProfile,
  pageFrame = null,
  includePaperMargins = true,
  reusableOutline,
}: {
  identity?: OutlineComputeIdentity;
  profile?: PlotProfile;
  pageFrame?: PageFrame | null;
  includePaperMargins?: boolean;
  reusableOutline?: { identity: OutlineComputeIdentity; scene: Scene };
} = {}) {
  return {
    type: "export" as const,
    jobKind: "export" as const,
    owner: "hidden-line-export" as const,
    jobId: 11,
    snapshot: createHiddenLineExportSnapshot({
      identity,
      profile,
      pageFrame,
      metadata: '{"sketch":"test","seed":1}',
      includePaperMargins,
      filename: "test-seed1-hidden-line.svg",
      ...(reusableOutline === undefined ? {} : { reusableOutline }),
    }),
  };
}

const reusableIdentityMismatches: ReadonlyArray<
  readonly [string, (copy: Record<string, any>) => void]
> = [
  ["sketch id", (copy) => (copy.sketchId = "other")],
  ["params", (copy) => (copy.params[0].value = 0.123)],
  ["seed", (copy) => (copy.seed = "other")],
  ["sampled time", (copy) => (copy.sampledT = 0.8)],
  ["Composition Frame", (copy) => (copy.compositionFrame.width = 41)],
  ["tolerance", (copy) => (copy.tolerance = 0.25)],
  [
    "source kind",
    (copy) => {
      copy.sourceKind = "specialized-sketch";
      delete copy.sourceScene;
    },
  ],
  [
    "completed source Scene",
    (copy) => (copy.sourceScene.primitives[0].points[0][0] = 2),
  ],
];

describe("hidden-line export worker runtime", () => {
  it("retains ordered completed Stipples while Page finalization restyles, rebases, and maps them", () => {
    const params = {
      ...defaultParams(toneCalibration.schema),
      strategy: "stippling",
    };
    const previewTarget = {
      toolWidthMillimeters: 0.3,
      millimetersPerSceneUnit: 0.2,
    };
    const previewIdentity = createOutlineComputeIdentity({
      sketchId: toneCalibration.id,
      schema: toneCalibration.schema,
      params,
      seed: "ordered-stipples",
      sampledT: 0,
      compositionFrame: completedStippling.space,
      tolerance: 0,
      sourceScene: completedStippling,
      outlineTarget: previewTarget,
    });
    const generate = vi.fn(toneCalibration.generate);
    const registryGet = vi
      .spyOn(registry, "get")
      .mockReturnValue({ ...toneCalibration, generate });
    const derive = vi.fn((...args: Parameters<typeof outlineScene>) =>
      outlineScene(...args),
    );

    try {
      const preview = handleHiddenLineWorkerMessage(
        {
          type: "preview",
          jobKind: "preview",
          owner: "outline-preview",
          jobId: 40,
          identity: previewIdentity,
        },
        { derive },
      );
      expect(preview).toMatchObject({
        type: "complete",
        jobKind: "preview",
        identity: previewIdentity,
      });
      if (preview?.type !== "complete" || preview.jobKind !== "preview") {
        throw new Error("expected preview completion");
      }
      expect(preview.scene.primitives.map(({ points }) => points)).toEqual([
        [[150, 250], [150.5, 250]],
        [[400, 300], [400, 300.5]],
        [[800, 700], [799.5, 700]],
      ]);
      expect(
        preview.scene.primitives.map(({ stroke }) => stroke?.color),
      ).toEqual(["black", "black", "black"]);
      for (const primitive of preview.scene.primitives) {
        expect(primitive.stroke?.width).toBeCloseTo(1.5, 12);
        expect(primitive.closed).not.toBe(true);
      }
      expect(
        preview.scene.primitives.every(({ points }) => points.length === 2),
      ).toBe(true);
      expect(derive).toHaveBeenCalledOnce();
      expect(generate).not.toHaveBeenCalled();

      const exportIdentity = createOutlineComputeIdentity({
        sketchId: toneCalibration.id,
        schema: toneCalibration.schema,
        params,
        seed: "ordered-stipples",
        sampledT: 0,
        compositionFrame: completedStippling.space,
        tolerance: 0,
        sourceScene: completedStippling,
        outlineTarget: {
          toolWidthMillimeters: 0.5,
          millimetersPerSceneUnit: 0.25,
        },
      });
      const pageFrame: PageFrame = {
        x: 100,
        y: 200,
        width: 800,
        height: 600,
      };
      const profile: PlotProfile = {
        width: 220,
        height: 170,
        insets: { top: 10, right: 10, bottom: 10, left: 10 },
        includeFrame: true,
        toolWidthMillimeters: 0.5,
      };
      const clip = vi.fn((scene: Scene) => scene);
      const exported = handleHiddenLineWorkerMessage(
        exportRequest({
          identity: exportIdentity,
          profile,
          pageFrame,
          reusableOutline: {
            identity: previewIdentity,
            scene: preview.scene,
          },
        }),
        { derive, clip },
      );

      expect(exported).toMatchObject({
        type: "complete",
        jobKind: "export",
        identity: exportIdentity,
        completedOutline: {
          identity: exportIdentity,
          scene: preview.scene,
        },
      });
      expect(derive).toHaveBeenCalledOnce();
      expect(generate).not.toHaveBeenCalled();
      expect(clip).toHaveBeenCalledOnce();
      expect(clip.mock.calls[0]![0]).toEqual({
        space: { width: 800, height: 600 },
        primitives: [
          {
            points: [[50, 50], [50.5, 50]],
            stroke: { color: "black", width: 2 },
          },
          {
            points: [[300, 100], [300, 100.5]],
            stroke: { color: "black", width: 2 },
          },
          {
            points: [[700, 500], [699.5, 500]],
            stroke: { color: "black", width: 2 },
          },
          {
            points: [[0, 0], [800, 0], [800, 600], [0, 600], [0, 0]],
            stroke: { color: "black", width: 2 },
          },
        ],
      });
      const paths =
        exported?.type === "complete" && exported.jobKind === "export"
          ? exported.svg.match(/<path\b[^>]*>/g) ?? []
          : [];
      expect(paths.map((path) => path.match(/d="([^"]+)"/)?.[1])).toEqual([
        "M22.5 22.5 L22.625 22.5",
        "M85 35 L85 35.125",
        "M185 135 L184.875 135",
        "M10 10 L210 10 L210 160 L10 160 L10 10",
      ]);
      expect(
        paths.map((path) => path.match(/stroke-width="([^"]+)"/)?.[1]),
      ).toEqual(["0.5", "0.5", "0.5", "0.5"]);
      expect(
        exported?.type === "complete" && exported.jobKind === "export"
          ? exported.svg
          : "",
      ).not.toMatch(/<rect\b|fill="(?!none)/);
    } finally {
      registryGet.mockRestore();
    }
  });

  it("derives the shared asymmetric fixed Page through Tone Calibration's registered completed-Scene source", () => {
    const millimetersPerSceneUnit =
      265 / FIXED_PAGE_PARITY_FRAME.width;
    const sourceScene = fixedPageParityScene();
    const identity = createOutlineComputeIdentity({
      sketchId: toneCalibration.id,
      schema: toneCalibration.schema,
      params: defaultParams(toneCalibration.schema),
      seed: "fixed-page-output-parity",
      sampledT: 0,
      compositionFrame: FIXED_PAGE_PARITY_COMPOSITION,
      tolerance: 0,
      sourceScene,
      outlineTarget: {
        toolWidthMillimeters:
          FIXED_PAGE_PARITY_PROFILE.toolWidthMillimeters,
        millimetersPerSceneUnit,
      },
    });

    const response = handleHiddenLineWorkerMessage(
      exportRequest({
        identity,
        profile: FIXED_PAGE_PARITY_PROFILE,
        pageFrame: FIXED_PAGE_PARITY_FRAME,
      }),
    );

    expect(response).toMatchObject({
      type: "complete",
      jobKind: "export",
      completedOutline: {
        identity,
        scene: {
          space: FIXED_PAGE_PARITY_COMPOSITION,
          primitives: [
            {
              points: sourceScene.primitives[0]!.points,
              stroke: {
                color: "black",
                width:
                  FIXED_PAGE_PARITY_PROFILE.toolWidthMillimeters /
                  millimetersPerSceneUnit,
              },
            },
          ],
        },
      },
    });
    if (response?.type !== "complete" || response.jobKind !== "export") {
      throw new Error("expected export completion");
    }
    const paths = response.svg.match(/<path\b[^>]*>/g) ?? [];
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain('d="M70 34.9 L282 162.1"');
    expect(paths[0]).toContain('stroke="black"');
    expect(paths[0]).toContain('stroke-width="0.37"');
    expect(paths[1]).toContain('d="M17 19 L282 19 L282 178 L17 178 L17 19"');
    expect(paths[1]).toContain('stroke="black"');
    expect(paths[1]).toContain('stroke-width="0.37"');
    expect(response.svg).not.toContain("#123456");
    expect(response.svg).not.toContain("#f4efe6");
  });

  it("derives a cache miss through the frame-free shared seam exactly once", () => {
    const identity = exportIdentity({ tolerance: 0.25 });
    const derived = outlineScene(source, identity.tolerance);
    const derive = vi.fn((...args: Parameters<typeof outlineScene>) =>
      outlineScene(...args),
    );

    const response = handleHiddenLineWorkerMessage(
      exportRequest({ identity }),
      { derive },
    );

    expect(derive).toHaveBeenCalledOnce();
    expect(derive).toHaveBeenCalledWith(source, 0.25, undefined);
    expect(response).toMatchObject({
      type: "complete",
      jobKind: "export",
      owner: "hidden-line-export",
      filename: "test-seed1-hidden-line.svg",
      completedOutline: { identity, scene: derived },
    });
    if (response?.type !== "complete" || response.jobKind !== "export") {
      throw new Error("expected export completion");
    }
    expect(response.completedOutline.scene.primitives).not.toContainEqual({
      points: [
        [0, 0],
        [40, 0],
        [40, 30],
        [0, 30],
        [0, 0],
      ],
      stroke: { color: "black", width: 1 },
    });
  });

  it("reuses an exact candidate without deriving, but derives after any identity mismatch", () => {
    const identity = exportIdentity();
    const completed = outlineScene(source, 0);
    const derive = vi.fn((...args: Parameters<typeof outlineScene>) =>
      outlineScene(...args),
    );

    const hit = handleHiddenLineWorkerMessage(
      exportRequest({
        identity,
        reusableOutline: { identity, scene: completed },
      }),
      { derive },
    );
    expect(hit).toMatchObject({
      type: "complete",
      completedOutline: { scene: completed },
    });
    expect(derive).not.toHaveBeenCalled();

    const mismatched = exportIdentity({ seed: 2 });
    const missRequest = exportRequest({
      identity,
      reusableOutline: { identity: mismatched, scene: completed },
    });
    expect(missRequest.snapshot.reusableOutline).toBeUndefined();
    handleHiddenLineWorkerMessage(missRequest, { derive });
    expect(derive).toHaveBeenCalledOnce();
  });

  it.each([
    "specialized-sketch",
    "completed-scene-sketch",
  ] as const)(
    "reuses %s geometry across a target-only change and applies the current target before Page finalization",
    (sourceKind) => {
      const current = physicalExportIdentity(sourceKind, {
        toolWidthMillimeters: 0.5,
        millimetersPerSceneUnit: 10,
      });
      const prior = structuredClone(current) as OutlineComputeIdentity;
      if (prior.sourceKind === "legacy-scene") {
        throw new Error("expected physical-tool identity");
      }
      (
        prior.outlineTarget as { toolWidthMillimeters: number }
      ).toolWidthMillimeters = 0.3;
      (
        prior.outlineTarget as { millimetersPerSceneUnit: number }
      ).millimetersPerSceneUnit = 5;
      const completed: Scene = {
        space: source.space,
        primitives: [
          {
            points: [[5, 10], [35, 10]],
            stroke: { color: "navy", width: 0.06 },
          },
        ],
      };
      const profile: PlotProfile = {
        ...plotProfile,
        includeFrame: true,
        toolWidthMillimeters: 0.5,
      };
      const pageFrame: PageFrame = {
        x: 10,
        y: 5,
        width: 20,
        height: 15,
      };
      const derive = vi.fn(() => {
        throw new Error("target-only reuse must skip hidden-line derivation");
      });
      const clip = vi.fn((scene: Scene) => scene);
      const captured = exportRequest({
        identity: current,
        profile,
        pageFrame,
        reusableOutline: { identity: prior, scene: completed },
      });

      expect(captured.snapshot.identity).toEqual(current);
      expect(captured.snapshot.reusableOutline?.identity).toEqual(prior);
      expect(outlineComputeIdentitiesEqual(current, prior)).toBe(false);

      const response = handleHiddenLineWorkerMessage(
        captured,
        { derive, clip },
      );

      expect(derive).not.toHaveBeenCalled();
      expect(clip).toHaveBeenCalledOnce();
      const finalized = clip.mock.calls[0]![0];
      expect(finalized.space).toEqual({ width: 20, height: 15 });
      expect(finalized.primitives.map(({ stroke }) => stroke?.width)).toEqual([
        0.05,
        0.05,
      ]);
      expect(finalized.primitives.at(-1)).toEqual({
        points: [[0, 0], [20, 0], [20, 15], [0, 15], [0, 0]],
        stroke: { color: "black", width: 0.05 },
      });
      expect(response).toMatchObject({
        type: "complete",
        jobKind: "export",
        identity: current,
        completedOutline: { identity: current, scene: completed },
      });
      if (response?.type !== "complete" || response.jobKind !== "export") {
        throw new Error("expected export completion");
      }
      expect(response.svg.match(/stroke-width="0.5"/g)).toHaveLength(2);
      expect(outlineComputeIdentitiesEqual(response.identity, current)).toBe(
        true,
      );
      expect(
        outlineComputeIdentitiesEqual(
          response.completedOutline.identity,
          current,
        ),
      ).toBe(true);
      expect(
        outlineComputeIdentitiesEqual(
          response.completedOutline.identity,
          prior,
        ),
      ).toBe(false);
    },
  );

  it.each(reusableIdentityMismatches)(
    "derives after a reusable %s mismatch",
    (_name, mutate) => {
      const current = physicalExportIdentity("completed-scene-sketch");
      const candidate = structuredClone(current) as Record<string, any>;
      mutate(candidate);
      const completed = outlineScene(source, current.tolerance);
      const request = exportRequest({
        identity: current,
        profile: { ...plotProfile, toolWidthMillimeters: 0.5 },
        reusableOutline: {
          identity: candidate as OutlineComputeIdentity,
          scene: completed,
        },
      });
      const derive = vi.fn(() => completed);

      expect(request.snapshot.reusableOutline).toBeUndefined();
      handleHiddenLineWorkerMessage(request, { derive });

      expect(derive).toHaveBeenCalledOnce();
    },
  );

  it("preserves legacy authored strokes while giving only the Page outline the current physical width", () => {
    const identity = exportIdentity();
    const completed: Scene = {
      space: source.space,
      primitives: [
        {
          points: [[5, 10], [35, 10]],
          stroke: { color: "navy", width: 3 },
        },
      ],
    };
    const profile: PlotProfile = {
      ...plotProfile,
      toolWidthMillimeters: 0.5,
    };
    const pageFrame: PageFrame = {
      x: 10,
      y: 5,
      width: 20,
      height: 15,
    };
    const clip = vi.fn((scene: Scene) => scene);

    const response = handleHiddenLineWorkerMessage(
      exportRequest({
        identity,
        profile,
        pageFrame,
        reusableOutline: { identity, scene: completed },
      }),
      { clip },
    );

    expect(
      clip.mock.calls[0]![0].primitives.map(({ stroke }) => stroke?.width),
    ).toEqual([3, 0.05]);
    expect(response).toMatchObject({ type: "complete", jobKind: "export" });
    if (response?.type !== "complete" || response.jobKind !== "export") {
      throw new Error("expected export completion");
    }
    expect(response.svg).toContain('stroke-width="30"');
    expect(response.svg).toContain('stroke-width="0.5"');

    const differentSourceKind = {
      ...structuredClone(identity),
      sourceKind: "completed-scene-sketch",
      outlineTarget: {
        toolWidthMillimeters: 0.5,
        millimetersPerSceneUnit: 10,
      },
    } as OutlineComputeIdentity;
    const miss = exportRequest({
      identity,
      profile,
      pageFrame,
      reusableOutline: { identity: differentSourceKind, scene: completed },
    });
    expect(miss.snapshot.reusableOutline).toBeUndefined();
  });

  it("is deterministic with the prior derive → clip → plotter expression", () => {
    const identity = exportIdentity({ tolerance: 0.5 });
    const expectedScene = outlineScene(source, 0.5);
    const finalizedScene = finalizeOutlineScene(
      expectedScene,
      null,
      plotProfile.includeFrame,
      {
        kind: "legacy-scene",
        target: {
          toolWidthMillimeters: plotProfile.toolWidthMillimeters,
          millimetersPerSceneUnit: 5,
        },
      },
    );
    const expectedSvg = renderPlotterSVG(
      clipSceneToBounds(finalizedScene),
      plotProfile,
      '{"sketch":"test","seed":1}',
      { includePaperMargins: true },
    );

    const response = handleHiddenLineWorkerMessage(exportRequest({ identity }));
    expect(response).toMatchObject({
      type: "complete",
      svg: expectedSvg,
      completedOutline: { scene: expectedScene },
    });
  });

  it("reuses one base across Page, profile, and frame-visibility changes", () => {
    const identity = exportIdentity();
    const completed = outlineScene(source, 0);
    const derive = vi.fn(() => completed);
    const larger: PlotProfile = {
      width: 420,
      height: 320,
      insets: { top: 10, right: 10, bottom: 10, left: 10 },
      includeFrame: true,
      toolWidthMillimeters: 0.3,
    };

    const first = handleHiddenLineWorkerMessage(
      exportRequest({
        identity,
        reusableOutline: { identity, scene: completed },
      }),
      { derive },
    );
    const second = handleHiddenLineWorkerMessage(
      exportRequest({
        identity,
        profile: larger,
        pageFrame: { x: 5, y: 5, width: 20, height: 15 },
        reusableOutline: { identity, scene: completed },
      }),
      { derive },
    );
    const third = handleHiddenLineWorkerMessage(
      exportRequest({
        identity,
        profile: { ...larger, includeFrame: false },
        pageFrame: { x: -5, y: -5, width: 40, height: 30 },
        reusableOutline: { identity, scene: completed },
      }),
      { derive },
    );

    expect(derive).not.toHaveBeenCalled();
    expect(first).toMatchObject({ type: "complete" });
    expect(second).toMatchObject({ type: "complete" });
    expect(third).toMatchObject({ type: "complete" });
    if (
      first?.type !== "complete" ||
      first.jobKind !== "export" ||
      second?.type !== "complete" ||
      second.jobKind !== "export" ||
      third?.type !== "complete" ||
      third.jobKind !== "export"
    ) {
      throw new Error("expected export completions");
    }
    expect(first.svg).toContain('width="220mm" height="170mm"');
    expect(second.svg).toContain('width="420mm" height="320mm"');
    expect(second.completedOutline).toEqual(first.completedOutline);
    expect(third.completedOutline).toEqual(first.completedOutline);
    expect(second.svg.match(/<path /g)).toHaveLength(
      (third.svg.match(/<path /g)?.length ?? 0) + 1,
    );
  });

  it("clips before rendering and forwards captured margins, metadata, and filename", () => {
    const identity = exportIdentity();
    const overflow: Scene = {
      space: source.space,
      background: { color: "hotpink" },
      primitives: [
        {
          points: [
            [-5, 10],
            [45, 10],
          ],
          fill: { color: "red" },
          stroke: { color: "black", width: 1 },
        },
      ],
    };
    const clip = vi.fn((scene: Scene) => clipSceneToBounds(scene));
    const render = vi.fn(
      (...args: Parameters<typeof renderPlotterSVG>) =>
        renderPlotterSVG(...args),
    );
    const response = handleHiddenLineWorkerMessage(
      exportRequest({
        identity,
        includePaperMargins: false,
        reusableOutline: { identity, scene: overflow },
      }),
      { clip, render },
    );

    expect(clip).toHaveBeenCalledOnce();
    const finalized = finalizeOutlineScene(overflow, null, true, {
      kind: "legacy-scene",
      target: {
        toolWidthMillimeters: plotProfile.toolWidthMillimeters,
        millimetersPerSceneUnit: 5,
      },
    });
    expect(clip).toHaveBeenCalledWith(finalized);
    expect(render).toHaveBeenCalledWith(
      clipSceneToBounds(finalized),
      plotProfile,
      '{"sketch":"test","seed":1}',
      { includePaperMargins: false },
    );
    expect(response).toMatchObject({
      type: "complete",
      filename: "test-seed1-hidden-line.svg",
    });
    if (response?.type !== "complete" || response.jobKind !== "export") {
      throw new Error("expected export completion");
    }
    expect(response.svg).toContain('data-paper-extent="drawable"');
    expect(response.svg).toContain("<metadata>");
    expect(response.svg).toContain('{"sketch":"test","seed":1}');
    expect(response.svg).not.toContain("hotpink");
    expect(response.svg).not.toContain('fill="red"');
    expect(response.svg.match(/<path /g)).toHaveLength(2);
    expect(response.svg).toContain("M0 50 L200 50");
  });

  it("rebases the final Page, clips every plotted point exactly, and frames the Page boundary", () => {
    const identity = exportIdentity();
    const base: Scene = {
      space: source.space,
      primitives: [
        { points: [[5, 10], [35, 10]], stroke: { color: "black", width: 1 } },
        { points: [[10, 5], [30, 20]], stroke: { color: "blue", width: 1 } },
        { points: [[0, 0], [5, 0]], stroke: { color: "red", width: 1 } },
        { points: [[9, 4], [12, 7]], stroke: { color: "green", width: 4 } },
        {
          points: [[8, 8], [18, 2], [32, 12], [18, 22]],
          closed: true,
          fill: { color: "gray" },
          stroke: { color: "purple", width: 2 },
        },
      ],
    };
    const pageFrame: PageFrame = { x: 10, y: 5, width: 20, height: 15 };
    const render = vi.fn(
      (...args: Parameters<typeof renderPlotterSVG>) =>
        renderPlotterSVG(...args),
    );

    const response = handleHiddenLineWorkerMessage(
      exportRequest({
        identity,
        pageFrame,
        reusableOutline: { identity, scene: base },
      }),
      { render },
    );

    expect(response).toMatchObject({
      type: "complete",
      completedOutline: { scene: base },
    });
    expect(render).toHaveBeenCalledOnce();
    const renderedScene = render.mock.calls[0]![0];
    expect(renderedScene.space).toEqual({ width: 20, height: 15 });
    expect(
      renderedScene.primitives
        .flatMap((primitive) => primitive.points)
        .every(([x, y]) => x >= 0 && x <= 20 && y >= 0 && y <= 15),
    ).toBe(true);
    expect(renderedScene.primitives).not.toContainEqual(
      expect.objectContaining({ stroke: { color: "red", width: 1 } }),
    );
    expect(renderedScene.primitives.at(-1)).toEqual({
      points: [[0, 0], [20, 0], [20, 15], [0, 15], [0, 0]],
      stroke: { color: "black", width: 0.03 },
    });
    expect(render.mock.calls[0]![1]).toEqual(plotProfile);
  });

  it("preserves padded Page origin and unchanged physical insets", () => {
    const identity = exportIdentity();
    const base: Scene = {
      space: source.space,
      primitives: [
        { points: [[0, 0], [40, 30]], stroke: { color: "black", width: 1 } },
      ],
    };
    const pageFrame: PageFrame = { x: -10, y: -5, width: 60, height: 45 };
    const paddedProfile: PlotProfile = {
      width: 220,
      height: 170,
      insets: { ...plotProfile.insets },
      includeFrame: false,
      toolWidthMillimeters: plotProfile.toolWidthMillimeters,
    };
    const render = vi.fn(
      (...args: Parameters<typeof renderPlotterSVG>) =>
        renderPlotterSVG(...args),
    );

    handleHiddenLineWorkerMessage(
      exportRequest({
        identity,
        profile: paddedProfile,
        pageFrame,
        reusableOutline: { identity, scene: base },
      }),
      { render },
    );

    expect(render.mock.calls[0]![0]).toMatchObject({
      space: { width: 60, height: 45 },
      primitives: [{ points: [[10, 5], [50, 35]] }],
    });
    expect(render.mock.calls[0]![1]).toEqual(paddedProfile);
    expect(render.mock.calls[0]![1].insets).toEqual(plotProfile.insets);
  });

  it("emits derivation progress, then finalizing, before returning complete", () => {
    const events: unknown[] = [];
    const response = handleHiddenLineWorkerMessage(
      exportRequest(),
      {},
      (event) => events.push(event),
      () => 0,
    );
    events.push(response);

    expect(events.at(-2)).toMatchObject({
      type: "finalizing",
      jobKind: "export",
      owner: "hidden-line-export",
      jobId: 11,
    });
    expect(events.at(-1)).toMatchObject({
      type: "complete",
      jobKind: "export",
      jobId: 11,
    });
    expect(
      events.some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "derivation-progress",
      ),
    ).toBe(true);
    for (const event of events.slice(0, -1)) {
      if (
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        (event.type === "derivation-progress" || event.type === "finalizing")
      ) {
        expect(event).not.toHaveProperty("identity");
        expect(event).not.toHaveProperty("sourceScene");
        expect(Object.keys(event)).toEqual(
          event.type === "derivation-progress"
            ? ["jobKind", "owner", "jobId", "type", "snapshot"]
            : ["type", "jobKind", "owner", "jobId"],
        );
      }
    }
  });

  it("keeps export status byte size independent of the legacy source Scene", () => {
    const statusBytes = (primitiveCount: number): number[] => {
      const largeSource: Scene = {
        space: source.space,
        primitives: Array.from({ length: primitiveCount }, (_, index) => ({
          points: [[index, index + 1] as [number, number]],
        })),
      };
      const identity = createOutlineComputeIdentity({
        sketchId: "size-independent",
        schema,
        params: {},
        seed: 1,
        sampledT: 0,
        compositionFrame: source.space,
        tolerance: 0,
        sourceScene: largeSource,
      });
      const events: unknown[] = [];
      const derive = vi.fn(
        (
          _scene: Scene,
          _tolerance: number,
          report?: Parameters<typeof outlineScene>[2],
        ) => {
          report?.({
            completedWorkUnits: 1,
            totalWorkUnits: 2,
            terminal: false,
          });
          report?.({
            completedWorkUnits: 2,
            totalWorkUnits: 2,
            terminal: true,
          });
          return source;
        },
      );
      handleHiddenLineWorkerMessage(
        exportRequest({ identity }),
        { derive: derive as typeof outlineScene },
        (event) => events.push(event),
        () => 0,
      );
      return events.map((event) => new TextEncoder().encode(JSON.stringify(event)).byteLength);
    };

    expect(statusBytes(1)).toEqual(statusBytes(2_000));
  });

  it("gives production preview and cold export the exact same derived Outline Scene", () => {
    const identity = exportIdentity({ tolerance: 0.5 });
    const preview = handleOutlineWorkerMessage({
      type: "compute",
      jobId: 21,
      identity,
    });
    const coldExport = handleHiddenLineWorkerMessage(
      {
        ...exportRequest({ identity }),
        jobId: 22,
      },
    );

    expect(preview?.type).toBe("success");
    expect(coldExport).toMatchObject({ type: "complete", jobKind: "export" });
    if (
      preview?.type !== "success" ||
      coldExport?.type !== "complete" ||
      coldExport.jobKind !== "export"
    ) {
      throw new Error("expected preview and export completions");
    }
    expect(coldExport.completedOutline).toEqual({
      identity,
      scene: preview.scene,
    });
  });

  it.each([
    ["Tone Calibration", toneCalibration, completedToneCalibration],
    ["Scribble Moon", scribbleMoon, completedScribbleMoon],
  ] as const)(
    "reuses %s's exact completed and simplified preview Scene for plotter export",
    (_name, sketch, completed) => {
      const target = {
        toolWidthMillimeters: 0.5,
        millimetersPerSceneUnit: 0.25,
      };
      const identity = createOutlineComputeIdentity({
        sketchId: sketch.id,
        schema: sketch.schema,
        params: defaultParams(sketch.schema),
        seed: "prepared-result",
        sampledT: 0,
        compositionFrame: completed.space,
        tolerance: 0.1,
        sourceScene: completed,
        outlineTarget: target,
      });
      const generate = vi.fn(sketch.generate);
      const registryGet = vi
        .spyOn(registry, "get")
        .mockReturnValue({ ...sketch, generate });
      const derive = vi.fn((...args: Parameters<typeof outlineScene>) =>
        outlineScene(...args),
      );

      try {
        const preview = handleHiddenLineWorkerMessage(
          {
            type: "preview",
            jobKind: "preview",
            owner: "outline-preview",
            jobId: 31,
            identity,
          },
          { derive },
        );
        expect(preview).toMatchObject({
          type: "complete",
          jobKind: "preview",
          identity,
        });
        if (preview?.type !== "complete" || preview.jobKind !== "preview") {
          throw new Error("expected preview completion");
        }

        const specialized = sketch.deriveOutlineSource!(
          structuredClone(completed),
          target,
        );
        const expected = outlineScene(specialized, 0.1);
        expect(preview.scene).toEqual(expected);
        expect(derive).toHaveBeenCalledOnce();
        expect(derive).toHaveBeenCalledWith(
          specialized,
          0.1,
          undefined,
        );

        const exported = handleHiddenLineWorkerMessage(
          exportRequest({
            identity,
            profile: {
              width: 220,
              height: 220,
              insets: { top: 10, right: 10, bottom: 10, left: 10 },
              includeFrame: false,
              toolWidthMillimeters: 0.5,
            },
            reusableOutline: { identity, scene: preview.scene },
          }),
          { derive },
        );

        expect(exported).toMatchObject({
          type: "complete",
          jobKind: "export",
          completedOutline: { identity, scene: expected },
        });
        expect(derive).toHaveBeenCalledOnce();
        expect(generate).not.toHaveBeenCalled();
      } finally {
        registryGet.mockRestore();
      }
    },
  );

  it.each([
    [
      "clip",
      {
        clip: (_scene: Scene): Scene => {
          throw new Error("clip exploded");
        },
      },
    ],
    [
      "render",
      {
        render: (
          ..._args: Parameters<typeof renderPlotterSVG>
        ): string => {
          throw new Error("render exploded");
        },
      },
    ],
    [
      "invalid render",
      {
        render: (
          ..._args: Parameters<typeof renderPlotterSVG>
        ): string => "   ",
      },
    ],
  ] as const)(
    "returns a safe failure with no partial payload when %s fails",
    (_, dependencies) => {
      const events: unknown[] = [];
      const response = handleHiddenLineWorkerMessage(
        exportRequest(),
        dependencies,
        (event) => events.push(event),
      );

      expect(events.at(-1)).toMatchObject({ type: "finalizing" });
      expect(response).toMatchObject({
        type: "failure",
        jobKind: "export",
        owner: "hidden-line-export",
        jobId: 11,
      });
      expect(response).not.toHaveProperty("svg");
      expect(response).not.toHaveProperty("filename");
      expect(response).not.toHaveProperty("completedOutline");
    },
  );

  it("supports the typed preview envelope without changing preview geometry", () => {
    const identity = exportIdentity({ tolerance: 0.5 });
    const response = handleHiddenLineWorkerMessage({
      type: "preview",
      jobKind: "preview",
      owner: "outline-preview",
      jobId: 12,
      identity,
    });
    expect(response).toEqual({
      type: "complete",
      jobKind: "preview",
      owner: "outline-preview",
      jobId: 12,
      identity,
      scene: outlineScene(source, 0.5),
    });
  });

  it("reuses one hybrid preview Scene for physical SVG export", () => {
    const identity = createOutlineComputeIdentity({
      sketchId: "hybrid",
      schema,
      params: {},
      seed: 1,
      sampledT: 0,
      compositionFrame: hybridSource.space,
      tolerance: 0,
      sourceScene: hybridSource,
    });
    const preview = handleHiddenLineWorkerMessage({
      type: "preview",
      jobKind: "preview",
      owner: "outline-preview",
      jobId: 12,
      identity,
    });
    if (preview?.type !== "complete" || preview.jobKind !== "preview") {
      throw new Error("expected preview completion");
    }
    const derive = vi.fn((...args: Parameters<typeof outlineScene>) =>
      outlineScene(...args),
    );

    const exported = handleHiddenLineWorkerMessage(
      exportRequest({
        identity,
        reusableOutline: { identity, scene: preview.scene },
      }),
      { derive },
    );

    expect(derive).not.toHaveBeenCalled();
    expect(exported).toMatchObject({
      type: "complete",
      jobKind: "export",
      completedOutline: { identity, scene: preview.scene },
    });
    if (exported?.type !== "complete" || exported.jobKind !== "export") {
      throw new Error("expected export completion");
    }
    expect(exported.svg.match(/<path /g)).toHaveLength(3);
  });

  it("exports the exact specialized preview completion without regenerating it", () => {
    const params = {
      ...defaultParams(grassHills.schema),
      hillCount: 1,
      bladeDensity: 0,
      ridgeAmplitude: 0,
    };
    const identity = createOutlineComputeIdentity({
      sketchId: grassHills.id,
      schema: grassHills.schema,
      params,
      seed: 12345,
      sampledT: 0,
      compositionFrame: hybridSource.space,
      tolerance: 0,
      outlineTarget: {
        toolWidthMillimeters: 0.3,
        millimetersPerSceneUnit: 0.18,
      },
    });
    const completedScene = hiddenLinePass(hybridSource);
    const derive = vi.fn(() => completedScene);
    const preview = handleHiddenLineWorkerMessage(
      {
        type: "preview",
        jobKind: "preview",
        owner: "outline-preview",
        jobId: 12,
        identity,
      },
      { derive },
    );
    if (preview?.type !== "complete" || preview.jobKind !== "preview") {
      throw new Error("expected preview completion");
    }
    expect(derive).toHaveBeenCalledOnce();

    const exported = handleHiddenLineWorkerMessage(
      exportRequest({
        identity,
        profile: { ...plotProfile, includeFrame: false },
        reusableOutline: { identity, scene: preview.scene },
      }),
      { derive },
    );

    expect(derive).toHaveBeenCalledOnce();
    expect(exported).toMatchObject({
      type: "complete",
      jobKind: "export",
      completedOutline: { identity, scene: preview.scene },
    });
    if (exported?.type !== "complete" || exported.jobKind !== "export") {
      throw new Error("expected export completion");
    }
    expect(exported.completedOutline.scene).toEqual(preview.scene);
    expect(exported.svg.match(/<path /g)).toHaveLength(
      preview.scene.primitives.length,
    );
  });
});
