/**
 * Deterministic adjacent-region hierarchy for Watercolor Forms.
 *
 * Candidate affinity explicitly combines visible color/luminance similarity,
 * weakness of the complete shared boundary, pressure to absorb small forms,
 * and resistance to an imbalanced or immediately repeated merge. The highest
 * affinity is consumed first. Recorded similarity is clamped to the preceding
 * merge, so the derived merge height (`1 - similarity`) is monotonic.
 *
 * The queue uses lazy invalidation: contractions enqueue fresh candidates and
 * old entries are rejected by region revision. Every exact tie is resolved by
 * the pair's ascending canonical leaf IDs, independent of Map or boundary
 * insertion order.
 */

import { WATERCOLOR_FORMS_LIMITS } from "./limits";
import type { WatercolorFormsLimitName } from "./limits";
import type {
  InitialRegionPartition,
  RegionHierarchy,
  SharedBoundarySegment,
  WatercolorRegionMerge,
  WatercolorRegionSummary,
} from "./types";

const VISIBLE_SIMILARITY_WEIGHT = 0.45;
const BOUNDARY_WEAKNESS_WEIGHT = 0.25;
const REGION_SIZE_PRESSURE_WEIGHT = 0.2;
const MERGE_STABILITY_WEIGHT = 0.1;

const DEFAULT_COLOR_SENSITIVITY = 0.5;
const MIN_COLOR_DISTANCE_SCALE = 0.75;
const COLOR_SENSITIVITY_DISTANCE_SCALE = 1.25;

interface BoundaryEvidence {
  readonly strengthLengthSum: number;
  readonly length: number;
}

interface ActiveRegion {
  readonly summary: Readonly<WatercolorRegionSummary>;
  readonly canonicalLeafId: number;
  readonly mergeHeight: number;
  readonly revision: number;
  readonly neighbors: Map<number, BoundaryEvidence>;
  active: boolean;
}

interface MergeScore {
  readonly similarity: number;
  readonly boundaryStrength: number;
  readonly stability: number;
}

interface MergeCandidate extends MergeScore {
  readonly firstRegionId: number;
  readonly secondRegionId: number;
  readonly firstRevision: number;
  readonly secondRevision: number;
  readonly firstCanonicalLeafId: number;
  readonly secondCanonicalLeafId: number;
}

interface HierarchyWorkLimits {
  readonly maxMergeCount: number;
  readonly maxMergeQueueEntryCount: number;
  readonly maxRegionUpdateCount: number;
}

interface HierarchyBuildOptions {
  readonly limits: Readonly<HierarchyWorkLimits>;
}

export interface WatercolorFormsHierarchyBuildDiagnostics {
  readonly limitedBy: WatercolorFormsLimitName | null;
  readonly mergeQueueEntryCount: number;
  readonly regionUpdateCount: number;
}

export interface WatercolorFormsHierarchyBuildResult {
  readonly hierarchy: Readonly<RegionHierarchy>;
  readonly diagnostics: Readonly<WatercolorFormsHierarchyBuildDiagnostics>;
}

const DEFAULT_WORK_LIMITS: Readonly<HierarchyWorkLimits> = Object.freeze({
  maxMergeCount: WATERCOLOR_FORMS_LIMITS.maxMergeCount,
  maxMergeQueueEntryCount: WATERCOLOR_FORMS_LIMITS.maxMergeQueueEntryCount,
  maxRegionUpdateCount: WATERCOLOR_FORMS_LIMITS.maxRegionUpdateCount,
});

const EMPTY_OPTIONS: Readonly<HierarchyBuildOptions> = Object.freeze({
  limits: DEFAULT_WORK_LIMITS,
});

function clampUnit(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function finiteLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeColorSensitivity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_COLOR_SENSITIVITY;
  return clampUnit(value);
}

type PerceptualColor = readonly [number, number, number];

