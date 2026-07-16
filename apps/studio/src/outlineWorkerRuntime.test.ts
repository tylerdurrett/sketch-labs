import { describe, expect, it, vi } from "vitest";

import {
  clipSceneToBounds,
  defaultParams,
  grassHills,
  hiddenLinePass,
  renderPlotterSVG,
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
    expect(response.scene).toEqual(outlineScene(source, 0.5, false));
    expect(response.scene).toEqual(hiddenLinePass(source, { tolerance: 0.5 }));
    expect(response.scene.background).toBeUndefined();
  });

  it("includes the authored frame through the shared seam", () => {
    const response = handleOutlineWorkerMessage(request(true));
    if (response?.type !== "success") throw new Error("expected success");
    expect(response.scene).toEqual(outlineScene(source, 0, true));
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

  it("derives an opted-in Sketch source generically inside the worker", () => {
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
      compositionFrame: { width: 1_000, height: 1_000 },
      tolerance: 0,
      includeFrame: false,
      outlineTarget: {
        toolWidthMillimeters: 0.3,
        millimetersPerSceneUnit: 0.18,
      },
    });
    const derive = vi.fn((scene: Scene) => scene);

    const response = handleOutlineWorkerMessage(
      { type: "compute", jobId: 9, identity },
      derive as typeof outlineScene,
    );

    expect(response).toMatchObject({ type: "success", jobId: 9 });
    expect(identity.sourceKind).toBe("specialized-sketch");
    expect("sourceScene" in identity).toBe(false);
    const specialized = derive.mock.calls[0]![0];
    expect(specialized).not.toEqual(source);
    expect(specialized.primitives.map(({ hiddenLineRole }) => hiddenLineRole))
      .toEqual(["occluder", "source"]);
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
    const derive: typeof outlineScene = (scene, _tolerance, _frame, observer) => {
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
  it("derives a cache miss through the shared seam exactly once, including one frame", () => {
    const identity = exportIdentity({ tolerance: 0.25, includeFrame: true });
    const derived = outlineScene(
      source,
      identity.tolerance,
      identity.includeFrame,
    );
    const derive = vi.fn((...args: Parameters<typeof outlineScene>) =>
      outlineScene(...args),
    );

    const response = handleHiddenLineWorkerMessage(
      exportRequest({ identity }),
      { derive },
    );

    expect(derive).toHaveBeenCalledOnce();
    expect(derive).toHaveBeenCalledWith(
      source,
      0.25,
      true,
      undefined,
    );
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
    const frame = response.completedOutline.scene.primitives.at(-1);
    expect(frame?.points).toEqual([
      [0, 0],
      [40, 0],
      [40, 30],
      [0, 30],
      [0, 0],
    ]);
    expect(
      response.completedOutline.scene.primitives.filter(
        (primitive) => primitive.points.length === 5,
      ),
    ).toHaveLength(1);
  });

  it("reuses an exact candidate without deriving, but derives after any identity mismatch", () => {
    const identity = exportIdentity();
    const completed = outlineScene(source, 0, true);
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
    const expectedScene = outlineScene(source, 0.5, true);
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
    const completed = outlineScene(source, 0, true);
    const derive = vi.fn(() => completed);
    const larger: PlotProfile = {
      width: 420,
      height: 320,
      insets: { top: 10, right: 10, bottom: 10, left: 10 },
      includeFrame: true,
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
  });

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
      scene: outlineScene(source, 0.5, false),
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

  it("reuses an exact specialized completion without deriving its source again", () => {
    const identity = createOutlineComputeIdentity({
      sketchId: grassHills.id,
      schema: grassHills.schema,
      params: defaultParams(grassHills.schema),
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
    const completedScene = hiddenLinePass(hybridSource);
    const derive = vi.fn(() => {
      throw new Error("exact reuse must not rederive");
    });

    const exported = handleHiddenLineWorkerMessage(
      exportRequest({
        identity,
        reusableOutline: { identity, scene: completedScene },
      }),
      { derive },
    );

    expect(derive).not.toHaveBeenCalled();
    expect(exported).toMatchObject({
      type: "complete",
      jobKind: "export",
      completedOutline: { identity, scene: completedScene },
    });
  });
});
