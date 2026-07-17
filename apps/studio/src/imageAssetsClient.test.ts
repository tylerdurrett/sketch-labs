// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ImageAssetsClientError,
  importImageAsset,
  listImageAssets,
} from "./imageAssetsClient";

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function stubFetch(response: Partial<Response> & { readonly ok: boolean }) {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(response as Response);
  });
  return calls;
}

function pngBlob(bytes: number[] = [137, 80, 78, 71]): Blob {
  return new Blob([new Uint8Array(bytes)], { type: "image/png" });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("imageAssetsClient — listImageAssets", () => {
  it("GETs the list route and returns defensively sorted display records", async () => {
    const calls = stubFetch({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify([
            "zebra-study-aaaaaaaaaaaa",
            "apple-tree-bbbbbbbbbbbb",
            "apple-study-cccccccccccc",
          ]),
        ),
    });

    await expect(listImageAssets()).resolves.toEqual([
      {
        id: "apple-study-cccccccccccc",
        name: "apple study",
        url: "/image-assets/apple-study-cccccccccccc.png",
      },
      {
        id: "apple-tree-bbbbbbbbbbbb",
        name: "apple tree",
        url: "/image-assets/apple-tree-bbbbbbbbbbbb.png",
      },
      {
        id: "zebra-study-aaaaaaaaaaaa",
        name: "zebra study",
        url: "/image-assets/zebra-study-aaaaaaaaaaaa.png",
      },
    ]);
    expect(calls).toEqual([{ url: "/__api/image-assets", init: undefined }]);
  });

  it.each([
    ["non-array", { ids: ["pine-cone-0123456789ab"] }],
    ["non-string entry", ["pine-cone-0123456789ab", 42]],
    ["malformed ID", ["pine-cone-0123456789AB"]],
  ])("rejects a %s response atomically", async (_label, body) => {
    stubFetch({ ok: true, text: () => Promise.resolve(JSON.stringify(body)) });

    await expect(listImageAssets()).rejects.toMatchObject({
      name: "ImageAssetsClientError",
      code: "malformed-response",
      operation: "list",
    });
  });

  it("maps invalid JSON syntax to a bounded malformed-response error", async () => {
    stubFetch({
      ok: true,
      text: () => Promise.resolve("private invalid JSON detail"),
    });

    const error = await listImageAssets().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ImageAssetsClientError);
    expect(error).toMatchObject({
      code: "malformed-response",
      operation: "list",
      message: "Image Asset server response is malformed",
    });
    expect(error).not.toHaveProperty("cause");
    expect((error as Error).message).not.toContain(
      "private invalid JSON detail",
    );
  });

  it("maps a failed response-body read to a bounded network error", async () => {
    stubFetch({
      ok: true,
      text: () => Promise.reject(new Error("private stream detail")),
    });

    const error = await listImageAssets().catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: "network",
      operation: "list",
      message: "Image Asset network request failed",
    });
    expect(error).not.toHaveProperty("cause");
    expect((error as Error).message).not.toContain("private stream detail");
  });

  it("distinguishes failed status and network errors", async () => {
    stubFetch({ ok: false, status: 503, statusText: "private detail" });
    await expect(listImageAssets()).rejects.toMatchObject({
      code: "http-status",
      operation: "list",
      status: 503,
      message: "Image Asset server request failed",
    });

    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline detail")));
    const networkError = await listImageAssets().catch(
      (reason: unknown) => reason,
    );
    expect(networkError).toMatchObject({
      code: "network",
      operation: "list",
      status: undefined,
      message: "Image Asset network request failed",
    });
    expect(networkError).not.toHaveProperty("cause");
    expect((networkError as Error).message).not.toContain("offline detail");
  });
});

describe("imageAssetsClient — importImageAsset", () => {
  it("canonicalizes the slug and POSTs the raw PNG Blob", async () => {
    const body = pngBlob();
    const calls = stubFetch({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            id: "pine-cone-png-0123456789ab",
            created: true,
          }),
        ),
    });

    await expect(importImageAsset("  Pine Cone.PNG  ", body)).resolves.toEqual({
      id: "pine-cone-png-0123456789ab",
      created: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/__api/image-assets/pine-cone-png");
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body,
    });
    expect(calls[0]?.init?.body).toBe(body);
  });

  it("uses the identity policy's safe fallback for a non-ASCII draft", async () => {
    const calls = stubFetch({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({ id: "image-0123456789ab", created: false }),
        ),
    });

    await expect(importImageAsset("🌲", pngBlob())).resolves.toEqual({
      id: "image-0123456789ab",
      created: false,
    });
    expect(calls[0]?.url).toBe("/__api/image-assets/image");
  });

  it.each([
    ["non-string slug", null, pngBlob()],
    ["non-PNG Blob", "study", new Blob(["bytes"], { type: "image/jpeg" })],
    ["empty PNG Blob", "study", pngBlob([])],
    ["non-Blob body", "study", new Uint8Array([1, 2, 3])],
  ])(
    "rejects invalid local input (%s) before fetching",
    async (_label, slug, body) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);

      await expect(
        importImageAsset(slug as string, body as Blob),
      ).rejects.toMatchObject({
        code: "invalid-input",
        operation: "import",
        message: "Image Asset request has invalid local input",
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing id", { created: true }],
    ["malformed id", { id: "Pine-0123456789ab", created: true }],
    ["missing created", { id: "pine-0123456789ab" }],
    ["non-boolean created", { id: "pine-0123456789ab", created: "yes" }],
    ["array", [{ id: "pine-0123456789ab", created: true }]],
  ])("rejects a malformed import response (%s)", async (_label, body) => {
    stubFetch({ ok: true, text: () => Promise.resolve(JSON.stringify(body)) });

    await expect(importImageAsset("pine", pngBlob())).rejects.toMatchObject({
      code: "malformed-response",
      operation: "import",
    });
  });

  it("distinguishes failed status, request network, body network, and invalid JSON", async () => {
    stubFetch({ ok: false, status: 413, statusText: "too large" });
    await expect(importImageAsset("pine", pngBlob())).rejects.toMatchObject({
      code: "http-status",
      operation: "import",
      status: 413,
    });

    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const requestError = await importImageAsset("pine", pngBlob()).catch(
      (reason: unknown) => reason,
    );
    expect(requestError).toMatchObject({
      code: "network",
      operation: "import",
    });
    expect(requestError).not.toHaveProperty("cause");

    stubFetch({
      ok: true,
      text: () => Promise.reject(new Error("private body detail")),
    });
    const bodyError = await importImageAsset("pine", pngBlob()).catch(
      (reason: unknown) => reason,
    );
    expect(bodyError).toMatchObject({
      code: "network",
      operation: "import",
    });
    expect(bodyError).not.toHaveProperty("cause");
    expect((bodyError as Error).message).not.toContain("private body detail");

    stubFetch({
      ok: true,
      text: () => Promise.resolve("private bad json detail"),
    });
    const syntaxError = await importImageAsset("pine", pngBlob()).catch(
      (reason: unknown) => reason,
    );
    expect(syntaxError).toMatchObject({
      code: "malformed-response",
      operation: "import",
    });
    expect(syntaxError).not.toHaveProperty("cause");
    expect((syntaxError as Error).message).not.toContain(
      "private bad json detail",
    );
  });
});
