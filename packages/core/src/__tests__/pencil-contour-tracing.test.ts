import { describe, expect, it } from "vitest";
import { tracePencilContourEdges } from "../sketches/pencil-contour/tracing";
import type {
  EdgeProvenance,
  LocalizedEdge,
  LocalizedEdgeGraph,
  TracedContourPath,
} from "../sketches/pencil-contour/types";
import type { Point } from "../types";

const LUMINANCE = Object.freeze({ kind: "luminance" } as const);
const ALPHA_BOUNDARY = Object.freeze({ kind: "alpha-boundary" } as const);

function edge(
  start: Readonly<Point>,
  end: Readonly<Point>,
  provenance: Readonly<EdgeProvenance> = LUMINANCE,
): Readonly<LocalizedEdge> {
  return Object.freeze({ start, end, provenance });
}

function graph(
  edges: readonly Readonly<LocalizedEdge>[],
  width = 6,
  height = 6,
): Readonly<LocalizedEdgeGraph> {
  return Object.freeze({
    width,
    height,
    alpha: Object.freeze(Array<number>(width * height).fill(1)),
    positiveSupport: Object.freeze(Array<boolean>(width * height).fill(true)),
    edges: Object.freeze([...edges]),
  });
}

function representedEdgeCount(path: Readonly<TracedContourPath>): number {
  return path.closed ? path.points.length : Math.max(0, path.points.length - 1);
}

