// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { downloadBlob } from "./downloadBlob";

/**
 * jsdom implements neither `URL.createObjectURL` nor `revokeObjectURL`, and an
 * anchor `click()` would otherwise try to navigate. Stub the object-URL pair and
 * spy on the anchor's `click` so we can prove the full sequence WITHOUT a real
 * download: create a URL for the Blob, point a `<a download={filename}>` at it,
 * click it, and revoke the URL. The contract under test is the wiring, not pixels.
 */

const OBJECT_URL = "blob:fake-url";
let createObjectURL: MockInstance<[Blob], string>;
let revokeObjectURL: MockInstance<[string], void>;
let clickSpy: MockInstance<[], void>;

beforeEach(() => {
  // The revoke is deferred to a macrotask, so drive timers deterministically.
  vi.useFakeTimers();
  createObjectURL = vi.fn((_blob: Blob) => OBJECT_URL);
  revokeObjectURL = vi.fn((_url: string) => {});
  vi.stubGlobal("URL", {
    createObjectURL,
    revokeObjectURL,
  });
  // Spy on every anchor's click so the programmatic download does not navigate.
  // `click` lives on HTMLElement.prototype (anchors inherit it).
  clickSpy = vi
    .spyOn(HTMLElement.prototype, "click")
    .mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("downloadBlob", () => {
  it("creates an object URL, clicks a named anchor, then revokes the URL", () => {
    const blob = new Blob(["hello"], { type: "text/plain" });

    // Capture the anchor the helper builds (and clicks) so we can assert its
    // href/download — the anchor is detached, so we read it off the click spy.
    let clickedAnchor: HTMLAnchorElement | undefined;
    clickSpy.mockImplementation(function (this: HTMLAnchorElement) {
      clickedAnchor = this;
    });

    downloadBlob(blob, "circles-seed42.png");

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(clickedAnchor?.href).toContain(OBJECT_URL);
    expect(clickedAnchor?.download).toBe("circles-seed42.png");
    // The revoke is DEFERRED to a macrotask so it cannot race the browser's
    // async read of the object URL when the download starts: it has not fired
    // synchronously with the click...
    expect(revokeObjectURL).not.toHaveBeenCalled();
    // ...but it does fire once the macrotask drains, freeing the Blob.
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith(OBJECT_URL);
  });
});
