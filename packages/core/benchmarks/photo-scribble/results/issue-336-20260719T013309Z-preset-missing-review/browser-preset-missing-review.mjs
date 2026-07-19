import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const puppeteerEntry = process.env.PUPPETEER_ENTRY;
if (!puppeteerEntry) throw new Error("PUPPETEER_ENTRY is required");
const puppeteer = (await import(pathToFileURL(puppeteerEntry).href)).default;

const root = process.cwd();
const evidenceId = "issue-336-20260719T013309Z-preset-missing-review";
const presetName = "issue-336-trial-preset-missing-review";
const selectedAssetId = "pinecone-4330aa0314f7";
const selectedAssetPath = resolve(root, `assets/image-assets/${selectedAssetId}.png`);
const presetPath = resolve(
  root,
  `packages/core/src/sketches/photo-scribble/presets/${presetName}.json`,
);
const outputDirectory = resolve(
  root,
  "packages/core/benchmarks/photo-scribble/results",
  evidenceId,
);
const studioUrl = "http://127.0.0.1:4319/";
const viteBinary = resolve(root, "apps/studio/node_modules/.bin/vite");

const observations = {
  schemaVersion: 1,
  review: "issue-336-product-studio-preset-missing-asset-review",
  evidenceId,
  presetName,
  selectedAssetId,
  studioUrl,
  policy: {
    source: "packages/core/src/scribbleStrategy/index.ts",
    maxAcceptedSegments: 1_000_000,
    maxPolylines: 16_000,
    maxStagnations: 32_000,
    maxRestarts: 16_000,
  },
  browser: {},
  lifecycle: [],
  actions: [],
  network: [],
  console: [],
  pageErrors: [],
  screenshots: [],
  phases: {},
  assertions: {},
  cleanup: {},
};

function nowIso() {
  return new Date().toISOString();
}

function workerSummary(worker) {
  return {
    workerId: worker.workerId,
    createdAt: worker.createdAt,
    url: worker.url,
    requestAt: worker.requestAt ?? null,
    request: worker.request ?? null,
    progress: worker.progress,
    successAt: worker.successAt ?? null,
    success: worker.success ?? null,
    failureAt: worker.failureAt ?? null,
    failure: worker.failure ?? null,
    terminatedAt: worker.terminatedAt ?? null,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function inventory(relativeDirectory) {
  const base = resolve(root, relativeDirectory);
  const rows = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        rows.push({
          path: path.slice(base.length + 1),
          byteLength: bytes.byteLength,
          sha256: sha256(bytes),
        });
      }
    }
  }
  await visit(base);
  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

async function waitForHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolvePromise) => {
      const request = http.get(url, (response) => {
        response.resume();
        resolvePromise(response.statusCode === 200);
      });
      request.on("error", () => resolvePromise(false));
      request.setTimeout(500, () => {
        request.destroy();
        resolvePromise(false);
      });
    });
    if (ok) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("Studio did not become ready");
}

