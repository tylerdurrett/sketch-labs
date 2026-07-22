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
import { directionCompatibleTopology } from "./topology";

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
  readonly evidenceId?: string;
  readonly strength?: number;
  readonly adjacentEvidenceIds?: readonly string[];
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

type JunctionPairings = ReadonlyMap<string, ReadonlyMap<number, number>>;

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

function sourceEvidenceByEdge(graph: Readonly<LocalizedEdgeGraph>): ReadonlyMap<
  Readonly<LocalizedEdge>,
  Readonly<{
    readonly id: string;
    readonly strength: number;
    readonly adjacentEvidenceIds: readonly string[];
  }>
> {
  const result = new Map<
    Readonly<LocalizedEdge>,
    Readonly<{
      readonly id: string;
      readonly strength: number;
      readonly adjacentEvidenceIds: readonly string[];
    }>
  >();
  if (
    !Array.isArray(graph.luminanceEvidence) ||
    !Array.isArray(graph.selectedLuminanceEdgeIds)
  ) {
    return result;
  }
  const evidenceById = new Map(
    graph.luminanceEvidence.map((evidence) => [evidence.id, evidence]),
  );
  for (
    let index = 0;
    index < graph.selectedLuminanceEdgeIds.length;
    index += 1
  ) {
    const edge = graph.edges[index];
    const evidence = evidenceById.get(graph.selectedLuminanceEdgeIds[index]!);
    if (
      edge?.provenance.kind !== "luminance" ||
      evidence === undefined ||
      !Number.isFinite(evidence.strength) ||
      pointKey(edge.start) !== pointKey(evidence.start) ||
      pointKey(edge.end) !== pointKey(evidence.end)
    ) {
      continue;
    }
    result.set(edge, {
      id: evidence.id,
      strength: evidence.strength,
      adjacentEvidenceIds: evidence.adjacentEdgeIds,
    });
  }
  return result;
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
  evidenceByEdge: ReadonlyMap<
    Readonly<LocalizedEdge>,
    Readonly<{
      readonly id: string;
      readonly strength: number;
      readonly adjacentEvidenceIds: readonly string[];
    }>
  >,
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
    const evidence = evidenceByEdge.get(edge);
    edges.push({
      id,
      startKey: start.key,
      endKey: end.key,
      ...(evidence === undefined
        ? {}
        : {
            evidenceId: evidence.id,
            strength: evidence.strength,
            adjacentEvidenceIds: evidence.adjacentEvidenceIds,
          }),
    });
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

function buildJunctionPairings(graph: ProvenanceGraph): JunctionPairings {
  if (graph.provenance.kind !== "luminance") return new Map();
  if (graph.edges.every(({ evidenceId }) => evidenceId !== undefined)) {
    const traceIdByEvidenceId = new Map(
      graph.edges.map((edge) => [edge.evidenceId!, edge.id]),
    );
    const pairings = new Map<string, Map<number, number>>();
    for (const edge of graph.edges) {
      for (const adjacentEvidenceId of edge.adjacentEvidenceIds ?? []) {
        const adjacentId = traceIdByEvidenceId.get(adjacentEvidenceId);
        if (adjacentId === undefined || adjacentId <= edge.id) continue;
        const adjacent = graph.edges[adjacentId]!;
        const vertexKey =
          edge.startKey === adjacent.startKey ||
          edge.startKey === adjacent.endKey
            ? edge.startKey
            : edge.endKey === adjacent.startKey ||
                edge.endKey === adjacent.endKey
              ? edge.endKey
              : undefined;
        if (vertexKey === undefined) continue;
        let atVertex = pairings.get(vertexKey);
        if (atVertex === undefined) {
          atVertex = new Map<number, number>();
          pairings.set(vertexKey, atVertex);
        }
        atVertex.set(edge.id, adjacentId);
        atVertex.set(adjacentId, edge.id);
      }
    }
    return pairings;
  }
  return directionCompatibleTopology(
    graph.edges.map((edge) => ({
      start: graph.vertices.get(edge.startKey)!.point,
      end: graph.vertices.get(edge.endKey)!.point,
    })),
  ).pairings;
}

function continuationEdge(
  pairings: JunctionPairings,
  vertex: TraceVertex,
  incomingEdgeId: number,
): number | undefined {
  if (vertex.edgeIds.length === 2) {
    return vertex.edgeIds[0] === incomingEdgeId
      ? vertex.edgeIds[1]
      : vertex.edgeIds[0];
  }
  return pairings.get(vertex.key)?.get(incomingEdgeId);
}

function unpairedIncidence(
  pairings: JunctionPairings,
  vertex: TraceVertex,
  edgeId: number,
): boolean {
  return continuationEdge(pairings, vertex, edgeId) === undefined;
}

function traceFrom(
  graph: ProvenanceGraph,
  pairings: JunctionPairings,
  start: TraceVertex,
  firstEdgeId: number,
  visited: Set<number>,
): Readonly<TracedContourPath> {
  const points: Readonly<Point>[] = [start.point];
  const evidenceIds: string[] = [];
  let strengthTotal = 0;
  let maximumStrength = -Infinity;
  let completeEvidence = graph.provenance.kind === "luminance";
  let current = start;
  let edgeId: number | undefined = firstEdgeId;
  let closed = false;

  // Each iteration permanently consumes one edge, making the graph's own edge
  // count a strict safety ceiling even for malformed adjacency in future edits.
  for (let consumed = 0; edgeId !== undefined; consumed += 1) {
    if (consumed >= graph.edges.length || visited.has(edgeId)) break;
    visited.add(edgeId);
    const edge = graph.edges[edgeId]!;
    if (edge.evidenceId === undefined || edge.strength === undefined) {
      completeEvidence = false;
    } else {
      evidenceIds.push(edge.evidenceId);
      strengthTotal += edge.strength;
      maximumStrength = Math.max(maximumStrength, edge.strength);
    }
    current = graph.vertices.get(otherVertexKey(edge, current.key))!;
    points.push(current.point);

    const nextEdgeId = continuationEdge(pairings, current, edgeId);
    if (nextEdgeId === undefined) break;
    if (current.key === start.key && nextEdgeId === firstEdgeId) {
      closed = true;
      points.pop();
      break;
    }
    if (visited.has(nextEdgeId)) break;
    edgeId = nextEdgeId;
  }

  const luminanceEvidence =
    completeEvidence && evidenceIds.length > 0
      ? Object.freeze({
          edgeIds: Object.freeze(evidenceIds),
          maximumStrength,
          meanStrength: strengthTotal / evidenceIds.length,
        })
      : undefined;
  return Object.freeze({
    points: Object.freeze(points),
    closed,
    provenance: graph.provenance,
    ...(luminanceEvidence === undefined ? {} : { luminanceEvidence }),
  });
}

function traceProvenanceGraph(graph: ProvenanceGraph): TracedProvenanceGraph {
  const visited = new Set<number>();
  const branches: Readonly<TracedContourPath>[] = [];
  const cycles: Readonly<TracedContourPath>[] = [];
  const pairings = buildJunctionPairings(graph);
  const orderedVertices = [...graph.vertices.values()].sort((first, second) =>
    comparePoints(first.point, second.point),
  );

  // Start at every unpaired incidence. Pairing straight-through luminance arms
  // makes compatible junction segments internal without inventing new edges.
  for (const vertex of orderedVertices) {
    for (const edgeId of vertex.edgeIds) {
      if (!visited.has(edgeId) && unpairedIncidence(pairings, vertex, edgeId)) {
        branches.push(traceFrom(graph, pairings, vertex, edgeId, visited));
      }
    }
  }

  // What remains consists of paired cycles. The first unvisited edge incident
  // to the row-major-smallest vertex fixes cycle direction.
  for (const vertex of orderedVertices) {
    const edgeId = vertex.edgeIds.find((candidate) => !visited.has(candidate));
    if (edgeId !== undefined) {
      const path = traceFrom(graph, pairings, vertex, edgeId, visited);
      if (path.closed) cycles.push(path);
      else branches.push(path);
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
  const evidenceByEdge = sourceEvidenceByEdge(graph);
  const luminance = traceProvenanceGraph(
    buildProvenanceGraph(edges, LUMINANCE_PROVENANCE, evidenceByEdge),
  );
  const alphaBoundary = traceProvenanceGraph(
    buildProvenanceGraph(edges, ALPHA_BOUNDARY_PROVENANCE, evidenceByEdge),
  );
  const paths = [
    ...[...luminance.branches, ...alphaBoundary.branches].sort(comparePaths),
    ...[...luminance.cycles, ...alphaBoundary.cycles].sort(comparePaths),
  ];
  return Object.freeze(paths);
}
