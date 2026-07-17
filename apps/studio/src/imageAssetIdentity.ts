/** Number of SHA-256 hex characters retained in a stable Image Asset ID. */
export const IMAGE_ASSET_HASH_HEX_LENGTH = 12;

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

/** Build an Image Asset ID from a readable name and a lowercase SHA-256 hex. */
export function imageAssetIdFromDigest(slug: string, digest: string): string {
  if (!SHA256_HEX.test(digest)) {
    throw new Error(
      "Image Asset digest must be 64 lowercase SHA-256 hex characters",
    );
  }

  return `${normalizeImageAssetSlug(slug)}-${digest.slice(
    0,
    IMAGE_ASSET_HASH_HEX_LENGTH,
  )}`;
}

/** Parse only the exact canonical `<slug>-<hash12>` Image Asset ID form. */
export function parseImageAssetId(value: string): ParsedImageAssetId | null {
  const match = IMAGE_ASSET_ID.exec(value);
  if (match === null) return null;

  return { slug: match[1]!, hash: match[2]! };
}

/** Whether a value is a canonical Image Asset ID. */
export function isImageAssetId(value: unknown): value is string {
  return typeof value === "string" && parseImageAssetId(value) !== null;
}
