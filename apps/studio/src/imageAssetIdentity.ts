/** Number of SHA-256 hex characters retained in a stable Image Asset ID. */
export const IMAGE_ASSET_HASH_HEX_LENGTH = 12;

/** Largest canonical human-readable slug accepted by every Image Asset seam. */
export const IMAGE_ASSET_MAX_SLUG_LENGTH = 100;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const IMAGE_ASSET_ID = /^([a-z0-9]+(?:-[a-z0-9]+)*)-([0-9a-f]{12})$/;

/** The canonical, URL-safe components encoded by an Image Asset ID. */
export interface ParsedImageAssetId {
  readonly slug: string;
  readonly hash: string;
}

/**
 * Normalize a human-readable asset name into its canonical ID slug.
 *
 * Every non-ASCII-alphanumeric run becomes one separator. Names without an
 * ASCII letter or digit use `image`, keeping the result valid and readable.
 */
export function normalizeImageAssetSlug(value: string): string {
  return (
    value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
    "image"
  );
}

/** Whether a draft normalizes to a slug that fits the shared identity bound. */
export function isImageAssetSlugDraftWithinLimit(value: string): boolean {
  return normalizeImageAssetSlug(value).length <= IMAGE_ASSET_MAX_SLUG_LENGTH;
}

/** Whether a value is already the exact bounded canonical slug form. */
export function isCanonicalImageAssetSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= IMAGE_ASSET_MAX_SLUG_LENGTH &&
    normalizeImageAssetSlug(value) === value
  );
}

/** Build an Image Asset ID from a readable name and a lowercase SHA-256 hex. */
export function imageAssetIdFromDigest(slug: string, digest: string): string {
  if (!SHA256_HEX.test(digest)) {
    throw new Error(
      "Image Asset digest must be 64 lowercase SHA-256 hex characters",
    );
  }

  const canonicalSlug = normalizeImageAssetSlug(slug);
  if (!isImageAssetSlugDraftWithinLimit(canonicalSlug)) {
    throw new Error(
      `Image Asset slug must be ${IMAGE_ASSET_MAX_SLUG_LENGTH} characters or fewer`,
    );
  }

  return `${canonicalSlug}-${digest.slice(
    0,
    IMAGE_ASSET_HASH_HEX_LENGTH,
  )}`;
}

/** Parse only the exact canonical `<slug>-<hash12>` Image Asset ID form. */
export function parseImageAssetId(value: string): ParsedImageAssetId | null {
  const match = IMAGE_ASSET_ID.exec(value);
  if (match === null || !isCanonicalImageAssetSlug(match[1])) return null;

  return { slug: match[1]!, hash: match[2]! };
}

/** Whether a value is a canonical Image Asset ID. */
export function isImageAssetId(value: unknown): value is string {
  return typeof value === "string" && parseImageAssetId(value) !== null;
}

/**
 * Resolve a canonical Image Asset ID to its browser-facing static URL.
 *
 * Invalid IDs have no URL: callers must not fabricate a request for an
 * unresolved or malformed value.
 */
export function imageAssetUrl(value: unknown): string | null {
  return isImageAssetId(value) ? `/image-assets/${value}.png` : null;
}

/** Return the readable slug portion of a canonical Image Asset ID. */
export function imageAssetDisplayName(value: unknown): string | null {
  const parsed = typeof value === "string" ? parseImageAssetId(value) : null;
  return parsed === null ? null : parsed.slug.replaceAll("-", " ");
}