describe("Pencil Contour graph tracing", () => {
  it("traces a straight chain once in canonical direction", () => {
    const paths = tracePencilContourEdges(
      graph([edge([1, 0], [2, 0]), edge([1, 0], [0, 0])]),
    );

    expect(paths).toEqual([
      {
        points: [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
        closed: false,
        provenance: { kind: "luminance" },
      },
    ]);
  });

  it("splits a junction into deterministic endpoint-to-junction branches", () => {
    const paths = tracePencilContourEdges(
      graph([
        edge([1, 1], [1, 2]),
        edge([1, 1], [2, 1]),
        edge([1, 0], [1, 1]),
        edge([0, 1], [1, 1]),
      ]),
    );

    expect(paths.map((path) => path.points)).toEqual([
      [
        [1, 0],
        [1, 1],
      ],
      [
        [0, 1],
        [1, 1],
      ],
      [
        [1, 1],
        [2, 1],
      ],
      [
        [1, 1],
        [1, 2],
      ],
    ]);
    expect(paths.every((path) => path.closed === false)).toBe(true);
  });

  it("orders disconnected paths by canonical row-major point sequences", () => {
    const paths = tracePencilContourEdges(
      graph([edge([4, 4], [5, 4]), edge([2, 1], [1, 1]), edge([0, 3], [0, 2])]),
    );

    expect(paths.map((path) => path.points)).toEqual([
      [
        [1, 1],
        [2, 1],
      ],
      [
        [0, 2],
        [0, 3],
      ],
      [
        [4, 4],
        [5, 4],
      ],
    ]);
  });

  it("emits endpoint and junction branches before remaining cycles", () => {
    const paths = tracePencilContourEdges(
      graph([
        edge([0, 0], [1, 0]),
        edge([1, 0], [1, 1]),
        edge([1, 1], [0, 1]),
        edge([0, 1], [0, 0]),
        edge([3, 3], [4, 3]),
      ]),
    );

    expect(paths.map((path) => path.closed)).toEqual([false, true]);
    expect(paths[0]!.points).toEqual([
      [3, 3],
      [4, 3],
    ]);
    expect(paths[1]!.points[0]).toEqual([0, 0]);
  });

  it("never merges touching luminance and alpha-boundary edges", () => {
    const paths = tracePencilContourEdges(
      graph([
        edge([0, 1], [1, 1], LUMINANCE),
        edge([1, 1], [2, 1], ALPHA_BOUNDARY),
      ]),
    );

    expect(paths).toEqual([
      {
        points: [
          [0, 1],
          [1, 1],
        ],
        closed: false,
        provenance: { kind: "luminance" },
      },
      {
        points: [
          [1, 1],
          [2, 1],
        ],
        closed: false,
        provenance: { kind: "alpha-boundary" },
      },
    ]);
  });

  it("traces remaining cycles from a canonical start without a duplicate terminal point", () => {
    const paths = tracePencilContourEdges(
      graph([
        edge([2, 2], [1, 2]),
        edge([2, 1], [2, 2]),
        edge([1, 2], [1, 1]),
        edge([2, 1], [1, 1]),
      ]),
    );

    expect(paths).toEqual([
      {
        points: [
          [1, 1],
          [2, 1],
          [2, 2],
          [1, 2],
        ],
        closed: true,
        provenance: { kind: "luminance" },
      },
    ]);
    expect(representedEdgeCount(paths[0]!)).toBe(4);
    expect(paths[0]!.points.at(-1)).not.toEqual(paths[0]!.points[0]);
  });

  it("represents every valid input graph edge exactly once", () => {
    const edges = [
      edge([0, 0], [1, 0]),
      edge([1, 0], [2, 0]),
      edge([1, 0], [1, 1]),
      edge([3, 2], [4, 2]),
      edge([4, 2], [4, 3]),
      edge([4, 3], [3, 3]),
      edge([3, 3], [3, 2]),
    ];

    const paths = tracePencilContourEdges(graph(edges));

    expect(
      paths.reduce((total, path) => total + representedEdgeCount(path), 0),
    ).toBe(edges.length);
  });

  it("repeats exact starts, directions, and output order for shuffled input", () => {
    const edges = [
      edge([2, 2], [1, 2]),
      edge([1, 1], [2, 1]),
      edge([1, 2], [1, 1]),
      edge([2, 1], [2, 2]),
      edge([4, 0], [3, 0], ALPHA_BOUNDARY),
      edge([4, 0], [5, 0], ALPHA_BOUNDARY),
    ];
    const expected = tracePencilContourEdges(graph(edges));

    expect(tracePencilContourEdges(graph([...edges].reverse()))).toEqual(
      expected,
    );
    expect(
      tracePencilContourEdges(
        graph([
          edges[3]!,
          edges[0]!,
          edges[5]!,
          edges[2]!,
          edges[1]!,
          edges[4]!,
        ]),
      ),
    ).toEqual(expected);
  });

  it("fails closed for invalid graph metadata", () => {
    const valid = graph([edge([0, 0], [1, 0])], 2, 2);
    const sparseAlpha = Array<number>(4);
    const sparsePositiveSupport = Array<boolean>(4);

    expect(tracePencilContourEdges({ ...valid, width: Number.NaN })).toEqual(
      [],
    );
    expect(tracePencilContourEdges({ ...valid, alpha: [1, 1, 1] })).toEqual([]);
    expect(
      tracePencilContourEdges({
        ...valid,
        positiveSupport: [true, true, true],
      }),
    ).toEqual([]);
    expect(tracePencilContourEdges({ ...valid, alpha: sparseAlpha })).toEqual(
      [],
    );
    expect(
      tracePencilContourEdges({
        ...valid,
        positiveSupport: sparsePositiveSupport,
      }),
    ).toEqual([]);
  });

  it("skips malformed edges without discarding independent valid contours or running away", () => {
    const malformed = [
      edge([1, 1], [1, 1]),
      edge([0, 0], [Number.NaN, 1]),
      edge([-1, 0], [0, 0]),
      {
        start: [0, 0],
        end: [0, 1],
        provenance: { kind: "unknown" },
      },
    ] as unknown as readonly Readonly<LocalizedEdge>[];
    const paths = tracePencilContourEdges(
      graph([edge([2, 2], [3, 2]), ...malformed], 4, 4),
    );

    expect(paths).toEqual([
      {
        points: [
          [2, 2],
          [3, 2],
        ],
        closed: false,
        provenance: { kind: "luminance" },
      },
    ]);
  });

  it("keeps duplicate parallel edges distinct while rejecting degenerate remnants", () => {
    const paths = tracePencilContourEdges(
      graph([edge([0, 0], [1, 0]), edge([1, 0], [0, 0]), edge([1, 0], [1, 0])]),
    );

    expect(paths).toEqual([
      {
        points: [
          [0, 0],
          [1, 0],
        ],
        closed: true,
        provenance: { kind: "luminance" },
      },
    ]);
    expect(representedEdgeCount(paths[0]!)).toBe(2);
  });
});
