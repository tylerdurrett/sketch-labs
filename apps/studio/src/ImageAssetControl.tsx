import { useEffect, useRef, useState } from "react";

import { Button } from "./components/ui/button";
import {
  IMAGE_ASSET_MAX_SLUG_LENGTH,
  imageAssetDisplayName,
  imageAssetUrl,
  isImageAssetSlugDraftWithinLimit,
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
import type { SketchEnvironmentResolutionStatus } from "./useSketchEnvironment";

type FailurePhase = "list" | "normalize" | "import";

/** Exact-resolution state shared by every schema-derived Image Asset row. */
export interface ImageAssetControlResolution {
  readonly status: SketchEnvironmentResolutionStatus;
  readonly failedId: string | null;
  /** Retry resolution without authoring a new param value. */
  readonly retry: () => void;
}

/** Decoded pixel dimensions presented for one exact Image Asset selection. */
export interface ImageAssetControlDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * A row-scoped presentation snapshot requesting an image-aspect recompose.
 *
 * The receiver must reread the current environment before mutating authored
 * state; neither the selected ID nor dimensions are authoritative here.
 */
export interface ImageAssetControlRecomposeRequest {
  readonly paramKey: string;
  readonly imageAssetId: string;
  readonly dimensions: ImageAssetControlDimensions;
}

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
  /** Resolution lifecycle for the current exact schema-declared asset set. */
  resolution?: ImageAssetControlResolution | undefined;
  /** Decoded dimensions presented for this row's exact selected asset. */
  imageDimensions?: ImageAssetControlDimensions | null | undefined;
  /** Request recomposition from this row's non-authoritative snapshot. */
  onRecomposeToImageAspect?:
    | ((request: ImageAssetControlRecomposeRequest) => void)
    | undefined;
}

