import { describe, expect, it } from "vitest";

import {
  buildWatercolorFormsHierarchy,
  buildWatercolorFormsHierarchyWithDiagnostics,
  buildWatercolorFormsHierarchyWithLimitsAndDiagnosticsForTest,
  buildWatercolorFormsHierarchyWithLimitsForTest,
} from "../sketches/watercolor-forms/hierarchy";
import { partitionWatercolorFormsRaster } from "../sketches/watercolor-forms/partition";
import type {
  InitialRegionPartition,
  PreparedWatercolorRaster,
  SharedBoundarySegment,
  WatercolorRegionSummary,
} from "../sketches/watercolor-forms/types";

type Color = readonly [number, number, number];

function luminance([red, green, blue]: Color): number {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function raster(
  width: number,
  height: number,
  colors: readonly Color[],
  alpha: readonly number[] = colors.map(() => 1),
  support: readonly boolean[] = alpha.map((value) => value > 0),
): PreparedWatercolorRaster {
  return Object.freeze({
    sourceWidth: width,
    sourceHeight: height,
    width,
    height,
    linearRed: Object.freeze(colors.map((color) => color[0])),
    linearGreen: Object.freeze(colors.map((color) => color[1])),
    linearBlue: Object.freeze(colors.map((color) => color[2])),
    luminance: Object.freeze(colors.map(luminance)),
    alpha: Object.freeze([...alpha]),
    positiveSupport: Object.freeze([...support]),
  });
}

function blockRaster(
  blocks: readonly Readonly<{
    count: number;
    color: Color;
    alpha?: number;
    support?: boolean;
  }>[],
): PreparedWatercolorRaster {
  const colors: Color[] = [];
  const alpha: number[] = [];
  const support: boolean[] = [];
  for (const block of blocks) {
    for (let index = 0; index < block.count; index += 1) {
      colors.push(block.color);
      alpha.push(block.alpha ?? 1);
      support.push(block.support ?? true);
    }
  }
  return raster(colors.length, 1, colors, alpha, support);
}

function region(
  id: number,
  sampleCount: number,
  color: Color,
): Readonly<WatercolorRegionSummary> {
  return Object.freeze({
    id,
    sampleCount,
    visibleSampleCount: sampleCount,
    meanLinearRed: color[0],
    meanLinearGreen: color[1],
    meanLinearBlue: color[2],
    meanLuminance: luminance(color),
    meanAlpha: 1,
  });
}

function segment(
  id: number,
  firstRegionId: number,
  secondRegionId: number,
  strength: number,
  x = id,
): Readonly<SharedBoundarySegment> {
  return Object.freeze({
    id,
    regionIds: Object.freeze([
      Math.min(firstRegionId, secondRegionId),
      Math.max(firstRegionId, secondRegionId),
    ] as [number, number]),
    start: Object.freeze([x, 0] as [number, number]),
    end: Object.freeze([x, 1] as [number, number]),
    strength,
    provenance: "visible-color" as const,
  });
}

function contractPartition(
  regions: readonly Readonly<WatercolorRegionSummary>[],
  boundaries: readonly Readonly<SharedBoundarySegment>[],
): InitialRegionPartition {
  const sampleCount = regions.reduce(
    (sum, entry) => sum + entry.sampleCount,
    0,
  );
  const colors = regions.flatMap((entry) =>
    Array.from(
      { length: entry.sampleCount },
      () =>
        [
          entry.meanLinearRed,
          entry.meanLinearGreen,
          entry.meanLinearBlue,
        ] as Color,
    ),
  );
  return Object.freeze({
    raster: raster(sampleCount, 1, colors),
    regionBySample: Object.freeze(
      regions.flatMap((entry) => Array(entry.sampleCount).fill(entry.id)),
    ),
    regions: Object.freeze([...regions]),
    sharedBoundarySegments: Object.freeze([...boundaries]),
  });
}

function withBoundaries(
  partition: Readonly<InitialRegionPartition>,
  boundaries: readonly Readonly<SharedBoundarySegment>[],
): InitialRegionPartition {
  return Object.freeze({
    ...partition,
    sharedBoundarySegments: Object.freeze([...boundaries]),
  });
}

function reconstructLeaves(
  hierarchy: ReturnType<typeof buildWatercolorFormsHierarchy>,
): ReadonlyMap<number, ReadonlySet<number>> {
  const leaves = new Map<number, ReadonlySet<number>>(
    hierarchy.partition.regions.map((entry) => [entry.id, new Set([entry.id])]),
  );
  for (const merge of hierarchy.merges) {
    leaves.set(
      merge.mergedRegion.id,
      new Set([
        ...leaves.get(merge.leftRegionId)!,
        ...leaves.get(merge.rightRegionId)!,
      ]),
    );
  }
  return leaves;
}

function currentRootIds(
  hierarchy: ReturnType<typeof buildWatercolorFormsHierarchy>,
): readonly number[] {
  const roots = new Set(hierarchy.partition.regions.map((entry) => entry.id));
  for (const merge of hierarchy.merges) {
    roots.delete(merge.leftRegionId);
    roots.delete(merge.rightRegionId);
    roots.add(merge.mergedRegion.id);
  }
  return [...roots].sort((first, second) => first - second);
}

describe("buildWatercolorFormsHierarchy", () => {
  it("repeats exactly and returns deeply immutable merge snapshots", () => {
    const partition = partitionWatercolorFormsRaster(
      raster(4, 1, [
        [0, 0, 0],
        [0.3, 0.3, 0.3],
        [0.65, 0.65, 0.65],
        [1, 1, 1],
      ]),
    );

    const first = buildWatercolorFormsHierarchy(partition, 0.5);
    const second = buildWatercolorFormsHierarchy(partition, 0.5);

    expect(first).toEqual(second);
    expect(first.complete).toBe(true);
    expect(first.merges).toHaveLength(3);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.regions)).toBe(true);
    expect(Object.isFrozen(first.merges)).toBe(true);
    expect(Object.isFrozen(first.merges[0])).toBe(true);
    expect(Object.isFrozen(first.merges[0]!.mergedRegion)).toBe(true);
  });

  it("is invariant to shared-boundary insertion and endpoint order", () => {
    const base = contractPartition(
      [
        region(0, 1, [0.1, 0.1, 0.1]),
        region(1, 1, [0.3, 0.3, 0.3]),
        region(2, 1, [0.6, 0.6, 0.6]),
        region(3, 1, [0.9, 0.9, 0.9]),
      ],
      [
        segment(0, 0, 1, 0.2),
        segment(1, 0, 2, 0.4),
        segment(2, 1, 3, 0.6),
        segment(3, 2, 3, 0.8),
        segment(4, 0, 1, 0.7, 4),
      ],
    );
    const shuffled = withBoundaries(
      base,
      [...base.sharedBoundarySegments].reverse().map((boundary) =>
        Object.freeze({
          ...boundary,
          regionIds: Object.freeze([
            boundary.regionIds[1],
            boundary.regionIds[0],
          ]) as readonly [number, number],
        }),
      ),
    );

    const canonical = buildWatercolorFormsHierarchy(base, 0.4);
    const reordered = buildWatercolorFormsHierarchy(shuffled, 0.4);

    expect(reordered.regions).toEqual(canonical.regions);
    expect(reordered.merges).toEqual(canonical.merges);
    expect(reordered.complete).toBe(canonical.complete);
  });

  it("records nondecreasing derived merge heights", () => {
    const partition = contractPartition(
      [
        region(0, 1, [0, 0, 0]),
        region(1, 1, [0.15, 0.15, 0.15]),
        region(2, 1, [0.4, 0.4, 0.4]),
        region(3, 1, [1, 1, 1]),
      ],
      [segment(0, 0, 1, 0.05), segment(1, 1, 2, 0.3), segment(2, 2, 3, 0.9)],
    );
    const result = buildWatercolorFormsHierarchy(partition, 0.5);
    const heights = result.merges.map((merge) => 1 - merge.similarity);

    expect(heights).toHaveLength(3);
    for (let index = 1; index < heights.length; index += 1) {
      expect(heights[index]).toBeGreaterThanOrEqual(heights[index - 1]!);
    }
  });

  it("breaks exact score ties by canonical leaf IDs", () => {
    const equal = [0.4, 0.4, 0.4] as const;
    const partition = contractPartition(
      [0, 1, 2, 3].map((id) => region(id, 1, equal)),
      [segment(0, 2, 3, 0.5), segment(1, 1, 2, 0.5), segment(2, 0, 1, 0.5)],
    );

    const result = buildWatercolorFormsHierarchy(partition, 0.5);

    expect(result.merges[0]).toMatchObject({
      leftRegionId: 0,
      rightRegionId: 1,
    });
    expect(result.merges[1]).toMatchObject({
      leftRegionId: 2,
      rightRegionId: 3,
    });
  });

  it("makes chromatic merging predictably more conservative at high sensitivity", () => {
    const red = [1, 0, 0] as const;
    const equalLuminanceGreen = [0, 0.2126 / 0.7152, 0] as const;
    const partition = partitionWatercolorFormsRaster(
      raster(2, 1, [red, equalLuminanceGreen]),
    );
    expect(partition.regions).toHaveLength(2);
    expect(partition.regions[0]!.meanLuminance).toBeCloseTo(
      partition.regions[1]!.meanLuminance,
      12,
    );

    const low = buildWatercolorFormsHierarchy(partition, 0);
    const high = buildWatercolorFormsHierarchy(partition, 1);

    expect(low.merges).toHaveLength(1);
    expect(high.merges).toHaveLength(1);
    expect(high.merges[0]!.similarity).toBeLessThan(low.merges[0]!.similarity);
    expect(high.merges[0]!.leftRegionId).toBe(low.merges[0]!.leftRegionId);
    expect(high.merges[0]!.rightRegionId).toBe(low.merges[0]!.rightRegionId);
  });

  it("leaves positive-support islands disconnected across exact-zero alpha", () => {
    const partition = partitionWatercolorFormsRaster(
      raster(
        3,
        1,
        [
          [0.3, 0.3, 0.3],
          [1, 0, 1],
          [0.3, 0.3, 0.3],
        ],
        [1, 0, 1],
        [true, false, true],
      ),
    );

    const result = buildWatercolorFormsHierarchy(partition, 0.5);

    expect(partition.regions).toHaveLength(2);
    expect(result.complete).toBe(true);
    expect(result.merges).toEqual([]);
    expect(result.regions).toEqual(partition.regions);
  });

  it("aggregates the complete shared boundary by geometric length", () => {
    const partition = contractPartition(
      [region(0, 1, [0.4, 0.4, 0.4]), region(1, 1, [0.4, 0.4, 0.4])],
      [
        segment(0, 0, 1, 0),
        Object.freeze({
          ...segment(1, 0, 1, 1),
          start: Object.freeze([1, 0] as [number, number]),
          end: Object.freeze([1, 3] as [number, number]),
        }),
      ],
    );

    const result = buildWatercolorFormsHierarchy(partition, 0.5);

    expect(result.merges[0]!.boundaryStrength).toBe(0.75);
  });

  it("includes visible similarity and boundary weakness in merge affinity", () => {
    const same = [0.25, 0.25, 0.25] as const;
    const different = [0.8, 0.8, 0.8] as const;
    const baseRegions = [region(0, 1, same), region(1, 1, same)];
    const weak = contractPartition(baseRegions, [segment(0, 0, 1, 0.1)]);
    const strong = contractPartition(baseRegions, [segment(0, 0, 1, 0.9)]);
    const colorDifferent = contractPartition(
      [region(0, 1, same), region(1, 1, different)],
      [segment(0, 0, 1, 0.1)],
    );

    const weakScore = buildWatercolorFormsHierarchy(weak, 0.5).merges[0]!
      .similarity;
    const strongScore = buildWatercolorFormsHierarchy(strong, 0.5).merges[0]!
      .similarity;
    const differentScore = buildWatercolorFormsHierarchy(colorDifferent, 0.5)
      .merges[0]!.similarity;

    expect(weakScore).toBeGreaterThan(strongScore);
    expect(weakScore).toBeGreaterThan(differentScore);
  });

  it("uses tone-shaped region means in hierarchy similarity", () => {
    const boundary = [segment(0, 0, 1, 0.1)];
    const compressed = contractPartition(
      [region(0, 1, [0.15, 0.15, 0.15]), region(1, 1, [0.16, 0.16, 0.16])],
      boundary,
    );
    const separated = contractPartition(
      [region(0, 1, [0, 0, 0]), region(1, 1, [1, 1, 1])],
      boundary,
    );

    expect(
      buildWatercolorFormsHierarchy(compressed, 0.5).merges[0]!.similarity,
    ).toBeGreaterThan(
      buildWatercolorFormsHierarchy(separated, 0.5).merges[0]!.similarity,
    );
  });

  it("includes small-region pressure independently of pair balance", () => {
    const source = (
      firstCount: number,
      secondCount: number,
      islandCount: number,
    ) =>
      partitionWatercolorFormsRaster(
        blockRaster([
          { count: firstCount, color: [0, 0, 0] },
          { count: secondCount, color: [1, 1, 1] },
          {
            count: 1,
            color: [1, 0, 1],
            alpha: 0,
            support: false,
          },
          { count: islandCount, color: [0, 0, 1] },
        ]),
      );
    const smallPair = buildWatercolorFormsHierarchy(source(1, 1, 8), 0.5);
    const largePair = buildWatercolorFormsHierarchy(source(4, 4, 2), 0.5);

    expect(smallPair.merges).toHaveLength(1);
    expect(largePair.merges).toHaveLength(1);
    expect(smallPair.merges[0]!.similarity).toBeGreaterThan(
      largePair.merges[0]!.similarity,
    );
  });

  it("includes merge balance and child persistence in stability resistance", () => {
    const gray = [0.4, 0.4, 0.4] as const;
    const balanced = contractPartition(
      [region(0, 2, gray), region(1, 2, gray), region(2, 6, gray)],
      [segment(0, 0, 1, 0.5)],
    );
    const imbalanced = contractPartition(
      [region(0, 1, gray), region(1, 3, gray), region(2, 6, gray)],
      [segment(0, 0, 1, 0.5)],
    );
    const balancedMerge = buildWatercolorFormsHierarchy(balanced, 0.5)
      .merges[0]!;
    const imbalancedMerge = buildWatercolorFormsHierarchy(imbalanced, 0.5)
      .merges[0]!;

    expect(balancedMerge.stability).toBeLessThan(imbalancedMerge.stability);
    expect(balancedMerge.similarity).toBeGreaterThan(
      imbalancedMerge.similarity,
    );

    const chain = contractPartition(
      [0, 1, 2].map((id) => region(id, 1, gray)),
      [segment(0, 0, 1, 0.5), segment(1, 1, 2, 0.5)],
    );
    const chained = buildWatercolorFormsHierarchy(chain, 0.5);
    expect(chained.merges[1]!.stability).toBeGreaterThan(
      chained.merges[0]!.stability,
    );
  });

  it.each([
    [
      "visible similarity",
      contractPartition(
        [
          region(0, 1, [0.4, 0.4, 0.4]),
          region(1, 1, [0.4, 0.4, 0.4]),
          region(2, 1, [0, 0, 0]),
          region(3, 1, [1, 1, 1]),
        ],
        [segment(0, 0, 1, 0.5), segment(1, 2, 3, 0.5)],
      ),
    ],
    [
      "aggregated boundary weakness",
      contractPartition(
        [0, 1, 2, 3].map((id) => region(id, 1, [0.4, 0.4, 0.4])),
        [segment(0, 0, 1, 0.1), segment(1, 2, 3, 0.9)],
      ),
    ],
    [
      "small-region pressure",
      contractPartition(
        [
          region(0, 1, [0.4, 0.4, 0.4]),
          region(1, 1, [0.4, 0.4, 0.4]),
          region(2, 4, [0.4, 0.4, 0.4]),
          region(3, 4, [0.4, 0.4, 0.4]),
        ],
        [segment(0, 0, 1, 0.5), segment(1, 2, 3, 0.5)],
      ),
    ],
    [
      "merge stability",
      contractPartition(
        [
          region(0, 2, [0.4, 0.4, 0.4]),
          region(1, 2, [0.4, 0.4, 0.4]),
          region(2, 1, [0.4, 0.4, 0.4]),
          region(3, 3, [0.4, 0.4, 0.4]),
        ],
        [segment(0, 0, 1, 0.5), segment(1, 2, 3, 0.5)],
      ),
    ],
  ])("lets %s change candidate ordering", (_name, partition) => {
    const result = buildWatercolorFormsHierarchy(partition, 0.5);

    expect(result.merges[0]).toMatchObject({
      leftRegionId: 0,
      rightRegionId: 1,
    });
  });

  it("only merges regions connected through the current adjacency graph", () => {
    const partition = contractPartition(
      [
        region(0, 1, [0, 0, 0]),
        region(1, 1, [1, 1, 1]),
        region(2, 1, [0.01, 0.01, 0.01]),
      ],
      [segment(0, 0, 1, 0.8), segment(1, 1, 2, 0.8)],
    );
    const result = buildWatercolorFormsHierarchy(partition, 0);
    const leaves = reconstructLeaves(result);
    const originalEdges = new Set(["0:1", "1:2"]);

    for (const merge of result.merges) {
      const leftLeaves = leaves.get(merge.leftRegionId)!;
      const rightLeaves = leaves.get(merge.rightRegionId)!;
      expect(
        [...leftLeaves].some((left) =>
          [...rightLeaves].some((right) =>
            originalEdges.has(
              `${Math.min(left, right)}:${Math.max(left, right)}`,
            ),
          ),
        ),
      ).toBe(true);
    }
    expect(result.merges[0]).not.toMatchObject({
      leftRegionId: 0,
      rightRegionId: 2,
    });
  });

  it("returns a deterministic valid forest prefix when a work cap is reached", () => {
    const partition = contractPartition(
      [0, 1, 2, 3].map((id) => region(id, 1, [id / 4, id / 4, id / 4])),
      [segment(0, 0, 1, 0.1), segment(1, 1, 2, 0.2), segment(2, 2, 3, 0.3)],
    );
    const capped = () =>
      buildWatercolorFormsHierarchyWithLimitsForTest(partition, 0.5, {
        maxMergeCount: 1,
      });
    const first = capped();
    const second = capped();

    expect(first).toEqual(second);
    expect(first.complete).toBe(false);
    expect(first.merges).toHaveLength(1);
    expect(first.regions).toHaveLength(partition.regions.length + 1);
    expect(currentRootIds(first)).toHaveLength(
      partition.regions.length - first.merges.length,
    );
    expect(
      reconstructLeaves(first).get(first.merges[0]!.mergedRegion.id),
    ).toHaveProperty("size", 2);
    expect(
      first.regions.every((entry) =>
        [
          entry.sampleCount,
          entry.visibleSampleCount,
          entry.meanLinearRed,
          entry.meanLinearGreen,
          entry.meanLinearBlue,
          entry.meanLuminance,
          entry.meanAlpha,
        ].every(Number.isFinite),
      ),
    ).toBe(true);
  });

  it("reports exact deterministic queue and region-update accounting", () => {
    const partition = contractPartition(
      [0, 1, 2].map((id) => region(id, 1, [id / 3, id / 3, id / 3])),
      [segment(0, 0, 1, 0.2), segment(1, 1, 2, 0.2)],
    );

    const first = buildWatercolorFormsHierarchyWithDiagnostics(
      partition,
      0.5,
    );
    const second = buildWatercolorFormsHierarchyWithDiagnostics(
      partition,
      0.5,
    );

    expect(first).toEqual(second);
    expect(first.hierarchy.complete).toBe(true);
    expect(first.diagnostics).toEqual({
      limitedBy: null,
      mergeQueueEntryCount: 3,
      regionUpdateCount: 1,
    });
    expect(Object.isFrozen(first.diagnostics)).toBe(true);
  });

  it.each([
    [
      "maxMergeCount",
      { maxMergeCount: 0 },
      { mergeQueueEntryCount: 2, regionUpdateCount: 0 },
    ],
    [
      "maxMergeQueueEntryCount",
      { maxMergeQueueEntryCount: 0 },
      { mergeQueueEntryCount: 0, regionUpdateCount: 0 },
    ],
    [
      "maxRegionUpdateCount",
      { maxRegionUpdateCount: 0 },
      { mergeQueueEntryCount: 2, regionUpdateCount: 0 },
    ],
  ] as const)(
    "names the %s cap without fabricating work counters",
    (limitedBy, limits, counts) => {
      const partition = contractPartition(
        [0, 1, 2].map((id) => region(id, 1, [id / 3, id / 3, id / 3])),
        [segment(0, 0, 1, 0.2), segment(1, 1, 2, 0.2)],
      );

      const result =
        buildWatercolorFormsHierarchyWithLimitsAndDiagnosticsForTest(
          partition,
          0.5,
          limits,
        );

      expect(result.hierarchy.complete).toBe(false);
      expect(result.diagnostics).toEqual({ limitedBy, ...counts });
    },
  );

  it.each([
    ["queue initialization", { maxMergeQueueEntryCount: 0 }],
    ["region updates", { maxRegionUpdateCount: 0 }],
  ])(
    "terminates safely at the %s cap without invalidating input",
    (_name, limits) => {
      const partition = contractPartition(
        [0, 1, 2].map((id) => region(id, 1, [id / 3, id / 3, id / 3])),
        [segment(0, 0, 1, 0.2), segment(1, 1, 2, 0.2)],
      );

      const result = buildWatercolorFormsHierarchyWithLimitsForTest(
        partition,
        0.5,
        limits,
      );

      expect(result.complete).toBe(false);
      expect(result.merges).toEqual([]);
      expect(result.regions).toEqual(partition.regions);
      expect(result.partition).toBe(partition);
    },
  );

  it("rejects stale lazy-queue entries while completing cyclic adjacency", () => {
    const gray = [0.4, 0.4, 0.4] as const;
    const partition = contractPartition(
      [0, 1, 2, 3].map((id) => region(id, 1, gray)),
      [
        segment(0, 0, 1, 0.5),
        segment(1, 0, 2, 0.5),
        segment(2, 1, 3, 0.5),
        segment(3, 2, 3, 0.5),
      ],
    );

    const result = buildWatercolorFormsHierarchy(partition, 0.5);

    expect(result.complete).toBe(true);
    expect(result.merges).toHaveLength(partition.regions.length - 1);
    expect(
      new Set(result.merges.map((merge) => merge.mergedRegion.id)).size,
    ).toBe(result.merges.length);
  });
});
