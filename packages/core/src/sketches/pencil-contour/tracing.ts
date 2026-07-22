/**
 * Deterministic edge-graph tracing for Pencil Contour.
 *
 * Tracing is deliberately topological only: it neither cleans nor smooths the
 * localized geometry. Edges, rather than vertices, own visitation so branches,
 * parallel edges, and cycles all retain every valid localized segment.
 */

import type { Point } from "../../types";
import type {
  EdgeProvenance,
  LocalizedEdge,
  LocalizedEdgeGraph,
  TracedContourPath,
} from "./types";

const LUMINANCE_PROVENANCE: Readonly<EdgeProvenance> = Object.freeze({
  kind: "luminance",
});
const ALPHA_BOUNDARY_PROVENANCE: Readonly<EdgeProvenance> = Object.freeze({
  kind: "alpha-boundary",
});

interface TraceEdge {
  readonly id: number;
  readonly startKey: string;
  readonly endKey: string;
}

interface TraceVertex {
  readonly key: string;
  readonly point: Readonly<Point>;
  readonly edgeIds: number[];
}

interface ProvenanceGraph {
  readonly provenance: Readonly<EdgeProvenance>;
  readonly edges: readonly TraceEdge[];
  readonly vertices: ReadonlyMap<string, TraceVertex>;
}

interface TracedProvenanceGraph {
  readonly branches: readonly Readonly<TracedContourPath>[];
  readonly cycles: readonly Readonly<TracedContourPath>[];
}

function comparePoints(
  first: Readonly<Point>,
  second: Readonly<Point>,
): number {
  return first[1] - second[1] || first[0] - second[0];
}

function pointKey(point: Readonly<Point>): string {
  // String normalizes -0 to the same vertex as 0, matching numeric equality.
  return `${point[0]},${point[1]}`;
}

function frozenPoint(point: Readonly<Point>): Readonly<Point> {
  return Object.freeze([point[0], point[1]] as Point);
}

function validPoint(value: unknown): value is Readonly<Point> {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

function provenanceFor(value: unknown): Readonly<EdgeProvenance> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const kind = (value as { readonly kind?: unknown }).kind;
  if (kind === "luminance") return LUMINANCE_PROVENANCE;
  if (kind === "alpha-boundary") return ALPHA_BOUNDARY_PROVENANCE;
  return undefined;
}

function validSampleFields(
  alpha: readonly number[],
  positiveSupport: readonly boolean[],
  sampleCount: number,
): boolean {
  for (let index = 0; index < sampleCount; index += 1) {
    if (
      !Object.prototype.hasOwnProperty.call(alpha, index) ||
      !Object.prototype.hasOwnProperty.call(positiveSupport, index)
    ) {
      return false;
    }

    const alphaValue = alpha[index];
    if (
      typeof alphaValue !== "number" ||
      !Number.isFinite(alphaValue) ||
      alphaValue < 0 ||
      alphaValue > 1 ||
      typeof positiveSupport[index] !== "boolean"
    ) {
      return false;
    }
  }
  return true;
}

function validGraphMetadata(graph: Readonly<LocalizedEdgeGraph>): boolean {
  if (
    !Number.isSafeInteger(graph.width) ||
    !Number.isSafeInteger(graph.height) ||
    graph.width < 0 ||
    graph.height < 0
  ) {
    return false;
  }

  const sampleCount = graph.width * graph.height;
  return (
    Number.isSafeInteger(sampleCount) &&
    Array.isArray(graph.alpha) &&
    Array.isArray(graph.positiveSupport) &&
    Array.isArray(graph.edges) &&
    graph.alpha.length === sampleCount &&
    graph.positiveSupport.length === sampleCount &&
    validSampleFields(graph.alpha, graph.positiveSupport, sampleCount)
  );
}

function validEdges(
  graph: Readonly<LocalizedEdgeGraph>,
): readonly Readonly<LocalizedEdge>[] {
  return graph.edges.filter(
    (candidate): candidate is Readonly<LocalizedEdge> => {
      if (candidate === null || typeof candidate !== "object") return false;
      const edge = candidate as Readonly<LocalizedEdge>;
      if (
        !validPoint(edge.start) ||
        !validPoint(edge.end) ||
        provenanceFor(edge.provenance) === undefined
      ) {
        return false;
      }

      if (edge.start[0] === edge.end[0] && edge.start[1] === edge.end[1]) {
        return false;
      }

      return (
        edge.start[0] >= 0 &&
        edge.start[1] >= 0 &&
        edge.end[0] >= 0 &&
        edge.end[1] >= 0 &&
        edge.start[0] <= graph.width - 1 &&
        edge.end[0] <= graph.width - 1 &&
        edge.start[1] <= graph.height - 1 &&
        edge.end[1] <= graph.height - 1
      );
    },
  );
}

function compareCanonicalEdges(
  first: Readonly<LocalizedEdge>,
  second: Readonly<LocalizedEdge>,
): number {
  const firstStart =
    comparePoints(first.start, first.end) <= 0 ? first.start : first.end;
  const firstEnd = firstStart === first.start ? first.end : first.start;
  const secondStart =
    comparePoints(second.start, second.end) <= 0 ? second.start : second.end;
  const secondEnd = secondStart === second.start ? second.end : second.start;
  return (
    comparePoints(firstStart, secondStart) || comparePoints(firstEnd, secondEnd)
  );
}

