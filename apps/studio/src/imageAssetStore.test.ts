// @vitest-environment node
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { imageAssetIdFromDigest } from "./imageAssetIdentity";
import {
  ImageAssetStoreError,
  listImageAssets,
  storeImageAsset,
} from "./imageAssetStore";

const PNG_A = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1]);
const PNG_B = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 2]);

function expectedId(slug: string, bytes: Uint8Array): string {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return imageAssetIdFromDigest(slug, digest);
}

function expectStoreError(
  error: unknown,
  code: ImageAssetStoreError["code"],
): boolean {
  expect(error).toBeInstanceOf(ImageAssetStoreError);
  expect((error as ImageAssetStoreError).code).toBe(code);
  return true;
}

describe("Image Asset store", () => {
  let root: string;
  let outsidePath: string;

  beforeEach(async () => {
    root = await mkdtemp(`${tmpdir()}/harness-image-asset-store-`);
    outsidePath = `${root}-outside.png`;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outsidePath, { recursive: true, force: true });
  });

  it("hashes and writes the exact normalized PNG bytes once", async () => {
    const id = expectedId("Pine Cone.png", PNG_A);

    await expect(storeImageAsset(root, "Pine Cone.png", PNG_A)).resolves.toEqual(
      { id, created: true },
    );
    await expect(storeImageAsset(root, "Pine Cone.png", PNG_A)).resolves.toEqual(
      { id, created: false },
    );
    expect(Array.from(await readFile(`${root}/${id}.png`))).toEqual(
      Array.from(PNG_A),
    );
  });

  it("rejects a non-PNG signature before writing an asset", async () => {
    await expect(
      storeImageAsset(root, "not-an-image", new Uint8Array([1, 2, 3])),
    ).rejects.toSatisfy((error: unknown) =>
      expectStoreError(error, "invalid-png"),
    );
    expect(await readdir(root)).toEqual([]);
  });

  it("lists canonical regular PNG leaves in stable order only", async () => {
    const alpha = "alpha-0123456789ab";
    const zulu = "zulu-abcdef012345";
    await writeFile(`${root}/${zulu}.png`, PNG_A);
    await writeFile(`${root}/${alpha}.png`, PNG_B);
    await writeFile(`${root}/Not-Canonical-0123456789ab.png`, PNG_A);
    await writeFile(`${root}/alpha-short.png`, PNG_A);
    await writeFile(`${root}/${alpha}.jpg`, PNG_A);
    await mkdir(`${root}/directory-111111111111.png`, { recursive: true });
    await writeFile(outsidePath, PNG_A);
    await symlink(outsidePath, `${root}/linked-222222222222.png`, "file");

    await expect(listImageAssets(root)).resolves.toEqual([alpha, zulu]);
  });

  it("returns an empty list when the configured root is missing", async () => {
    const missingRoot = `${root}/missing`;

    await expect(listImageAssets(missingRoot)).resolves.toEqual([]);
  });

  it("deduplicates identical bytes across different proposed slugs", async () => {
    const first = await storeImageAsset(root, "first", PNG_A);
    const second = await storeImageAsset(root, "second", PNG_A);

    expect(first).toEqual({ id: expectedId("first", PNG_A), created: true });
    expect(second).toEqual({ id: first.id, created: false });
    await expect(listImageAssets(root)).resolves.toEqual([first.id]);
  });

  it("mints a new content identity when bytes change under one slug", async () => {
    const first = await storeImageAsset(root, "study", PNG_A);
    const changed = await storeImageAsset(root, "study", PNG_B);

    expect(changed).toEqual({ id: expectedId("study", PNG_B), created: true });
    expect(changed.id).not.toBe(first.id);
    await expect(listImageAssets(root)).resolves.toEqual(
      [first.id, changed.id].sort(),
    );
  });

  it("refuses to replace conflicting bytes and keeps failures path-free", async () => {
    const id = expectedId("collision", PNG_A);
    await writeFile(`${root}/${id}.png`, PNG_B);

    await expect(storeImageAsset(root, "collision", PNG_A)).rejects.toSatisfy(
      (error: unknown) => {
        expectStoreError(error, "conflict");
        expect((error as Error).message).not.toContain(root);
        return true;
      },
    );
    expect(Array.from(await readFile(`${root}/${id}.png`))).toEqual(
      Array.from(PNG_B),
    );
  });

  it("wraps filesystem details in a stable path-free error", async () => {
    const invalidRoot = `${root}\0unusable`;

    await expect(storeImageAsset(invalidRoot, "study", PNG_A)).rejects.toSatisfy(
      (error: unknown) => {
        expectStoreError(error, "filesystem");
        expect((error as Error).message).not.toContain(root);
        return true;
      },
    );
  });

  it("serializes concurrent deduplication and releases the queue after rejection", async () => {
    const [first, second] = await Promise.all([
      storeImageAsset(root, "first", PNG_A),
      storeImageAsset(root, "second", PNG_A),
    ]);

    expect(first.id).toBe(second.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    await expect(listImageAssets(root)).resolves.toEqual([first.id]);
    expect(await readdir(root)).toEqual([`${first.id}.png`]);
    expect(Array.from(await readFile(`${root}/${first.id}.png`))).toEqual(
      Array.from(PNG_A),
    );

    const rejected = storeImageAsset(root, "bad", new Uint8Array([0]));
    const later = storeImageAsset(root, "later", PNG_B);
    await expect(rejected).rejects.toSatisfy((error: unknown) =>
      expectStoreError(error, "invalid-png"),
    );
    await expect(later).resolves.toEqual({
      id: expectedId("later", PNG_B),
      created: true,
    });
  });
});
