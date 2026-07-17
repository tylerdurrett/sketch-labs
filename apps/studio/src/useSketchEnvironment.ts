import { useEffect, useRef, useState } from "react";

import type {
  ParamSchema,
  Params,
  SketchEnvironment,
} from "@harness/core";

import {
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

export interface UseSketchEnvironmentResult {
  /** Canonical identity of the current schema-declared Image Asset set. */
  readonly key: string;
  readonly requiredIds: readonly string[];
  /** True synchronously for asset-free inputs, or after this exact key resolves. */
  readonly ready: boolean;
  /** Present only when it was resolved for the exact current key. */
  readonly environment: SketchEnvironment | undefined;
  /** Bounded resolution failure for the current key; broader UX belongs to #335. */
  readonly error: Error | null;
}

const defaultResolver: SketchEnvironmentResolver = (schema, params, signal) =>
  resolveSketchEnvironment(schema, params, undefined, signal);

interface ResolutionState {
  readonly key: string;
  readonly generation: number;
  readonly environment?: SketchEnvironment;
  readonly error?: Error;
}

function safeResolutionError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Image Asset resolution failed");
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
  const currentIdentityRef = useRef({ key, generation: 1 });
  if (currentIdentityRef.current.key !== key) {
    currentIdentityRef.current = {
      key,
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
        setResolution({ key, generation, error: safeResolutionError(error) });
      },
    );

    return () => controller.abort();
    // The exact ID-set key is the cache boundary. Same-key param, seed, Tone,
    // and Scribble edits must retain the environment without re-fetching bytes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, key, resolver]);

  if (requiredIds.length === 0) {
    return {
      key,
      requiredIds,
      ready: true,
      environment: undefined,
      error: null,
    };
  }

  const currentResolution =
    resolution?.key === key && resolution.generation === generation
      ? resolution
      : null;
  const environment = currentResolution?.environment;
  return {
    key,
    requiredIds,
    ready: environment !== undefined,
    environment,
    error: currentResolution?.error ?? null,
  };
}
