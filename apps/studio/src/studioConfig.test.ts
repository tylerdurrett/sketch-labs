import { describe, expect, it } from "vitest";

import { STUDIO_IMAGE_ASSET_LONG_EDGE_CAP } from "./studioConfig";

describe("Studio configuration", () => {
  it("caps normalized Image Assets at a 2048-pixel long edge by default", () => {
    expect(STUDIO_IMAGE_ASSET_LONG_EDGE_CAP).toBe(2048);
  });
});
