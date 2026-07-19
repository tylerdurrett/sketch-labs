import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const puppeteerEntry = process.env.PUPPETEER_ENTRY;
if (!puppeteerEntry) throw new Error("PUPPETEER_ENTRY is required");
const puppeteer = (await import(pathToFileURL(puppeteerEntry).href)).default;

const studioUrl = process.env.STUDIO_URL ?? "http://127.0.0.1:4317/";
const root = process.cwd();
const evidenceId = "issue-336-20260719T012407Z-responsive-fine-review";
const outputDirectory = resolve(
  root,
  "packages/core/benchmarks/photo-scribble/results",
  evidenceId,
);
const primarySeed = 5036310400360331;
const reseed = 5036310400360332;
const expectedFine = {
  targetHash: "96738e63053982deb8f7b0afd042311f827b88280434024ad17e086826b72008",
  sceneHash: "6a2dbad0f2e899b0dff72d726b513495034adf01205c42e5472f191719fce57b",
  termination: "budget-exhausted",
  residualError: 0.062259759099295466,
};

async function fileManifest(relativeDirectory) {
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
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }
  await visit(base);
  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

const observations = {
  schemaVersion: 1,
  review: "issue-336-product-studio-responsive-fine-review",
  evidenceId,
  studioUrl,
  browser: {},
  policy: {
    acceptedSegments: 1_000_000,
    polylines: 16_000,
    stagnations: 32_000,
    restarts: 16_000,
  },
  actions: [],
  transitions: {},
  probes: [],
  console: [],
  pageErrors: [],
  screenshots: [],
  video: null,
  assertions: {},
  cleanup: {},
};

const beforeAssets = await fileManifest("assets/image-assets");
const beforePresets = await fileManifest(
  "packages/core/src/sketches/photo-scribble/presets",
);

function nowIso() {
  return new Date().toISOString();
}

function workerSummary(worker) {
  return {
    workerId: worker.workerId,
    createdAt: worker.createdAt,
    requestAt: worker.requestAt ?? null,
    request: worker.request ?? null,
    progress: worker.progress ?? [],
    successAt: worker.successAt ?? null,
    success: worker.success ?? null,
    failureAt: worker.failureAt ?? null,
    failure: worker.failure ?? null,
    terminatedAt: worker.terminatedAt ?? null,
  };
}

