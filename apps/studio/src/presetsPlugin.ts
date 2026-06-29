/**
 * Dev-server Preset I/O middleware for the Studio (slice #8, task #62).
 *
 * Exposes exactly two routes under {@link API_PREFIX}, per ADR-0006's split of
 * "read-one is a static file; list + write are dev middleware":
 *
 * - `POST /__api/presets/{id}` — persist a Preset JSON at
 *   `{sketchesRoot}/{id}/presets/{name}.json` (name in the JSON-body `name`
 *   field), creating the `presets/` dir recursively. The bytes are owned by
 *   core's Preset model (#61): this writes them back verbatim (re-serialized for
 *   stable formatting) and performs no shape transformation.
 * - `GET /__api/presets/{id}` — list the sketch's preset names (sorted); a
 *   missing dir returns `[]` (ENOENT).
 *
 * Read-one and DELETE are deliberately ABSENT: read-one is served as a plain
 * static file at `/sketches/{id}/presets/{name}.json` (wired in vite.config.ts)
 * so every consumer — dev studio via Vite, Remotion via fs — reads the same
 * file; there is no "no standalone server" delete path in this slice.
 *
 * `sketchesRoot` is passed IN (it already points AT the sketches directory, e.g.
 * `packages/core/src/sketches`), so the on-disk path is
 * `{sketchesRoot}/{id}/presets/{name}.json` with NO extra `sketches` segment —
 * the donor's `server.config.root`-relative derivation does not apply here.
 *
 * Stays node-free for typechecking (the repo has no `@types/node`): the only
 * Node import is `node:fs/promises`, narrowed by a local ambient shim; paths are
 * built as strings, ENOENT is narrowed via `(err as { code?: string }).code`,
 * and the request type is a minimal structural interface rather than
 * `http.IncomingMessage`.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import type { Connect, Plugin } from "vite";

/** URL prefix all preset middleware routes live under. */
const API_PREFIX = "/__api/presets/";

/**
 * Logical URL prefix the sketches root is exposed at in dev, so a preset reads
 * as a plain static file at `/sketches/{id}/presets/{name}.json` (ADR-0006:
 * read-one is a static file, list + write are dev middleware).
 */
const STATIC_PREFIX = "/sketches/";

/** Cap on request body size (1 MB) to prevent abuse. */
const MAX_BODY_BYTES = 1_048_576;

/** Cap on a sketch id / preset name length. */
const MAX_NAME_LENGTH = 100;

/**
 * Lowercase-slug rule: alphanumeric start, then alphanumeric / hyphen /
 * underscore. Forbidding dots, slashes, and backslashes prevents path
 * traversal. This is the same rule CONTEXT.md/#8 pin on a Preset's
 * `name`/filename stem and on a sketch id.
 */
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Reused for Content-Length byte counts (node-free, no `Buffer`). */
const utf8 = new TextEncoder();

/** Validate a sketch id or preset name for safe filesystem use. */
export function isValidName(name: string): boolean {
  return (
    name.length > 0 && name.length <= MAX_NAME_LENGTH && SAFE_NAME_RE.test(name)
  );
}

/** The `res` half of a Connect middleware — node's `http.ServerResponse`. */
type ServerResponse = Parameters<Connect.SimpleHandleFunction>[1];

/**
 * The slice of the incoming request the handler reads. The repo has no
 * `@types/node`, so `Connect.IncomingMessage`'s `http.IncomingMessage` base is
 * opaque and exposes none of these members; declaring them structurally keeps
 * the handler fully typed and unit-testable with a plain fake object. The real
 * request is bridged with a single boundary cast in {@link presetsPlugin}.
 */
export interface PresetRequest {
  url?: string | undefined;
  method?: string | undefined;
  on(
    event: "data",
    cb: (chunk: { toString(encoding: string): string; length: number }) => void,
  ): void;
  on(event: "end", cb: () => void): void;
  on(event: "error", cb: (err: unknown) => void): void;
  destroy(): void;
}

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": utf8.encode(body).length,
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJSON(res, status, { error: message });
}

/** Read the request body as a UTF-8 string, capped to prevent abuse. */
function readBody(req: PresetRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    let size = 0;
    req.on("data", (chunk) => {
      const text = chunk.toString("utf-8");
      size += utf8.encode(text).length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(text);
    });
    req.on("end", () => resolve(chunks.join("")));
    req.on("error", reject);
  });
}

/** Narrow an unknown caught value to a node ENOENT (missing path) error. */
function isENOENT(err: unknown): boolean {
  return (err as { code?: string }).code === "ENOENT";
}

function presetsDir(sketchesRoot: string, id: string): string {
  return `${sketchesRoot}/${id}/presets`;
}

function presetFile(sketchesRoot: string, id: string, name: string): string {
  return `${presetsDir(sketchesRoot, id)}/${name}.json`;
}

/** List preset names for a sketch, sorted. Missing dir → `[]`. */
async function handleList(
  sketchesRoot: string,
  id: string,
  res: ServerResponse,
): Promise<void> {
  try {
    const entries = await readdir(presetsDir(sketchesRoot, id));
    const names = entries
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
    sendJSON(res, 200, names);
  } catch (err: unknown) {
    if (isENOENT(err)) {
      sendJSON(res, 200, []);
    } else {
      throw err;
    }
  }
}

/**
 * Write a Preset JSON, creating `presets/` if needed. The `name` is taken from
 * the request body's `name` field (the record's filename stem) and validated as
 * a slug. Bytes are owned by core (#61) — re-serialized for stable formatting,
 * never reshaped.
 */
