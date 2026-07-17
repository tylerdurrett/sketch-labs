// @vitest-environment node
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  handleImageAssetRequest,
  IMAGE_ASSET_MAX_BODY_BYTES,
  IMAGE_ASSET_MAX_SLUG_LENGTH,
  imageAssetsPlugin,
} from "./imageAssetsPlugin";
import { imageAssetIdFromDigest } from "./imageAssetIdentity";

const ID = "pine-cone-0123456789ab";
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);

interface CapturedResponse {
  status: number;
  headers: Record<string, string | number>;
  body: string | Uint8Array;
  headersSent: boolean;
  writeHead(status: number, headers?: Record<string, string | number>): void;
  end(body?: string | Uint8Array): void;
  json(): unknown;
}

function fakeRes(): CapturedResponse {
  return {
    status: 0,
    headers: {},
    body: "",
    headersSent: false,
    json(): unknown {
      return JSON.parse(this.body as string);
    },
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

interface RequestOptions {
  readonly chunks?: readonly Uint8Array[];
  readonly headers?: Readonly<Record<string, string>>;
}

function fakeReq(
  url: string,
  method: string,
  options: RequestOptions = {},
): unknown {
  const listeners: Record<string, ((arg?: unknown) => void)[]> = {};

  return {
    url,
    method,
    headers: options.headers ?? {},
    on(event: string, cb: (arg?: unknown) => void): void {
      (listeners[event] ??= []).push(cb);
      if (event === "end") {
        queueMicrotask(() => {
          for (const chunk of options.chunks ?? []) {
            for (const listener of listeners["data"] ?? []) listener(chunk);
          }
          for (const listener of listeners["end"] ?? []) listener();
        });
      }
    },
  };
}

async function request(
  root: string,
  url: string,
  method = "GET",
  options: RequestOptions = {},
): Promise<CapturedResponse> {
  const res = fakeRes();
  await handleImageAssetRequest(
    root,
    fakeReq(url, method, options) as never,
    res as never,
  );
  return res;
}

function post(
  root: string,
  slug: string,
  bytes: Uint8Array,
  headers: Readonly<Record<string, string>> = {},
): Promise<CapturedResponse> {
  return request(root, `/__api/image-assets/${slug}`, "POST", {
    chunks: [bytes],
    headers: {
      "content-type": "image/png",
      "content-length": String(bytes.byteLength),
      ...headers,
    },
  });
}

function expectedId(slug: string, bytes: Uint8Array): string {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return imageAssetIdFromDigest(slug, digest);
}

async function overLimitChunkedHttpRequest(
  root: string,
): Promise<{ readonly status: number; readonly body: string }> {
  const server = createServer((req, res) => {
    void handleImageAssetRequest(root, req as never, res as never);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address() as { readonly port: number };
    return await new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: "/__api/image-assets/streamed-study",
          method: "POST",
          headers: { "Content-Type": "image/png" },
        },
        (res) => {
          const chunks: string[] = [];
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => chunks.push(chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: chunks.join("") }),
          );
        },
      );
      req.on("error", reject);

      void (async () => {
        const chunk = new Uint8Array(1024 * 1024);
        for (
          let sent = 0;
          sent < IMAGE_ASSET_MAX_BODY_BYTES;
          sent += chunk.byteLength
        ) {
          if (!req.write(chunk)) {
            await new Promise<void>((drain) => req.once("drain", drain));
          }
        }
        req.end(new Uint8Array([0]));
      })().catch(reject);
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}

