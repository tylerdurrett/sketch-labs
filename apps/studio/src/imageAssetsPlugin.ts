/**
 * Dev middleware for immutable project-managed Image Assets.
 *
 * The browser owns decoding and PNG normalization. This boundary exposes only
 * sorted listing, bounded creation, and exact-byte static reads; identity,
 * deduplication, concurrency, and persistence remain owned by imageAssetStore.
 */
import { lstat, readFile } from "node:fs/promises";
import type { Connect, Plugin } from "vite";

import {
  isCanonicalImageAssetSlug,
  parseImageAssetId,
} from "./imageAssetIdentity";
import {
  ImageAssetStoreError,
  listImageAssets,
  storeImageAsset,
} from "./imageAssetStore";

const API_ROOT_PATH = "/__api/image-assets";
const API_PREFIX = `${API_ROOT_PATH}/`;
const IMAGE_ASSET_PREFIX = "/image-assets/";
const IMAGE_ASSET_ROOT_PATH = "/image-assets";
const PNG_SUFFIX = ".png";
const PNG_CONTENT_TYPE = "image/png";

/** The largest accepted normalized PNG body. */
export const IMAGE_ASSET_MAX_BODY_BYTES = 32 * 1024 * 1024;

interface RequestChunk extends Uint8Array {
  readonly length: number;
}

/** The request fields used by the isolated, unit-testable handler. */
export interface ImageAssetRequest {
  readonly url?: string | undefined;
  readonly method?: string | undefined;
  readonly headers?:
    | Readonly<Record<string, string | readonly string[] | undefined>>
    | undefined;
  on(event: "data", cb: (chunk: RequestChunk) => void): void;
  on(event: "end", cb: () => void): void;
  on(event: "error", cb: (error: unknown) => void): void;
}

/** The response half of Vite's Connect middleware. */
type ServerResponse = Parameters<Connect.SimpleHandleFunction>[1];

class RequestBodyTooLargeError extends Error {}

function isENOENT(error: unknown): boolean {
  return (error as { code?: string }).code === "ENOENT";
}

const utf8 = new TextEncoder();

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": utf8.encode(body).byteLength,
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJSON(res, status, { error: message });
}

function requestPathname(url: string): string {
  return url.split("?", 1)[0] ?? "";
}

function isImageAssetPath(url: string): boolean {
  const pathname = requestPathname(url);
  return (
    pathname === API_ROOT_PATH ||
    pathname.startsWith(API_PREFIX) ||
    pathname === IMAGE_ASSET_ROOT_PATH ||
    pathname.startsWith(IMAGE_ASSET_PREFIX)
  );
}

function requestHeader(req: ImageAssetRequest, name: string): string | null {
  const value = req.headers?.[name];
  return typeof value === "string" ? value : null;
}

function declaredBodyLength(req: ImageAssetRequest): number | null | "invalid" {
  const value = requestHeader(req, "content-length");
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return "invalid";

  const length = Number(value);
  return Number.isSafeInteger(length) ? length : "invalid";
}

/** Buffer the binary request without ever retaining more than the body cap. */
function readBoundedBody(req: ImageAssetRequest): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) return;
      if (chunk.byteLength > IMAGE_ASSET_MAX_BODY_BYTES - size) {
        settled = true;
        chunks.length = 0;
        reject(new RequestBodyTooLargeError());
        // Leave this data listener attached: the stream stays flowing and the
        // settled guard drains without retaining the remainder, allowing the
        // same HTTP connection to carry the JSON 413 response.
        return;
      }

      size += chunk.byteLength;
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;

      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve(body);
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function sendStoreError(res: ServerResponse, error: unknown): void {
  if (error instanceof ImageAssetStoreError) {
    switch (error.code) {
      case "invalid-png":
        sendError(res, 400, "Invalid PNG body");
        return;
      case "conflict":
        sendError(res, 409, "Image Asset conflicts with existing bytes");
        return;
      case "filesystem":
        sendError(res, 500, "Internal server error");
        return;
    }
  }

  sendError(res, 500, "Internal server error");
}

async function handleList(
  imageAssetsRoot: string,
  res: ServerResponse,
): Promise<void> {
  try {
    sendJSON(res, 200, await listImageAssets(imageAssetsRoot));
  } catch (error: unknown) {
    sendStoreError(res, error);
  }
}

