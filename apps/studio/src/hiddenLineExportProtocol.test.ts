import { describe, expect, it } from "vitest";

import type { ParamSchema, PlotProfile, Scene } from "@harness/core";

import {
  createHiddenLineExportSnapshot,
  createOutlineComputeIdentity,
  isHiddenLineExportSnapshot,
  isHiddenLineWorkerMessage,
  isHiddenLineWorkerRequest,
  type CompletedOutline,
  type CompletedSceneOutlineComputeIdentity,
  type HiddenLineExportSnapshot,
  type LegacyOutlineComputeIdentity,
  type OutlineComputeIdentity,
  type SpecializedOutlineComputeIdentity,
} from "./outlineComputeProtocol";

const schema: ParamSchema = {
  amount: { kind: "number", min: 0, max: 10, default: 1 },
};

function sourceScene(): Scene {
  return {
    space: { width: 100, height: 80 },
    background: { color: "white" },
    primitives: [
      {
        points: [
          [1, 2],
          [30, 40],
        ],
        stroke: { color: "black", width: 1 },
        hiddenLineRole: "source",
      },
    ],
  };
}

function identity(frame = { width: 100, height: 80 }): LegacyOutlineComputeIdentity {
  return createOutlineComputeIdentity({
    sketchId: "lines",
    schema,
    params: { amount: 3 },
    seed: 42,
    sampledT: 1.25,
    compositionFrame: frame,
    tolerance: 0.5,
    sourceScene: sourceScene(),
  });
}

function completedSceneIdentity(): CompletedSceneOutlineComputeIdentity {
  return createOutlineComputeIdentity({
    sketchId: "prepared-lines",
    schema,
    params: { amount: 3 },
    seed: 42,
    sampledT: 1.25,
    compositionFrame: { width: 100, height: 80 },
    tolerance: 0.5,
    sourceScene: sourceScene(),
    outlineTarget: {
      toolWidthMillimeters: 0.3,
      millimetersPerSceneUnit: 0.18,
    },
  });
}

function specializedIdentity(): SpecializedOutlineComputeIdentity {
  return createOutlineComputeIdentity({
    sketchId: "generated-lines",
    schema,
    params: { amount: 3 },
    seed: 42,
    sampledT: 1.25,
    compositionFrame: { width: 100, height: 80 },
    tolerance: 0.5,
    outlineTarget: {
      toolWidthMillimeters: 0.3,
      millimetersPerSceneUnit: 0.18,
    },
  });
}

function profile(scale = 1): PlotProfile {
  return {
    width: 210 * scale,
    height: 168 * scale,
    insets: {
      top: 10 * scale,
      right: 10 * scale,
      bottom: 10 * scale,
      left: 10 * scale,
    },
    includeFrame: true,
    toolWidthMillimeters: 0.3,
  };
}

function completed(
  completedIdentity: OutlineComputeIdentity = identity(),
): { identity: OutlineComputeIdentity; scene: Scene } {
  return { identity: completedIdentity, scene: sourceScene() };
}

function snapshot(
  overrides: Partial<Parameters<typeof createHiddenLineExportSnapshot>[0]> = {},
): HiddenLineExportSnapshot {
  return createHiddenLineExportSnapshot({
    identity: identity(),
    profile: profile(),
    metadata: '{"version":2}',
    includePaperMargins: true,
    filename: "lines-seed42-hidden-line.svg",
    reusableOutline: completed(),
    ...overrides,
  });
}

const identityMismatches: ReadonlyArray<
  readonly [string, (copy: Record<string, any>) => void]
> = [
  ["params", (copy) => {
    copy.params[0].value = 4;
  }],
  ["seed", (copy) => {
    copy.seed = 43;
  }],
  ["sampled time", (copy) => {
    copy.sampledT = 1.5;
  }],
  [
    "Composition Frame",
    (copy) => {
      copy.compositionFrame.width = 101;
    },
  ],
  ["tolerance", (copy) => {
    copy.tolerance = 0.75;
  }],
  [
    "source Scene",
    (copy) => {
      copy.sourceScene.primitives[0].points[0][0] = 2;
    },
  ],
  [
    "source/occluder role",
    (copy) => {
      copy.sourceScene.primitives[0].hiddenLineRole = "both";
    },
  ],
];

