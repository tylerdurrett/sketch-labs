/**
 * Deterministic safety policy for Watercolor Forms.
 *
 * The primary cap is the bounded square analysis lattice. Every later geometry
 * cap is derived from its sample or canonical four-neighbor grid-edge bound,
 * making the relationship between memory/work limits visible and testable.
 */

const ANALYSIS_MAX_DIMENSION = 256
const MAX_SAMPLE_COUNT = ANALYSIS_MAX_DIMENSION * ANALYSIS_MAX_DIMENSION

/**
 * A width-by-height four-neighbor lattice has
 * `width * (height - 1) + height * (width - 1)` canonical adjacencies.
 * The largest permitted square therefore has this many, always `< 2 * samples`.
 */
const MAX_GRID_ADJACENCY_COUNT =
  2 * MAX_SAMPLE_COUNT - 2 * ANALYSIS_MAX_DIMENSION

const MAX_INITIAL_REGION_COUNT = MAX_SAMPLE_COUNT
const MAX_MERGE_COUNT = MAX_INITIAL_REGION_COUNT - 1
const MAX_RETAINED_BOUNDARY_SEGMENT_COUNT = MAX_GRID_ADJACENCY_COUNT
const MAX_BOUNDARY_PATH_COUNT = MAX_RETAINED_BOUNDARY_SEGMENT_COUNT
const MAX_PRIMITIVE_COUNT = MAX_BOUNDARY_PATH_COUNT

/**
 * Deterministic secondary work budgets. Queue entries and region updates are
 * bounded multiples of the complete canonical adjacency inventory; curve
 * points are bounded by the worst case of two endpoints per retained segment.
 */
const MAX_MERGE_QUEUE_ENTRY_COUNT = 8 * MAX_GRID_ADJACENCY_COUNT
const MAX_REGION_UPDATE_COUNT = 8 * MAX_GRID_ADJACENCY_COUNT
const MAX_CURVE_POINT_COUNT = 2 * MAX_RETAINED_BOUNDARY_SEGMENT_COUNT

export const WATERCOLOR_FORMS_LIMITS = Object.freeze({
  analysisMaxDimension: ANALYSIS_MAX_DIMENSION,
  maxSampleCount: MAX_SAMPLE_COUNT,
  maxInitialRegionCount: MAX_INITIAL_REGION_COUNT,
  maxGridAdjacencyCount: MAX_GRID_ADJACENCY_COUNT,
  maxMergeCount: MAX_MERGE_COUNT,
  maxMergeQueueEntryCount: MAX_MERGE_QUEUE_ENTRY_COUNT,
  maxRegionUpdateCount: MAX_REGION_UPDATE_COUNT,
  maxRetainedBoundarySegmentCount: MAX_RETAINED_BOUNDARY_SEGMENT_COUNT,
  maxBoundaryPathCount: MAX_BOUNDARY_PATH_COUNT,
  maxCurvePointCount: MAX_CURVE_POINT_COUNT,
  maxPrimitiveCount: MAX_PRIMITIVE_COUNT,
})

export type WatercolorFormsLimitName = keyof typeof WATERCOLOR_FORMS_LIMITS