function linearRgbToPerceptual(
  red: number,
  green: number,
  blue: number,
): PerceptualColor {
  const long = Math.cbrt(
    0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue,
  );
  const medium = Math.cbrt(
    0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue,
  );
  const short = Math.cbrt(
    0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue,
  );

  return [
    0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
  ];
}

function visibleDifference(
  first: Readonly<WatercolorRegionSummary>,
  second: Readonly<WatercolorRegionSummary>,
): number {
  const firstColor = linearRgbToPerceptual(
    first.meanLinearRed,
    first.meanLinearGreen,
    first.meanLinearBlue,
  );
  const secondColor = linearRgbToPerceptual(
    second.meanLinearRed,
    second.meanLinearGreen,
    second.meanLinearBlue,
  );
  const chromaticDistance = Math.hypot(
    firstColor[0] - secondColor[0],
    firstColor[1] - secondColor[1],
    firstColor[2] - secondColor[2],
  );
  const luminanceDistance = Math.abs(
    first.meanLuminance - second.meanLuminance,
  );
  return clampUnit(Math.max(chromaticDistance, luminanceDistance));
}

function boundaryLength(segment: Readonly<SharedBoundarySegment>): number {
  return Math.hypot(
    segment.end[0] - segment.start[0],
    segment.end[1] - segment.start[1],
  );
}

function pairKey(firstRegionId: number, secondRegionId: number): string {
  return `${firstRegionId}:${secondRegionId}`;
}

function canonicalBoundaryGraph(
  partition: Readonly<InitialRegionPartition>,
  activeRegions: ReadonlyMap<number, ActiveRegion>,
): readonly (readonly [number, number, BoundaryEvidence])[] {
  const evidenceByPair = new Map<
    string,
    {
      firstRegionId: number;
      secondRegionId: number;
      strengthLengthSum: number;
      length: number;
    }
  >();

  const canonicalSegments = [...partition.sharedBoundarySegments].sort(
    (first, second) => {
      const firstLow = Math.min(...first.regionIds);
      const firstHigh = Math.max(...first.regionIds);
      const secondLow = Math.min(...second.regionIds);
      const secondHigh = Math.max(...second.regionIds);
      return (
        firstLow - secondLow ||
        firstHigh - secondHigh ||
        first.id - second.id ||
        Math.min(first.start[0], first.end[0]) -
          Math.min(second.start[0], second.end[0]) ||
        Math.min(first.start[1], first.end[1]) -
          Math.min(second.start[1], second.end[1]) ||
        Math.max(first.start[0], first.end[0]) -
          Math.max(second.start[0], second.end[0]) ||
        Math.max(first.start[1], first.end[1]) -
          Math.max(second.start[1], second.end[1]) ||
        first.strength - second.strength
      );
    },
  );

  for (const segment of canonicalSegments) {
    const firstRegionId = Math.min(segment.regionIds[0], segment.regionIds[1]);
    const secondRegionId = Math.max(segment.regionIds[0], segment.regionIds[1]);
    // Negative IDs represent exact-zero support, not mergeable regions.
    if (
      firstRegionId < 0 ||
      firstRegionId === secondRegionId ||
      !activeRegions.has(firstRegionId) ||
      !activeRegions.has(secondRegionId)
    ) {
      continue;
    }

    const length = boundaryLength(segment);
    if (!Number.isFinite(length) || length <= 0) continue;
    const key = pairKey(firstRegionId, secondRegionId);
    const existing = evidenceByPair.get(key);
    if (existing === undefined) {
      evidenceByPair.set(key, {
        firstRegionId,
        secondRegionId,
        strengthLengthSum: clampUnit(segment.strength) * length,
        length,
      });
    } else {
      existing.strengthLengthSum += clampUnit(segment.strength) * length;
      existing.length += length;
    }
  }

  return [...evidenceByPair.values()]
    .sort(
      (first, second) =>
        first.firstRegionId - second.firstRegionId ||
        first.secondRegionId - second.secondRegionId,
    )
    .map((entry) => [
      entry.firstRegionId,
      entry.secondRegionId,
      Object.freeze({
        strengthLengthSum: entry.strengthLengthSum,
        length: entry.length,
      }),
    ]);
}

