export const DEFAULT_ETA_MIN_ELAPSED_MS = 1_000;
export const DEFAULT_ETA_WINDOW_MS = 5_000;

export interface RollingEtaOptions {
  /** Real observation time required before the first rate is exposed. */
  readonly minElapsedMs?: number;
  /** Recent observation window used to revise the weighted-work rate. */
  readonly windowMs?: number;
}

/** One cumulative weighted-work observation, timed by the caller's clock. */
export interface RollingEtaSample {
  readonly timestampMs: number;
  readonly completedWork: number;
  readonly totalWork: number;
}

export type RollingEtaEstimate =
  | { readonly kind: "estimating"; readonly revision: number }
  | {
      readonly kind: "remaining";
      readonly revision: number;
      /** Finite, non-negative estimated milliseconds remaining. */
      readonly remainingMs: number;
    };

export interface RollingEtaEstimator {
  readonly estimate: RollingEtaEstimate;
  /** Observe a sample and return the current estimate. Invalid samples are ignored. */
  observe(sample: RollingEtaSample): RollingEtaEstimate;
}

interface ResolvedOptions {
  readonly minElapsedMs: number;
  readonly windowMs: number;
}

function resolveOptions(options: RollingEtaOptions): ResolvedOptions {
  const minElapsedMs = options.minElapsedMs ?? DEFAULT_ETA_MIN_ELAPSED_MS;
  const windowMs = options.windowMs ?? DEFAULT_ETA_WINDOW_MS;

  if (!Number.isFinite(minElapsedMs) || minElapsedMs < 0) {
    throw new RangeError("minElapsedMs must be finite and non-negative");
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError("windowMs must be finite and positive");
  }

  return { minElapsedMs, windowMs };
}

function validSample(sample: RollingEtaSample): boolean {
  return (
    Number.isFinite(sample.timestampMs) &&
    Number.isFinite(sample.completedWork) &&
    Number.isFinite(sample.totalWork) &&
    sample.completedWork >= 0 &&
    sample.totalWork >= 0
  );
}

/**
 * Create the current job's rolling ETA estimator.
 *
 * The estimator owns no clock: all time enters through samples, keeping the
 * calculation deterministic and straightforward to test. A fresh estimator is
 * required for every job so throughput from one Scene never predicts another.
 */
export function createRollingEtaEstimator(
  options: RollingEtaOptions = {},
): RollingEtaEstimator {
  const { minElapsedMs, windowMs } = resolveOptions(options);
  let samples: RollingEtaSample[] = [];
  let estimate: RollingEtaEstimate = { kind: "estimating", revision: 0 };

  return {
    get estimate() {
      return estimate;
    },

    observe(sample) {
      if (!validSample(sample)) return estimate;

      const previous = samples.at(-1);
      if (previous !== undefined) {
        if (
          sample.totalWork !== previous.totalWork ||
          sample.timestampMs <= previous.timestampMs ||
          sample.completedWork <= previous.completedWork
        ) {
          return estimate;
        }
      }

      const accepted = { ...sample };
      samples.push(accepted);
      const revision = estimate.revision + 1;

      if (accepted.totalWork === 0 || accepted.completedWork >= accepted.totalWork) {
        estimate = { kind: "remaining", revision, remainingMs: 0 };
        return estimate;
      }

      const first = samples[0]!;
      const elapsedMs = accepted.timestampMs - first.timestampMs;
      const observedWork = accepted.completedWork - first.completedWork;
      if (elapsedMs < minElapsedMs || observedWork <= 0) {
        estimate = { kind: "estimating", revision };
        return estimate;
      }

      const cutoff = accepted.timestampMs - windowMs;
      let baselineIndex = samples.findIndex(
        (candidate) => candidate.timestampMs >= cutoff,
      );
      if (baselineIndex < 0) baselineIndex = samples.length - 1;
      // Keep the last sample before the window as a rate baseline. This avoids
      // losing the estimate when valid progress reports are farther apart than
      // the configured window, while newer reports naturally displace it.
      if (
        baselineIndex > 0 &&
        samples[baselineIndex]!.timestampMs > cutoff
      ) {
        baselineIndex -= 1;
      }
      const baseline = samples[baselineIndex]!;
      const rateElapsedMs = accepted.timestampMs - baseline.timestampMs;
      const rateWork = accepted.completedWork - baseline.completedWork;
      const rate = rateWork / rateElapsedMs;
      const remainingMs = (accepted.totalWork - accepted.completedWork) / rate;

      // Retain only the baseline and current window; memory remains bounded by
      // progress-message frequency rather than total job duration.
      samples = samples.slice(baselineIndex);

      estimate =
        rateElapsedMs > 0 && rateWork > 0 && Number.isFinite(remainingMs)
          ? { kind: "remaining", revision, remainingMs: Math.max(0, remainingMs) }
          : { kind: "estimating", revision };
      return estimate;
    },
  };
}