describe("hidden-line export snapshot", () => {
  it("deeply copies and freezes every mutable capture and candidate", () => {
    const liveIdentity = identity();
    const liveProfile = profile();
    const livePageFrame = { x: -5, y: 3, width: 110, height: 75 };
    const liveCandidate = completed(liveIdentity);
    const captured = snapshot({
      identity: liveIdentity,
      profile: liveProfile,
      pageFrame: livePageFrame,
      reusableOutline: liveCandidate,
    });

    liveProfile.width = 999;
    liveProfile.insets.left = 99;
    livePageFrame.x = 999;
    liveCandidate.scene.space.width = 999;
    liveCandidate.scene.primitives[0]!.points[0]![0] = 999;

    expect(captured.profile.width).toBe(210);
    expect(captured.profile.insets.left).toBe(10);
    expect(captured.pageFrame).toEqual({ x: -5, y: 3, width: 110, height: 75 });
    expect(captured.reusableOutline?.scene.space.width).toBe(100);
    expect(captured.reusableOutline?.scene.primitives[0]?.points[0]?.[0]).toBe(1);
    expect(captured.identity.sourceKind).toBe("legacy-scene");
    if (captured.identity.sourceKind !== "legacy-scene") {
      throw new Error("expected legacy identity");
    }
    expect(captured.identity.sourceScene.primitives[0]?.hiddenLineRole).toBe(
      "source",
    );
    expect(
      captured.reusableOutline?.scene.primitives[0]?.hiddenLineRole,
    ).toBe("source");
    expect(captured.identity).not.toBe(liveIdentity);
    expect(captured.reusableOutline?.identity).not.toBe(liveIdentity);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.profile.insets)).toBe(true);
    expect(Object.isFrozen(captured.pageFrame)).toBe(true);
    expect(Object.isFrozen(captured.identity.sourceScene.primitives[0]?.points[0])).toBe(
      true,
    );
    expect(
      Object.isFrozen(captured.reusableOutline?.scene.primitives[0]?.points[0]),
    ).toBe(true);
  });

  it("reuses across Page/profile changes but rejects an aspect identity miss", () => {
    const geometryIdentity = identity();
    const profileOnlyChange = snapshot({
      identity: geometryIdentity,
      profile: { ...profile(2), includeFrame: false },
      pageFrame: { x: 10, y: 5, width: 50, height: 40 },
      reusableOutline: completed(identity()),
    });
    expect(profileOnlyChange.reusableOutline).toBeDefined();

    const changedAspect = identity({ width: 120, height: 80 });
    const aspectMiss = snapshot({
      identity: changedAspect,
      reusableOutline: completed(geometryIdentity),
    });
    expect(aspectMiss.reusableOutline).toBeUndefined();
  });

  it("accepts a prior immutable protocol completion as the next candidate", () => {
    const first = snapshot();
    const prior: CompletedOutline = first.reusableOutline!;
    const next = snapshot({ reusableOutline: prior });

    expect(next.reusableOutline).toEqual(prior);
    expect(next.reusableOutline).not.toBe(prior);
    expect(next.reusableOutline?.scene).not.toBe(prior.scene);
    expect(isHiddenLineExportSnapshot(next)).toBe(true);
  });

  it("normalizes an omitted Page Frame to null and rejects invalid frames", () => {
    expect(snapshot().pageFrame).toBeNull();
    expect(() =>
      snapshot({ pageFrame: { x: 0, y: 0, width: 0, height: 80 } }),
    ).toThrow("Hidden-line export Page Frame is invalid");
    expect(() =>
      snapshot({
        pageFrame: {
          x: Number.MAX_VALUE,
          y: 0,
          width: Number.MAX_VALUE,
          height: 80,
        },
      }),
    ).toThrow("Hidden-line export Page Frame is invalid");
  });

  it("copies completed-Scene geometry across a target-only change but not a Scene change", () => {
    const requested = completedSceneIdentity();
    const matching = createHiddenLineExportSnapshot({
      identity: requested,
      profile: profile(),
      metadata: "test",
      includePaperMargins: false,
      filename: "prepared.svg",
      reusableOutline: completed(completedSceneIdentity()),
    });
    expect(matching.reusableOutline).toBeDefined();
    expect(matching.identity).not.toBe(requested);
    expect(matching.identity.sourceKind).toBe("completed-scene-sketch");

    const staleScene = structuredClone(requested) as unknown as Record<
      string,
      any
    >;
    staleScene.sourceScene.primitives[0]!.points[0]![0] = 99;
    const sceneMiss = createHiddenLineExportSnapshot({
      ...matching,
      identity: requested,
      profile: profile(),
      reusableOutline: completed(
        staleScene as unknown as OutlineComputeIdentity,
      ),
    });
    expect(sceneMiss.reusableOutline).toBeUndefined();

    const staleTarget = structuredClone(requested) as unknown as Record<
      string,
      any
    >;
    staleTarget.outlineTarget.toolWidthMillimeters = 0.31;
    const targetReuse = createHiddenLineExportSnapshot({
      ...matching,
      identity: requested,
      profile: profile(),
      reusableOutline: completed(
        staleTarget as unknown as OutlineComputeIdentity,
      ),
    });
    expect(targetReuse.reusableOutline).toBeDefined();
    expect(targetReuse.identity).toEqual(requested);
    expect(targetReuse.reusableOutline?.identity).toEqual(staleTarget);
  });

  it("copies specialized geometry across a target-only change while retaining the strict new request", () => {
    const requested = specializedIdentity();
    const oldTarget = structuredClone(requested) as unknown as Record<
      string,
      any
    >;
    oldTarget.outlineTarget = {
      toolWidthMillimeters: 0.9,
      millimetersPerSceneUnit: 0.4,
    };

    const captured = snapshot({
      identity: requested,
      reusableOutline: completed(
        oldTarget as unknown as OutlineComputeIdentity,
      ),
    });

    expect(captured.identity).toEqual(requested);
    expect(captured.reusableOutline?.identity).toEqual(oldTarget);
    expect(captured.reusableOutline?.scene).toEqual(sourceScene());
    expect(isHiddenLineExportSnapshot(captured)).toBe(true);
  });

  it.each(identityMismatches)(
    "omits a reusable Outline on a %s mismatch",
    (_, mutate) => {
      const requested = identity();
      const candidateIdentity = structuredClone(requested) as Record<
        string,
        any
      >;
      mutate(candidateIdentity);

      const captured = snapshot({
        identity: requested,
        reusableOutline: completed(
          candidateIdentity as unknown as OutlineComputeIdentity,
        ),
      });
      expect(captured.reusableOutline).toBeUndefined();
    },
  );

  it.each([
    null,
    {},
    { ...structuredClone(snapshot()), filename: "" },
    { ...structuredClone(snapshot()), includePaperMargins: "yes" },
    { ...structuredClone(snapshot()), pageFrame: undefined },
    {
      ...structuredClone(snapshot()),
      pageFrame: { x: 0, y: 0, width: 0, height: 80 },
    },
    {
      ...structuredClone(snapshot()),
      pageFrame: { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 80 },
    },
    {
      ...structuredClone(snapshot()),
      profile: { ...profile(), width: 0 },
    },
    {
      ...structuredClone(snapshot()),
      reusableOutline: completed(identity({ width: 120, height: 80 })),
    },
  ])("rejects malformed snapshots %#", (candidate) => {
    expect(isHiddenLineExportSnapshot(candidate)).toBe(false);
  });
});

