/**
 * Headless Watercolor Forms pipeline contracts.
 *
 * These records connect the independent region-first stages without exposing
 * Image Asset lookup, Sketch registration, rendering, or worker transport.
 * Collections and nested records are readonly by contract; stage
 * implementations must return immutable snapshots rather than mutable working
 * storage.
 */

import type { DecodedPixels } from '../../imageAssets'
import type { CoordinateSpace, Scene } from '../../scene'
import type { Point } from '../../types'
import type { WatercolorFormsControls } from './controls'
import type { WatercolorFormsLimitName } from './limits'

/** Bounded visible-raster signal retained by the region stages. */
export interface PreparedWatercolorRaster {
  /** Original decoded dimensions, retained for exact contain fitting. */
  readonly sourceWidth: number
  readonly sourceHeight: number
  /** Dimensions of the bounded row-major analysis lattice. */
  readonly width: number
  readonly height: number
  /** Visible, unassociated linear-sRGB channels in `[0, 1]`. */
  readonly linearRed: readonly number[]
  readonly linearGreen: readonly number[]
  readonly linearBlue: readonly number[]
  /** Visible linear luminance in `[0, 1]`, retained as independent evidence. */
  readonly luminance: readonly number[]
  /** Sampled straight-alpha coverage in `[0, 1]`. */
  readonly alpha: readonly number[]
  /** Exact-zero permission derived independently from the sampled color. */
  readonly positiveSupport: readonly boolean[]
}

/** Immutable visible statistics for one initial or merged region. */
export interface WatercolorRegionSummary {
  /** Stable deterministic identity. Initial region IDs precede merged IDs. */
  readonly id: number
  readonly sampleCount: number
  readonly visibleSampleCount: number
  readonly meanLinearRed: number
  readonly meanLinearGreen: number
  readonly meanLinearBlue: number
  readonly meanLuminance: number
  readonly meanAlpha: number
}

/**
 * One canonical lattice-edge boundary, owned once by its neighboring regions.
 *
 * `regionIds` is ascending and never represents the fitted image perimeter.
 * Endpoints are lattice-boundary vertices, not sample centers.
 */
export interface SharedBoundarySegment {
  readonly id: number
  readonly regionIds: readonly [number, number]
  readonly start: Readonly<Point>
  readonly end: Readonly<Point>
  /** Normalized visible color/luminance or meaningful alpha evidence. */
  readonly strength: number
  readonly provenance: 'visible-color' | 'alpha-boundary'
}

/** Fine deterministic partition from which the merge hierarchy begins. */
export interface InitialRegionPartition {
  readonly raster: Readonly<PreparedWatercolorRaster>
  /** Row-major initial region ID for every analysis sample. */
  readonly regionBySample: readonly number[]
  /** Stable ascending initial-region inventory. */
  readonly regions: readonly Readonly<WatercolorRegionSummary>[]
  /** Canonical shared segments; each four-neighbor adjacency appears at most once. */
  readonly sharedBoundarySegments: readonly Readonly<SharedBoundarySegment>[]
}

/** One stable event in the region hierarchy's deterministic merge order. */
export interface WatercolorRegionMerge {
  readonly leftRegionId: number
  readonly rightRegionId: number
  readonly mergedRegion: Readonly<WatercolorRegionSummary>
  /** Normalized neighbor similarity at the moment of this merge. */
  readonly similarity: number
  /** Normalized evidence carried by the consumed shared boundary. */
  readonly boundaryStrength: number
  /** Normalized resistance to unstable or over-large merging. */
  readonly stability: number
}

/** Complete or safely budget-limited hierarchy over one initial partition. */
export interface RegionHierarchy {
  readonly partition: Readonly<InitialRegionPartition>
  /** Initial summaries followed by stable merged-region summaries. */
  readonly regions: readonly Readonly<WatercolorRegionSummary>[]
  readonly merges: readonly Readonly<WatercolorRegionMerge>[]
  /**
   * False only when a deterministic work budget stopped hierarchy construction.
   * The recorded prefix remains valid and may produce conservative partial output.
   */
  readonly complete: boolean
}

/** Significant forms and their once-owned retained shared boundaries. */
export interface SelectedWatercolorForms {
  readonly hierarchy: Readonly<RegionHierarchy>
  /** Stable ascending IDs of regions surviving the authored hierarchy selection. */
  readonly regionIds: readonly number[]
  /** Retained segments remapped to surviving region IDs and kept in stable order. */
  readonly sharedBoundarySegments: readonly Readonly<SharedBoundarySegment>[]
}

/** One longest deterministic continuation through the selected boundary network. */
export interface WatercolorBoundaryPath {
  readonly points: readonly Readonly<Point>[]
  readonly closed: boolean
  /** Stable segment identities consumed exactly once by this path. */
  readonly boundarySegmentIds: readonly number[]
}

/** Why generation stopped; empty valid inputs still report `complete`. */
export type WatercolorFormsTermination =
  | 'complete'
  | 'invalid-input'
  | 'limit-reached'

/**
 * Immutable work and output accounting for safety tests and reference evidence.
 *
 * `limit-reached` means a structurally valid deterministic prefix may have been
 * emitted. `invalid-input` always fails closed and is therefore distinct.
 */
export interface WatercolorFormsDiagnostics {
  readonly termination: WatercolorFormsTermination
  readonly limitedBy: WatercolorFormsLimitName | null
  readonly analysisWidth: number
  readonly analysisHeight: number
  readonly sampleCount: number
  readonly initialRegionCount: number
  readonly gridAdjacencyCount: number
  readonly mergeCount: number
  readonly mergeQueueEntryCount: number
  readonly regionUpdateCount: number
  readonly selectedRegionCount: number
  readonly retainedBoundarySegmentCount: number
  readonly boundaryPathCount: number
  readonly curvePointCount: number
  readonly primitiveCount: number
}

/** Complete reusable input, independent of registered Sketch machinery. */
export interface WatercolorFormsGeneratorInput {
  readonly pixels: Readonly<DecodedPixels>
  readonly frame: Readonly<CoordinateSpace>
  readonly controls: Readonly<WatercolorFormsControls>
}

/** Ordinary vector output plus immutable bounded-work accounting. */
export interface WatercolorFormsGeneratorResult {
  readonly scene: Scene
  readonly diagnostics: Readonly<WatercolorFormsDiagnostics>
}

/** Pure deterministic Watercolor Forms capability boundary. */
export type WatercolorFormsGenerator = (
  input: Readonly<WatercolorFormsGeneratorInput>,
) => WatercolorFormsGeneratorResult