function mergeScore(
  first: Readonly<ActiveRegion>,
  second: Readonly<ActiveRegion>,
  boundary: Readonly<BoundaryEvidence>,
  totalSampleCount: number,
  colorSensitivity: number,
): MergeScore {
  const distanceScale =
    MIN_COLOR_DISTANCE_SCALE +
    COLOR_SENSITIVITY_DISTANCE_SCALE * colorSensitivity;
  const visibleSimilarity =
    1 -
    clampUnit(visibleDifference(first.summary, second.summary) * distanceScale);
  const boundaryStrength = clampUnit(
    boundary.strengthLengthSum / boundary.length,
  );
  const boundaryWeakness = 1 - boundaryStrength;
  const combinedSampleCount =
    first.summary.sampleCount + second.summary.sampleCount;
  const regionSizePressure =
    totalSampleCount <= 0
      ? 0
      : 1 - clampUnit(combinedSampleCount / totalSampleCount);
  const sizeBalance =
    combinedSampleCount <= 0
      ? 0
      : (2 * Math.min(first.summary.sampleCount, second.summary.sampleCount)) /
        combinedSampleCount;
  const childPersistence =
    1 - clampUnit(Math.max(first.mergeHeight, second.mergeHeight));
  const stabilityAffinity = (sizeBalance + childPersistence) / 2;
  // Exposed stability is resistance, matching the RegionMerge contract.
  const stability = 1 - stabilityAffinity;
  const similarity = clampUnit(
    VISIBLE_SIMILARITY_WEIGHT * visibleSimilarity +
      BOUNDARY_WEAKNESS_WEIGHT * boundaryWeakness +
      REGION_SIZE_PRESSURE_WEIGHT * regionSizePressure +
      MERGE_STABILITY_WEIGHT * stabilityAffinity,
  );

  return { similarity, boundaryStrength, stability };
}

function compareCandidates(
  first: Readonly<MergeCandidate>,
  second: Readonly<MergeCandidate>,
): number {
  return (
    first.similarity - second.similarity ||
    second.firstCanonicalLeafId - first.firstCanonicalLeafId ||
    second.secondCanonicalLeafId - first.secondCanonicalLeafId ||
    second.firstRegionId - first.firstRegionId ||
    second.secondRegionId - first.secondRegionId
  );
}

class CandidateHeap {
  readonly #entries: MergeCandidate[] = [];

  get size(): number {
    return this.#entries.length;
  }