describe("Image Asset static serving", () => {
  let root: string;
  let outsidePath: string;

  beforeEach(async () => {
    root = await mkdtemp(`${tmpdir()}/harness-image-assets-`);
    outsidePath = `${root}-outside.png`;
    await writeFile(`${root}/${ID}.png`, PNG_BYTES);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outsidePath, { recursive: true, force: true });
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

  it("refuses a canonical-named symlink without reading outside the root", async () => {
    await rm(`${root}/${ID}.png`, { recursive: true, force: true });
    await writeFile(outsidePath, PNG_BYTES);
    await symlink(outsidePath, `${root}/${ID}.png`, "file");

    const res = await request(root, `/image-assets/${ID}.png`);

    expect(res.status).toBe(404);
    expect(res.body).toBe('{"error":"Not found"}');
    expect(res.body).not.toContain(root);
    expect(res.body).not.toContain(outsidePath);
  });

  it("returns a path-free 500 for unexpected filesystem failures", async () => {
    const invalidRoot = `${root}\0unreadable`;

    const res = await request(invalidRoot, `/image-assets/${ID}.png`);

    expect(res.status).toBe(500);
    expect(res.body).toBe('{"error":"Internal server error"}');
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

  it("rejects writes to the immutable static route", async () => {
    const res = await request(root, `/image-assets/${ID}.png`, "POST");

    expect(res.status).toBe(405);
    expect(Array.from(await readFile(`${root}/${ID}.png`))).toEqual(
      Array.from(PNG_BYTES),
    );
  });

  it("is a serve-only Vite plugin with the expected identity", () => {
    expect(imageAssetsPlugin(root)).toMatchObject({
      name: "harness:image-assets",
      apply: "serve",
    });
  });
});

describe("Image Asset list and write API", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(`${tmpdir()}/harness-image-assets-api-`);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists only persisted assets in stable order", async () => {
    const zulu = "zulu-abcdef012345";
    const alpha = "alpha-0123456789ab";
    await writeFile(`${root}/${zulu}.png`, PNG_BYTES);
    await writeFile(`${root}/${alpha}.png`, PNG_BYTES);
    await writeFile(`${root}/not-an-asset.png`, PNG_BYTES);

    const res = await request(root, "/__api/image-assets");

    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/json");
    expect(res.json()).toEqual([alpha, zulu]);
  });

  it("writes exact bytes once and serves them from the stable static URL", async () => {
    const res = await post(root, "pine-cone", PNG_BYTES);
    const id = expectedId("pine-cone", PNG_BYTES);

    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ id, created: true });
    expect(Array.from(await readFile(`${root}/${id}.png`))).toEqual(
      Array.from(PNG_BYTES),
    );

    const staticRes = await request(root, `/image-assets/${id}.png`);
    expect(staticRes.status).toBe(200);
    expect(staticRes.headers["Content-Type"]).toBe("image/png");
    expect(Array.from(staticRes.body as Uint8Array)).toEqual(
      Array.from(PNG_BYTES),
    );
  });

  it("deduplicates identical bytes across slugs through the store", async () => {
    const first = await post(root, "first-name", PNG_BYTES);
    const second = await post(root, "second-name", PNG_BYTES);

    expect(first.json()).toMatchObject({ created: true });
    expect(second.json()).toEqual({
      id: (first.json() as { id: string }).id,
      created: false,
    });
    expect(await readdir(root)).toEqual([
      `${(first.json() as { id: string }).id}.png`,
    ]);
  });

  it("serializes concurrent writes of identical bytes", async () => {
    const [first, second] = await Promise.all([
      post(root, "first", PNG_BYTES),
      post(root, "second", PNG_BYTES),
    ]);
    const results = [first.json(), second.json()] as {
      id: string;
      created: boolean;
    }[];

    expect(results[0]!.id).toBe(results[1]!.id);
    expect(results.map(({ created }) => created).sort()).toEqual([false, true]);
    expect(await readdir(root)).toEqual([`${results[0]!.id}.png`]);
  });

  it("maps an immutable identity conflict to a path-free 409", async () => {
    const id = expectedId("collision", PNG_BYTES);
    const conflictingBytes = new Uint8Array([...PNG_BYTES, 1]);
    await writeFile(`${root}/${id}.png`, conflictingBytes);

    const res = await post(root, "collision", PNG_BYTES);

    expect(res.status).toBe(409);
    expect(res.body).toBe(
      '{"error":"Image Asset conflicts with existing bytes"}',
    );
    expect(res.body).not.toContain(root);
    expect(Array.from(await readFile(`${root}/${id}.png`))).toEqual(
      Array.from(conflictingBytes),
    );
  });

  it.each([
    ["GET on write", `/__api/image-assets/pine-cone`, "GET", 405],
    ["POST on list", "/__api/image-assets", "POST", 405],
    ["DELETE on static read", `/image-assets/${ID}.png`, "DELETE", 405],
    ["list trailing slash", "/__api/image-assets/", "GET", 404],
    ["write extra segment", "/__api/image-assets/pine/cone", "POST", 404],
  ])("rejects the unsupported %s route", async (_case, url, method, status) => {
    const res = await request(root, url, method);

    expect(res.status).toBe(status);
    expect(res.headers["Content-Type"]).toBe("application/json");
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    ["uppercase", "Pine-cone"],
    ["underscore", "pine_cone"],
    ["encoded separator", "pine%2dcone"],
    ["encoded traversal", "%2e%2e"],
    ["raw traversal", ".."],
    ["leading hyphen", "-pine"],
    ["overlong", "a".repeat(IMAGE_ASSET_MAX_SLUG_LENGTH + 1)],
  ])("rejects a %s slug before reading or writing", async (_case, slug) => {
    const res = await post(root, slug, PNG_BYTES);

    expect(res.status).toBe(400);
    expect(res.body).toBe('{"error":"Invalid Image Asset slug"}');
    expect(await readdir(root)).toEqual([]);
  });

  it("accepts the bounded canonical slug edge", async () => {
    const slug = "a".repeat(IMAGE_ASSET_MAX_SLUG_LENGTH);
    const res = await post(root, slug, PNG_BYTES);

    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ created: true });
  });

  it.each([
    ["missing", {}],
    ["wrong", { "content-type": "application/octet-stream" }],
    ["parameterized", { "content-type": "image/png; charset=binary" }],
  ])("rejects %s PNG content type without mutation", async (_case, headers) => {
    const res = await request(
      root,
      "/__api/image-assets/study",
      "POST",
      { chunks: [PNG_BYTES], headers },
    );

    expect(res.status).toBe(400);
    expect(res.body).toBe('{"error":"Content-Type must be image/png"}');
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects an invalid PNG signature as a bounded 400 without mutation", async () => {
    const res = await post(root, "study", new Uint8Array([1, 2, 3]));

    expect(res.status).toBe(400);
    expect(res.body).toBe('{"error":"Invalid PNG body"}');
    expect(res.body).not.toContain(root);
    expect(await readdir(root)).toEqual([]);
  });

  it.each(["-1", "1.5", "garbage", "9007199254740992"])(
    "rejects invalid Content-Length %s without mutation",
    async (length) => {
      const res = await request(
        root,
        "/__api/image-assets/study",
        "POST",
        {
          chunks: [PNG_BYTES],
          headers: {
            "content-type": "image/png",
            "content-length": length,
          },
        },
      );

      expect(res.status).toBe(400);
      expect(res.body).toBe('{"error":"Invalid Content-Length"}');
      expect(await readdir(root)).toEqual([]);
    },
  );

  it("rejects an over-limit declared body before persistence", async () => {
    const res = await request(
      root,
      "/__api/image-assets/study",
      "POST",
      {
        headers: {
          "content-type": "image/png",
          "content-length": String(IMAGE_ASSET_MAX_BODY_BYTES + 1),
        },
      },
    );

    expect(res.status).toBe(413);
    expect(res.body).toBe('{"error":"Request body too large"}');
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects streamed bytes crossing the limit before persistence", async () => {
    const first = new Uint8Array(IMAGE_ASSET_MAX_BODY_BYTES);
    first.set(PNG_BYTES.subarray(0, 8));
    const res = await request(
      root,
      "/__api/image-assets/study",
      "POST",
      {
        chunks: [first, new Uint8Array([0])],
        headers: { "content-type": "image/png" },
      },
    );

    expect(res.status).toBe(413);
    expect(res.body).toBe('{"error":"Request body too large"}');
    expect(await readdir(root)).toEqual([]);
  });

  it("returns JSON 413 over real HTTP while draining an over-limit chunked body", async () => {
    const res = await overLimitChunkedHttpRequest(root);

    expect(res.status).toBe(413);
    expect(res.body).toBe('{"error":"Request body too large"}');
    expect(await readdir(root)).toEqual([]);
  });

  it("accepts a 20 MiB normalized PNG payload", async () => {
    const bytes = new Uint8Array(20 * 1024 * 1024);
    bytes.set(PNG_BYTES.subarray(0, 8));

    const res = await post(root, "large-study", bytes);

    expect(res.status).toBe(200);
    const { id, created } = res.json() as { id: string; created: boolean };
    expect(created).toBe(true);
    expect((await readFile(`${root}/${id}.png`)).byteLength).toBe(
      bytes.byteLength,
    );
  });

  it("maps storage failures to a bounded path-free 500", async () => {
    const invalidRoot = `${root}\0unusable`;
    const res = await request(invalidRoot, "/__api/image-assets");

    expect(res.status).toBe(500);
    expect(res.body).toBe('{"error":"Internal server error"}');
    expect(res.body).not.toContain(root);
  });
});
