import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ParamSchema,
  Params,
  SketchEnvironment,
} from "@harness/core";

import {
  ImageAssetResolutionError,
  imageAssetIdSetKey,
  requiredImageAssetIds,
  resolveSketchEnvironment,
} from "./imageAssetResolver";

export type SketchEnvironmentResolver = (
  schema: ParamSchema,
  params: Params,
  signal: AbortSignal,
) => Promise<SketchEnvironment>;

export interface UseSketchEnvironmentOptions {
  readonly schema: ParamSchema;
  readonly params: Params;
  readonly resolver?: SketchEnvironmentResolver;
}

export type SketchEnvironmentResolutionStatus =
  | "loading"
  | "resolved"
  | "missing"
  | "error";

export interface UseSketchEnvironmentResult {
  /** Explicit lifecycle for the current exact ID set and retry attempt. */
  readonly status: SketchEnvironmentResolutionStatus;
  /** Canonical identity of the current schema-declared Image Asset set. */
  readonly key: string;
  /** Descriptive alias for `key`, exposed to resolution-state consumers. */
  readonly resolutionKey: string;
  readonly requiredIds: readonly string[];
  /** True synchronously for asset-free inputs, or after this exact key resolves. */
  readonly ready: boolean;
  /** Present only when it was resolved for the exact current key. */
  readonly environment: SketchEnvironment | undefined;
  /** Bounded resolution failure for the current key; broader UX belongs to #335. */
  readonly error: ImageAssetResolutionError | null;
  /** Exact authored ID that failed, when the resolver can identify one. */
  readonly failedId: string | null;
  /** Start a fresh attempt for the same IDs without mutating authored params. */
  readonly retry: () => void;
}

const defaultResolver: SketchEnvironmentResolver = (schema, params, signal) =>
  resolveSketchEnvironment(schema, params, undefined, signal);

interface ResolutionState {
  readonly key: string;
  readonly generation: number;
  readonly environment?: SketchEnvironment;
  readonly error?: ImageAssetResolutionError;
  readonly failedId?: string;
}

function safeResolutionError(error: unknown): ImageAssetResolutionError {
  return error instanceof ImageAssetResolutionError
    ? error
    : new ImageAssetResolutionError("resolution-failed");
}

/**
 * Resolve the current schema-declared Image Asset set for main-thread consumers.
 *
 * Readiness is derived during render by matching the resolved record's key to
 * the current synchronous key. State from A is therefore unusable on the very
 * first render of B, before the replacement effect has had a chance to retire A.
 */
export function useSketchEnvironment({
  schema,
  params,
  resolver = defaultResolver,
}: UseSketchEnvironmentOptions): UseSketchEnvironmentResult {
  const requiredIds = requiredImageAssetIds(schema, params);
  const key = imageAssetIdSetKey(requiredIds);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const retry = useCallback(() => setRetryGeneration((value) => value + 1), []);
  const currentIdentityRef = useRef({ key, retryGeneration, generation: 1 });
  if (
    currentIdentityRef.current.key !== key ||
    currentIdentityRef.current.retryGeneration !== retryGeneration
  ) {
    currentIdentityRef.current = {
      key,
      retryGeneration,
      generation: currentIdentityRef.current.generation + 1,
    };
  }
  const generation = currentIdentityRef.current.generation;
  const [resolution, setResolution] = useState<ResolutionState | null>(null);

  useEffect(() => {
    if (requiredIds.length === 0) return;

    const controller = new AbortController();
    void resolver(schema, params, controller.signal).then(
      (environment) => {
        if (
          controller.signal.aborted ||
          currentIdentityRef.current.key !== key ||
          currentIdentityRef.current.generation !== generation
        ) {
          return;
        }
        setResolution({ key, generation, environment });
      },
      (error: unknown) => {
        if (
          controller.signal.aborted ||
          currentIdentityRef.current.key !== key ||
          currentIdentityRef.current.generation !== generation
        ) {
          return;
        }
        const safeError = safeResolutionError(error);
        const failedId =
          safeError.assetId ??
          (requiredIds.length === 1 ? requiredIds[0] : undefined);
        setResolution(
          failedId === undefined
            ? { key, generation, error: safeError }
            : { key, generation, error: safeError, failedId },
        );
      },
    );

    return () => controller.abort();
    // The exact ID-set key is the cache boundary. Same-key param, seed, Tone,
    // and Shading edits must retain the environment without re-fetching bytes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, key, resolver]);

  if (requiredIds.length === 0) {
    return {
      status: "resolved",
      key,
      resolutionKey: key,
      requiredIds,
      ready: true,
      environment: undefined,
      error: null,
      failedId: null,
      retry,
    };
  }

  const currentResolution =
    resolution?.key === key && resolution.generation === generation
      ? resolution
      : null;
  const environment = currentResolution?.environment;
  const error = currentResolution?.error ?? null;
  const status =
    environment !== undefined
      ? "resolved"
      : error?.code === "missing"
        ? "missing"
        : error === null
          ? "loading"
          : "error";
  return {
    status,
    key,
    resolutionKey: key,
    requiredIds,
    ready: environment !== undefined,
    environment,
    error,
    failedId: currentResolution?.failedId ?? null,
    retry,
  };
}
