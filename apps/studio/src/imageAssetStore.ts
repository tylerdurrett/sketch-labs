/**
 * Immutable filesystem storage for project-managed Image Assets.
 *
 * The browser owns image decoding and PNG normalization. This node-only seam
 * validates that normalized payload boundary, derives the canonical identity,
 * deduplicates exact content, and commits the bytes without ever replacing an
 * existing asset.
 */
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";

import {
  imageAssetIdFromDigest,
  normalizeImageAssetSlug,
  parseImageAssetId,
} from "./imageAssetIdentity";

const PNG_SUFFIX = ".png";
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** Stable categories callers can translate into an HTTP or Studio error. */
export type ImageAssetStoreErrorCode =
  | "invalid-png"
  | "conflict"
  | "filesystem";

/** A deliberately path-free failure from the Image Asset persistence seam. */
export class ImageAssetStoreError extends Error {
  readonly code: ImageAssetStoreErrorCode;

  constructor(code: ImageAssetStoreErrorCode, message: string) {
    super(message);
    this.name = "ImageAssetStoreError";
    this.code = code;
  }
}

const rootQueues = new Map<string, Promise<void>>();

function isNodeError(error: unknown, code: string): boolean {
  return (error as { code?: string }).code === code;
}

function filesystemError(): ImageAssetStoreError {
  return new ImageAssetStoreError(
    "filesystem",
    "Image Asset storage operation failed",
  );
}

function conflictError(): ImageAssetStoreError {
  return new ImageAssetStoreError(
    "conflict",
    "Image Asset identity conflicts with existing bytes",
  );
}

function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PNG_SIGNATURE.byteLength) return false;

  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;

  return left.every((byte, index) => right[index] === byte);
}

function assetPath(root: string, id: string): string {
  return `${root}/${id}${PNG_SUFFIX}`;
}

/**
 * Run one operation after every earlier operation for the same resolved root.
 * The queue tail always fulfills, so a rejection cannot poison later work.
 */
function serializeForRoot<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = rootQueues.get(root) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  rootQueues.set(root, tail);

  return result.finally(() => {
    if (rootQueues.get(root) === tail) rootQueues.delete(root);
  });
}

async function canonicalRoot(
  root: string,
  create: boolean,
): Promise<string | null> {
  try {
    if (create) await mkdir(root, { recursive: true });
    return await realpath(root);
  } catch (error: unknown) {
    if (!create && isNodeError(error, "ENOENT")) return null;
    throw filesystemError();
  }
}

/**
 * List only regular files whose leaf names exactly match the canonical Image
 * Asset form. A disappearing leaf is treated like an absent entry; malformed
 * names, directories, and leaf symlinks are not assets.
 */
async function listCanonicalIds(root: string): Promise<string[]> {
  const entries = await readdir(root);
  const ids: string[] = [];

  for (const filename of entries) {
    if (!filename.endsWith(PNG_SUFFIX)) continue;

    const id = filename.slice(0, -PNG_SUFFIX.length);
    if (parseImageAssetId(id) === null) continue;

    try {
      const entry = await lstat(assetPath(root, id));
      if (!entry.isSymbolicLink() && entry.isFile()) ids.push(id);
    } catch (error: unknown) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }

  return ids.sort();
}

/**
 * Return all persisted canonical Image Asset IDs in stable lexical order.
 * A missing configured root is an empty library.
 */
export async function listImageAssets(root: string): Promise<string[]> {
  const resolvedRoot = await canonicalRoot(root, false);
  if (resolvedRoot === null) return [];

  return serializeForRoot(resolvedRoot, async () => {
    try {
      return await listCanonicalIds(resolvedRoot);
    } catch (error: unknown) {
      if (error instanceof ImageAssetStoreError) throw error;
      throw filesystemError();
    }
  });
}

/**
 * Persist normalized PNG bytes under their readable, content-addressed ID.
 *
 * Exact bytes already present under any slug reuse that existing ID. A new
 * target is created exclusively, making every successful asset immutable. The
 * entire validation/hash/scan/dedup/write sequence is serialized per resolved
 * root so concurrent imports cannot create duplicate content and listing never
 * observes this module midway through a commit.
 */
export async function storeImageAsset(
  root: string,
  slug: string,
  bytes: Uint8Array,
): Promise<{ id: string; created: boolean }> {
  const resolvedRoot = await canonicalRoot(root, true);
  if (resolvedRoot === null) throw filesystemError();

  return serializeForRoot(resolvedRoot, async () => {
    try {
      if (!hasPngSignature(bytes)) {
        throw new ImageAssetStoreError(
          "invalid-png",
          "Image Asset bytes must have a PNG signature",
        );
      }

      const digest = createHash("sha256").update(bytes).digest("hex");
      const normalizedSlug = normalizeImageAssetSlug(slug);
      const id = imageAssetIdFromDigest(normalizedSlug, digest);
      const hash = parseImageAssetId(id)!.hash;
      const existingIds = await listCanonicalIds(resolvedRoot);

      // The suffix narrows disk reads while the exact byte comparison protects
      // correctness if the deliberately short identity suffix ever collides.
      for (const existingId of existingIds) {
        if (parseImageAssetId(existingId)!.hash !== hash) continue;

        try {
          const existingBytes = await readFile(
            assetPath(resolvedRoot, existingId),
          );
          if (equalBytes(existingBytes, bytes)) {
            return { id: existingId, created: false };
          }
        } catch (error: unknown) {
          if (!isNodeError(error, "ENOENT")) throw error;
        }
      }

      try {
        await writeFile(assetPath(resolvedRoot, id), bytes, { flag: "wx" });
        return { id, created: true };
      } catch (error: unknown) {
        if (!isNodeError(error, "EEXIST")) throw error;

        // Another process may have won after our scan. Never replace it: only
        // accept it when it is a regular leaf containing these exact bytes.
        try {
          const entry = await lstat(assetPath(resolvedRoot, id));
          if (entry.isSymbolicLink() || !entry.isFile()) throw conflictError();
          const existingBytes = await readFile(assetPath(resolvedRoot, id));
          if (equalBytes(existingBytes, bytes)) return { id, created: false };
        } catch (existingError: unknown) {
          if (existingError instanceof ImageAssetStoreError) {
            throw existingError;
          }
          if (!isNodeError(existingError, "ENOENT")) throw existingError;
        }

        throw conflictError();
      }
    } catch (error: unknown) {
      if (error instanceof ImageAssetStoreError) throw error;
      throw filesystemError();
    }
  });
}
