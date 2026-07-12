export type HistoryShortcut = "undo" | "redo";
export type HistoryShortcutPlatform = "mac" | "other";

type PlatformNavigator = Pick<Navigator, "platform"> & {
  readonly userAgentData?: { readonly platform?: string };
};

/** Detect which modifier owns history shortcuts in the current browser. */
export function detectHistoryShortcutPlatform(
  browserNavigator: PlatformNavigator = navigator,
): HistoryShortcutPlatform {
  const platform =
    browserNavigator.userAgentData?.platform || browserNavigator.platform;
  return /^(?:mac|iphone|ipad|ipod)/i.test(platform) ? "mac" : "other";
}

/** Resolve the Studio history command represented by a platform shortcut. */
export function historyShortcutFor(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
  >,
  platform: HistoryShortcutPlatform,
): HistoryShortcut | null {
  const primaryKey = platform === "mac" ? event.metaKey : event.ctrlKey;
  const crossPlatformKey = platform === "mac" ? event.ctrlKey : event.metaKey;
  if (event.altKey || !primaryKey || crossPlatformKey) return null;

  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && platform === "other" && !event.shiftKey) return "redo";
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