function hasValidDimensions(
  dimensions: ImageAssetControlDimensions | null | undefined,
): dimensions is ImageAssetControlDimensions {
  return (
    dimensions !== null &&
    dimensions !== undefined &&
    Number.isSafeInteger(dimensions.width) &&
    dimensions.width > 0 &&
    Number.isSafeInteger(dimensions.height) &&
    dimensions.height > 0
  );
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
  let guidance = " Try again.";
  if (error instanceof ImageAssetsClientError) {
    switch (error.code) {
      case "slug-too-long":
        guidance = ` Shorten the name to ${IMAGE_ASSET_MAX_SLUG_LENGTH} characters or fewer.`;
        break;
      case "conflict":
        guidance = " Choose a different name or image.";
        break;
      case "payload-too-large":
        guidance = " Choose a smaller image.";
        break;
      case "invalid-request":
        guidance = " Choose a different image.";
        break;
    }
  }
  return `${lead}${detail === null ? "" : ` ${detail}`}${guidance}`;
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
  resolution,
  imageDimensions,
  onRecomposeToImageAspect,
}: ImageAssetControlProps) {
  const displayName = imageAssetDisplayName(value);
  const url = imageAssetUrl(value);
  const resolutionStatus = resolution?.status ?? "resolved";
  const failureAffectsValue =
    resolution?.failedId === null || resolution?.failedId === value;
  const presentationStatus =
    (resolutionStatus === "missing" || resolutionStatus === "error") &&
    !failureAffectsValue
      ? "resolved"
      : resolutionStatus;
  const showThumbnail =
    presentationStatus === "resolved" && url !== null && displayName !== null;
  const canRecompose =
    presentationStatus === "resolved" &&
    hasValidDimensions(imageDimensions) &&
    onRecomposeToImageAspect !== undefined;
  const recomposeUnavailableReason = canRecompose
    ? null
    : presentationStatus === "loading"
      ? "Recompose is unavailable while the exact Image Asset is loading."
      : presentationStatus === "missing"
        ? "Recompose is unavailable because the exact Image Asset is missing."
        : presentationStatus === "error"
          ? "Recompose is unavailable because the exact Image Asset could not be resolved."
          : !hasValidDimensions(imageDimensions)
            ? "Recompose is unavailable because decoded image dimensions are unavailable."
            : "Recompose is unavailable in this context.";
  const recomposeUnavailableId = `${paramKey}-image-asset-recompose-unavailable`;
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
  const controlledValue = useRef({ value, revision: 0 });
  const committedValue = useRef(value);

  if (controlledValue.current.value !== value) {
    controlledValue.current = {
      value,
      revision: controlledValue.current.revision + 1,
    };
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      catalogToken.current += 1;
      importToken.current += 1;
    };
  }, []);

  useEffect(() => {
    if (committedValue.current === value) return;
    committedValue.current = value;
    // Undo, Redo, and preset reloads are newer controlled intent. Leave the
    // selected file available for retry, but stop presenting the older import
    // as busy and prevent its result from changing selection or the catalog.
    importToken.current += 1;
    setImporting(false);
  }, [value]);

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
    setFile(next);
    const proposedSlug = next === null ? "" : proposeImageAssetSlug(next.name);
    setSlug(proposedSlug);
    setFailure(
      next !== null && !isImageAssetSlugDraftWithinLimit(proposedSlug)
        ? failureMessage(
            "import",
            new ImageAssetsClientError("slug-too-long", "import"),
          )
        : null,
    );
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
    if (!isImageAssetSlugDraftWithinLimit(slug)) {
      setFailure(
        failureMessage(
          "import",
          new ImageAssetsClientError("slug-too-long", "import"),
        ),
      );
      return;
    }
    const selectedFile = file;
    const slugDraft = slug;
    const token = ++importToken.current;
    const confirmedValue = controlledValue.current;
    setImporting(true);
    setFailure(null);

    const isCurrent = (): boolean =>
      mounted.current &&
      importToken.current === token &&
      controlledValue.current.value === confirmedValue.value &&
      controlledValue.current.revision === confirmedValue.revision;

    let normalized: Awaited<ReturnType<typeof normalizeImageAsset>>;
    try {
      normalized = await normalizeImageAsset(selectedFile, {
        maxLongEdge: imageAssetLongEdgeCap,
      });
    } catch (error) {
      if (!isCurrent()) return;
      setImporting(false);
      setFailure(failureMessage("normalize", error));
      return;
    }
    if (!isCurrent()) return;

    try {
      const result = await importImageAsset(slugDraft, normalized.png);
      if (!isCurrent()) return;
      onChange(result.id);
      setFile(null);
      setSlug("");
      if (fileInput.current !== null) fileInput.current.value = "";
      setImporting(false);
      await refreshCatalog();
    } catch (error) {
      if (!isCurrent()) return;
      setImporting(false);
      setFailure(failureMessage("import", error));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        {showThumbnail ? (
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
          {presentationStatus === "loading" ? (
            <div role="status" className="text-sm text-muted-foreground">
              Loading exact Image Asset…
            </div>
          ) : presentationStatus === "missing" ? (
            <div role="alert" className="text-sm text-destructive">
              Image Asset is missing. The exact selected ID remains active.
            </div>
          ) : presentationStatus === "error" ? (
            <div role="alert" className="text-sm text-destructive">
              Image Asset is unavailable. The exact selected ID remains active.
            </div>
          ) : null}
        </div>
        {presentationStatus === "missing" ||
        presentationStatus === "error" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={resolution?.retry}
          >
            Retry exact asset
          </Button>
        ) : null}
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

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        disabled={!canRecompose}
        aria-describedby={
          recomposeUnavailableReason === null
            ? undefined
            : recomposeUnavailableId
        }
        onClick={() => {
          if (!canRecompose) return;
          onRecomposeToImageAspect({
            paramKey,
            imageAssetId: value,
            dimensions: {
              width: imageDimensions.width,
              height: imageDimensions.height,
            },
          });
        }}
      >
        Recompose to this image’s aspect
      </Button>
      {recomposeUnavailableReason !== null ? (
        <span id={recomposeUnavailableId} className="sr-only">
          {recomposeUnavailableReason}
        </span>
      ) : null}

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
                  maxLength={IMAGE_ASSET_MAX_SLUG_LENGTH}
                  aria-describedby={`${paramKey}-slug-help`}
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                  onChange={(event) => {
                    const nextSlug = event.currentTarget.value;
                    setSlug(nextSlug);
                    setFailure(
                      isImageAssetSlugDraftWithinLimit(nextSlug)
                        ? null
                        : failureMessage(
                            "import",
                            new ImageAssetsClientError(
                              "slug-too-long",
                              "import",
                            ),
                          ),
                    );
                  }}
                />
                <div
                  id={`${paramKey}-slug-help`}
                  className="text-xs text-muted-foreground"
                >
                  Up to {IMAGE_ASSET_MAX_SLUG_LENGTH} characters.
                </div>
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    importing || !isImageAssetSlugDraftWithinLimit(slug)
                  }
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
