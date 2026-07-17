import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID } from "@harness/core";
import { describe, expect, it } from "vitest";

import {
  IMAGE_ASSET_HASH_HEX_LENGTH,
  imageAssetDisplayName,
  imageAssetIdFromDigest,
  imageAssetUrl,
  isImageAssetId,
  normalizeImageAssetSlug,
  parseImageAssetId,
} from "./imageAssetIdentity";

const ASSET_FILENAME = `${PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID}.png`;
const ASSET_URL = new URL(
  `../../../assets/image-assets/${ASSET_FILENAME}`,
  import.meta.url,
);

describe("Image Asset identity", () => {
  it("normalizes readable names into a nonempty lowercase ASCII slug", () => {
    expect(normalizeImageAssetSlug("  Pinecone Study (Alpha)  ")).toBe(
      "pinecone-study-alpha",
    );
    expect(normalizeImageAssetSlug("ONE___two---three")).toBe("one-two-three");
    expect(normalizeImageAssetSlug("🌲")).toBe("image");
  });

  it("builds an ID from exactly one lowercase SHA-256 digest", () => {
    const digest = "0123456789abcdef".repeat(4);

    expect(IMAGE_ASSET_HASH_HEX_LENGTH).toBe(12);
    expect(imageAssetIdFromDigest("Pinecone.PNG", digest)).toBe(
      "pinecone-png-0123456789ab",
    );
    expect(() =>
      imageAssetIdFromDigest("pinecone", digest.toUpperCase()),
    ).toThrow(/64 lowercase SHA-256 hex/);
    expect(() =>
      imageAssetIdFromDigest("pinecone", digest.slice(0, 63)),
    ).toThrow(/64 lowercase SHA-256 hex/);
  });

  it("strictly parses only canonical IDs split at the final hash suffix", () => {
    expect(parseImageAssetId("pine-cone-0123456789ab")).toEqual({
      slug: "pine-cone",
      hash: "0123456789ab",
    });
    expect(isImageAssetId("pine-cone-0123456789ab")).toBe(true);

    for (const invalid of [
      "Pine-cone-0123456789ab",
      "pine--cone-0123456789ab",
      "pine-cone-0123456789AB",
      "pine-cone-0123456789abc",
      "pine-cone-0123456789ab.png",
      "0123456789ab",
      "",
    ]) {
      expect(parseImageAssetId(invalid)).toBeNull();
      expect(isImageAssetId(invalid)).toBe(false);
    }
    expect(isImageAssetId(null)).toBe(false);
  });

  it("exposes browser-safe URL and readable-name helpers only for valid IDs", () => {
    const id = "pine-cone-0123456789ab";

    expect(imageAssetUrl(id)).toBe(`/image-assets/${id}.png`);
    expect(imageAssetDisplayName(id)).toBe("pine cone");

    for (const invalid of [
      "Pine-cone-0123456789ab",
      "pine-cone-0123456789AB",
      "pine-cone-0123456789ab.png",
      "../pine-cone-0123456789ab",
      null,
    ]) {
      expect(imageAssetUrl(invalid)).toBeNull();
      expect(imageAssetDisplayName(invalid)).toBeNull();
    }
  });
});

describe("bundled Photo Scribble sample", () => {
  it("derives the committed filename and core default from the exact PNG bytes", () => {
    const bytes = readFileSync(ASSET_URL);
    const digest = createHash("sha256").update(bytes).digest("hex");

    expect(imageAssetIdFromDigest("pinecone", digest)).toBe(
      PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID,
    );
    expect(ASSET_FILENAME).toBe("pinecone-4330aa0314f7.png");
  });

  it("is a 512×768, 8-bit RGBA PNG", () => {
    const bytes = readFileSync(ASSET_URL);

    expect([...bytes.subarray(0, 8)]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
    expect(bytes.toString("ascii", 12, 16)).toBe("IHDR");
    expect(bytes.readUInt32BE(16)).toBe(512);
    expect(bytes.readUInt32BE(20)).toBe(768);
    expect(bytes[24]).toBe(8);
    expect(bytes[25]).toBe(6);
  });
});
