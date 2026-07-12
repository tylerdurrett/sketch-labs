export type HistoryShortcut = "undo" | "redo";

/** Resolve the Studio history command represented by a platform shortcut. */
export function historyShortcutFor(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
  >,
): HistoryShortcut | null {
  if (event.altKey || event.metaKey === event.ctrlKey) return null;

  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && event.ctrlKey && !event.shiftKey) return "redo";
  return null;
}

/** Whether the shortcut belongs to native field editing instead of Studio. */
export function fieldOwnsHistoryShortcut(
  target: EventTarget | null,
  transactionActive: boolean,
): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('[data-studio-history="exclude"]') !== null) return true;
  if (!transactionActive) return false;

  if (
    target instanceof HTMLTextAreaElement ||
    target.closest(
      '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
    ) !== null
  ) {
    return true;
  }
  if (!(target instanceof HTMLInputElement)) return false;

  return [
    "email",
    "number",
    "password",
    "search",
    "tel",
    "text",
    "url",
  ].includes(target.type);
}
