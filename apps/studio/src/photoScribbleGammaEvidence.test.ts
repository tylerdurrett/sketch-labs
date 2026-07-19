// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import {
  photoScribbleGammaControls,
  photoScribbleGammaCaptureId,
  type MappingId,
} from "./photoScribbleGammaEvidence";

const fixtures = [
  "flowers-opaque-portrait",
  "pinecone-dark-alpha-portrait",
] as const;
const mappings: readonly MappingId[] = [
  "current-0.5-to-2",
  "candidate-0.25-to-4",
];

afterEach(() => {
  document.body.replaceChildren();
});

describe("Photo Scribble gamma capture IDs", () => {
  it("defaults frozen protocol controls to the current stop point", () => {
    expect(
      photoScribbleGammaControls({
        pathDensity: 20,
        scribbleScale: 0.35,
        momentum: 0.75,
        chaos: 0.25,
        toneFidelity: 0.99,
      }),
    ).toEqual({
      pathDensity: 20,
      scribbleScale: 0.35,
      momentum: 0.75,
      chaos: 0.25,
      toneFidelity: 0.99,
      stopPoint: 100,
    });
  });

  it("resolves all four returned IDs through browser and Puppeteer-compatible APIs", () => {
    const captures = fixtures.flatMap((fixtureId) =>
      mappings.map((mapping) => {
        const id = photoScribbleGammaCaptureId(fixtureId, mapping);
        const element = document.createElement("figure");
        element.id = id;
        document.body.append(element);
        return { id, element };
      }),
    );

    expect(new Set(captures.map(({ id }) => id)).size).toBe(4);
    for (const { id, element } of captures) {
      expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
      expect(document.getElementById(id)).toBe(element);
      expect(document.querySelector(`#${id}`)).toBe(element);
    }
  });
});