describe("hidden-line worker protocol", () => {
  const currentIdentity = identity();
  const currentSnapshot = snapshot({ identity: currentIdentity });
  const completedOutline: CompletedOutline = currentSnapshot.reusableOutline!;

  const previewRequest = {
    type: "preview",
    jobKind: "preview",
    owner: "outline-preview",
    jobId: 1,
    identity: currentIdentity,
  } as const;
  const exportRequest = {
    type: "export",
    jobKind: "export",
    owner: "hidden-line-export",
    jobId: 2,
    snapshot: currentSnapshot,
  } as const;

  it("accepts every request and response variant", () => {
    expect(isHiddenLineWorkerRequest(previewRequest)).toBe(true);
    expect(isHiddenLineWorkerRequest(exportRequest)).toBe(true);

    expect(
      isHiddenLineWorkerMessage({
        type: "derivation-progress",
        jobKind: "preview",
        owner: "outline-preview",
        jobId: 1,
        snapshot: {
          completedWorkUnits: 1,
          totalWorkUnits: 2,
          terminal: false,
        },
      }),
    ).toBe(true);
    expect(
      isHiddenLineWorkerMessage({
        type: "finalizing",
        jobKind: "export",
        owner: "hidden-line-export",
        jobId: 2,
      }),
    ).toBe(true);
    expect(
      isHiddenLineWorkerMessage({
        type: "complete",
        jobKind: "preview",
        owner: "outline-preview",
        jobId: 1,
        identity: currentIdentity,
        scene: sourceScene(),
      }),
    ).toBe(true);
    expect(
      isHiddenLineWorkerMessage({
        type: "complete",
        jobKind: "export",
        owner: "hidden-line-export",
        jobId: 2,
        identity: currentIdentity,
        svg: "<svg/>",
        filename: currentSnapshot.filename,
        completedOutline,
      }),
    ).toBe(true);
    expect(
      isHiddenLineWorkerMessage({
        type: "failure",
        jobKind: "export",
        owner: "hidden-line-export",
        jobId: 2,
        identity: currentIdentity,
        error: "serialization failed",
      }),
    ).toBe(true);
  });

  it.each([
    { ...previewRequest, jobKind: "export" },
    { ...previewRequest, owner: "hidden-line-export" },
    { ...exportRequest, jobKind: "preview" },
    { ...exportRequest, owner: "outline-preview" },
    { ...exportRequest, jobId: 0 },
  ])("rejects request kind/owner mismatches %#", (candidate) => {
    expect(isHiddenLineWorkerRequest(candidate)).toBe(false);
  });

  it.each([
    {
      type: "finalizing",
      jobKind: "preview",
      owner: "outline-preview",
      jobId: 1,
    },
    {
      type: "complete",
      jobKind: "export",
      owner: "outline-preview",
      jobId: 2,
      identity: currentIdentity,
      svg: "<svg/>",
      filename: "out.svg",
      completedOutline,
    },
    {
      type: "complete",
      jobKind: "preview",
      owner: "outline-preview",
      jobId: 1,
      identity: currentIdentity,
      svg: "<svg/>",
    },
    {
      type: "complete",
      jobKind: "export",
      owner: "hidden-line-export",
      jobId: 2,
      identity: currentIdentity,
      svg: "",
      filename: "out.svg",
      completedOutline,
    },
    {
      type: "complete",
      jobKind: "export",
      owner: "hidden-line-export",
      jobId: 2,
      identity: currentIdentity,
      svg: " \n\t ",
      filename: "out.svg",
      completedOutline,
    },
    {
      type: "complete",
      jobKind: "export",
      owner: "hidden-line-export",
      jobId: 2,
      identity: currentIdentity,
      svg: "<svg/>",
      filename: "out.svg",
      completedOutline: completed(identity({ width: 120, height: 80 })),
    },
    {
      type: "derivation-progress",
      jobKind: "export",
      owner: "hidden-line-export",
      jobId: 2,
      snapshot: {
        completedWorkUnits: 3,
        totalWorkUnits: 2,
        terminal: false,
      },
    },
    {
      type: "failure",
      jobKind: "preview",
      owner: "hidden-line-export",
      jobId: 1,
      identity: currentIdentity,
      error: "bad",
    },
  ])("rejects malformed or cross-kind messages %#", (candidate) => {
    expect(isHiddenLineWorkerMessage(candidate)).toBe(false);
  });
});
