// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Preset } from "@harness/core";

import {
  handlePresetRequest,
  handleStaticRequest,
  isValidName,
} from "./presetsPlugin";

/**
 * Captures everything {@link handlePresetRequest} / {@link handleStaticRequest}
 * write to the response, so a test can assert on status + parsed body without a
 * real server.
 */
interface CapturedResponse {
  status: number;
  headers: Record<string, string | number>;
  body: string;
  json(): unknown;
}

/** A fake `ServerResponse` recording the single writeHead/end the handler does. */
function fakeRes(): CapturedResponse & {
  writeHead(status: number, headers?: Record<string, string | number>): void;
  end(body?: string): void;
  headersSent: boolean;
} {
  const captured = {
    status: 0,
    headers: {} as Record<string, string | number>,
    body: "",
    headersSent: false,
    json(): unknown {
      return JSON.parse(this.body);
    },
    writeHead(status: number, headers?: Record<string, string | number>): void {
      this.status = status;
      if (headers) this.headers = headers;
      this.headersSent = true;
    },
    end(body?: string): void {
      if (body !== undefined) this.body = body;
    },
  };
  return captured;
}

/**
 * A fake request. For a POST, `body` is delivered through the `data`/`end`
 * events the handler listens for; the events fire on the next microtask so the
 * handler has registered its listeners first.
 */
function fakeReq(url: string, method: string, body?: string): unknown {
  const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
  const req = {
    url,
    method,
    on(event: string, cb: (arg?: unknown) => void): void {
      (listeners[event] ??= []).push(cb);
      if (event === "end") {
        queueMicrotask(() => {
          if (body !== undefined) {
            for (const cb of listeners["data"] ?? []) {
              cb({ toString: () => body, length: body.length });
            }
          }
          for (const cb of listeners["end"] ?? []) cb();
        });
      }
    },
    destroy(): void {},
  };
  return req;
}

const SKETCH = "circles";

function samplePreset(name: string): Preset {
  return {
    version: 1,
    sketch: SKETCH,
    name,
    seed: "abc123",
    params: { count: 12, radius: 4.5 },
    locks: ["count"],
  };
}

// The handlers take a structural request; cast the fakes at the call site, the
// same boundary cast the plugin uses against the real http.IncomingMessage.
function post(root: string, id: string, preset: Preset): Promise<CapturedResponse> {
  const res = fakeRes();
  return handlePresetRequest(
    root,
    fakeReq(`/__api/presets/${id}`, "POST", JSON.stringify(preset)) as never,
    res as never,
  ).then(() => res);
}

function list(root: string, id: string): Promise<CapturedResponse> {
  const res = fakeRes();
  return handlePresetRequest(
    root,
    fakeReq(`/__api/presets/${id}`, "GET") as never,
    res as never,
  ).then(() => res);
}

describe("presetsPlugin handlers", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(`${tmpdir()}/harness-presets-`);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("POST writes the record verbatim and round-trips off disk", async () => {
    const preset = samplePreset("warm");
    const res = await post(root, SKETCH, preset);
    expect(res.status).toBe(200);

    const onDisk = await readFile(
      `${root}/${SKETCH}/presets/warm.json`,
      "utf-8",
    );
    expect(JSON.parse(onDisk)).toEqual(preset);
  });

  it("GET list returns the written preset name", async () => {
    await post(root, SKETCH, samplePreset("warm"));
    await post(root, SKETCH, samplePreset("cool"));

    const res = await list(root, SKETCH);
    expect(res.status).toBe(200);
    expect(res.json()).toEqual(["cool", "warm"]); // sorted
  });

  it("GET list on a missing sketch dir returns an empty list", async () => {
    const res = await list(root, "never-saved");
    expect(res.status).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("rejects an invalid sketch id with 400", async () => {
    const res = await list(root, "Bad_Name");
    expect(res.status).toBe(400);
  });

  it("rejects an invalid preset name in the body with 400", async () => {
    const res = await post(root, SKETCH, samplePreset("Not A Slug"));
    expect(res.status).toBe(400);
  });

  it("has no read-one or DELETE route — both 4xx, nothing written", async () => {
    await post(root, SKETCH, samplePreset("warm"));

    // A two-segment read-one path is not a route (404).
    const readOne = fakeRes();
    await handlePresetRequest(
      root,
      fakeReq(`/__api/presets/${SKETCH}/warm`, "GET") as never,
      readOne as never,
    );
    expect(readOne.status).toBe(404);

    // DELETE on the sketch id is not an allowed method (405).
    const del = fakeRes();
    await handlePresetRequest(
      root,
      fakeReq(`/__api/presets/${SKETCH}`, "DELETE") as never,
      del as never,
    );
    expect(del.status).toBe(405);

    // The preset is still present after both — neither route mutated disk.
    const after = await list(root, SKETCH);
    expect(after.json()).toEqual(["warm"]);
  });

  it("serves a written preset as a static file at /sketches/{id}/presets/{name}.json", async () => {
    const preset = samplePreset("warm");
    await post(root, SKETCH, preset);

    const res = fakeRes();
    let nextCalled = false;
    const next = (): void => {
      nextCalled = true;
    };
    await handleStaticRequest(
      root,
      fakeReq(`/sketches/${SKETCH}/presets/warm.json`, "GET") as never,
      res as never,
      next as never,
    );
    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual(preset);
    expect(nextCalled).toBe(false);
  });

  it("falls through to the next middleware for an off-shape /sketches/ URL", async () => {
    const res = fakeRes();
    let nextCalled = false;
    const next = (): void => {
      nextCalled = true;
    };
    await handleStaticRequest(
      root,
      fakeReq(`/sketches/${SKETCH}/index.ts`, "GET") as never,
      res as never,
      next as never,
    );
    expect(nextCalled).toBe(true);
    expect(res.status).toBe(0);
    expect(res.headersSent).toBe(false);
  });

  it("isValidName enforces the lowercase-slug rule", () => {
    expect(isValidName("warm-1")).toBe(true);
    expect(isValidName("Warm")).toBe(false);
    expect(isValidName("../escape")).toBe(false);
    expect(isValidName("")).toBe(false);
  });
});