async function clickButton(page, label) {
  await page.waitForFunction(
    (text) =>
      [...document.querySelectorAll("button")].some(
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

async function waitForNewRequest(page, previousCount) {
  await page.waitForFunction(
    (count) =>
      window.__ISSUE_336_REVIEW__.workers
        .slice(count)
        .some((worker) => worker.requestAt !== undefined),
    { timeout: 30_000 },
    previousCount,
  );
  return page.evaluate((count) => {
    const workers = window.__ISSUE_336_REVIEW__.workers;
    for (let index = workers.length - 1; index >= count; index -= 1) {
      if (workers[index].requestAt !== undefined) return index;
    }
    return -1;
  }, previousCount);
}

async function waitForProgress(page, index) {
  await page.waitForFunction(
    (workerIndex) =>
      window.__ISSUE_336_REVIEW__.workers[workerIndex]?.progress.some(
        (entry) => entry.terminal === false,
      ) === true,
    { timeout: 120_000 },
    index,
  );
}

async function waitForSuccess(page, index) {
  await page.waitForFunction(
    (workerIndex) =>
      window.__ISSUE_336_REVIEW__.workers[workerIndex]?.successAt !== undefined,
    { timeout: 180_000 },
    index,
  );
  await page.evaluate(
    () => new Promise((resolvePromise) =>
      requestAnimationFrame(() => requestAnimationFrame(resolvePromise)),
    ),
  );
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
}

async function waitForAnySuccess(page) {
  await page.waitForFunction(
    () => window.__ISSUE_336_REVIEW__.workers.some((worker) => worker.successAt),
    { timeout: 120_000 },
  );
  const index = await page.evaluate(() => {
    const workers = window.__ISSUE_336_REVIEW__.workers;
    for (let index = workers.length - 1; index >= 0; index -= 1) {
      if (workers[index].successAt !== undefined) return index;
    }
    return -1;
  });
  await page.evaluate(
    () => new Promise((resolvePromise) =>
      requestAnimationFrame(() => requestAnimationFrame(resolvePromise)),
    ),
  );
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  return index;
}

async function setNumericBeforeEnter(page, selector, value) {
  const previousCount = await workerCount(page);
  const previousInputs = await page.evaluate(
    () => window.__ISSUE_336_REVIEW__.inputs.length,
  );
  await page.click(selector, { clickCount: 3 });
  await page.type(selector, String(value));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  const beforeEnter = await page.evaluate(
    ({ workerStart, inputStart }) => ({
      workerCount: window.__ISSUE_336_REVIEW__.workers.length,
      newWorkers: window.__ISSUE_336_REVIEW__.workers
        .slice(workerStart)
        .map((worker) => ({
          workerId: worker.workerId,
          requestAt: worker.requestAt ?? null,
          terminatedAt: worker.terminatedAt ?? null,
        })),
      inputs: window.__ISSUE_336_REVIEW__.inputs.slice(inputStart),
    }),
    { workerStart: previousCount, inputStart: previousInputs },
  );
  await page.keyboard.press("Enter");
  const workerIndex = await waitForNewRequest(page, previousCount);
  const action = {
    at: nowIso(),
    action: "select-complete-value, type, press Enter",
    selector,
    value,
    previousCount,
    workerIndex,
    beforeEnter,
  };
  observations.actions.push(action);
  return { workerIndex, action, previousInputs };
}

async function canvasHash(page) {
  return page.evaluate(async () => {
    const canvas = document.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Canvas missing");
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas context missing");
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const digest = await crypto.subtle.digest("SHA-256", pixels);
    return {
      width: canvas.width,
      height: canvas.height,
      rgbaSha256: [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    };
  });
}

async function shadingSnapshot(page) {
  return page.evaluate(() => {
    const details = [...document.querySelectorAll("details")].find(
      (candidate) =>
        candidate.querySelector("summary > span")?.textContent?.trim() === "Shading",
    );
    return {
      bodyText: document.body?.innerText ?? "",
      open: details?.open ?? false,
      summary: details?.querySelector("summary")?.innerText ?? null,
      detail: details?.innerText ?? null,
      exportsDisabled: [...document.querySelectorAll("button")]
        .filter((button) => button.textContent?.startsWith("Export"))
        .map((button) => ({ label: button.textContent, disabled: button.disabled })),
    };
  });
}

async function openShading(page, open) {
  await page.evaluate((desired) => {
    const details = [...document.querySelectorAll("details")].find(
      (candidate) =>
        candidate.querySelector("summary > span")?.textContent?.trim() === "Shading",
    );
    if (!(details instanceof HTMLDetailsElement)) throw new Error("Shading missing");
    details.open = desired;
  }, open);
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

async function hashWorkerResult(page, index) {
  return page.evaluate(async ({ workerIndex, workspaceRoot }) => {
    const worker = window.__ISSUE_336_REVIEW__.workers[workerIndex];
    if (worker?._scene === undefined || worker.success === undefined) {
      throw new Error(`Worker ${workerIndex} has no retained result`);
    }
    const hashes = await import("/src/photoScribbleEvidenceHash.ts");
    const resolver = await import("/src/imageAssetResolver.ts");
    const core = await import(
      `/@fs${workspaceRoot}/packages/core/src/index.ts`
    );
    const identity = worker.success.identity;
    const params = Object.fromEntries(
      identity.params.map((entry) => [entry.key, entry.value]),
    );
    const sketch = core.registry.get(identity.sketchId);
    const environment = await resolver.resolveSketchEnvironment(sketch.schema, params);
    const frame = {
      width: identity.compositionFrame.width,
      height: identity.compositionFrame.height,
    };
    const source = sketch.generateToneSource(params, frame, environment);
    const controls = {
      pathDensity: params.pathDensity,
      scribbleScale: params.scribbleScale,
      momentum: params.momentum,
      chaos: params.chaos,
      toneFidelity: params.toneFidelity,
    };
    const sceneHash = await hashes.canonicalBrowserSceneHash(worker._scene);
    const diagnosticsHash = await hashes.canonicalBrowserDiagnosticsHash(
      worker.success.diagnostics,
    );
    const identityHash = await hashes.canonicalScribbleIdentityHash(identity);
    const targetHash = await hashes.canonicalBrowserScribbleTargetHash(
      source,
      frame,
      controls,
    );
    let pointCount = 0;
    for (const primitive of worker._scene.primitives) {
      pointCount += primitive.points.length;
    }
    worker._scene = undefined;
    return {
      sceneHash,
      diagnosticsHash,
      identityHash,
      targetHash,
      primitiveCount: worker.success.primitiveCount,
      pointCount,
      diagnostics: worker.success.diagnostics,
      computeTimeMs: worker.success.computeTimeMs,
      identity,
    };
  }, { workerIndex: index, workspaceRoot: root });
}

async function interactionProbe(page, probeId, targetSelector, expected) {
  const target = await page.$(targetSelector);
  if (target === null) throw new Error(`Missing target ${targetSelector}`);
  const box = await target.boundingBox();
  if (box === null) throw new Error(`Hidden target ${targetSelector}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const startedAt = await page.evaluate(() => performance.now());
  await page.mouse.click(x, y);
  const endedAt = await page.evaluate(async ({ selector, state }) => {
    for (;;) {
      const target = document.querySelector(selector);
      const matched = state.kind === "aria-label"
        ? target?.getAttribute("aria-label") === state.value
        : target instanceof HTMLElement && target.closest("details")?.open === state.value;
      if (matched) {
        return new Promise((resolvePromise) =>
          requestAnimationFrame(() => resolvePromise(performance.now())),
        );
      }
      await new Promise((resolvePromise) => requestAnimationFrame(resolvePromise));
    }
  }, { selector: expected.selector, state: expected.state });
  const record = {
    probeId,
    target: targetSelector,
    coordinate: { x, y, xFraction: 0.5, yFraction: 0.5 },
    action: "single primary-pointer click",
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
  };
  observations.probes.push(record);
  return record;
}

const browser = await puppeteer.launch({
  headless: false,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
});

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(180_000);
  page.on("console", (message) =>
    observations.console.push({ at: nowIso(), type: message.type(), text: message.text() }),
  );
  page.on("pageerror", (error) => observations.pageErrors.push(String(error)));
  await page.evaluateOnNewDocument(() => {
    const NativeWorker = window.Worker;
    const state = { workers: [], inputs: [] };
    window.__ISSUE_336_REVIEW__ = state;
    window.addEventListener("input", (event) => {
      if (!(event.target instanceof HTMLInputElement)) return;
      state.inputs.push({
        at: performance.now(),
        id: event.target.id,
        value: event.target.value,
      });
    }, true);
    window.Worker = class ReviewWorker extends NativeWorker {
      constructor(...args) {
        super(...args);
        const record = {
          workerId: state.workers.length + 1,
          createdAt: performance.now(),
          progress: [],
        };
        state.workers.push(record);
        this.__issue336Record = record;
        this.addEventListener("message", (event) => {
          const data = event.data;
          if (data?.type === "progress") {
            record.progress.push({ at: performance.now(), ...data.snapshot });
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
            record.failure = { error: data.error, identity: structuredClone(data.identity) };
          }
        });
        record.url = String(args[0]);
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

  const response = await page.goto(studioUrl, { waitUntil: "networkidle2" });
  if (!response?.ok()) throw new Error(`Studio load failed: ${response?.status()}`);
  observations.browser = {
    product: await browser.version(),
    userAgent: await browser.userAgent(),
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio })),
  };

  const initialIndex = await waitForAnySuccess(page);
  await openShading(page, true);
  const initialCanvas = await canvasHash(page);
  const initialShading = await shadingSnapshot(page);
  await screenshot(page, "initial-converged");
  const initialResult = await hashWorkerResult(page, initialIndex);
  observations.transitions.initialConverged = {
    workerIndex: initialIndex,
    worker: workerSummary(await page.evaluate((index) => window.__ISSUE_336_REVIEW__.workers[index], initialIndex)),
    canvas: initialCanvas,
    shading: initialShading,
    result: initialResult,
  };

  const beforeNeat = await workerCount(page);
  await page.select('select[aria-label="saved presets"]', "neat");
  await clickButton(page, "Reload");
  observations.actions.push({ at: nowIso(), action: "load committed preset", preset: "neat" });
  const neatIndex = await waitForNewRequest(page, beforeNeat);
  await waitForSuccess(page, neatIndex);
  await openShading(page, true);
  const neatCanvas = await canvasHash(page);
  const neatShading = await shadingSnapshot(page);
  await screenshot(page, "neat-primary-settled");
  const neatResult = await hashWorkerResult(page, neatIndex);
  observations.transitions.neatPrimary = {
    workerIndex: neatIndex,
    worker: workerSummary(await page.evaluate((index) => window.__ISSUE_336_REVIEW__.workers[index], neatIndex)),
    canvas: neatCanvas,
    shading: neatShading,
    result: neatResult,
  };
  await openShading(page, false);

  const fineEdit = await setNumericBeforeEnter(page, "#control-scribbleScale", 0.1);
  await waitForSuccess(page, fineEdit.workerIndex);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  await openShading(page, true);
  const finePrimaryCanvas = await canvasHash(page);
  const finePrimaryShading = await shadingSnapshot(page);
  await screenshot(page, "fine-primary-budget-exhausted");
  const finePrimaryResult = await hashWorkerResult(page, fineEdit.workerIndex);
  observations.transitions.finePrimary = {
    workerIndex: fineEdit.workerIndex,
    worker: workerSummary(
      await page.evaluate(
        (index) => window.__ISSUE_336_REVIEW__.workers[index],
        fineEdit.workerIndex,
      ),
    ),
    action: fineEdit.action,
    canvas: finePrimaryCanvas,
    shading: finePrimaryShading,
    result: finePrimaryResult,
    expectedFine,
  };
  await openShading(page, false);

  observations.video = {
    status: "not-recorded",
    reason:
      "The corrected review uses timestamped screenshots plus raw Worker/DOM timing logs and canonical hashes; no recorder is injected into the fine/high-density interaction path.",
  };
  const seedEdit = await setNumericBeforeEnter(page, "#sketch-seed", reseed);
  const fineReseedIndex = seedEdit.workerIndex;
  await waitForProgress(page, fineReseedIndex);
  const staleCanvasBeforeProbes = await canvasHash(page);
  const staleBeforeProbes = await shadingSnapshot(page);
  await screenshot(page, "fine-reseed-active-stale-retained");

  await page.waitForFunction(
    (workerIndex) => {
      const worker = window.__ISSUE_336_REVIEW__.workers[workerIndex];
      const latest = worker?.progress.at(-1);
      return latest !== undefined && latest.at - worker.requestAt >= 1_000;
    },
    { timeout: 5_000 },
    fineReseedIndex,
  );

  await interactionProbe(
    page,
    "hide-inspector",
    'button[aria-label="Hide inspector"]',
    { selector: 'button[aria-label="Show inspector"]', state: { kind: "aria-label", value: "Show inspector" } },
  );
  await interactionProbe(
    page,
    "show-inspector",
    'button[aria-label="Show inspector"]',
    { selector: 'button[aria-label="Hide inspector"]', state: { kind: "aria-label", value: "Hide inspector" } },
  );
  await page.evaluate(() => {
    const summary = [...document.querySelectorAll("summary")].find(
      (candidate) => candidate.querySelector(":scope > span")?.textContent?.trim() === "Shading",
    );
    summary?.setAttribute("data-issue-336-shading", "true");
  });
  await interactionProbe(
    page,
    "toggle-shading-disclosure",
    'summary[data-issue-336-shading="true"]',
    { selector: 'summary[data-issue-336-shading="true"]', state: { kind: "details-open", value: true } },
  );
  await page.waitForFunction(
    () => {
      const details = [...document.querySelectorAll("details")].find(
        (candidate) =>
          candidate.querySelector("summary > span")?.textContent?.trim() === "Shading",
      );
      return !(details?.innerText ?? "").includes("Estimating…");
    },
    { timeout: 500 },
  );
  const activeAfterProbes = await shadingSnapshot(page);
  await screenshot(page, "fine-active-progress-and-rolling-eta");

  const chaosEdit = await setNumericBeforeEnter(page, "#control-chaos", 0.71);
  const latestIndex = chaosEdit.workerIndex;
  await page.waitForFunction(
    (index) => window.__ISSUE_336_REVIEW__.workers[index]?.terminatedAt !== undefined,
    { timeout: 5_000 },
    fineReseedIndex,
  );
  const cancellationState = await page.evaluate(
    ({ workerIndex, inputStart }) => ({
      worker: window.__ISSUE_336_REVIEW__.workers[workerIndex],
      inputs: window.__ISSUE_336_REVIEW__.inputs.slice(inputStart),
    }),
    { workerIndex: fineReseedIndex, inputStart: chaosEdit.previousInputs },
  );
  const firstChaosInput = cancellationState.inputs.find((entry) => entry.id === "control-chaos");
  const cancellationLatencyMs = cancellationState.worker.terminatedAt - firstChaosInput.at;
  const staleCanvasAfterCancellation = await canvasHash(page);
  const staleAfterCancellation = await shadingSnapshot(page);
  await screenshot(page, "fine-chaos-supersedes-reseed-latest-input-wins");

  await waitForSuccess(page, latestIndex);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  const latestCanvas = await canvasHash(page);
  const latestShading = await shadingSnapshot(page);
  await screenshot(page, "fine-latest-chaos-result-settled");
  const latestResult = await hashWorkerResult(page, latestIndex);
  const reseedWorkerAfterLatest = await page.evaluate(
    (index) => window.__ISSUE_336_REVIEW__.workers[index],
    fineReseedIndex,
  );
  observations.transitions.supersedingFineEdit = {
    fineReseedWorkerIndex: fineReseedIndex,
    latestWorkerIndex: latestIndex,
    seedEdit,
    chaosEdit,
    staleBeforeProbes,
    staleCanvasBeforeProbes,
    activeAfterProbes,
    cancellationState: {
      firstInputAt: firstChaosInput.at,
      workerTerminatedAt: cancellationState.worker.terminatedAt,
      cancellationLatencyMs,
    },
    staleAfterCancellation,
    staleCanvasAfterCancellation,
    latestCanvas,
    latestShading,
    latestResult,
    cancelledWorker: workerSummary(reseedWorkerAfterLatest),
    noLateReplacement: reseedWorkerAfterLatest.successAt === undefined,
  };

  const restoreChaos = await setNumericBeforeEnter(page, "#control-chaos", 0.72);
  await waitForSuccess(page, restoreChaos.workerIndex);
  const reseedFixedResult = await hashWorkerResult(page, restoreChaos.workerIndex);
  const reseedFixedShading = await shadingSnapshot(page);
  await screenshot(page, "fine-reseed-fixed-budget-exhausted");
  observations.transitions.fineReseedFixed = {
    workerIndex: restoreChaos.workerIndex,
    action: restoreChaos.action,
    result: reseedFixedResult,
    shading: reseedFixedShading,
  };

  const workers = await page.evaluate(() => window.__ISSUE_336_REVIEW__.workers);
  observations.workers = workers.map(workerSummary);
  const activeWorker = workers[fineReseedIndex];
  const heartbeatTimes = [activeWorker.requestAt, ...activeWorker.progress.map((entry) => entry.at)];
  const heartbeatGaps = heartbeatTimes.slice(1).map((value, index) => value - heartbeatTimes[index]);
  const activeParams = Object.fromEntries(
    activeWorker.request.identity.params.map((entry) => [entry.key, entry.value]),
  );
  const probeWindow = {
    startedAt: Math.min(...observations.probes.map((probe) => probe.startedAt)),
    endedAt: Math.max(...observations.probes.map((probe) => probe.endedAt)),
  };
  observations.transitions.supersedingFineEdit.criticalWorkerProof = {
    workerIndex: fineReseedIndex,
    identity: activeWorker.request.identity,
    params: activeParams,
    workerRequestAt: activeWorker.requestAt,
    workerTerminatedAt: activeWorker.terminatedAt,
    workerSuccessAt: activeWorker.successAt ?? null,
    probeWindow,
  };
  observations.transitions.supersedingFineEdit.cancelledHeartbeat = {
    samples: heartbeatTimes,
    gapsMs: heartbeatGaps,
    maximumGapMs: Math.max(...heartbeatGaps),
  };
  observations.assertions = {
    initialTruthfullyConverged:
      initialResult.diagnostics.termination === "completed" &&
      initialShading.summary.includes("Converged"),
    settledSeedEditLaunchedOnlyAfterEnter:
      seedEdit.action.beforeEnter.newWorkers.every((worker) => worker.requestAt === null),
    settledFineEditLaunchedOnlyAfterEnter:
      fineEdit.action.beforeEnter.newWorkers.every((worker) => worker.requestAt === null),
    settledChaosEditLaunchedOnlyAfterEnter:
      chaosEdit.action.beforeEnter.newWorkers.every((worker) => worker.requestAt === null),
    staleCanvasRetainedDuringReseed:
      staleCanvasBeforeProbes.rgbaSha256 === staleCanvasAfterCancellation.rgbaSha256,
    staleCanvasRetainedAfterCancellation:
      staleCanvasBeforeProbes.rgbaSha256 === staleCanvasAfterCancellation.rgbaSha256,
    staleCanvasMatchesCompletedFineResult:
      finePrimaryCanvas.rgbaSha256 === staleCanvasBeforeProbes.rgbaSha256,
    staleStateLabelled:
      staleBeforeProbes.summary.includes("Displayed result: stale") &&
      staleAfterCancellation.summary.includes("Displayed result: stale"),
    progressVisible:
      activeAfterProbes.detail.includes("Progress") &&
      activeAfterProbes.detail.includes("work units"),
    rollingEtaVisible:
      activeAfterProbes.detail.includes("Estimated time remaining") &&
      !activeAfterProbes.detail.includes("Estimating…"),
    cancellationWithin500Ms: cancellationLatencyMs <= 500,
    noLateStaleReplacement: reseedWorkerAfterLatest.successAt === undefined,
    latestCanvasReplacedStale:
      latestCanvas.rgbaSha256 !== staleCanvasAfterCancellation.rgbaSha256,
    exactFineWorkerActiveDuringAllProbes:
      activeWorker.requestAt <= probeWindow.startedAt &&
      activeWorker.terminatedAt >= probeWindow.endedAt &&
      activeWorker.successAt === undefined &&
      activeWorker.request.identity.seed === reseed &&
      activeParams.imageAsset === "pinecone-4330aa0314f7" &&
      activeParams.toneContrast === 1 &&
      activeParams.toneGamma === 1 &&
      activeParams.pathDensity === 20 &&
      activeParams.scribbleScale === 0.1 &&
      activeParams.momentum === 1 &&
      activeParams.chaos === 0.72 &&
      activeParams.toneFidelity === 1,
    supersedingLatestStayedFine:
      latestResult.identity.seed === reseed &&
      Object.fromEntries(latestResult.identity.params.map((entry) => [entry.key, entry.value])).scribbleScale === 0.1,
    fineReseedTargetExactlyStable:
      finePrimaryResult.targetHash === reseedFixedResult.targetHash,
    reseedIdentityChanged:
      finePrimaryResult.identityHash !== reseedFixedResult.identityHash,
    reseedSceneChanged:
      finePrimaryResult.sceneHash !== reseedFixedResult.sceneHash,
    finePrimaryTruthfullyBudgetExhausted:
      finePrimaryResult.diagnostics.termination === "budget-exhausted" &&
      finePrimaryShading.summary.includes("Budget exhausted") &&
      finePrimaryShading.detail.includes("bounded partial result, not a computation error"),
    fineReseedTruthfullyBudgetExhausted:
      reseedFixedResult.diagnostics.termination === "budget-exhausted" &&
      reseedFixedShading.summary.includes("Budget exhausted") &&
      reseedFixedShading.detail.includes("bounded partial result, not a computation error"),
    fineMatchesAdoptedTarget: finePrimaryResult.targetHash === expectedFine.targetHash,
    fineMatchesAdoptedScene: finePrimaryResult.sceneHash === expectedFine.sceneHash,
    fineMatchesAdoptedResidual:
      finePrimaryResult.diagnostics.residualError === expectedFine.residualError,
    probesWithin250Ms: observations.probes.every((probe) => probe.durationMs <= 250),
    noPageErrors: observations.pageErrors.length === 0,
  };
  const failedAssertions = Object.entries(observations.assertions)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failedAssertions.length > 0) {
    throw new Error(`Product review assertions failed: ${failedAssertions.join(", ")}`);
  }
  await page.close();
} catch (error) {
  observations.failure = error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: "unknown", message: String(error) };
  throw error;
} finally {
  await browser.close();
  const afterAssets = await fileManifest("assets/image-assets");
  const afterPresets = await fileManifest(
    "packages/core/src/sketches/photo-scribble/presets",
  );
  observations.cleanup = {
    beforeAssets,
    afterAssets,
    assetsExact: JSON.stringify(beforeAssets) === JSON.stringify(afterAssets),
    beforePresets,
    afterPresets,
    presetsExact: JSON.stringify(beforePresets) === JSON.stringify(afterPresets),
    trialAssetsOrPresetsCreated: false,
    browserClosed: true,
  };
  await writeFile(
    resolve(outputDirectory, "raw-browser-responsive-fine-review.json"),
    `${JSON.stringify(observations, null, 2)}\n`,
  );
}