function buildProvenanceGraph(
  sourceEdges: readonly Readonly<LocalizedEdge>[],
  provenance: Readonly<EdgeProvenance>,
): ProvenanceGraph {
  const matching = sourceEdges
    .filter((edge) => edge.provenance.kind === provenance.kind)
    .slice()
    .sort(compareCanonicalEdges);
  const vertices = new Map<string, TraceVertex>();
  const edges: TraceEdge[] = [];

  const vertexFor = (point: Readonly<Point>): TraceVertex => {
    const key = pointKey(point);
    const existing = vertices.get(key);
    if (existing !== undefined) return existing;
    const created = { key, point: frozenPoint(point), edgeIds: [] };
    vertices.set(key, created);
    return created;
  };

  for (const [id, edge] of matching.entries()) {
    const start = vertexFor(edge.start);
    const end = vertexFor(edge.end);
    edges.push({ id, startKey: start.key, endKey: end.key });
    start.edgeIds.push(id);
    end.edgeIds.push(id);
  }

  const otherVertex = (edge: TraceEdge, vertexKey: string): TraceVertex =>
    vertices.get(edge.startKey === vertexKey ? edge.endKey : edge.startKey)!;

  for (const vertex of vertices.values()) {
    vertex.edgeIds.sort((firstId, secondId) => {
      const first = otherVertex(edges[firstId]!, vertex.key);
      const second = otherVertex(edges[secondId]!, vertex.key);
      return comparePoints(first.point, second.point) || firstId - secondId;
    });
  }

  return { provenance, edges, vertices };
}

function otherVertexKey(edge: TraceEdge, vertexKey: string): string {
  return edge.startKey === vertexKey ? edge.endKey : edge.startKey;
}

function nextUnusedEdge(
  vertex: TraceVertex,
  visited: ReadonlySet<number>,
): number | undefined {
  return vertex.edgeIds.find((edgeId) => !visited.has(edgeId));
}

function traceFrom(
  graph: ProvenanceGraph,
  start: TraceVertex,
  firstEdgeId: number,
  visited: Set<number>,
): Readonly<TracedContourPath> {
  const points: Readonly<Point>[] = [start.point];
  let current = start;
  let edgeId: number | undefined = firstEdgeId;

  // Each iteration permanently consumes one edge, making the graph's own edge
  // count a strict safety ceiling even for malformed adjacency in future edits.
  for (let consumed = 0; edgeId !== undefined; consumed += 1) {
    if (consumed >= graph.edges.length || visited.has(edgeId)) break;
    visited.add(edgeId);
    const edge = graph.edges[edgeId]!;
    current = graph.vertices.get(otherVertexKey(edge, current.key))!;
    points.push(current.point);

    if (current.key === start.key || current.edgeIds.length !== 2) break;
    edgeId = nextUnusedEdge(current, visited);
  }

  const closed = current.key === start.key;
  if (closed) points.pop();
  return Object.freeze({
    points: Object.freeze(points),
    closed,
    provenance: graph.provenance,
  });
}

function traceProvenanceGraph(graph: ProvenanceGraph): TracedProvenanceGraph {
  const visited = new Set<number>();
  const branches: Readonly<TracedContourPath>[] = [];
  const cycles: Readonly<TracedContourPath>[] = [];
  const orderedVertices = [...graph.vertices.values()].sort((first, second) =>
    comparePoints(first.point, second.point),
  );

  // Split at endpoints and junctions first. Degree-two vertices remain internal
  // to a maximal branch and are intentionally allowed to appear in many paths.
  for (const vertex of orderedVertices) {
    if (vertex.edgeIds.length === 2) continue;
    let edgeId = nextUnusedEdge(vertex, visited);
    while (edgeId !== undefined) {
      branches.push(traceFrom(graph, vertex, edgeId, visited));
      edgeId = nextUnusedEdge(vertex, visited);
    }
  }

  // What remains consists only of degree-two components. The first unvisited
  // edge incident to the row-major-smallest vertex fixes cycle direction.
  for (const vertex of orderedVertices) {
    const edgeId = nextUnusedEdge(vertex, visited);
    if (edgeId !== undefined) {
      cycles.push(traceFrom(graph, vertex, edgeId, visited));
    }
  }

  return { branches, cycles };
}

function comparePaths(
  first: Readonly<TracedContourPath>,
  second: Readonly<TracedContourPath>,
): number {
  const length = Math.min(first.points.length, second.points.length);
  for (let index = 0; index < length; index += 1) {
    const pointOrder = comparePoints(
      first.points[index]!,
      second.points[index]!,
    );
    if (pointOrder !== 0) return pointOrder;
  }
  return (
    first.points.length - second.points.length ||
    Number(first.closed) - Number(second.closed) ||
    (first.provenance.kind === second.provenance.kind
      ? 0
      : first.provenance.kind < second.provenance.kind
        ? -1
        : 1)
  );
}

/**
 * Consume every valid localized edge exactly once into deterministic contours.
 *
 * Invalid graph metadata fails closed. Invalid individual edges are skipped so
 * one malformed segment cannot discard independent valid image structure.
 */
export function tracePencilContourEdges(
  graph: Readonly<LocalizedEdgeGraph>,
): readonly Readonly<TracedContourPath>[] {
  if (
    graph === null ||
    typeof graph !== "object" ||
    !validGraphMetadata(graph)
  ) {
    return Object.freeze([]);
  }

  const edges = validEdges(graph);
  const luminance = traceProvenanceGraph(
    buildProvenanceGraph(edges, LUMINANCE_PROVENANCE),
  );
  const alphaBoundary = traceProvenanceGraph(
    buildProvenanceGraph(edges, ALPHA_BOUNDARY_PROVENANCE),
  );
  const paths = [
    ...[...luminance.branches, ...alphaBoundary.branches].sort(comparePaths),
    ...[...luminance.cycles, ...alphaBoundary.cycles].sort(comparePaths),
  ];
  return Object.freeze(paths);
}