let server = null;
async function startStudio(reason) {
  const record = { at: nowIso(), action: "start-studio", reason, stdout: [], stderr: [] };
  observations.lifecycle.push(record);
  server = spawn(
    viteBinary,
    ["--host", "127.0.0.1", "--port", "4319", "--strictPort"],
    { cwd: resolve(root, "apps/studio"), stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  server.stdout.on("data", (chunk) => record.stdout.push(chunk));
  server.stderr.on("data", (chunk) => record.stderr.push(chunk));
  server.on("exit", (code, signal) => {
    record.exit = { at: nowIso(), code, signal };
  });
  await waitForHttp(studioUrl);
  record.readyAt = nowIso();
}

async function stopStudio(reason) {
  if (server === null) return;
  const active = server;
  observations.lifecycle.push({ at: nowIso(), action: "stop-studio", reason });
  if (active.exitCode === null && active.signalCode === null) {
    active.kill("SIGTERM");
    await Promise.race([
      new Promise((resolvePromise) => active.once("exit", resolvePromise)),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
    ]);
    if (active.exitCode === null && active.signalCode === null) active.kill("SIGKILL");
  }
  server = null;
}

async function clickButton(page, label) {
  await page.waitForFunction(
    (text) => [...document.querySelectorAll("button")].some(
      (button) => button.textContent?.trim() === text && !button.disabled,
    ),
    {},
    label,
  );
  await page.evaluate((text) => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === text && !candidate.disabled,
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing ${text}`);
    button.click();
  }, label);
}

async function workerCount(page) {
  return page.evaluate(() => window.__ISSUE_336_REVIEW__.workers.length);
}

async function waitForNewSuccess(page, startIndex) {
  await page.waitForFunction(
    (start) => window.__ISSUE_336_REVIEW__.workers.slice(start).some(
      (worker) => worker.successAt !== undefined,
    ),
    { timeout: 180_000 },
    startIndex,
  );
  const index = await page.evaluate((start) => {
    const workers = window.__ISSUE_336_REVIEW__.workers;
    for (let index = workers.length - 1; index >= start; index -= 1) {
      if (workers[index].successAt !== undefined) return index;
    }
    return -1;
  }, startIndex);
  await page.evaluate(() => new Promise((resolvePromise) =>
    requestAnimationFrame(() => requestAnimationFrame(resolvePromise)),
  ));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  return index;
}

async function hashWorkerResult(page, index) {
  return page.evaluate(async (workerIndex) => {
    const worker = window.__ISSUE_336_REVIEW__.workers[workerIndex];
    if (worker?._scene === undefined || worker.success === undefined) {
      throw new Error(`Worker ${workerIndex} has no retained result`);
    }
    const hashes = await import("/src/photoScribbleEvidenceHash.ts");
    const sceneHash = await hashes.canonicalBrowserSceneHash(worker._scene);
    const diagnosticsHash = await hashes.canonicalBrowserDiagnosticsHash(
      worker.success.diagnostics,
    );
    const identityHash = await hashes.canonicalScribbleIdentityHash(
      worker.success.identity,
    );
    const params = Object.fromEntries(
      worker.success.identity.params.map((entry) => [entry.key, entry.value]),
    );
    let pointCount = 0;
    for (const primitive of worker._scene.primitives) pointCount += primitive.points.length;
    return {
      sceneHash,
      diagnosticsHash,
      identityHash,
      identity: worker.success.identity,
      params,
      diagnostics: worker.success.diagnostics,
      primitiveCount: worker.success.primitiveCount,
      pointCount,
      computeTimeMs: worker.success.computeTimeMs,
    };
  }, index);
}

async function savePreset(page) {
  await page.click('input[aria-label="preset name"]');
  await page.type('input[aria-label="preset name"]', presetName);
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/__api/presets/photo-scribble") &&
      response.request().method() === "POST",
  );
  await clickButton(page, "Save");
  const response = await responsePromise;
  if (response.status() !== 200) throw new Error(`Preset save failed: ${response.status()}`);
  await page.waitForFunction(
    (name) => [...document.querySelectorAll('select[aria-label="saved presets"] option')]
      .some((option) => option.value === name),
    {},
    presetName,
  );
}

async function loadPreset(page) {
  await page.waitForFunction(
    (name) => [...document.querySelectorAll('select[aria-label="saved presets"] option')]
      .some((option) => option.value === name),
    {},
    presetName,
  );
  await page.select('select[aria-label="saved presets"]', presetName);
  await clickButton(page, "Reload");
}

async function pageState(page) {
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    const canvas = document.querySelector("canvas");
    const identity = document.querySelector(
      '[aria-label="imageAsset image asset identity"]',
    )?.textContent?.trim() ?? null;
    const alerts = [...document.querySelectorAll('[role="alert"]')]
      .map((element) => element.textContent?.trim() ?? "");
    const overlay = document.querySelector(".live-canvas-unavailable");
    return {
      bodyText: document.body?.innerText ?? "",
      assetIdentity: identity,
      alerts,
      overlay: overlay?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      canvas: canvas instanceof HTMLCanvasElement
        ? { width: canvas.width, height: canvas.height, ariaHidden: canvas.getAttribute("aria-hidden") }
        : null,
      exports: buttons.filter((button) => button.textContent?.startsWith("Export"))
        .map((button) => ({ label: button.textContent?.trim(), disabled: button.disabled })),
      retryVisible: buttons.some((button) => button.textContent?.trim() === "Retry exact asset"),
      thumbnailForSelected: document.querySelector(
        `img[alt*="${identity ?? "__none__"}"]`,
      ) !== null,
    };
  });
}

async function canvasHash(page) {
  return page.evaluate(async () => {
    const canvas = document.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Canvas missing");
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas context missing");
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const firstRgba = [...pixels.slice(0, 4)];
    let uniform = true;
    for (let offset = 4; offset < pixels.length; offset += 4) {
      if (
        pixels[offset] !== firstRgba[0] ||
        pixels[offset + 1] !== firstRgba[1] ||
        pixels[offset + 2] !== firstRgba[2] ||
        pixels[offset + 3] !== firstRgba[3]
      ) {
        uniform = false;
        break;
      }
    }
    const digest = await crypto.subtle.digest("SHA-256", pixels);
    return {
      width: canvas.width,
      height: canvas.height,
      firstRgba,
      uniform,
      rgbaSha256: [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    };
  });
}

async function screenshot(page, slug) {
  const stamp = new Date().toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "America/Chicago",
  }).replaceAll(":", "");
  const filename = `2026-07-18_${stamp}_${slug}.jpg`;
  const path = resolve(outputDirectory, filename);
  await page.screenshot({ path, type: "jpeg", quality: 80, fullPage: true });
  observations.screenshots.push(
    `packages/core/benchmarks/photo-scribble/results/${evidenceId}/${filename}`,
  );
}

function installPageObservers(page) {
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.origin === new URL(studioUrl).origin &&
      (url.pathname === "/" ||
        url.pathname.startsWith("/image-assets/") ||
        url.pathname.startsWith("/__api/presets/") ||
        url.pathname.startsWith("/sketches/photo-scribble/presets/"))
    ) {
      observations.network.push({
        at: nowIso(),
        event: "request",
        method: request.method(),
        path: url.pathname,
        resourceType: request.resourceType(),
      });
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      url.origin === new URL(studioUrl).origin &&
      (url.pathname === "/" ||
        url.pathname.startsWith("/image-assets/") ||
        url.pathname.startsWith("/__api/presets/") ||
        url.pathname.startsWith("/sketches/photo-scribble/presets/"))
    ) {
      observations.network.push({
        at: nowIso(),
        event: "response",
        method: response.request().method(),
        path: url.pathname,
        status: response.status(),
        resourceType: response.request().resourceType(),
      });
    }
  });
  page.on("console", (message) => observations.console.push({
    at: nowIso(), type: message.type(), text: message.text(),
  }));
  page.on("pageerror", (error) => observations.pageErrors.push({
    at: nowIso(), error: String(error),
  }));
}

async function installWorkerInstrumentation(page) {
  await page.evaluateOnNewDocument(() => {
    const NativeWorker = window.Worker;
    const state = { workers: [] };
    window.__ISSUE_336_REVIEW__ = state;
    window.Worker = class ReviewWorker extends NativeWorker {
      constructor(...args) {
        super(...args);
        const record = {
          workerId: state.workers.length + 1,
          createdAt: performance.now(),
          url: String(args[0]),
          progress: [],
        };
        state.workers.push(record);
        this.__issue336Record = record;
        this.addEventListener("message", (event) => {
          const data = event.data;
          if (data?.type === "progress") {
            record.progress.push({ at: performance.now(), ...structuredClone(data.snapshot) });
          } else if (data?.type === "success") {
            record.successAt = performance.now();
            record._scene = data.scene;
            record.success = {
              identity: structuredClone(data.identity),
              diagnostics: structuredClone(data.diagnostics),
              computeTimeMs: data.computeTimeMs,
              primitiveCount: data.scene.primitives.length,
            };
          } else if (data?.type === "failure") {
            record.failureAt = performance.now();
            record.failure = { identity: structuredClone(data.identity), error: data.error };
          }
        });
      }
      postMessage(message, options) {
        const record = this.__issue336Record;
        if (message?.type === "compute" && record !== undefined) {
          record.requestAt = performance.now();
          record.request = structuredClone(message);
        }
        return options === undefined
          ? super.postMessage(message)
          : super.postMessage(message, options);
      }
      terminate() {
        const record = this.__issue336Record;
        if (record !== undefined) record.terminatedAt = performance.now();
        return super.terminate();
      }
    };
  });
}

await mkdir(outputDirectory, { recursive: true });
const beforeAssets = await inventory("assets/image-assets");
const beforePresets = await inventory("packages/core/src/sketches/photo-scribble/presets");
const selectedAssetBefore = await readFile(selectedAssetPath);
const backupDirectory = await mkdtemp(resolve(os.tmpdir(), `${presetName}-`));
await cp(resolve(root, "assets/image-assets"), resolve(backupDirectory, "image-assets"), {
  recursive: true,
});
await cp(
  resolve(root, "packages/core/src/sketches/photo-scribble/presets"),
  resolve(backupDirectory, "presets"),
  { recursive: true },
);
const backupAssets = await (async () => {
  const rows = [];
  async function visit(directory, base) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path, base);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        rows.push({ path: path.slice(base.length + 1), byteLength: bytes.byteLength, sha256: sha256(bytes) });
      }
    }
  }
  await visit(resolve(backupDirectory, "image-assets"), resolve(backupDirectory, "image-assets"));
  return rows.sort((a, b) => a.path.localeCompare(b.path));
})();
const backupPresets = await (async () => {
  const rows = [];
  const base = resolve(backupDirectory, "presets");
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const bytes = await readFile(resolve(base, entry.name));
    rows.push({ path: entry.name, byteLength: bytes.byteLength, sha256: sha256(bytes) });
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
})();
observations.phases.preflight = {
  beforeAssets,
  beforePresets,
  backupAssets,
  backupPresets,
  backupInventoriesExact:
    JSON.stringify(beforeAssets) === JSON.stringify(backupAssets) &&
    JSON.stringify(beforePresets) === JSON.stringify(backupPresets),
  externalBackupCreated: true,
  selectedAsset: {
    path: `assets/image-assets/${basename(selectedAssetPath)}`,
    byteLength: selectedAssetBefore.byteLength,
    sha256: sha256(selectedAssetBefore),
  },
};

let browser = null;
let page = null;
let quarantined = false;
let presetCreated = false;
try {
  await startStudio("settled-save-and-reload-proof");
  browser = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
  });
  page = await browser.newPage();
  page.setDefaultTimeout(180_000);
  installPageObservers(page);
  await installWorkerInstrumentation(page);
  const response = await page.goto(studioUrl, { waitUntil: "networkidle2" });
  if (!response?.ok()) throw new Error(`Studio load failed: ${response?.status()}`);
  observations.browser = {
    product: await browser.version(),
    userAgent: await browser.userAgent(),
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    viewport: await page.evaluate(() => ({
      width: innerWidth, height: innerHeight, devicePixelRatio,
    })),
  };

  const firstSuccess = await waitForNewSuccess(page, 0);
  observations.phases.initial = {
    result: await hashWorkerResult(page, firstSuccess),
    workers: (await page.evaluate(() => window.__ISSUE_336_REVIEW__.workers))
      .map(workerSummary),
  };

  const beforeNeat = await workerCount(page);
  await page.select('select[aria-label="saved presets"]', "neat");
  await clickButton(page, "Reload");
  const neatIndex = await waitForNewSuccess(page, beforeNeat);
  const beforeSaveResult = await hashWorkerResult(page, neatIndex);
  await screenshot(page, "preset-before-save-settled");
  await savePreset(page);
  presetCreated = true;
  const savedBytes = await readFile(presetPath);
  const savedRecord = JSON.parse(savedBytes.toString("utf8"));
  observations.actions.push({ at: nowIso(), action: "save-prefixed-preset", presetName });
  observations.phases.beforeSave = {
    result: beforeSaveResult,
    ui: await pageState(page),
    preset: {
      path: `packages/core/src/sketches/photo-scribble/presets/${presetName}.json`,
      byteLength: savedBytes.byteLength,
      sha256: sha256(savedBytes),
      record: savedRecord,
    },
  };

  await page.reload({ waitUntil: "networkidle2" });
  const beforeReloadPreset = await workerCount(page);
  await loadPreset(page);
  const reloadedIndex = await waitForNewSuccess(page, beforeReloadPreset);
  const postReloadResult = await hashWorkerResult(page, reloadedIndex);
  await screenshot(page, "preset-post-full-reload-exact");
  observations.actions.push({ at: nowIso(), action: "full-reload-and-load-prefixed-preset", presetName });
  observations.phases.postReload = {
    result: postReloadResult,
    ui: await pageState(page),
    workers: (await page.evaluate(() => window.__ISSUE_336_REVIEW__.workers))
      .map(workerSummary),
  };

  await stopStudio("required-before-selected-asset-quarantine");
  const quarantinePath = resolve(backupDirectory, basename(selectedAssetPath));
  await rename(selectedAssetPath, quarantinePath);
  quarantined = true;
  observations.actions.push({
    at: nowIso(),
    action: "quarantine-only-selected-worktree-asset",
    assetId: selectedAssetId,
    externalByteLength: (await stat(quarantinePath)).size,
    externalSha256: sha256(await readFile(quarantinePath)),
  });
  await startStudio("missing-asset-fail-closed-proof");

  const networkBeforeMissingPhase = observations.network.length;
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForFunction(
    (assetId) => document.body?.innerText.includes("Image Asset unavailable") &&
      document.body?.innerText.includes(assetId),
    {},
    selectedAssetId,
  );
  const workersBeforeMissingLoad = await workerCount(page);
  await loadPreset(page);
  await page.waitForFunction(
    (assetId) => document.body?.innerText.includes("Image Asset unavailable") &&
      document.body?.innerText.includes(assetId),
    {},
    selectedAssetId,
  );
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  const workersAfterMissingLoad = await page.evaluate(
    (start) => window.__ISSUE_336_REVIEW__.workers.slice(start),
    workersBeforeMissingLoad,
  );
  const missingState = await pageState(page);
  const missingCanvas = await canvasHash(page);
  const downloadDirectory = resolve(backupDirectory, "downloads");
  await mkdir(downloadDirectory);
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDirectory,
    eventsEnabled: true,
  });
  const exportAttempt = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("button")]
      .filter((button) => button.textContent?.startsWith("Export"));
    const before = rows.map((button) => ({ label: button.textContent?.trim(), disabled: button.disabled }));
    for (const button of rows) button.click();
    return { before, clickedThroughDomApi: rows.length };
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  const downloadsAfterDisabledClicks = await readdir(downloadDirectory);
  await screenshot(page, "missing-asset-explicit-fail-closed");
  observations.actions.push({
    at: nowIso(),
    action: "load-preset-with-selected-asset-quarantined-and-attempt-all-disabled-exports",
    presetName,
  });
  observations.phases.missing = {
    workersBeforeMissingLoad,
    workersAfterMissingLoad,
    workerRequestsAfterMissingLoad: workersAfterMissingLoad.filter(
      (worker) => worker.requestAt !== undefined,
    ).length,
    ui: missingState,
    canvas: missingCanvas,
    exportAttempt,
    downloadsAfterDisabledClicks,
    network: observations.network.slice(networkBeforeMissingPhase),
  };

  await rename(quarantinePath, selectedAssetPath);
  quarantined = false;
  const restoredBytes = await readFile(selectedAssetPath);
  observations.actions.push({
    at: nowIso(),
    action: "restore-exact-selected-asset-by-rename",
    assetId: selectedAssetId,
    byteLength: restoredBytes.byteLength,
    sha256: sha256(restoredBytes),
  });
  const beforeRecovery = await workerCount(page);
  await clickButton(page, "Retry exact asset");
  const recoveredIndex = await waitForNewSuccess(page, beforeRecovery);
  const recoveredResult = await hashWorkerResult(page, recoveredIndex);
  await screenshot(page, "restored-asset-retry-recovers-exact");
  observations.phases.recovered = {
    recoveryAction: "Retry exact asset",
    result: recoveredResult,
    ui: await pageState(page),
    workers: await page.evaluate(
      (start) => window.__ISSUE_336_REVIEW__.workers.slice(start),
      beforeRecovery,
    ).then((workers) => workers.map(workerSummary)),
    selectedAsset: {
      byteLength: restoredBytes.byteLength,
      sha256: sha256(restoredBytes),
    },
  };

  const sameIdentity = (left, right) =>
    left.identity.seed === right.identity.seed &&
    JSON.stringify(left.identity.params) === JSON.stringify(right.identity.params) &&
    JSON.stringify(left.identity.compositionFrame) === JSON.stringify(right.identity.compositionFrame);
  observations.assertions = {
    preflightBackupExact: observations.phases.preflight.backupInventoriesExact,
    adoptedProductionPolicyRecorded: observations.policy.maxAcceptedSegments === 1_000_000,
    savedAssetIdExact: savedRecord.params.imageAsset === selectedAssetId,
    savedParamsExact:
      JSON.stringify(savedRecord.params) === JSON.stringify(beforeSaveResult.params),
    savedSeedExact: savedRecord.seed === beforeSaveResult.identity.seed,
    fullReloadSceneExact: beforeSaveResult.sceneHash === postReloadResult.sceneHash,
    fullReloadDiagnosticsExact:
      beforeSaveResult.diagnosticsHash === postReloadResult.diagnosticsHash,
    fullReloadIdentityExact: sameIdentity(beforeSaveResult, postReloadResult),
    fullReloadAssetIdExact: postReloadResult.params.imageAsset === selectedAssetId,
    missingAssetIdPreserved: missingState.assetIdentity === selectedAssetId,
    missingStateExplicit:
      missingState.overlay?.includes("Image Asset unavailable") === true &&
      missingState.overlay?.includes(selectedAssetId) === true &&
      missingState.alerts.some((text) => text.includes("exact selected ID remains active")),
    missingCanvasHiddenAndNeutral:
      missingState.canvas?.ariaHidden === "true" &&
      missingCanvas.width > 0 &&
      missingCanvas.height > 0 &&
      missingCanvas.uniform,
    noBackgroundScribbleJobForMissingAsset:
      observations.phases.missing.workerRequestsAfterMissingLoad === 0,
    allExportsDisabled:
      missingState.exports.length === 3 && missingState.exports.every((entry) => entry.disabled),
    disabledExportsFailClosed: downloadsAfterDisabledClicks.length === 0,
    selectedAssetFetch404:
      observations.phases.missing.network.some((entry) =>
        entry.event === "response" &&
        entry.path === `/image-assets/${selectedAssetId}.png` &&
        entry.status === 404,
      ),
    noFallbackOrSubstitution:
      missingState.assetIdentity === selectedAssetId &&
      !observations.phases.missing.network.some((entry) =>
        entry.event === "request" &&
        entry.path.startsWith("/image-assets/") &&
        entry.path !== `/image-assets/${selectedAssetId}.png`,
      ),
    restoredAssetBytesExact:
      restoredBytes.byteLength === selectedAssetBefore.byteLength &&
      sha256(restoredBytes) === sha256(selectedAssetBefore),
    recoverySceneExact: recoveredResult.sceneHash === beforeSaveResult.sceneHash,
    recoveryDiagnosticsExact:
      recoveredResult.diagnosticsHash === beforeSaveResult.diagnosticsHash,
    recoveryIdentityExact: sameIdentity(recoveredResult, beforeSaveResult),
    recoveryAssetIdExact: recoveredResult.params.imageAsset === selectedAssetId,
    recoveryUiResolved:
      observations.phases.recovered.ui.overlay === null &&
      observations.phases.recovered.ui.assetIdentity === selectedAssetId &&
      observations.phases.recovered.ui.exports.every((entry) => !entry.disabled),
    noPageErrors: observations.pageErrors.length === 0,
  };
  const failures = Object.entries(observations.assertions)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failures.length > 0) throw new Error(`Review assertions failed: ${failures.join(", ")}`);
} catch (error) {
  observations.failure = error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: "unknown", message: String(error) };
  throw error;
} finally {
  if (page !== null && !page.isClosed()) await page.close().catch(() => {});
  if (browser !== null) await browser.close().catch(() => {});
  await stopStudio("review-complete-or-failed").catch(() => {});
  if (quarantined) {
    const quarantinePath = resolve(backupDirectory, basename(selectedAssetPath));
    await rename(quarantinePath, selectedAssetPath);
    quarantined = false;
  }
  if (presetCreated) await unlink(presetPath).catch(() => {});
  const afterAssets = await inventory("assets/image-assets");
  const afterPresets = await inventory("packages/core/src/sketches/photo-scribble/presets");
  observations.cleanup = {
    beforeAssets,
    afterAssets,
    assetsExact: JSON.stringify(beforeAssets) === JSON.stringify(afterAssets),
    beforePresets,
    afterPresets,
    presetsExact: JSON.stringify(beforePresets) === JSON.stringify(afterPresets),
    selectedAssetRestored:
      afterAssets.some((entry) =>
        entry.path === basename(selectedAssetPath) &&
        entry.sha256 === sha256(selectedAssetBefore) &&
        entry.byteLength === selectedAssetBefore.byteLength,
      ),
    trialPresetRemoved: !afterPresets.some((entry) => entry.path === `${presetName}.json`),
    browserClosed: true,
    studioStopped: true,
    externalBackupRemoved: true,
  };
  await rm(backupDirectory, { recursive: true, force: true });
  await writeFile(
    resolve(outputDirectory, "raw-browser-preset-missing-review.json"),
    `${JSON.stringify(observations, null, 2)}\n`,
  );
}
