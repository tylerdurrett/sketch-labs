// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { makePreset, type Preset } from "@harness/core";

import {
  listPresets,
  loadPreset,
  savePreset,
} from "./presetsClient";

/**
 * Wiring tests for the headless Preset client: prove the request SHAPES (URL,
 * verb, body) and the read-path `JSON.parse → core.deserialize` hop. The Preset
 * model itself (serialize/deserialize/applyPreset) is core's concern and tested
 * there; here `fetch` is stubbed so nothing touches a real server.
 */

interface StubInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Install a `fetch` stub returning `response`, capturing the call args. */
function stubFetch(response: Partial<Response> & { ok: boolean }) {
  const calls: { url: string; init: StubInit | undefined }[] = [];
  vi.stubGlobal("fetch", (url: string, init?: StubInit) => {
    calls.push({ url, init });
    return Promise.resolve(response as Response);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const SKETCH = "circles";

function samplePreset(name: string): Preset {
  return makePreset(
    SKETCH,
    name,
    { count: 12, radius: 4.5 },
    "abc123",
    new Set(["count"]),
  );
}

describe("presetsClient — listPresets", () => {
  it("GETs the dev list route and returns the sorted names", async () => {
    const calls = stubFetch({
      ok: true,
      json: () => Promise.resolve(["cool", "warm"]),
    });

    const names = await listPresets(SKETCH);

    expect(names).toEqual(["cool", "warm"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`/__api/presets/${SKETCH}`);
    expect(calls[0]?.init).toBeUndefined();
  });

  it("throws on a non-array body", async () => {
    stubFetch({ ok: true, json: () => Promise.resolve({ nope: true }) });
    await expect(listPresets(SKETCH)).rejects.toThrow(/string array/);
  });

  it("throws on a failed request", async () => {
    stubFetch({ ok: false, status: 500, statusText: "boom" } as never);
    await expect(listPresets(SKETCH)).rejects.toThrow(/500/);
  });
});

describe("presetsClient — savePreset", () => {
  it("POSTs the serialized record to the dev write route with the name in the body", async () => {
    const calls = stubFetch({ ok: true });
    const preset = samplePreset("warm");

    await savePreset(preset);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`/__api/presets/${SKETCH}`);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toMatchObject({
      "Content-Type": "application/json",
    });
    const body = JSON.parse(calls[0]?.init?.body ?? "{}");
    expect(body).toEqual(preset);
    expect(body.name).toBe("warm");
  });

  it("throws on a failed write", async () => {
    stubFetch({ ok: false, status: 413, statusText: "too big" } as never);
    await expect(savePreset(samplePreset("warm"))).rejects.toThrow(/413/);
  });
});

describe("presetsClient — loadPreset", () => {
  it("GETs the STATIC file path and runs JSON.parse → deserialize", async () => {
    const preset = samplePreset("warm");
    const calls = stubFetch({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(preset)),
    });

    const loaded = await loadPreset(SKETCH, "warm");

    expect(loaded).toEqual(preset);
    expect(calls[0]?.url).toBe(`/sketches/${SKETCH}/presets/warm.json`);
    expect(calls[0]?.init).toBeUndefined();
  });

  it("throws (via core deserialize) on a malformed Preset", async () => {
    stubFetch({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ version: 99 })),
    });
    await expect(loadPreset(SKETCH, "warm")).rejects.toThrow(/version/);
  });

  it("throws on a 404 missing file", async () => {
    stubFetch({ ok: false, status: 404, statusText: "Not found" } as never);
    await expect(loadPreset(SKETCH, "warm")).rejects.toThrow(/404/);
  });
});
