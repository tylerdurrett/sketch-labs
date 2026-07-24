import { describe, expect, it } from "vitest";

import { defaultParams, flowingContours, type Scene } from "@harness/core";

import { createFlowingContoursComputeIdentity } from "./flowingContoursComputeProtocol";
import { acknowledgedCurrentFlowingContours } from "./flowingContoursExportReadiness";
import {
  createFlowingContoursSessionState,
  flowingContoursSessionReducer,
} from "./flowingContoursSession";

const scene: Scene = {
  space: { width: 20, height: 10 },
  primitives: [],
};
const identity = createFlowingContoursComputeIdentity({
  sketchId: flowingContours.id,
  schema: flowingContours.schema,
  params: defaultParams(flowingContours.schema),
  seed: 1,
  compositionFrame: scene.space,
});

function completed() {
  const initial = createFlowingContoursSessionState(identity, 4);
  const active = flowingContoursSessionReducer(initial, {
    type: "launched",
    token: 1,
    identity,
  });
  return flowingContoursSessionReducer(active, {
    type: "succeeded",
    token: 1,
    identity,
    scene,
    computeTimeMs: 5,
  });
}

describe("Flowing Contours export readiness", () => {
  it("requires exact current session, acknowledgement, and canvas revisions", () => {
    const state = completed();
    const provenance = { sourceInputRevision: 4, contentRevision: 1 };
    const displayed = {
      scene,
      sourceScene: scene,
      displayedScene: scene,
      t: 0,
      renderMode: "fill" as const,
      tolerance: 0,
      includeFrame: true,
      inputRevision: 4,
      ...provenance,
    };
    expect(
      acknowledgedCurrentFlowingContours(state, provenance, displayed),
    ).toBe(state.displayed);
    expect(
      acknowledgedCurrentFlowingContours(
        state,
        { ...provenance, contentRevision: 0 },
        displayed,
      ),
    ).toBeNull();
    expect(
      acknowledgedCurrentFlowingContours(state, provenance, {
        ...displayed,
        sourceInputRevision: 3,
      }),
    ).toBeNull();
  });
});
