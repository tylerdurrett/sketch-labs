import { writeFile } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const puppeteerEntry = process.env.PUPPETEER_ENTRY;
if (!puppeteerEntry) throw new Error("PUPPETEER_ENTRY is required");

const puppeteer = (await import(pathToFileURL(puppeteerEntry).href)).default;
const studioUrl = process.env.STUDIO_URL ?? "http://127.0.0.1:4316/";
const stagedImage = process.env.STAGED_IMAGE;
if (!stagedImage) throw new Error("STAGED_IMAGE is required");

const outputDirectory = resolve(
  "packages/core/benchmarks/photo-scribble/results/issue-336-20260719T003449Z-import-review",
);
const trialSlug = "issue-336-trial-import-review";
const trialPreset = "issue-336-trial-import-review";
const expectedInitialAssets = [
  "img-0672-79d639daec62",
  "pinecone-4330aa0314f7",
];
const expectedDefaultAsset = "pinecone-4330aa0314f7";
const localPathMarkers = ["/Users/", "/tmp/", "issue-336-trial-pinecone-import.png"];

const observations = {
  schemaVersion: 1,
  review: "issue-336-product-studio-import",
  browser: {},
  initial: {},
  import: {},
  reuse: {},
  reload: {},
  privacy: {},
  storage: {},
  network: [],
  console: [],
  pageErrors: [],
  screenshots: [],
};

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function relevantPath(path) {
  return (
    path.startsWith("/__api/image-assets") ||
    path.startsWith("/image-assets/") ||
    path.startsWith("/__api/presets/") ||
    path.startsWith("/sketches/photo-scribble/presets/")
  );
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
  const clicked = await page.evaluate((text) => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) =>
        candidate.textContent?.trim() === text && !candidate.disabled,
    );
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`Could not click ${label}`);
}

async function identity(page) {
  return page.$eval(
    '[aria-label="imageAsset image asset identity"]',
    (element) => element.textContent?.trim() ?? "",
  );
}

async function waitForIdentity(page, expected) {
  await page.waitForFunction(
    (value) =>
      document
        .querySelector('[aria-label="imageAsset image asset identity"]')
        ?.textContent?.trim() === value,
    {},
    expected,
  );
}

async function picker(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[aria-label="Image Assets"] button')].map(
      (button) => ({
        label: button.querySelector("span span")?.textContent?.trim() ?? "",
        current: button.getAttribute("aria-pressed") === "true",
        thumbnail: button.querySelector("img")?.getAttribute("src") ?? "",
      }),
    ),
  );
}

async function selectPickerAsset(page, label) {
  const selected = await page.evaluate((name) => {
    const button = [
      ...document.querySelectorAll('[aria-label="Image Assets"] button'),
    ].find(
      (candidate) =>
        candidate.querySelector("span span")?.textContent?.trim() === name,
    );
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  }, label);
  if (!selected) throw new Error(`Picker asset not found: ${label}`);
}

async function setValue(page, selector, value) {
  await page.waitForSelector(selector);
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type(selector, value);
}

async function screenshot(page, filename) {
  const relative = `packages/core/benchmarks/photo-scribble/results/issue-336-20260719T003449Z-import-review/${filename}`;
  await page.screenshot({
    path: resolve(relative),
    type: "jpeg",
    quality: 80,
    fullPage: true,
  });
  observations.screenshots.push(relative);
}

async function uploadedAssetFacts(page, id) {
  return page.evaluate(async (assetId) => {
    const response = await fetch(`/image-assets/${assetId}.png`);
    const bytes = await response.arrayBuffer();
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const blob = new Blob([bytes], { type: "image/png" });
    const bitmap = await createImageBitmap(blob);
    const facts = {
      status: response.status,
      contentType: response.headers.get("content-type"),
      byteLength: bytes.byteLength,
      sha256: digest,
      width: bitmap.width,
      height: bitmap.height,
    };
    bitmap.close();
    return facts;
  }, id);
}

