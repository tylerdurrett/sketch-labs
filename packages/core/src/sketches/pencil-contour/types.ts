/**
 * Headless Pencil Contour pipeline contracts.
 *
 * Image Asset lookup, Sketch params, registration, rendering, and worker
 * transport stay outside this boundary. The reusable generator receives
 * decoded pixels directly and returns ordinary Scene geometry.
 */

import type { DecodedPixels } from '../../imageAssets'
import type { CoordinateSpace, Scene } from '../../scene'
import type { Point } from '../../types'
import type { PencilContourControls } from './controls'

/** @internal Bounded raster signal retained between analysis stages. */
export interface AnalyzedRaster {
  /** Original decoded dimensions, retained for exact contain fitting. */
  readonly sourceWidth: number
  readonly sourceHeight: number
  /** Dimensions of the bounded row-major analysis lattice. */
  readonly width: number
  readonly height: number
  /** Visible, unassociated linear luminance in `[0, 1]`. */
  readonly luminance: readonly number[]
  /** Independently analyzed alpha coverage in `[0, 1]`. */
  readonly alpha: readonly number[]
  /** Exact-zero permission derived from the sampled straight-alpha field. */
  readonly positiveSupport: readonly boolean[]
}

/** A structural edge derived from visible luminance variation. */
export interface LuminanceEdgeProvenance {
  readonly kind: 'luminance'
}

/** A meaningful internal transition in alpha coverage. */
export interface AlphaBoundaryEdgeProvenance {
  readonly kind: 'alpha-boundary'
}

/**
 * Why an edge exists. Keeping alpha boundaries distinct prevents later cleanup
 * from treating permission geometry as interchangeable luminance texture.
 */
export type EdgeProvenance =
  | LuminanceEdgeProvenance
  | AlphaBoundaryEdgeProvenance

/** @internal One deterministic segment in analysis-lattice coordinates. */
export interface LocalizedEdge {
  readonly start: Readonly<Point>
  readonly end: Readonly<Point>
  readonly provenance: Readonly<EdgeProvenance>
}

/** @internal Stable edge order and coordinate extent passed into tracing. */
export interface LocalizedEdgeGraph {
  readonly width: number
  readonly height: number
  readonly edges: readonly Readonly<LocalizedEdge>[]
}

/**
 * @internal One traced contour with explicit topology and source permission.
 *
 * `closed` is carried from tracing rather than inferred by comparing points;
 * cleanup may remove or move endpoints without changing path topology.
 */
export interface TracedContourPath {
  readonly points: readonly Readonly<Point>[]
  readonly closed: boolean
  readonly provenance: Readonly<EdgeProvenance>
}

/** Complete reusable input, independent of registered Sketch machinery. */
export interface PencilContourGeneratorInput {
  readonly pixels: Readonly<DecodedPixels>
  readonly frame: Readonly<CoordinateSpace>
  readonly controls: Readonly<PencilContourControls>
}

/** Ordinary vector output reusable by Sketches and later compositions. */
export interface PencilContourGeneratorResult {
  readonly scene: Scene
}

/** Pure deterministic Pencil Contour capability boundary. */
export type PencilContourGenerator = (
  input: Readonly<PencilContourGeneratorInput>,
) => PencilContourGeneratorResult
