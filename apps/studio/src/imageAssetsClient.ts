/**
 * Browser wire client for project-managed Image Assets.
 *
 * This module deliberately owns no local asset state. Every operation either
 * returns one fully validated server result or fails with a small, stable error
 * code; malformed lists are never filtered and failed imports are never
 * retried under a fallback slug.
 */
import {
  normalizeImageAssetSlug,
  parseImageAssetId,
} from "./imageAssetIdentity";

const API_PATH = "/__api/image-assets";
const PNG_MEDIA_TYPE = "image/png";

export type ImageAssetsClientOperation = "list" | "import";

export type ImageAssetsClientErrorCode =
  | "invalid-input"
  | "network"
  | "http-status"
  | "malformed-response";

const ERROR_MESSAGES: Readonly<Record<ImageAssetsClientErrorCode, string>> = {
  "invalid-input": "Image Asset request has invalid local input",
  network: "Image Asset network request failed",
  "http-status": "Image Asset server request failed",
  "malformed-response": "Image Asset server response is malformed",
};

/** A bounded, UI-safe failure from the managed Image Asset wire client. */
export class ImageAssetsClientError extends Error {
  readonly code: ImageAssetsClientErrorCode;
  readonly operation: ImageAssetsClientOperation;
  readonly status: number | undefined;

  constructor(
    code: ImageAssetsClientErrorCode,
    operation: ImageAssetsClientOperation,
    options: { readonly status?: number } = {},
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "ImageAssetsClientError";
    this.code = code;
    this.operation = operation;
    this.status = options.status;
  }
}

/** One validated managed asset ready for picker display. */
export interface ManagedImageAsset {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

/** The validated result of an immutable import. */
export interface ImportImageAssetResult {
  readonly id: string;
  readonly created: boolean;
}

function malformedResponse(
  operation: ImageAssetsClientOperation,
): ImageAssetsClientError {
  return new ImageAssetsClientError("malformed-response", operation);
}

async function request(
  operation: ImageAssetsClientOperation,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ImageAssetsClientError("network", operation);
  }

  if (!response.ok) {
    throw new ImageAssetsClientError("http-status", operation, {
      status: response.status,
    });
  }
  return response;
}

async function responseJson(
  response: Response,
  operation: ImageAssetsClientOperation,
): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ImageAssetsClientError("network", operation);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw malformedResponse(operation);
  }
}

/**
 * List every persisted Image Asset as validated, display-ready records.
 *
 * The client sorts defensively instead of relying on middleware ordering.
 */
export async function listImageAssets(): Promise<ManagedImageAsset[]> {
  const operation = "list";
  const response = await request(operation, API_PATH);
  const data = await responseJson(response, operation);

  if (!Array.isArray(data)) throw malformedResponse(operation);

  const assets = data.map((value: unknown): ManagedImageAsset => {
    if (typeof value !== "string") throw malformedResponse(operation);

    const parsed = parseImageAssetId(value);
    if (parsed === null) throw malformedResponse(operation);

    return {
      id: value,
      name: parsed.slug.replaceAll("-", " "),
      url: `/image-assets/${value}.png`,
    };
  });

  return assets.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

function canonicalImportSlug(slugDraft: string): string {
  if (typeof slugDraft !== "string") {
    throw new ImageAssetsClientError("invalid-input", "import");
  }

  // The identity helper is the canonical policy, including its readable
  // `image` fallback for names without ASCII letters or digits.
  return normalizeImageAssetSlug(slugDraft);
}

function validateNormalizedPng(normalizedPng: Blob): void {
  if (
    !(normalizedPng instanceof Blob) ||
    normalizedPng.type !== PNG_MEDIA_TYPE ||
    normalizedPng.size === 0
  ) {
    throw new ImageAssetsClientError("invalid-input", "import");
  }
}

/**
 * Import normalized PNG bytes beneath the canonical form of `slugDraft`.
 *
 * The PNG Blob is the raw request body: source-file bytes and metadata never
 * enter the managed-asset API.
 */
export async function importImageAsset(
  slugDraft: string,
  normalizedPng: Blob,
): Promise<ImportImageAssetResult> {
  const slug = canonicalImportSlug(slugDraft);
  validateNormalizedPng(normalizedPng);

  const operation = "import";
  const response = await request(
    operation,
    `${API_PATH}/${encodeURIComponent(slug)}`,
    {
      method: "POST",
      headers: { "Content-Type": PNG_MEDIA_TYPE },
      body: normalizedPng,
    },
  );
  const data = await responseJson(response, operation);

  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    !("id" in data) ||
    typeof data.id !== "string" ||
    parseImageAssetId(data.id) === null ||
    !("created" in data) ||
    typeof data.created !== "boolean"
  ) {
    throw malformedResponse(operation);
  }

  return { id: data.id, created: data.created };
}
