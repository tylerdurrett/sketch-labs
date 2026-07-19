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
  type ParamSchema,
  type PlotProfile,
  type Scene,
} from "@harness/core";

import {
  createHiddenLineExportSnapshot,
  createOutlineComputeIdentity,
  type OutlineComputeIdentity,
} from "./outlineComputeProtocol";
import { outlineScene } from "./outlineScene";
import {
  handleHiddenLineWorkerMessage,
  handleOutlineWorkerMessage,
} from "./outlineWorkerRuntime";

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

function request(includeFrame = false, tolerance = 0) {
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
      includeFrame,
      sourceScene: source,
    }),
  };
}

describe("outline worker runtime", () => {
  it("returns direct outlineScene parity, including background and tolerance", () => {
    const response = handleOutlineWorkerMessage(request(false, 0.5));
    expect(response).toMatchObject({ type: "success", jobId: 7 });
    if (response?.type !== "success") throw new Error("expected success");
    expect(response.scene).toEqual(outlineScene(source, 0.5));
    expect(response.scene).toEqual(hiddenLinePass(source, { tolerance: 0.5 }));
    expect(response.scene.background).toBeUndefined();
  });

  it("keeps expensive derivation frame-free when identity includes a frame", () => {
    const response = handleOutlineWorkerMessage(request(true));
    if (response?.type !== "success") throw new Error("expected success");
    expect(response.scene).toEqual(outlineScene(source, 0));
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
        includeFrame: false,
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
      includeFrame: false,
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
      includeFrame: false,
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
      includeFrame: false,
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
      includeFrame: false,
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
      includeFrame: false,
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
        includeFrame: false,
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
        includeFrame: false,
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
    includeFrame: boolean;
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
    includeFrame: overrides.includeFrame ?? true,
    sourceScene: source,
  });
}

function exportRequest({
  identity = exportIdentity(),
  profile = plotProfile,
  includePaperMargins = true,
  reusableOutline,
}: {
  identity?: OutlineComputeIdentity;
  profile?: PlotProfile;
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
      metadata: '{"sketch":"test","seed":1}',
      includePaperMargins,
      filename: "test-seed1-hidden-line.svg",
      ...(reusableOutline === undefined ? {} : { reusableOutline }),
    }),
  };
}

describe("hidden-line export worker runtime", () => {
  it("derives a cache miss through the frame-free shared seam exactly once", () => {
    const identity = exportIdentity({ tolerance: 0.25, includeFrame: true });
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

  it("is deterministic with the prior derive → clip → plotter expression", () => {
    const identity = exportIdentity({ tolerance: 0.5 });
    const expectedScene = outlineScene(source, 0.5);
    const expectedSvg = renderPlotterSVG(
      clipSceneToBounds(expectedScene),
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

  it("reuses geometry across profile-only changes while changing physical output", () => {
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
        reusableOutline: { identity, scene: completed },
      }),
      { derive },
    );

    expect(derive).not.toHaveBeenCalled();
    expect(first).toMatchObject({ type: "complete" });
    expect(second).toMatchObject({ type: "complete" });
    if (
      first?.type !== "complete" ||
      first.jobKind !== "export" ||
      second?.type !== "complete" ||
      second.jobKind !== "export"
    ) {
      throw new Error("expected export completions");
    }
    expect(first.svg).toContain('width="220mm" height="170mm"');
    expect(second.svg).toContain('width="420mm" height="320mm"');
    expect(second.completedOutline).toEqual(first.completedOutline);
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
    expect(clip).toHaveBeenCalledWith(overflow);
    expect(render).toHaveBeenCalledWith(
      clipSceneToBounds(overflow),
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
    expect(response.svg.match(/<path /g)).toHaveLength(1);
    expect(response.svg).toContain("M0 50 L200 50");
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
        includeFrame: false,
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
    const identity = exportIdentity({ tolerance: 0.5, includeFrame: false });
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
        includeFrame: false,
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
    const identity = exportIdentity({ tolerance: 0.5, includeFrame: false });
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
      includeFrame: false,
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
    expect(exported.svg.match(/<path /g)).toHaveLength(2);
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
      includeFrame: false,
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
