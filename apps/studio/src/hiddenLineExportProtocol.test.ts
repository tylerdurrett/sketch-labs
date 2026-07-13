import { describe, expect, it } from "vitest";

import type { ParamSchema, PlotProfile, Scene } from "@harness/core";

import {
  createHiddenLineExportSnapshot,
  createOutlineComputeIdentity,
  isHiddenLineExportSnapshot,
  isHiddenLineWorkerMessage,
  isHiddenLineWorkerRequest,
  type CompletedOutline,
  type HiddenLineExportSnapshot,
  type OutlineComputeIdentity,
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
      },
    ],
  };
}

function identity(frame = { width: 100, height: 80 }): OutlineComputeIdentity {
  return createOutlineComputeIdentity({
    sketchId: "lines",
    schema,
    params: { amount: 3 },
    seed: 42,
    sampledT: 1.25,
    compositionFrame: frame,
    tolerance: 0.5,
    includeFrame: true,
    sourceScene: sourceScene(),
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

describe("hidden-line export snapshot", () => {
  it("deeply copies and freezes every mutable capture and candidate", () => {
    const liveIdentity = identity();
    const liveProfile = profile();
    const liveCandidate = completed(liveIdentity);
    const captured = snapshot({
      identity: liveIdentity,
      profile: liveProfile,
      reusableOutline: liveCandidate,
    });

    liveProfile.width = 999;
    liveProfile.insets.left = 99;
    liveCandidate.scene.space.width = 999;
    liveCandidate.scene.primitives[0]!.points[0]![0] = 999;

    expect(captured.profile.width).toBe(210);
    expect(captured.profile.insets.left).toBe(10);
    expect(captured.reusableOutline?.scene.space.width).toBe(100);
    expect(captured.reusableOutline?.scene.primitives[0]?.points[0]?.[0]).toBe(1);
    expect(captured.identity).not.toBe(liveIdentity);
    expect(captured.reusableOutline?.identity).not.toBe(liveIdentity);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.profile.insets)).toBe(true);
    expect(Object.isFrozen(captured.identity.sourceScene.primitives[0]?.points[0])).toBe(
      true,
    );
    expect(
      Object.isFrozen(captured.reusableOutline?.scene.primitives[0]?.points[0]),
    ).toBe(true);
  });

  it("reuses across profile-only changes but rejects an aspect identity miss", () => {
    const geometryIdentity = identity();
    const profileOnlyChange = snapshot({
      identity: geometryIdentity,
      profile: profile(2),
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

  it.each([
    null,
    {},
    { ...structuredClone(snapshot()), filename: "" },
    { ...structuredClone(snapshot()), includePaperMargins: "yes" },
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
        identity: currentIdentity,
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
        identity: currentIdentity,
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
      identity: currentIdentity,
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
      svg: "<svg/>",
      filename: "out.svg",
      completedOutline: completed(identity({ width: 120, height: 80 })),
    },
    {
      type: "derivation-progress",
      jobKind: "export",
      owner: "hidden-line-export",
      jobId: 2,
      identity: currentIdentity,
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