  push(candidate: MergeCandidate): void {
    let index = this.#entries.length;
    this.#entries.push(candidate);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (
        compareCandidates(this.#entries[parent]!, this.#entries[index]!) >= 0
      ) {
        break;
      }
      [this.#entries[parent], this.#entries[index]] = [
        this.#entries[index]!,
        this.#entries[parent]!,
      ];
      index = parent;
    }
  }

  pop(): MergeCandidate | undefined {
    const first = this.#entries[0];
    const last = this.#entries.pop();
    if (first === undefined || last === undefined) return first;
    if (this.#entries.length === 0) return first;
    this.#entries[0] = last;

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let largest = index;
      if (
        left < this.#entries.length &&
        compareCandidates(this.#entries[left]!, this.#entries[largest]!) > 0
      ) {
        largest = left;
      }
      if (
        right < this.#entries.length &&
        compareCandidates(this.#entries[right]!, this.#entries[largest]!) > 0
      ) {
        largest = right;
      }
      if (largest === index) break;
      [this.#entries[index], this.#entries[largest]] = [
        this.#entries[largest]!,
        this.#entries[index]!,
      ];
      index = largest;
    }

    return first;
  }
}

function orderedPair(
  first: Readonly<ActiveRegion>,
  second: Readonly<ActiveRegion>,
): readonly [ActiveRegion, ActiveRegion] {
  return first.canonicalLeafId < second.canonicalLeafId ||
    (first.canonicalLeafId === second.canonicalLeafId &&
      first.summary.id < second.summary.id)
    ? [first, second]
    : [second, first];
}

function candidateFor(
  first: Readonly<ActiveRegion>,
  second: Readonly<ActiveRegion>,
  boundary: Readonly<BoundaryEvidence>,
  totalSampleCount: number,
  colorSensitivity: number,
): MergeCandidate {
  const [orderedFirst, orderedSecond] = orderedPair(first, second);
  return {
    firstRegionId: orderedFirst.summary.id,
    secondRegionId: orderedSecond.summary.id,
    firstRevision: orderedFirst.revision,
    secondRevision: orderedSecond.revision,
    firstCanonicalLeafId: orderedFirst.canonicalLeafId,
    secondCanonicalLeafId: orderedSecond.canonicalLeafId,
    ...mergeScore(
      orderedFirst,
      orderedSecond,
      boundary,
      totalSampleCount,
      colorSensitivity,
    ),
  };
}

function candidateIsCurrent(
  candidate: Readonly<MergeCandidate>,
  activeRegions: ReadonlyMap<number, ActiveRegion>,
): boolean {
  const first = activeRegions.get(candidate.firstRegionId);
  const second = activeRegions.get(candidate.secondRegionId);
  return (
    first !== undefined &&
    second !== undefined &&
    first.active &&
    second.active &&
    first.revision === candidate.firstRevision &&
    second.revision === candidate.secondRevision &&
    first.neighbors.has(second.summary.id) &&
    second.neighbors.has(first.summary.id)
  );
}

function mergedSummary(
  id: number,
  first: Readonly<WatercolorRegionSummary>,
  second: Readonly<WatercolorRegionSummary>,
): Readonly<WatercolorRegionSummary> {
  const visibleSampleCount =
    first.visibleSampleCount + second.visibleSampleCount;
  const visibleMean = (firstValue: number, secondValue: number): number =>
    visibleSampleCount === 0
      ? 0
      : (firstValue * first.visibleSampleCount +
          secondValue * second.visibleSampleCount) /
        visibleSampleCount;

  return Object.freeze({
    id,
    sampleCount: first.sampleCount + second.sampleCount,
    visibleSampleCount,
    meanLinearRed: visibleMean(first.meanLinearRed, second.meanLinearRed),
    meanLinearGreen: visibleMean(first.meanLinearGreen, second.meanLinearGreen),
    meanLinearBlue: visibleMean(first.meanLinearBlue, second.meanLinearBlue),
    meanLuminance: visibleMean(first.meanLuminance, second.meanLuminance),
    meanAlpha: visibleMean(first.meanAlpha, second.meanAlpha),
  });
}

function combinedBoundary(
  first: Readonly<BoundaryEvidence> | undefined,
  second: Readonly<BoundaryEvidence> | undefined,
): BoundaryEvidence {
  return Object.freeze({
    strengthLengthSum:
      (first?.strengthLengthSum ?? 0) + (second?.strengthLengthSum ?? 0),
    length: (first?.length ?? 0) + (second?.length ?? 0),
  });
}

function buildHierarchy(
  partition: Readonly<InitialRegionPartition>,
  colorSensitivityInput: number,
  options: Readonly<HierarchyBuildOptions>,
): WatercolorFormsHierarchyBuildResult {
  const initialRegions = [...partition.regions].sort(
    (first, second) => first.id - second.id,
  );
  const regions: Readonly<WatercolorRegionSummary>[] = [...initialRegions];
  const merges: Readonly<WatercolorRegionMerge>[] = [];
  const activeRegions = new Map<number, ActiveRegion>();
  const totalSampleCount = initialRegions.reduce(
    (sum, region) => sum + region.sampleCount,
    0,
  );
  const colorSensitivity = normalizeColorSensitivity(colorSensitivityInput);

  for (const summary of initialRegions) {
    activeRegions.set(summary.id, {
      summary,
      canonicalLeafId: summary.id,
      mergeHeight: 0,
      revision: 0,
      neighbors: new Map(),
      active: true,
    });
  }

  const initialEdges = canonicalBoundaryGraph(partition, activeRegions);
  for (const [firstRegionId, secondRegionId, boundary] of initialEdges) {
    activeRegions.get(firstRegionId)!.neighbors.set(secondRegionId, boundary);
    activeRegions.get(secondRegionId)!.neighbors.set(firstRegionId, boundary);
  }

  const queue = new CandidateHeap();
  let mergeQueueEntryCount = 0;
  let regionUpdateCount = 0;
  let complete = true;
  let limitedBy: WatercolorFormsLimitName | null = null;
  if (initialEdges.length > options.limits.maxMergeQueueEntryCount) {
    complete = false;
    limitedBy = "maxMergeQueueEntryCount";
  } else {
    for (const [firstRegionId, secondRegionId, boundary] of initialEdges) {
      queue.push(
        candidateFor(
          activeRegions.get(firstRegionId)!,
          activeRegions.get(secondRegionId)!,
          boundary,
          totalSampleCount,
          colorSensitivity,
        ),
      );
      mergeQueueEntryCount += 1;
    }
  }

  let nextRegionId =
    initialRegions.reduce(
      (maximum, region) => Math.max(maximum, region.id),
      -1,
    ) + 1;
  let previousSimilarity = 1;

  while (complete && queue.size > 0) {
    const candidate = queue.pop()!;
    if (!candidateIsCurrent(candidate, activeRegions)) continue;

    const first = activeRegions.get(candidate.firstRegionId)!;
    const second = activeRegions.get(candidate.secondRegionId)!;
    const neighborIds = [
      ...new Set([...first.neighbors.keys(), ...second.neighbors.keys()]),
    ]
      .filter(
        (regionId) =>
          regionId !== first.summary.id &&
          regionId !== second.summary.id &&
          activeRegions.get(regionId)?.active === true,
      )
      .sort((firstId, secondId) => {
        const firstNeighbor = activeRegions.get(firstId)!;
        const secondNeighbor = activeRegions.get(secondId)!;
        return (
          firstNeighbor.canonicalLeafId - secondNeighbor.canonicalLeafId ||
          firstId - secondId
        );
      });
    const requiredWork = neighborIds.length;
    if (merges.length >= options.limits.maxMergeCount) {
      complete = false;
      limitedBy = "maxMergeCount";
      break;
    }
    if (
      mergeQueueEntryCount + requiredWork >
      options.limits.maxMergeQueueEntryCount
    ) {
      complete = false;
      limitedBy = "maxMergeQueueEntryCount";
      break;
    }
    if (
      regionUpdateCount + requiredWork >
      options.limits.maxRegionUpdateCount
    ) {
      complete = false;
      limitedBy = "maxRegionUpdateCount";
      break;
    }

    const similarity = Math.min(previousSimilarity, candidate.similarity);
    const mergeHeight = 1 - similarity;
    const summary = mergedSummary(nextRegionId, first.summary, second.summary);
    nextRegionId += 1;
    const merged: ActiveRegion = {
      summary,
      canonicalLeafId: Math.min(first.canonicalLeafId, second.canonicalLeafId),
      mergeHeight,
      revision: Math.max(first.revision, second.revision) + 1,
      neighbors: new Map(),
      active: true,
    };

    first.active = false;
    second.active = false;
    activeRegions.delete(first.summary.id);
    activeRegions.delete(second.summary.id);
    activeRegions.set(summary.id, merged);

    for (const neighborId of neighborIds) {
      const neighbor = activeRegions.get(neighborId)!;
      const boundary = combinedBoundary(
        first.neighbors.get(neighborId),
        second.neighbors.get(neighborId),
      );
      neighbor.neighbors.delete(first.summary.id);
      neighbor.neighbors.delete(second.summary.id);
      neighbor.neighbors.set(summary.id, boundary);
      merged.neighbors.set(neighborId, boundary);
      regionUpdateCount += 1;
    }

    first.neighbors.clear();
    second.neighbors.clear();
    regions.push(summary);
    merges.push(
      Object.freeze({
        leftRegionId: first.summary.id,
        rightRegionId: second.summary.id,
        mergedRegion: summary,
        similarity,
        boundaryStrength: candidate.boundaryStrength,
        stability: candidate.stability,
      }),
    );
    previousSimilarity = similarity;

    for (const neighborId of neighborIds) {
      const neighbor = activeRegions.get(neighborId)!;
      queue.push(
        candidateFor(
          merged,
          neighbor,
          merged.neighbors.get(neighborId)!,
          totalSampleCount,
          colorSensitivity,
        ),
      );
      mergeQueueEntryCount += 1;
    }
  }

  const hierarchy = Object.freeze({
    partition,
    regions: Object.freeze(regions),
    merges: Object.freeze(merges),
    complete,
  });
  return Object.freeze({
    hierarchy,
    diagnostics: Object.freeze({
      limitedBy,
      mergeQueueEntryCount,
      regionUpdateCount,
    }),
  });
}

/** Build the bounded deterministic adjacency hierarchy for one partition. */
export function buildWatercolorFormsHierarchy(
  partition: Readonly<InitialRegionPartition>,
  colorSensitivity: number,
): RegionHierarchy {
  return buildHierarchy(partition, colorSensitivity, EMPTY_OPTIONS).hierarchy;
}

/**
 * Build the production hierarchy with exact bounded-work accounting.
 *
 * The ordinary builder remains the convenient stage API; orchestration uses
 * this narrow result seam so generator diagnostics never infer internal work.
 */
export function buildWatercolorFormsHierarchyWithDiagnostics(
  partition: Readonly<InitialRegionPartition>,
  colorSensitivity: number,
): WatercolorFormsHierarchyBuildResult {
  return buildHierarchy(partition, colorSensitivity, EMPTY_OPTIONS);
}

/**
 * @internal Test seam for proving safe prefix termination at deliberately tiny
 * budgets. Production always uses the limits derived from the analysis lattice.
 */
export function buildWatercolorFormsHierarchyWithLimitsForTest(
  partition: Readonly<InitialRegionPartition>,
  colorSensitivity: number,
  limits: Partial<HierarchyWorkLimits>,
): RegionHierarchy {
  return buildWatercolorFormsHierarchyWithLimitsAndDiagnosticsForTest(
    partition,
    colorSensitivity,
    limits,
  ).hierarchy;
}

/** @internal Exact accounting seam for focused safety-limit tests. */
export function buildWatercolorFormsHierarchyWithLimitsAndDiagnosticsForTest(
  partition: Readonly<InitialRegionPartition>,
  colorSensitivity: number,
  limits: Partial<HierarchyWorkLimits>,
): WatercolorFormsHierarchyBuildResult {
  return buildHierarchy(partition, colorSensitivity, {
    limits: Object.freeze({
      maxMergeCount: finiteLimit(
        limits.maxMergeCount,
        DEFAULT_WORK_LIMITS.maxMergeCount,
      ),
      maxMergeQueueEntryCount: finiteLimit(
        limits.maxMergeQueueEntryCount,
        DEFAULT_WORK_LIMITS.maxMergeQueueEntryCount,
      ),
      maxRegionUpdateCount: finiteLimit(
        limits.maxRegionUpdateCount,
        DEFAULT_WORK_LIMITS.maxRegionUpdateCount,
      ),
    }),
  });
}
