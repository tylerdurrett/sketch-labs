// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImageAssetsClientError } from "./imageAssetsClient";
import { ImageAssetControl } from "./ImageAssetControl";
import { ImageAssetNormalizationError } from "./imageAssetNormalization";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const operations = vi.hoisted(() => ({
  list: vi.fn(),
  normalize: vi.fn(),
  import: vi.fn(),
}));

vi.mock("./imageAssetsClient", async (importActual) => {
  const actual = await importActual<typeof import("./imageAssetsClient")>();
  return {
    ...actual,
    listImageAssets: operations.list,
    importImageAsset: operations.import,
  };
});

vi.mock("./imageAssetNormalization", async (importActual) => {
  const actual =
    await importActual<typeof import("./imageAssetNormalization")>();
  return { ...actual, normalizeImageAsset: operations.normalize };
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(node: React.ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

function button(el: ParentNode, name: string): HTMLButtonElement {
  const found = [...el.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (found === undefined) throw new Error(`No button named ${name}`);
  return found;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function chooseFile(el: ParentNode, file: File): void {
  const input = el.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [file],
  });
  act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  operations.list.mockResolvedValue([]);
  operations.normalize.mockResolvedValue({
    png: new Blob(["png"], { type: "image/png" }),
    width: 10,
    height: 8,
  });
  operations.import.mockResolvedValue({
    id: "imported-image-bbbbbbbbbbbb",
    created: true,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

describe("ImageAssetControl", () => {
  it("shows the exact canonical identity, readable name, and stable thumbnail", () => {
    const value = "pine-cone-0123456789ab";
    const html = renderToStaticMarkup(
      <ImageAssetControl paramKey="source" value={value} onChange={() => {}} />,
    );

    expect(html).toContain("pine cone");
    expect(html).toContain(`src="/image-assets/${value}.png"`);
    expect(html).toContain('alt="pine cone image asset thumbnail"');
    const host = document.createElement("div");
    host.innerHTML = html;
    expect(host.querySelector("code")?.textContent).toBe(value);
  });

  it("preserves unresolved and malformed identities without substitution", () => {
    const unresolved = "not-in-the-catalog-abcdef012345";
    expect(
      renderToStaticMarkup(
        <ImageAssetControl
          paramKey="source"
          value={unresolved}
          onChange={() => {}}
        />,
      ),
    ).toContain(`src="/image-assets/${unresolved}.png"`);

    const malformed = "../Pine Cone.png?raw=1";
    const html = renderToStaticMarkup(
      <ImageAssetControl
        paramKey="source"
        value={malformed}
        onChange={() => {}}
      />,
    );
    expect(html).not.toContain("<img");
    const host = document.createElement("div");
    host.innerHTML = html;
    expect(host.querySelector("code")?.textContent).toBe(malformed);
  });

  it.each([
    [
      "missing",
      "Image Asset is missing. The exact selected ID remains active.",
    ],
    [
      "error",
      "Image Asset is unavailable. The exact selected ID remains active.",
    ],
  ] as const)(
    "shows an exact %s state without a broken thumbnail or fallback selection",
    (status, message) => {
      const value = "unresolved-image-abcdef012345";
      const retry = vi.fn();
      const onChange = vi.fn();
      const el = mount(
        <ImageAssetControl
          paramKey="source"
          value={value}
          onChange={onChange}
          resolution={{ status, failedId: value, retry }}
        />,
      );

      expect(el.querySelector("img")).toBeNull();
      expect(el.querySelector('[role="alert"]')?.textContent).toBe(message);
      expect(el.querySelector("code")?.textContent).toBe(value);
      expect(el.textContent).not.toContain("default");

      act(() => button(el, "Retry exact asset").click());
      expect(retry).toHaveBeenCalledTimes(1);
      expect(onChange).not.toHaveBeenCalled();
      expect(operations.list).not.toHaveBeenCalled();
    },
  );

  it("shows loading for the exact selection, then its resolved thumbnail", () => {
    const value = "pending-image-abcdef012345";
    const retry = vi.fn();
    const renderControl = (status: "loading" | "resolved") => (
      <ImageAssetControl
        paramKey="source"
        value={value}
        onChange={() => {}}
        resolution={{ status, failedId: null, retry }}
      />
    );
    const el = mount(renderControl("loading"));

    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector('[role="status"]')?.textContent).toBe(
      "Loading exact Image Asset…",
    );
    expect(el.querySelector("code")?.textContent).toBe(value);

    act(() => root!.render(renderControl("resolved")));
    expect(el.querySelector('[role="status"]')).toBeNull();
    expect(el.querySelector("img")?.getAttribute("src")).toBe(
      `/image-assets/${value}.png`,
    );
  });

  it("limits a known failure to rows selecting the failed exact ID", () => {
    const value = "healthy-image-abcdef012345";
    const html = renderToStaticMarkup(
      <ImageAssetControl
        paramKey="source"
        value={value}
        onChange={() => {}}
        resolution={{
          status: "missing",
          failedId: "missing-sibling-aaaaaaaaaaaa",
          retry: () => {},
        }}
      />,
    );

    expect(html).toContain(`src="/image-assets/${value}.png"`);
    expect(html).not.toContain("Image Asset is missing");
    expect(html).not.toContain("Retry exact asset");
  });

  it("keeps resolution retry independent from an open managed library", async () => {
    const value = "missing-image-abcdef012345";
    const retry = vi.fn();
    const onChange = vi.fn();
    const el = mount(
      <ImageAssetControl
        paramKey="source"
        value={value}
        onChange={onChange}
        resolution={{ status: "missing", failedId: value, retry }}
      />,
    );

    act(() => button(el, "Choose image").click());
    await flush();
    expect(operations.list).toHaveBeenCalledTimes(1);

    act(() => button(el, "Retry exact asset").click());
    expect(retry).toHaveBeenCalledTimes(1);
    expect(operations.list).toHaveBeenCalledTimes(1);
    expect(el.querySelector('input[type="file"]')).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not list or render import UI until the library is opened", async () => {
    const el = mount(
      <ImageAssetControl
        paramKey="source"
        value="current-aaaaaaaaaaaa"
        onChange={() => {}}
      />,
    );
    expect(operations.list).not.toHaveBeenCalled();
    expect(el.querySelector('input[type="file"]')).toBeNull();

    act(() => button(el, "Choose image").click());
    expect(operations.list).toHaveBeenCalledTimes(1);
    expect(el.querySelector('input[type="file"]')).not.toBeNull();
    await flush();
  });

  it("renders stable sorted thumbnail choices and marks/selects the active ID", async () => {
    operations.list.mockResolvedValueOnce([
      {
        id: "zebra-cccccccccccc",
        name: "zebra",
        url: "/image-assets/zebra-cccccccccccc.png",
      },
      {
        id: "apple-bbbbbbbbbbbb",
        name: "apple",
        url: "/image-assets/apple-bbbbbbbbbbbb.png",
      },
    ]);
    const onChange = vi.fn();
    const el = mount(
      <ImageAssetControl
        paramKey="source"
        value="zebra-cccccccccccc"
        onChange={onChange}
      />,
    );
    act(() => button(el, "Choose image").click());
    await flush();

    const choices = [
      ...el.querySelectorAll<HTMLButtonElement>(
        '[aria-label="Image Assets"] button',
      ),
    ];
    expect(choices.map((choice) => choice.textContent?.trim())).toEqual([
      "apple",
      "zebraCurrent",
    ]);
    expect(choices[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(choices[0]?.querySelector("img")?.src).toContain(
      "/image-assets/apple-bbbbbbbbbbbb.png",
    );

    act(() => choices[0]!.click());
    expect(onChange).toHaveBeenCalledWith("apple-bbbbbbbbbbbb");
  });

  it("proposes an editable slug without decoding, importing, or selecting", async () => {
    const onChange = vi.fn();
    const el = mount(
      <ImageAssetControl
        paramKey="source"
        value="current-aaaaaaaaaaaa"
        onChange={onChange}
      />,
    );
    act(() => button(el, "Choose image").click());
    await flush();
    const input = el.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.hasAttribute("accept")).toBe(false);

    chooseFile(el, new File(["source"], "Pine Cone.final.HEIC"));
    expect(el.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe(
      "pine-cone-final",
    );
    expect(operations.normalize).not.toHaveBeenCalled();
    expect(operations.import).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    ["proposed filename", true],
    ["edited slug", false],
  ])(
    "rejects an overlong %s before normalization, import, or selection",
    async (_case, fromFilename) => {
      const onChange = vi.fn();
      const el = mount(
        <ImageAssetControl
          paramKey="source"
          value="current-aaaaaaaaaaaa"
          onChange={onChange}
        />,
      );
      act(() => button(el, "Choose image").click());
      await flush();
      chooseFile(
        el,
        new File(["source"], `${fromFilename ? "a".repeat(101) : "short"}.png`),
      );

      const slugInput =
        el.querySelector<HTMLInputElement>('input[type="text"]')!;
      expect(slugInput.maxLength).toBe(100);
      expect(slugInput.getAttribute("aria-describedby")).toBe(
        "source-slug-help",
      );
      if (!fromFilename) {
        const valueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set!;
        act(() => {
          valueSetter.call(slugInput, "b".repeat(101));
          slugInput.dispatchEvent(new Event("input", { bubbles: true }));
        });
      }

      expect(el.textContent).toContain("Up to 100 characters.");
      expect(el.querySelector('[role="alert"]')?.textContent).toContain(
        "Shorten the name to 100 characters or fewer.",
      );
      expect(button(el, "Import Image Asset").disabled).toBe(true);
      act(() => button(el, "Import Image Asset").click());
      await flush();
      expect(operations.normalize).not.toHaveBeenCalled();
      expect(operations.import).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it("normalizes only on confirm with the supplied cap, imports the edited slug, selects immediately, and refreshes", async () => {
    const refreshed = deferred<never[]>();
    operations.list
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => refreshed.promise);
    const png = new Blob(["normalized"], { type: "image/png" });
    operations.normalize.mockResolvedValueOnce({ png, width: 11, height: 7 });
    const onChange = vi.fn();
    const el = mount(
      <ImageAssetControl
        paramKey="source"
        value="current-aaaaaaaaaaaa"
        onChange={onChange}
        imageAssetLongEdgeCap={777}
      />,
    );
    act(() => button(el, "Choose image").click());
    await flush();
    const file = new File(["source"], "Pine.jpg");
    chooseFile(el, file);
    const slugInput = el.querySelector<HTMLInputElement>('input[type="text"]')!;
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      valueSetter.call(slugInput, "edited pine");
      slugInput.dispatchEvent(new Event("input", { bubbles: true }));
      button(el, "Import Image Asset").click();
    });
    await flush();

    expect(operations.normalize).toHaveBeenCalledWith(file, {
      maxLongEdge: 777,
    });
    expect(operations.import).toHaveBeenCalledWith("edited pine", png);
    expect(onChange).toHaveBeenCalledWith("imported-image-bbbbbbbbbbbb");
    expect(operations.list).toHaveBeenCalledTimes(2);
    refreshed.resolve([]);
    await flush();
  });

  it.each([
    [
      "normalization",
      () =>
        operations.normalize.mockRejectedValueOnce(
          new ImageAssetNormalizationError("decode-failed"),
        ),
      "Could not prepare the selected image.",
    ],
    [
      "import",
      () =>
        operations.import.mockRejectedValueOnce(
          new ImageAssetsClientError("network", "import"),
        ),
      "Could not import the prepared Image Asset.",
    ],
  ])("keeps selection unchanged after an actionable %s failure", async (_phase, fail, message) => {
    fail();
    const onChange = vi.fn();
    const el = mount(
      <ImageAssetControl
        paramKey="source"
        value="current-aaaaaaaaaaaa"
        onChange={onChange}
      />,
    );
    act(() => button(el, "Choose image").click());
    await flush();
    chooseFile(el, new File(["source"], "Pine.jpg"));
    act(() => button(el, "Import Image Asset").click());
    await flush();

    expect(onChange).not.toHaveBeenCalled();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(message);
    expect(el.querySelector("code")?.textContent).toBe(
      "current-aaaaaaaaaaaa",
    );
  });

  it("keeps the last good catalog and selection after a bounded refresh failure", async () => {
    operations.list
      .mockResolvedValueOnce([
        {
          id: "pine-aaaaaaaaaaaa",
          name: "pine",
          url: "/image-assets/pine-aaaaaaaaaaaa.png",
        },
      ])
      .mockRejectedValueOnce(new ImageAssetsClientError("network", "list"));
    const onChange = vi.fn();
    const el = mount(
      <ImageAssetControl
        paramKey="source"
        value="pine-aaaaaaaaaaaa"
        onChange={onChange}
      />,
    );
    act(() => button(el, "Choose image").click());
    await flush();
    act(() => button(el, "Refresh").click());
    await flush();

    expect(el.textContent).toContain("pineCurrent");
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not load the Image Asset library.",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps a newer library choice when an older import settles late", async () => {
    operations.list.mockResolvedValueOnce([
      {
        id: "library-choice-bbbbbbbbbbbb",
        name: "library choice",
        url: "/image-assets/library-choice-bbbbbbbbbbbb.png",
      },
    ]);
    const pendingImport = deferred<{ id: string; created: boolean }>();
    operations.import.mockImplementationOnce(() => pendingImport.promise);
    const onChange = vi.fn();
    const el = mount(
      <ImageAssetControl
        paramKey="source"
        value="current-aaaaaaaaaaaa"
        onChange={onChange}
      />,
    );
    act(() => button(el, "Choose image").click());
    await flush();
    chooseFile(el, new File(["source"], "Pending.jpg"));
    act(() => button(el, "Import Image Asset").click());
    await flush();

    act(() => {
      el.querySelector<HTMLButtonElement>(
        '[aria-label="Image Assets"] button',
      )!.click();
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(
      "library-choice-bbbbbbbbbbbb",
    );
    expect(button(el, "Import Image Asset").disabled).toBe(false);

    pendingImport.resolve({ id: "stale-import-cccccccccccc", created: true });
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(
      "library-choice-bbbbbbbbbbbb",
    );
  });

  it("keeps a controlled value changed externally while an import settles", async () => {
    const pendingImport = deferred<{ id: string; created: boolean }>();
    operations.import.mockImplementationOnce(() => pendingImport.promise);
    const onChange = vi.fn();
    const renderControl = (value: string) => (
      <ImageAssetControl paramKey="source" value={value} onChange={onChange} />
    );
    const el = mount(renderControl("current-aaaaaaaaaaaa"));
    act(() => button(el, "Choose image").click());
    await flush();
    chooseFile(el, new File(["source"], "Pending.jpg"));
    act(() => button(el, "Import Image Asset").click());
    await flush();
    expect(operations.import).toHaveBeenCalledTimes(1);
    expect(button(el, "Importing…").disabled).toBe(true);

    act(() => root!.render(renderControl("undo-choice-bbbbbbbbbbbb")));
    expect(el.querySelector("code")?.textContent).toBe(
      "undo-choice-bbbbbbbbbbbb",
    );
    expect(button(el, "Import Image Asset").disabled).toBe(false);

    pendingImport.resolve({ id: "stale-import-cccccccccccc", created: true });
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    expect(operations.list).toHaveBeenCalledTimes(1);
    expect(el.querySelector("code")?.textContent).toBe(
      "undo-choice-bbbbbbbbbbbb",
    );
  });

  it.each([
    ["conflict", 409, "Choose a different name or image."],
    ["payload-too-large", 413, "Choose a smaller image."],
    ["invalid-request", 400, "Choose a different image."],
  ] as const)(
    "shows actionable bounded guidance for an import %s",
    async (code, status, guidance) => {
      operations.import.mockRejectedValueOnce(
        new ImageAssetsClientError(code, "import", { status }),
      );
      const el = mount(
        <ImageAssetControl
          paramKey="source"
          value="current-aaaaaaaaaaaa"
          onChange={() => {}}
        />,
      );
      act(() => button(el, "Choose image").click());
      await flush();
      chooseFile(el, new File(["source"], "Pine.jpg"));
      act(() => button(el, "Import Image Asset").click());
      await flush();

      const message = el.querySelector('[role="alert"]')?.textContent ?? "";
      expect(message).toContain(guidance);
      expect(message).not.toContain("/__api/");
      expect(message).not.toContain("assets/image-assets");
    },
  );

  it("ignores superseded catalog results and import completion after unmount", async () => {
    const oldList = deferred<
      { id: string; name: string; url: string }[]
    >();
    const newList = deferred<
      { id: string; name: string; url: string }[]
    >();
    operations.list
      .mockImplementationOnce(() => oldList.promise)
      .mockImplementationOnce(() => newList.promise);
    const onChange = vi.fn();
    const el = mount(
      <ImageAssetControl
        paramKey="source"
        value="current-aaaaaaaaaaaa"
        onChange={onChange}
      />,
    );
    act(() => button(el, "Choose image").click());
    act(() => button(el, "Close library").click());
    act(() => button(el, "Choose image").click());
    newList.resolve([
      {
        id: "newer-bbbbbbbbbbbb",
        name: "newer",
        url: "/image-assets/newer-bbbbbbbbbbbb.png",
      },
    ]);
    await flush();
    oldList.resolve([
      {
        id: "older-cccccccccccc",
        name: "older",
        url: "/image-assets/older-cccccccccccc.png",
      },
    ]);
    await flush();
    expect(el.textContent).toContain("newer");
    expect(el.textContent).not.toContain("older");

    const pendingImport = deferred<{ id: string; created: boolean }>();
    operations.import.mockImplementationOnce(() => pendingImport.promise);
    chooseFile(el, new File(["source"], "Pine.jpg"));
    act(() => button(el, "Import Image Asset").click());
    await flush();
    act(() => root!.unmount());
    root = null;
    pendingImport.resolve({ id: "late-dddddddddddd", created: true });
    await flush();
    expect(onChange).not.toHaveBeenCalled();
  });
});
