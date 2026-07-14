/** Maximum length shared by the Studio field and preset middleware. */
export const MAX_PRESET_NAME_LENGTH = 100;

/** Filesystem- and URL-safe Preset name contract. */
const PRESET_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * The rendered value plus the boundaries of whitespace runs normalized into
 * hyphens. The boundaries let later adjacent spacebar presses remain part of
 * those runs even though the controlled input no longer contains the original
 * whitespace. Boundary 0 represents discarded leading whitespace.
 */
export interface PresetNameDraft {
  value: string;
  whitespaceRunEnds: readonly number[];
}

/** Validate the persisted Preset name / filename stem contract. */
export function isValidPresetName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_PRESET_NAME_LENGTH &&
    PRESET_NAME_RE.test(value)
  );
}

/**
 * Normalize text at the input boundary without hiding invalid characters.
 *
 * Only ASCII uppercase and whitespace are rewritten. Unsupported visible
 * characters remain in place so validation can explain why Save is disabled.
 * Literal hyphens (including runs) and underscores are preserved exactly.
 */
export function normalizePresetName(value: string): string {
  return normalizedDraft(value).value;
}

/** Normalize a full browser value while retaining generated-hyphen origins. */
function normalizedDraft(value: string): PresetNameDraft {
  let normalized = "";
  let inWhitespaceRun = false;
  const whitespaceRunEnds: number[] = [];

  for (const character of value) {
    if (/^\s$/.test(character)) {
      if (!inWhitespaceRun) {
        if (normalized === "") {
          whitespaceRunEnds.push(0);
        } else {
          normalized += "-";
          whitespaceRunEnds.push(normalized.length);
        }
      }
      inWhitespaceRun = true;
      continue;
    }

    inWhitespaceRun = false;
    normalized += /^[A-Z]$/.test(character)
      ? character.toLowerCase()
      : character;
  }

  return { value: normalized, whitespaceRunEnds };
}

/**
 * Find the position of one unambiguous contiguous insertion. Replacements,
 * deletions, and insertions with multiple possible locations return `null`.
 */
function insertionIndex(previous: string, next: string): number | null {
  const insertedLength = next.length - previous.length;
  if (insertedLength <= 0) return null;

  let commonPrefix = 0;
  while (
    commonPrefix < previous.length &&
    previous[commonPrefix] === next[commonPrefix]
  ) {
    commonPrefix += 1;
  }

  let commonSuffix = 0;
  while (
    commonSuffix < previous.length &&
    previous[previous.length - 1 - commonSuffix] ===
      next[next.length - 1 - commonSuffix]
  ) {
    commonSuffix += 1;
  }

  const earliestIndex = previous.length - commonSuffix;
  return earliestIndex === commonPrefix ? commonPrefix : null;
}

/**
 * Advance a controlled Preset-name draft from the browser's next raw value.
 *
 * A newly inserted whitespace run becomes one hyphen and records its rendered
 * boundary. More whitespace typed beside a generated delimiter keeps the
 * existing hyphen. Every other edit falls back to whole-value normalization,
 * retaining the origins of any whitespace normalized during that edit.
 */
export function updatePresetNameDraft(
  previousDraft: PresetNameDraft,
  browserValue: string,
): PresetNameDraft {
  const index = insertionIndex(previousDraft.value, browserValue);
  const insertedLength = browserValue.length - previousDraft.value.length;
  const inserted =
    index === null ? "" : browserValue.slice(index, index + insertedLength);

  if (index !== null && /^\s+$/.test(inserted)) {
    const adjacentToGeneratedRun = previousDraft.whitespaceRunEnds.some(
      (end) => index === end || index + 1 === end,
    );
    if (adjacentToGeneratedRun) {
      return {
        value: previousDraft.value,
        whitespaceRunEnds: [...previousDraft.whitespaceRunEnds],
      };
    }

    if (index === 0) {
      return {
        value: previousDraft.value,
        whitespaceRunEnds: [0, ...previousDraft.whitespaceRunEnds],
      };
    }

    const shiftedRunEnds = previousDraft.whitespaceRunEnds.map((end) =>
      end > index ? end + 1 : end,
    );
    return {
      value:
        previousDraft.value.slice(0, index) +
        "-" +
        previousDraft.value.slice(index),
      whitespaceRunEnds: [...shiftedRunEnds, index + 1].sort(
        (left, right) => left - right,
      ),
    };
  }

  return normalizedDraft(browserValue);
}