async function handleWrite(
  imageAssetsRoot: string,
  slug: string,
  req: ImageAssetRequest,
  res: ServerResponse,
): Promise<void> {
  if (requestHeader(req, "content-type") !== PNG_CONTENT_TYPE) {
    sendError(res, 400, "Content-Type must be image/png");
    return;
  }

  const declaredLength = declaredBodyLength(req);
  if (declaredLength === "invalid") {
    sendError(res, 400, "Invalid Content-Length");
    return;
  }
  if (declaredLength !== null && declaredLength > IMAGE_ASSET_MAX_BODY_BYTES) {
    sendError(res, 413, "Request body too large");
    return;
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBody(req);
  } catch (error: unknown) {
    if (error instanceof RequestBodyTooLargeError) {
      sendError(res, 413, "Request body too large");
      return;
    }
    sendError(res, 500, "Internal server error");
    return;
  }

  try {
    sendJSON(res, 200, await storeImageAsset(imageAssetsRoot, slug, bytes));
  } catch (error: unknown) {
    sendStoreError(res, error);
  }
}

async function handleStaticRead(
  imageAssetsRoot: string,
  pathname: string,
  res: ServerResponse,
): Promise<void> {
  if (!pathname.startsWith(IMAGE_ASSET_PREFIX)) {
    sendError(res, 404, "Not found");
    return;
  }

  const filename = pathname.slice(IMAGE_ASSET_PREFIX.length);
  if (!filename.endsWith(PNG_SUFFIX)) {
    sendError(res, 404, "Not found");
    return;
  }

  const id = filename.slice(0, -PNG_SUFFIX.length);
  if (parseImageAssetId(id) === null) {
    sendError(res, 404, "Not found");
    return;
  }

  const assetPath = `${imageAssetsRoot}/${id}${PNG_SUFFIX}`;
  try {
    // Refuse leaf symlinks so reads cannot escape the configured asset root.
    const entry = await lstat(assetPath);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      sendError(res, 404, "Not found");
      return;
    }

    const bytes = await readFile(assetPath);
    res.writeHead(200, {
      "Content-Type": PNG_CONTENT_TYPE,
      "Content-Length": bytes.byteLength,
    });
    res.end(bytes);
  } catch (error: unknown) {
    if (isENOENT(error)) {
      sendError(res, 404, "Not found");
      return;
    }
    sendError(res, 500, "Internal server error");
  }
}

/**
 * Route one Image Asset request. Exact supported shapes are:
 *
 * - `GET /__api/image-assets`
 * - `POST /__api/image-assets/{canonical-slug}`
 * - `GET /image-assets/{canonical-id}.png`
 */
export async function handleImageAssetRequest(
  imageAssetsRoot: string,
  req: ImageAssetRequest,
  res: ServerResponse,
): Promise<void> {
  const pathname = requestPathname(req.url ?? "");
  const method = req.method ?? "GET";

  if (pathname === API_ROOT_PATH) {
    if (method !== "GET") {
      sendError(res, 405, "Method not allowed");
      return;
    }
    await handleList(imageAssetsRoot, res);
    return;
  }

  if (pathname.startsWith(API_PREFIX)) {
    const slug = pathname.slice(API_PREFIX.length);
    if (slug.length === 0 || slug.includes("/")) {
      sendError(res, 404, "Not found");
      return;
    }
    if (!isCanonicalImageAssetSlug(slug)) {
      sendError(res, 400, "Invalid Image Asset slug");
      return;
    }
    if (method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }
    await handleWrite(imageAssetsRoot, slug, req, res);
    return;
  }

  if (
    pathname === IMAGE_ASSET_ROOT_PATH ||
    pathname.startsWith(IMAGE_ASSET_PREFIX)
  ) {
    if (method !== "GET") {
      sendError(res, 405, "Method not allowed");
      return;
    }
    await handleStaticRead(imageAssetsRoot, pathname, res);
    return;
  }

  sendError(res, 404, "Not found");
}

/** Dev-only Vite middleware exposing the configured Image Asset root. */
export function imageAssetsPlugin(imageAssetsRoot: string): Plugin {
  const name = "harness:image-assets";
  return {
    name,
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const imageAssetReq = req as unknown as ImageAssetRequest;
        if (!isImageAssetPath(imageAssetReq.url ?? "")) {
          next();
          return;
        }

        handleImageAssetRequest(imageAssetsRoot, imageAssetReq, res).catch(
          (error: unknown) => {
            console.error(`[${name}]`, error);
            if (!res.headersSent) sendError(res, 500, "Internal server error");
          },
        );
      });
    },
  };
}