async function handleWrite(
  sketchesRoot: string,
  id: string,
  req: PresetRequest,
  res: ServerResponse,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendError(res, 413, "Request body too large");
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendError(res, 400, "Invalid JSON body");
    return;
  }

  const name = (parsed as { name?: unknown }).name;
  if (typeof name !== "string" || !isValidName(name)) {
    sendError(res, 400, "Invalid preset name");
    return;
  }

  await mkdir(presetsDir(sketchesRoot, id), { recursive: true });
  await writeFile(
    presetFile(sketchesRoot, id, name),
    JSON.stringify(parsed, null, 2) + "\n",
    "utf-8",
  );
  sendJSON(res, 200, { ok: true });
}

/**
 * Route a preset request. Exported for unit testing — drive it with a temp
 * `sketchesRoot` and a fake request/response rather than a real server.
 *
 * Routes (single `{id}` segment only):
 * - `GET  /__api/presets/{id}` → list names
 * - `POST /__api/presets/{id}` → write (name from body)
 *
 * Anything else (extra path segments, other methods) is a 4xx; there is no
 * read-one or DELETE route.
 */
export async function handlePresetRequest(
  sketchesRoot: string,
  req: PresetRequest,
  res: ServerResponse,
): Promise<void> {
  const url = (req.url ?? "").split("?")[0] ?? "";
  const segments = url.slice(API_PREFIX.length).split("/").filter(Boolean);
  const method = req.method ?? "GET";

  // Exactly one segment (the sketch id). Two-segment read-one / DELETE are gone.
  if (segments.length !== 1) {
    sendError(res, 404, "Not found");
    return;
  }

  const id = segments[0] ?? "";
  if (!isValidName(id)) {
    sendError(res, 400, "Invalid sketch id");
    return;
  }

  switch (method) {
    case "GET":
      await handleList(sketchesRoot, id, res);
      return;
    case "POST":
      await handleWrite(sketchesRoot, id, req, res);
      return;
    default:
      sendError(res, 405, "Method not allowed");
  }
}

/**
 * A request handler bound to a `sketchesRoot`, as used by both dev plugins.
 */
type RequestHandler = (
  req: PresetRequest,
  res: ServerResponse,
  next: Connect.NextFunction,
) => Promise<void>;

/**
 * Build a dev-only (`apply: 'serve'`) Vite plugin whose middleware runs
 * `handler` for every request under `prefix` and passes everything else to the
 * next middleware. Both preset plugins share this shape — only the prefix and
 * handler differ — including the boundary cast (the real request structurally
 * satisfies {@link PresetRequest}, but its `http.IncomingMessage` base is
 * untyped without `@types/node`) and the 500 fallback for an unhandled reject.
 */
function devMiddlewarePlugin(
  name: string,
  prefix: string,
  handler: RequestHandler,
): Plugin {
  return {
    name,
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const presetReq = req as unknown as PresetRequest;
        if (!(presetReq.url ?? "").startsWith(prefix)) {
          next();
          return;
        }
        handler(presetReq, res, next).catch((err: unknown) => {
          console.error(`[${name}]`, err);
          if (!res.headersSent) {
            sendError(res, 500, "Internal server error");
          }
        });
      });
    },
  };
}

/**
 * Vite dev-server plugin exposing the preset write + list middleware. Dev-only;
 * presets are stored as JSON alongside sketch code at
 * `{sketchesRoot}/{id}/presets/{name}.json`. `sketchesRoot` is supplied by
 * `vite.config.ts` and already points at the sketches directory.
 */
export function presetsPlugin(sketchesRoot: string): Plugin {
  return devMiddlewarePlugin("harness:presets", API_PREFIX, (req, res) =>
    handlePresetRequest(sketchesRoot, req, res),
  );
}

/**
 * Serve a preset as a plain static file in dev. Resolves
 * `/sketches/{id}/presets/{name}.json` to `{sketchesRoot}/{id}/presets/{name}.json`
 * and returns its bytes. Exported for testing.
 *
 * Only that exact `{id}/presets/{name}.json` shape is served (every segment is
 * slug-validated, which also blocks `..` traversal). Off-shape `/sketches/`
 * requests fall through to the next middleware (Vite) so it can serve other
 * assets/source under the prefix; a missing preset file is a real 404.
 */
export async function handleStaticRequest(
  sketchesRoot: string,
  req: PresetRequest,
  res: ServerResponse,
  next: Connect.NextFunction,
): Promise<void> {
  const path = (req.url ?? "").split("?")[0] ?? "";
  const segments = path.slice(STATIC_PREFIX.length).split("/").filter(Boolean);

  // Exactly `{id}/presets/{name}.json`.
  const [id, presetsSeg, file] = segments;
  if (
    segments.length !== 3 ||
    presetsSeg !== "presets" ||
    !file?.endsWith(".json")
  ) {
    next();
    return;
  }
  const name = file.slice(0, -".json".length);
  if (id === undefined || !isValidName(id) || !isValidName(name)) {
    next();
    return;
  }

  try {
    const content = await readFile(presetFile(sketchesRoot, id, name), "utf-8");
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": utf8.encode(content).length,
    });
    res.end(content);
  } catch (err: unknown) {
    if (isENOENT(err)) {
      sendError(res, 404, "Not found");
    } else {
      throw err;
    }
  }
}

/**
 * Vite dev-server plugin that exposes `{sketchesRoot}` at the logical URL
 * `/sketches/`, so a preset is readable as a static file by every consumer
 * (ADR-0006). Dev-only; `sketchesRoot` is supplied by `vite.config.ts`.
 */
export function sketchesStaticPlugin(sketchesRoot: string): Plugin {
  return devMiddlewarePlugin(
    "harness:sketches-static",
    STATIC_PREFIX,
    (req, res, next) => handleStaticRequest(sketchesRoot, req, res, next),
  );
}