async function importTrial(page) {
  const input = await page.waitForSelector('input[type="file"]');
  await input.uploadFile(stagedImage);
  await page.waitForSelector("#imageAsset-slug");
  await setValue(page, "#imageAsset-slug", trialSlug);
  await clickButton(page, "Import Image Asset");
}

const browser = await puppeteer.launch({
  headless: false,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
});

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(120_000);
  const responseReads = [];

  page.on("console", (message) => {
    observations.console.push({ type: message.type(), text: message.text() });
  });
  page.on("pageerror", (error) => observations.pageErrors.push(String(error)));
  page.on("request", (request) => {
    const path = pathOf(request.url());
    if (!relevantPath(path)) return;
    const headers = request.headers();
    const record = {
      phase: "request",
      method: request.method(),
      path,
      contentType: headers["content-type"] ?? null,
      contentLength: headers["content-length"] ?? null,
    };
    if (path.startsWith("/__api/presets/") && request.method() === "POST") {
      record.jsonBody = JSON.parse(request.postData() ?? "null");
    }
    observations.network.push(record);
  });
  page.on("response", (response) => {
    const path = pathOf(response.url());
    if (!relevantPath(path)) return;
    responseReads.push(
      (async () => {
        const record = {
          phase: "response",
          method: response.request().method(),
          path,
          status: response.status(),
          contentType: response.headers()["content-type"] ?? null,
        };
        if (
          path.startsWith("/__api/") ||
          path.startsWith("/sketches/photo-scribble/presets/")
        ) {
          try {
            const text = await response.text();
            record.jsonBody = text === "" ? null : JSON.parse(text);
          } catch (error) {
            record.bodyReadError = error instanceof Error ? error.name : "unknown";
          }
        }
        observations.network.push(record);
      })(),
    );
  });

  const firstResponse = await page.goto(studioUrl, { waitUntil: "networkidle2" });
  if (!firstResponse?.ok()) throw new Error(`Studio load failed: ${firstResponse?.status()}`);
  observations.browser = {
    product: await browser.version(),
    userAgent: await browser.userAgent(),
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    viewport: await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      devicePixelRatio,
    })),
  };

  const initialId = await identity(page);
  observations.initial = {
    selectedId: initialId,
    expectedInitialAssets,
    bodyContainsLocalPath: await page.evaluate(
      (markers) =>
        markers.some((marker) => document.body?.textContent?.includes(marker)),
      localPathMarkers,
    ),
  };
  if (initialId !== expectedDefaultAsset) {
    throw new Error(`Unexpected initial asset: ${initialId}`);
  }

  await clickButton(page, "Choose image");
  await page.waitForFunction(() =>
    document.querySelectorAll('[aria-label="Image Assets"] button').length >= 2,
  );
  observations.initial.picker = await picker(page);
  await screenshot(page, "2026-07-18_193700_initial-picker.jpg");

  await importTrial(page);
  await page.waitForFunction(
    (prefix) =>
      document
        .querySelector('[aria-label="imageAsset image asset identity"]')
        ?.textContent?.trim()
        .startsWith(`${prefix}-`) === true,
    {},
    trialSlug,
  );
  const importedId = await identity(page);
  await page.waitForFunction(() =>
    document.querySelectorAll('[aria-label="Image Assets"] button').length >= 3,
  );
  const firstFacts = await uploadedAssetFacts(page, importedId);
  observations.import = {
    selectedId: importedId,
    picker: await picker(page),
    persisted: firstFacts,
    idHashMatchesPersistedBytes: importedId.endsWith(firstFacts.sha256.slice(0, 12)),
  };
  await screenshot(page, "2026-07-18_193710_imported-selected.jpg");

  await importTrial(page);
  await waitForIdentity(page, importedId);
  await page.waitForFunction(() =>
    ![...document.querySelectorAll("button")].some(
      (button) => button.textContent?.trim() === "Importing…",
    ),
  );
  const secondFacts = await uploadedAssetFacts(page, importedId);
  observations.import.secondRead = secondFacts;
  observations.import.persistedBytesImmutable =
    JSON.stringify(firstFacts) === JSON.stringify(secondFacts);

  await selectPickerAsset(page, "img 0672");
  await waitForIdentity(page, expectedInitialAssets[0]);
  const flowersSelectedId = await identity(page);
  await selectPickerAsset(page, "pinecone");
  await waitForIdentity(page, expectedInitialAssets[1]);
  const pineconeSelectedId = await identity(page);
  await selectPickerAsset(page, trialSlug.replaceAll("-", " "));
  await waitForIdentity(page, importedId);
  observations.reuse = {
    flowersSelectedId,
    pineconeSelectedId,
    importedReselectedId: await identity(page),
    picker: await picker(page),
  };

  await setValue(page, '[aria-label="preset name"]', trialPreset);
  await clickButton(page, "Save");
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll('[aria-label="saved presets"] option')].some(
        (option) => option.getAttribute("value") === name,
      ),
    {},
    trialPreset,
  );

  await page.reload({ waitUntil: "networkidle2" });
  const postReloadDefaultId = await identity(page);
  await page.select('[aria-label="saved presets"]', trialPreset);
  await clickButton(page, "Reload");
  await waitForIdentity(page, importedId);
  await clickButton(page, "Choose image");
  await page.waitForFunction(() =>
    document.querySelectorAll('[aria-label="Image Assets"] button').length >= 3,
  );
  const loadedPresetResponse = await page.evaluate(async (name) => {
    const response = await fetch(`/sketches/photo-scribble/presets/${name}.json`);
    return { status: response.status, body: await response.json() };
  }, trialPreset);
  observations.reload = {
    postReloadDefaultId,
    selectedPreset: trialPreset,
    restoredId: await identity(page),
    picker: await picker(page),
    preset: loadedPresetResponse,
  };
  await screenshot(page, "2026-07-18_193720_reload-picker-reuse.jpg");

  observations.storage = await page.evaluate(async () => ({
    localStorage: { ...localStorage },
    sessionStorage: { ...sessionStorage },
    indexedDatabases:
      typeof indexedDB.databases === "function"
        ? await indexedDB.databases()
        : "unsupported",
    cookie: document.cookie,
  }));
  const privacySurface = {
    bodyText: await page.evaluate(() => document.body?.textContent ?? ""),
    storage: observations.storage,
    network: observations.network,
    preset: loadedPresetResponse,
  };
  observations.privacy = {
    checkedSurfaces: [
      "visible body text",
      "local/session/IndexedDB/cookie state",
      "captured managed-asset and Preset requests/responses",
      "saved Preset JSON",
    ],
    checkedMarkers: localPathMarkers,
    markerMatches: localPathMarkers.filter((marker) =>
      JSON.stringify(privacySurface).includes(marker),
    ),
    fileInputValueAfterImport: await page.$eval(
      'input[type="file"]',
      (input) => input.value,
    ),
  };

  await Promise.all(responseReads);
  observations.import.postResponses = observations.network.filter(
    (entry) =>
      entry.phase === "response" &&
      entry.method === "POST" &&
      entry.path.startsWith(`/__api/image-assets/${trialSlug}`),
  );
  observations.pass =
    observations.import.postResponses.length === 2 &&
    observations.import.postResponses[0]?.jsonBody?.created === true &&
    observations.import.postResponses[1]?.jsonBody?.created === false &&
    observations.import.postResponses.every(
      (entry) => entry.jsonBody?.id === importedId,
    ) &&
    observations.import.idHashMatchesPersistedBytes === true &&
    observations.import.persistedBytesImmutable === true &&
    observations.reuse.flowersSelectedId === expectedInitialAssets[0] &&
    observations.reuse.pineconeSelectedId === expectedInitialAssets[1] &&
    observations.reload.restoredId === importedId &&
    observations.reload.preset.body.params.imageAsset === importedId &&
    observations.privacy.markerMatches.length === 0 &&
    observations.privacy.fileInputValueAfterImport === "" &&
    observations.pageErrors.length === 0;

  await writeFile(
    resolve(outputDirectory, "raw-browser-import-review.json"),
    `${JSON.stringify(observations, null, 2)}\n`,
  );
  if (!observations.pass) throw new Error("Browser import review assertions failed");
} finally {
  await browser.close();
}
