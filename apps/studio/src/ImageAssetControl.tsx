import { useEffect, useRef, useState } from "react";

import { Button } from "./components/ui/button";
import {
  imageAssetDisplayName,
  imageAssetUrl,
} from "./imageAssetIdentity";
import {
  importImageAsset,
  ImageAssetsClientError,
  listImageAssets,
  type ManagedImageAsset,
} from "./imageAssetsClient";
import {
  normalizeImageAsset,
  ImageAssetNormalizationError,
  proposeImageAssetSlug,
} from "./imageAssetNormalization";
import { STUDIO_IMAGE_ASSET_LONG_EDGE_CAP } from "./studioConfig";

type FailurePhase = "list" | "normalize" | "import";

/** Props for the schema-derived Image Asset picker/import control. */
export interface ImageAssetControlProps {
  /** The param's key in the schema, used as the visible row label. */
  paramKey: string;
  /** The exact current identity after ControlPanel's type-only fallback. */
  value: string;
  /** Commit one ordinary Image Asset param value. */
  onChange: (value: string) => void;
  /** Longest normalized source edge, supplied by the Studio shell. */
  imageAssetLongEdgeCap?: number;
}

function failureMessage(phase: FailurePhase, error: unknown): string {
  const detail =
    error instanceof ImageAssetsClientError ||
    error instanceof ImageAssetNormalizationError
      ? error.message
      : null;
  const lead =
    phase === "list"
      ? "Could not load the Image Asset library."
      : phase === "normalize"
        ? "Could not prepare the selected image."
        : "Could not import the prepared Image Asset.";
  return `${lead}${detail === null ? "" : ` ${detail}`} Try again.`;
}

/**
 * Show the exact current identity and lazily expose managed reuse/import UI.
 *
 * File selection only records the browser File and proposes an editable slug.
 * Normalization and persistence start on explicit confirmation. Async tokens
 * keep closed, superseded, and unmounted controls from applying stale results.
 */
export function ImageAssetControl({
  paramKey,
  value,
  onChange,
  imageAssetLongEdgeCap = STUDIO_IMAGE_ASSET_LONG_EDGE_CAP,
}: ImageAssetControlProps) {
  const displayName = imageAssetDisplayName(value);
  const url = imageAssetUrl(value);
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<ManagedImageAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [slug, setSlug] = useState("");
  const [importing, setImporting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const catalogToken = useRef(0);
  const importToken = useRef(0);
  const mounted = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      catalogToken.current += 1;
      importToken.current += 1;
    };
  }, []);

  const refreshCatalog = async (): Promise<void> => {
    const token = ++catalogToken.current;
    setLoading(true);
    setFailure(null);
    try {
      const listed = await listImageAssets();
      if (!mounted.current || catalogToken.current !== token) return;
      setAssets(
        [...listed].sort((left, right) =>
          left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
        ),
      );
    } catch (error) {
      if (!mounted.current || catalogToken.current !== token) return;
      setFailure(failureMessage("list", error));
    } finally {
      if (mounted.current && catalogToken.current === token) setLoading(false);
    }
  };

  const toggleOpen = (): void => {
    if (open) {
      catalogToken.current += 1;
      importToken.current += 1;
      setOpen(false);
      setLoading(false);
      setImporting(false);
      setFailure(null);
      return;
    }
    setOpen(true);
    void refreshCatalog();
  };

  const chooseFile = (next: File | null): void => {
    importToken.current += 1;
    setImporting(false);
    setFailure(null);
    setFile(next);
    setSlug(next === null ? "" : proposeImageAssetSlug(next.name));
  };

  const selectAsset = (id: string): void => {
    // A library choice is newer authored intent than any in-flight import.
    // The browser request cannot be cancelled once posted, but its result must
    // never overwrite this explicit selection when it eventually settles.
    importToken.current += 1;
    setImporting(false);
    setFailure(null);
    onChange(id);
  };

  const confirmImport = async (): Promise<void> => {
    if (file === null || importing) return;
    const selectedFile = file;
    const slugDraft = slug;
    const token = ++importToken.current;
    setImporting(true);
    setFailure(null);

    let normalized: Awaited<ReturnType<typeof normalizeImageAsset>>;
    try {
      normalized = await normalizeImageAsset(selectedFile, {
        maxLongEdge: imageAssetLongEdgeCap,
      });
    } catch (error) {
      if (!mounted.current || importToken.current !== token) return;
      setImporting(false);
      setFailure(failureMessage("normalize", error));
      return;
    }
    if (!mounted.current || importToken.current !== token) return;

    try {
      const result = await importImageAsset(slugDraft, normalized.png);
      if (!mounted.current || importToken.current !== token) return;
      onChange(result.id);
      setFile(null);
      setSlug("");
      if (fileInput.current !== null) fileInput.current.value = "";
      setImporting(false);
      await refreshCatalog();
    } catch (error) {
      if (!mounted.current || importToken.current !== token) return;
      setImporting(false);
      setFailure(failureMessage("import", error));
    }
  };

  return (
    <div className="flex flex-col gap-2">
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
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={open}
          onClick={toggleOpen}
        >
          {open ? "Close library" : "Choose image"}
        </Button>
      </div>

      {open ? (
        <div className="flex flex-col gap-3 rounded-md border p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">Image Asset library</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={loading}
              onClick={() => void refreshCatalog()}
            >
              Refresh
            </Button>
          </div>
          {loading ? (
            <div role="status" className="text-sm text-muted-foreground">
              Loading Image Assets…
            </div>
          ) : null}
          {assets.length > 0 ? (
            <div className="grid grid-cols-2 gap-2" aria-label="Image Assets">
              {assets.map((asset) => {
                const active = asset.id === value;
                return (
                  <button
                    key={asset.id}
                    type="button"
                    aria-pressed={active}
                    className="flex min-w-0 items-center gap-2 rounded-md border p-2 text-left"
                    onClick={() => selectAsset(asset.id)}
                  >
                    <img
                      src={asset.url}
                      alt=""
                      className="size-10 shrink-0 rounded object-cover"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{asset.name}</span>
                      {active ? (
                        <span className="block text-xs text-muted-foreground">
                          Current
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : !loading && failure === null ? (
            <div className="text-sm text-muted-foreground">
              No managed Image Assets yet.
            </div>
          ) : null}

          <div className="flex flex-col gap-2 border-t pt-3">
            <label className="text-sm font-medium" htmlFor={`${paramKey}-file`}>
              Import an image
            </label>
            <input
              ref={fileInput}
              id={`${paramKey}-file`}
              type="file"
              disabled={importing}
              onChange={(event) =>
                chooseFile(event.currentTarget.files?.[0] ?? null)
              }
            />
            {file !== null ? (
              <>
                <label className="text-sm" htmlFor={`${paramKey}-slug`}>
                  Asset name
                </label>
                <input
                  id={`${paramKey}-slug`}
                  type="text"
                  value={slug}
                  disabled={importing}
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                  onChange={(event) => setSlug(event.currentTarget.value)}
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={importing}
                  onClick={() => void confirmImport()}
                >
                  {importing ? "Importing…" : "Import Image Asset"}
                </Button>
              </>
            ) : null}
          </div>
          {failure !== null ? (
            <div role="alert" className="text-sm text-destructive">
              {failure}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
