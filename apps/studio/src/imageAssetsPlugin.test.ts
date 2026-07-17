// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  handleImageAssetRequest,
  imageAssetsPlugin,
} from "./imageAssetsPlugin";

const ID = "pine-cone-0123456789ab";
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);

interface CapturedResponse {
  status: number;
  headers: Record<string, string | number>;
  body: string | Uint8Array;
  headersSent: boolean;
  writeHead(status: number, headers?: Record<string, string | number>): void;
  end(body?: string | Uint8Array): void;
}

function fakeRes(): CapturedResponse {
  return {
    status: 0,
    headers: {},
    body: "",
    headersSent: false,
    writeHead(status, headers): void {
      this.status = status;
      if (headers) this.headers = headers;
      this.headersSent = true;
    },
    end(body): void {
      if (body !== undefined) this.body = body;
    },
  };
}

async function request(
  root: string,
  url: string,
  method = "GET",
): Promise<CapturedResponse> {
  const res = fakeRes();
  await handleImageAssetRequest(root, { url, method }, res as never);
  return res;
}

describe("Image Asset static serving", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(`${tmpdir()}/harness-image-assets-`);
    await writeFile(`${root}/${ID}.png`, PNG_BYTES);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serves the exact PNG bytes with the correct headers", async () => {
    const res = await request(root, `/image-assets/${ID}.png`);

    expect(res.status).toBe(200);
    expect(res.headers).toEqual({
      "Content-Type": "image/png",
      "Content-Length": PNG_BYTES.byteLength,
    });
    expect(Array.from(res.body as Uint8Array)).toEqual(Array.from(PNG_BYTES));
    expect(Array.from(await readFile(`${root}/${ID}.png`))).toEqual(
      Array.from(PNG_BYTES),
    );
  });

  it("allows a query without using it to resolve the filesystem path", async () => {
    const res = await request(
      root,
      `/image-assets/${ID}.png?cache=1/../../outside.png`,
    );

    expect(res.status).toBe(200);
    expect(Array.from(res.body as Uint8Array)).toEqual(Array.from(PNG_BYTES));
  });

  it("returns a path-free 404 for a valid but missing asset", async () => {
    const res = await request(
      root,
      "/image-assets/missing-asset-abcdef012345.png",
    );

    expect(res.status).toBe(404);
    expect(res.body).toBe('{"error":"Not found"}');
    expect(res.body).not.toContain(root);
  });

  it.each([
    ["root without slash", "/image-assets"],
    ["list root", "/image-assets/"],
    ["uppercase slug", "/image-assets/Pine-cone-0123456789ab.png"],
    ["uppercase hash", "/image-assets/pine-cone-0123456789AB.png"],
    ["short hash", "/image-assets/pine-cone-0123456789a.png"],
    ["long hash", "/image-assets/pine-cone-0123456789abc.png"],
    ["extra segment", `/image-assets/nested/${ID}.png`],
    ["raw traversal", `/image-assets/../${ID}.png`],
    ["encoded traversal", `/image-assets/%2e%2e%2f${ID}.png`],
    ["wrong extension", `/image-assets/${ID}.jpg`],
    ["double extension", `/image-assets/${ID}.png.png`],
  ])("returns 404 for %s", async (_case, url) => {
    const res = await request(root, url);

    expect(res.status).toBe(404);
    expect(res.body).toBe('{"error":"Not found"}');
    expect(res.body).not.toContain(root);
  });

  it("has no write operation", async () => {
    const res = await request(root, `/image-assets/${ID}.png`, "POST");

    expect(res.status).toBe(404);
    expect(Array.from(await readFile(`${root}/${ID}.png`))).toEqual(
      Array.from(PNG_BYTES),
    );
  });

  it("is a serve-only Vite plugin with the expected identity", () => {
    expect(imageAssetsPlugin(root)).toMatchObject({
      name: "harness:image-assets-static",
      apply: "serve",
    });
  });
});
