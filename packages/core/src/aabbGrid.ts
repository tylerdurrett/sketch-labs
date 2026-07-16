/** Axis-aligned bounding box in an arbitrary shared coordinate space. */
export interface AABB {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

/** Construction options for {@link UniformAabbGrid}. */
export interface UniformAabbGridOptions {
  /** Width and height of every square grid cell. Must be finite and positive. */
  readonly cellSize: number
  /** Maximum cells one AABB may occupy before using the overflow path. */
  readonly maxCellsPerAabb?: number
}

/** Immutable construction metrics for observing index effectiveness. */
export interface UniformAabbGridStats {
  readonly entryCount: number
  readonly indexedEntryCount: number
  readonly overflowEntryCount: number
  readonly unsafeEntryCount: number
  readonly cellCapOverflowEntryCount: number
  readonly occupiedCellCount: number
  readonly cellEntryCount: number
}

interface StoredAabb extends AABB {
  readonly ordinary: boolean
}

interface CellRange {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

const DEFAULT_MAX_CELLS_PER_AABB = 1024

function isOrdinary(aabb: AABB): boolean {
  return (
    Number.isFinite(aabb.minX) &&
    Number.isFinite(aabb.minY) &&
    Number.isFinite(aabb.maxX) &&
    Number.isFinite(aabb.maxY) &&
    aabb.minX <= aabb.maxX &&
    aabb.minY <= aabb.maxY
  )
}

/** Touching boundaries count as overlap. Call only for ordinary AABBs. */
function overlaps(a: AABB, b: AABB): boolean {
  return (
    a.minX <= b.maxX &&
    a.maxX >= b.minX &&
    a.minY <= b.maxY &&
    a.maxY >= b.minY
  )
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`
}

/**
 * A deterministic, exact broad-phase index for painter-ordered AABBs.
 *
 * Input positions are their painter indices. Queries return exactly the indices
 * whose ordinary AABBs overlap the query, plus unsafe entries which must be
 * retained conservatively. Results are always ascending and duplicate-free.
 *
 * Ordinary finite boxes are placed in every grid cell they touch. Boxes whose
 * cell coordinates cannot be represented safely, boxes spanning more than the
 * configured cap, and malformed/non-finite boxes use an overflow list. This
 * can reduce performance for pathological geometry, but never removes a
 * possible candidate. Likewise, an unsafe query falls back to every entry.
 */
export class UniformAabbGrid {
  readonly stats: UniformAabbGridStats

  private readonly entries: readonly StoredAabb[]
  private readonly cells = new Map<string, number[]>()
  private readonly overflowIndices: readonly number[]
  private readonly cellSize: number
  private readonly maxCellsPerAabb: number

  constructor(
    aabbs: readonly AABB[],
    options: UniformAabbGridOptions,
  ) {
    const { cellSize } = options
    const maxCellsPerAabb =
      options.maxCellsPerAabb ?? DEFAULT_MAX_CELLS_PER_AABB
    if (!Number.isFinite(cellSize) || cellSize <= 0) {
      throw new RangeError('UniformAabbGrid cellSize must be finite and positive')
    }
    if (
      !Number.isSafeInteger(maxCellsPerAabb) ||
      maxCellsPerAabb <= 0
    ) {
      throw new RangeError(
        'UniformAabbGrid maxCellsPerAabb must be a positive safe integer',
      )
    }

    this.cellSize = cellSize
    this.maxCellsPerAabb = maxCellsPerAabb
    this.entries = aabbs.map((aabb) => ({
      minX: aabb.minX,
      minY: aabb.minY,
      maxX: aabb.maxX,
      maxY: aabb.maxY,
      ordinary: isOrdinary(aabb),
    }))

    const overflowIndices: number[] = []
    let indexedEntryCount = 0
    let unsafeEntryCount = 0
    let cellCapOverflowEntryCount = 0
    let cellEntryCount = 0

    for (let index = 0; index < this.entries.length; index++) {
      const aabb = this.entries[index]!
      if (!aabb.ordinary) {
        overflowIndices.push(index)
        unsafeEntryCount++
        continue
      }

      const range = this.cellRange(aabb)
      if (range === null) {
        overflowIndices.push(index)
        unsafeEntryCount++
        continue
      }
      if (this.cellCountExceedsCap(range)) {
        overflowIndices.push(index)
        cellCapOverflowEntryCount++
        continue
      }

      indexedEntryCount++
      for (let y = range.minY; y <= range.maxY; y++) {
        for (let x = range.minX; x <= range.maxX; x++) {
          const key = cellKey(x, y)
          const bucket = this.cells.get(key)
          if (bucket === undefined) this.cells.set(key, [index])
          else bucket.push(index)
          cellEntryCount++
        }
      }
    }

    this.overflowIndices = overflowIndices
    this.stats = Object.freeze({
      entryCount: this.entries.length,
      indexedEntryCount,
      overflowEntryCount: overflowIndices.length,
      unsafeEntryCount,
      cellCapOverflowEntryCount,
      occupiedCellCount: this.cells.size,
      cellEntryCount,
    })
  }

  /** Return ascending, duplicate-free painter indices overlapping `query`. */
  query(query: AABB): number[] {
    if (!isOrdinary(query)) {
      return this.entries.map((_, index) => index)
    }

    const range = this.cellRange(query)
    if (range === null || this.cellCountExceedsCap(range)) {
      return this.scanAll(query)
    }

    const candidates = new Set<number>()
    for (let y = range.minY; y <= range.maxY; y++) {
      for (let x = range.minX; x <= range.maxX; x++) {
        const bucket = this.cells.get(cellKey(x, y))
        if (bucket === undefined) continue
        for (const index of bucket) candidates.add(index)
      }
    }

    for (const index of this.overflowIndices) candidates.add(index)

    const result: number[] = []
    for (const index of candidates) {
      const aabb = this.entries[index]!
      if (!aabb.ordinary || overlaps(aabb, query)) result.push(index)
    }
    result.sort((a, b) => a - b)
    return result
  }

  private scanAll(query: AABB): number[] {
    const result: number[] = []
    for (let index = 0; index < this.entries.length; index++) {
      const aabb = this.entries[index]!
      if (!aabb.ordinary || overlaps(aabb, query)) result.push(index)
    }
    return result
  }

  private cellRange(aabb: AABB): CellRange | null {
    const minX = Math.floor(aabb.minX / this.cellSize)
    const minY = Math.floor(aabb.minY / this.cellSize)
    const maxX = Math.floor(aabb.maxX / this.cellSize)
    const maxY = Math.floor(aabb.maxY / this.cellSize)
    if (
      !Number.isSafeInteger(minX) ||
      !Number.isSafeInteger(minY) ||
      !Number.isSafeInteger(maxX) ||
      !Number.isSafeInteger(maxY)
    ) {
      return null
    }
    return { minX, minY, maxX, maxY }
  }

  private cellCountExceedsCap(range: CellRange): boolean {
    const width = range.maxX - range.minX + 1
    const height = range.maxY - range.minY + 1
    return (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width > Math.floor(this.maxCellsPerAabb / height)
    )
  }
}
