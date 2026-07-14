// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HARNESS_FALLBACK_PLOT_PROFILE,
  type Preset,
} from "@harness/core";

import { PresetControls } from "./PresetControls";

const presetClient = vi.hoisted(() => ({
  list: vi.fn<[string], Promise<string[]>>(),
  load: vi.fn<[string, string], Promise<Preset>>(),
  save: vi.fn<[Preset], Promise<void>>(),
}));

vi.mock("./presetsClient", () => ({
  listPresets: (sketchId: string) => presetClient.list(sketchId),
  loadPreset: (sketchId: string, name: string) =>
    presetClient.load(sketchId, name),
  savePreset: (preset: Preset) => presetClient.save(preset),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

async function mount(names: string[] = []): Promise<HTMLDivElement> {
  presetClient.list.mockResolvedValue(names);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <PresetControls
        sketchId="circles"
        params={{ count: 12 }}
        seed="abc123"
        locks={new Set(["count"])}
        profile={HARNESS_FALLBACK_PLOT_PROFILE}
        onReload={vi.fn()}
      />,
    ),
  );
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

function nameInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(
    'input[aria-label="preset name"]',
  )!;
}

function enterBrowserValue(value: string): void {
  const input = nameInput();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function saveButton(): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Save",
  )!;
}

async function clickSave(): Promise<void> {
  await act(async () => {
    saveButton().click();
    await Promise.resolve();
  });
}

beforeEach(() => {
  presetClient.list.mockReset();
  presetClient.load.mockReset();
  presetClient.save.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("PresetControls name entry", () => {
  it("normalizes uppercase and repeated whitespace during incremental typing", async () => {
    await mount();

    enterBrowserValue("NICE");
    expect(nameInput().value).toBe("nice");

    enterBrowserValue("nice ");
    expect(nameInput().value).toBe("nice-");

    enterBrowserValue("nice- ");
    expect(nameInput().value).toBe("nice-");

    enterBrowserValue("nice-o");
    expect(nameInput().value).toBe("nice-o");
  });

  it("normalizes pasted whitespace runs and discards leading whitespace", async () => {
    await mount();

    enterBrowserValue("   Nice   One");

    expect(nameInput().value).toBe("nice-one");
    enterBrowserValue("nice- one");
    expect(nameInput().value).toBe("nice-one");
    expect(saveButton().disabled).toBe(false);
  });

  it("keeps unsupported visible characters and explains disabled Save", async () => {
    await mount();

    enterBrowserValue("Good?!");

    expect(nameInput().value).toBe("good?!");
    expect(saveButton().disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "use only a-z",
    );
  });

  it("explains that otherwise-valid punctuation cannot start a name", async () => {
    await mount();

    for (const value of ["-warm", "_warm"]) {
      enterBrowserValue(value);
      expect(nameInput().value).toBe(value);
      expect(saveButton().disabled).toBe(true);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "start with a-z or 0-9",
      );
    }
  });

  it("serializes the normalized name when saving", async () => {
    await mount();
    enterBrowserValue("My Preset");

    await clickSave();

    expect(presetClient.save).toHaveBeenCalledTimes(1);
    expect(presetClient.save.mock.calls[0]?.[0]).toMatchObject({
      sketch: "circles",
      name: "my-preset",
    });
  });

  it("uses the normalized name for overwrite decline and acceptance", async () => {
    await mount(["my-preset"]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    enterBrowserValue("My Preset");

    await clickSave();
    expect(confirm).toHaveBeenCalledWith('Overwrite preset "my-preset"?');
    expect(presetClient.save).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await clickSave();
    expect(presetClient.save).toHaveBeenCalledTimes(1);
    expect(presetClient.save.mock.calls[0]?.[0].name).toBe("my-preset");
  });
});
