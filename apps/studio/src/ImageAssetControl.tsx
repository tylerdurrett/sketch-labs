import {
  imageAssetDisplayName,
  imageAssetUrl,
} from "./imageAssetIdentity";

/** Props for the schema-derived, read-only Image Asset control. */
export interface ImageAssetControlProps {
  /** The param's key in the schema, used as the visible row label. */
  paramKey: string;
  /** The exact current identity after ControlPanel's type-only fallback. */
  value: string;
}

/**
 * Display one Image Asset identity without inventing asset-management UI.
 *
 * Canonical IDs gain a readable name and stable logical thumbnail URL. A
 * malformed identity remains visible verbatim but never becomes a request URL;
 * availability is deliberately not inferred here, so an unresolved canonical
 * ID still points at its own logical URL rather than silently substituting the
 * schema default.
 */
export function ImageAssetControl({
  paramKey,
  value,
}: ImageAssetControlProps) {
  const displayName = imageAssetDisplayName(value);
  const url = imageAssetUrl(value);

  return (
    <div className="flex items-center gap-3">
      {url !== null && displayName !== null ? (
        <img
          src={url}
          alt={`${displayName} image asset thumbnail`}
          className="size-12 shrink-0 rounded-md border bg-muted object-cover"
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground">{paramKey}</div>
        {displayName !== null ? (
          <div className="truncate text-sm text-muted-foreground">
            {displayName}
          </div>
        ) : null}
        <code
          aria-label={`${paramKey} image asset identity`}
          className="block break-all text-xs text-muted-foreground"
        >
          {value}
        </code>
      </div>
    </div>
  );
}
