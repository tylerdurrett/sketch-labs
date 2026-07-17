/**
 * Read-only dev serving for project-managed Image Assets.
 *
 * Exactly `GET /image-assets/{canonical-id}.png` maps to
 * `{imageAssetsRoot}/{canonical-id}.png`. There are deliberately no list,
 * write, delete, or import routes. The canonical ID parser is the sole path
 * boundary: malformed IDs never reach the filesystem.
 */
import { lstat, readFile } from "node:fs/promises";
import type { Connect, Plugin } from "vite";

import { parseImageAssetId } from "./imageAssetIdentity";

const IMAGE_ASSET_PREFIX = "/image-assets/";
const IMAGE_ASSET_ROOT_PATH = "/image-assets";
const PNG_SUFFIX = ".png";

/** The request fields used by the isolated, unit-testable handler. */
export interface ImageAssetRequest {
  readonly url?: string | undefined;
  readonly method?: string | undefined;
}

/** The response half of Vite's Connect middleware. */
type ServerResponse = Parameters<Connect.SimpleHandleFunction>[1];

function isENOENT(error: unknown): boolean {
  return (error as { code?: string }).code === "ENOENT";
}

function sendNotFound(res: ServerResponse): void {
  const body = '{"error":"Not found"}';
  res.writeHead(404, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
  });
  res.end(body);
}

function sendInternalError(res: ServerResponse): void {
  const body = '{"error":"Internal server error"}';
  res.writeHead(500, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
  });
  res.end(body);
}

function requestPathname(url: string): string {
  return url.split("?", 1)[0] ?? "";
}

function isImageAssetPath(url: string): boolean {
  const pathname = requestPathname(url);
  return (
    pathname === IMAGE_ASSET_ROOT_PATH ||
    pathname.startsWith(IMAGE_ASSET_PREFIX)
  );
}

/**
 * Serve one canonical PNG from the configured root. Exported so route and byte
 * behavior can be tested without starting Vite.
 *
 * A query string is allowed for normal browser cache busting, but is discarded
 * before matching and never participates in filesystem resolution.
 */
export async function handleImageAssetRequest(
  imageAssetsRoot: string,
  req: ImageAssetRequest,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "GET") {
    sendNotFound(res);
    return;
  }

  const pathname = requestPathname(req.url ?? "");
  if (!pathname.startsWith(IMAGE_ASSET_PREFIX)) {
    sendNotFound(res);
    return;
  }

  const filename = pathname.slice(IMAGE_ASSET_PREFIX.length);
  if (!filename.endsWith(PNG_SUFFIX)) {
    sendNotFound(res);
    return;
  }

  const id = filename.slice(0, -PNG_SUFFIX.length);
  if (parseImageAssetId(id) === null) {
    sendNotFound(res);
    return;
  }

  const assetPath = `${imageAssetsRoot}/${id}${PNG_SUFFIX}`;
  try {
    // Asset files must be owned by the configured root, not merely named
    // there. Refuse a leaf symlink so readFile cannot follow it outside.
    if ((await lstat(assetPath)).isSymbolicLink()) {
      sendNotFound(res);
      return;
    }

    const bytes = await readFile(assetPath);
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": bytes.byteLength,
    });
    res.end(bytes);
  } catch (error: unknown) {
    if (isENOENT(error)) {
      sendNotFound(res);
      return;
    }
    sendInternalError(res);
  }
}

/**
 * Dev-only Vite middleware exposing the configured Image Asset root at its
 * stable logical URL. Requests below the prefix are handled as closed-world
 * asset lookups; unrelated URLs continue through Vite normally.
 */
export function imageAssetsPlugin(imageAssetsRoot: string): Plugin {
  return {
    name: "harness:image-assets-static",
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
            console.error("[harness:image-assets-static]", error);
            if (!res.headersSent) sendInternalError(res);
          },
        );
      });
    },
  };
}
