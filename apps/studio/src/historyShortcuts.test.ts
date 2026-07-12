// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  fieldOwnsHistoryShortcut,
  historyShortcutFor,
} from "./historyShortcuts";

describe("Studio history shortcuts", () => {
  it.each([
    [{ key: "z", metaKey: true }, "undo"],
    [{ key: "Z", metaKey: true, shiftKey: true }, "redo"],
    [{ key: "z", ctrlKey: true }, "undo"],
    [{ key: "z", ctrlKey: true, shiftKey: true }, "redo"],
    [{ key: "y", ctrlKey: true }, "redo"],
  ] as const)("maps $0 to $1", (chord, command) => {
    expect(
      historyShortcutFor({
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        ...chord,
      }),
    ).toBe(command);
  });

  it.each([
    { key: "z" },
    { key: "z", altKey: true, ctrlKey: true },
    { key: "z", ctrlKey: true, metaKey: true },
    { key: "y", metaKey: true },
    { key: "y", ctrlKey: true, shiftKey: true },
    { key: "x", ctrlKey: true },
  ])("ignores unsupported chord $key", (chord) => {
    expect(
      historyShortcutFor({
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        ...chord,
      }),
    ).toBeNull();
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
