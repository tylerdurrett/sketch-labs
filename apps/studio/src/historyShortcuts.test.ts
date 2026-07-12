// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  detectHistoryShortcutPlatform,
  fieldOwnsHistoryShortcut,
  historyShortcutFor,
} from "./historyShortcuts";

describe("Studio history shortcuts", () => {
  const event = (
    chord: Partial<
      Pick<
        KeyboardEvent,
        "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
      >
    >,
  ) => ({
    key: "z",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...chord,
  });

  it.each([
    [{ key: "z", metaKey: true }, "undo"],
    [{ key: "Z", metaKey: true, shiftKey: true }, "redo"],
  ] as const)("maps macOS $0 to $1", (chord, command) => {
    expect(historyShortcutFor(event(chord), "mac")).toBe(command);
  });

  it.each([
    [{ key: "z", ctrlKey: true }, "undo"],
    [{ key: "z", ctrlKey: true, shiftKey: true }, "redo"],
    [{ key: "y", ctrlKey: true }, "redo"],
  ] as const)("maps non-macOS $0 to $1", (chord, command) => {
    expect(historyShortcutFor(event(chord), "other")).toBe(command);
  });

  it.each([
    ["mac", { key: "z", ctrlKey: true }],
    ["mac", { key: "y", ctrlKey: true }],
    ["mac", { key: "y", metaKey: true }],
    ["other", { key: "z", metaKey: true }],
    ["other", { key: "y", metaKey: true }],
    ["other", { key: "z" }],
    ["other", { key: "z", altKey: true, ctrlKey: true }],
    ["other", { key: "z", ctrlKey: true, metaKey: true }],
    ["other", { key: "y", ctrlKey: true, shiftKey: true }],
    ["other", { key: "x", ctrlKey: true }],
  ] as const)("ignores unsupported %s chord $1", (platform, chord) => {
    expect(historyShortcutFor(event(chord), platform)).toBeNull();
  });

  it("prefers high-entropy platform data and falls back to navigator.platform", () => {
    expect(
      detectHistoryShortcutPlatform({
        platform: "Linux x86_64",
        userAgentData: { platform: "macOS" },
      }),
    ).toBe("mac");
    expect(
      detectHistoryShortcutPlatform({ platform: "Win32" }),
    ).toBe("other");
    expect(
      detectHistoryShortcutPlatform({ platform: "iPhone" }),
    ).toBe("mac");
    expect(
      detectHistoryShortcutPlatform({
        platform: "MacIntel",
        userAgentData: { platform: "" },
      }),
    ).toBe("mac");
  });

  it.each([
    ["text input", () => document.createElement("input")],
    [
      "numeric input",
      () => {
        const input = document.createElement("input");
        input.type = "number";
        return input;
      },
    ],
    ["textarea", () => document.createElement("textarea")],
    [
      "contenteditable",
      () => {
        const editor = document.createElement("div");
        editor.setAttribute("contenteditable", "true");
        return editor;
      },
    ],
  ] as const)(
    "gives an active %s native precedence until settlement",
    (_label, createEditor) => {
      const editor = createEditor();
      expect(fieldOwnsHistoryShortcut(editor, true)).toBe(true);
      expect(fieldOwnsHistoryShortcut(editor, false)).toBe(false);
    },
  );

  it("always gives explicitly excluded text and its descendants native precedence", () => {
    const excluded = document.createElement("div");
    excluded.dataset.studioHistory = "exclude";
    const input = document.createElement("input");
    excluded.appendChild(input);

    expect(fieldOwnsHistoryShortcut(input, true)).toBe(true);
    expect(fieldOwnsHistoryShortcut(input, false)).toBe(true);
  });
});
