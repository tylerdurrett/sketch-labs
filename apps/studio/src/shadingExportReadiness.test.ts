import { describe, expect, it } from "vitest";

import type { ParamSchema, Scene, ShadingDiagnostics } from "@harness/core";

import type { DisplayedSceneSnapshot } from "./LiveCanvas";
import { createShadingComputeIdentity } from "./shadingComputeProtocol";
import {
  acknowledgedCurrentShading,
  isAcknowledgedCurrentShading,
} from "./shadingExportReadiness";
import {
  createShadingSessionState,
  shadingSessionReducer,
  type ShadingSessionState,
} from "./shadingSession";

const schema: ParamSchema = {
  amount: { kind: "number", min: 0, max: 10, default: 1 },
};
const scene: Scene = {
  space: { width: 20, height: 10 },
  primitives: [{ points: [[0, 0], [10, 10]] }],
};
const diagnostics: ShadingDiagnostics = {
  termination: "budget-exhausted",
  pathLength: 42,
  polylineCount: 3,
  penLiftCount: 2,
  fidelity: { kind: "scribble", residualError: 0.01 },
};
const identity = createShadingComputeIdentity({
  sketchId: "shading-test",
  schema,
  params: { amount: 1 },
  seed: 7,
  compositionFrame: scene.space,
});

function currentSession(): ShadingSessionState {
  const pending = createShadingSessionState(identity, 7);
  const active = shadingSessionReducer(pending, {
    type: "launched",
    token: 1,
    identity,
  });
  return shadingSessionReducer(active, {
    type: "succeeded",
    token: 1,
    identity,
    scene,
    diagnostics,
    computeTimeMs: 12,
  });
}

function paintedSnapshot(
  sourceInputRevision = 7,
  contentRevision = 1,
): DisplayedSceneSnapshot {
  return {
    scene,
    sourceScene: scene,
    displayedScene: scene,
    t: 0,
    renderMode: "fill",
    tolerance: 0,
    includeFrame: false,
    sourceInputRevision,
    contentRevision,
  };
}

describe("Shading export readiness", () => {
  it("returns current budget-exhausted artwork only after the exact revision is painted", () => {
    const session = currentSession();
    const acknowledgement = {
      sourceInputRevision: 7,
      contentRevision: 1,
    };
    const displayed = paintedSnapshot();

    expect(
      acknowledgedCurrentShading(session, acknowledgement, displayed),
    ).toBe(session.displayed);
    expect(
      isAcknowledgedCurrentShading(session, acknowledgement, displayed),
    ).toBe(true);
  });

  it.each([
    ["no acknowledgement", null, paintedSnapshot()],
    [
      "stale acknowledgement input",
      { sourceInputRevision: 6, contentRevision: 1 },
      paintedSnapshot(),
    ],
    [
      "stale acknowledgement content",
      { sourceInputRevision: 7, contentRevision: 0 },
      paintedSnapshot(),
    ],
    [
      "stale canvas input",
      { sourceInputRevision: 7, contentRevision: 1 },
      paintedSnapshot(6, 1),
    ],
    [
      "stale canvas content",
      { sourceInputRevision: 7, contentRevision: 1 },
      paintedSnapshot(7, 0),
    ],
  ])("rejects %s", (_case, acknowledgement, displayed) => {
    expect(
      acknowledgedCurrentShading(
        currentSession(),
        acknowledgement,
        displayed,
      ),
    ).toBeNull();
  });

  it("rejects painted artwork while authored session truth is stale", () => {
    const stale = shadingSessionReducer(currentSession(), {
      type: "transaction-began",
    });
    const acknowledgement = {
      sourceInputRevision: 7,
      contentRevision: 1,
    };

    expect(
      acknowledgedCurrentShading(
        stale,
        acknowledgement,
        paintedSnapshot(),
      ),
    ).toBeNull();
    expect(
      isAcknowledgedCurrentShading(
        stale,
        acknowledgement,
        paintedSnapshot(),
      ),
    ).toBe(false);
  });
});
