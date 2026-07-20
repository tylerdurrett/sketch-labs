/**
 * Headless Image Asset values shared by every Harness environment.
 *
 * Fetching and decoding remain environment concerns (ADR-0014). Core receives
 * only synchronous, pre-resolved pixel records, so Sketch generation stays pure
 * and no browser, decoder, file-location, or worker-transfer concern enters this
 * package.
 */

import type {
  IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
  PreparedImageDetailAnalysis,
} from './imageDetailAnalysis'

/** The two ordinary RGBA8 storage types produced by browser and Node decoders. */
export type Rgba8Bytes = Uint8Array | Uint8ClampedArray

/**
 * One decoded raster in the exact representation consumed by core adapters.
 *
 * Contract:
 *
 * - `width` and `height` are positive safe integers.
 * - `data.length` is exactly `width * height * 4`.
 * - Bytes are row-major RGBA8: red, green, blue, alpha for each pixel.
 * - RGB channels are unassociated sRGB values. They are NOT linear-light and
 *   are NOT premultiplied by alpha.
 * - Alpha is straight/unpremultiplied coverage.
 *
 * Ownership stays with the resolving environment. Core borrows the record and
 * may retain its byte array for the lifetime of a derived Tone Source, but never
 * mutates or transfers it. The owner must therefore keep both the record and its
 * bytes immutable for that whole borrowed lifetime. `readonly` documents this
 * requirement, though JavaScript typed-array elements cannot be deeply frozen.
 * Studio main thread, workers, and later Node consumers each own an independently
 * decoded record; decoded bytes never cross the worker identity protocol.
 */
export interface DecodedPixels {
  readonly width: number
  readonly height: number
  readonly data: Readonly<Rgba8Bytes>
}

/**
 * Synchronously resolve one already-decoded Image Asset by stable logical ID.
 * A lookup used for one generation input must be deterministic: the same ID
 * resolves to the same immutable record throughout that input's lifetime.
 */
export type ImageAssetLookup = (
  id: string,
) => Readonly<DecodedPixels> | undefined

/**
 * Synchronously resolve one prepared analysis by both exact source identity and
 * exact analysis-definition identity. Preparation, fetching, and decoding stay
 * outside a pure Sketch capability call.
 */
export type PreparedImageDetailAnalysisLookup = (
  imageAssetId: string,
  analysisDefinitionId: typeof IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
) => Readonly<PreparedImageDetailAnalysis> | undefined

/** Pre-resolved, synchronous inputs an environment supplies to pure Sketch code. */
export interface SketchEnvironment {
  readonly imageAssets: ImageAssetLookup
  /** Optional prepared-detail lookup; its absence means no analysis is resolved. */
  readonly getPreparedImageDetailAnalysis?: PreparedImageDetailAnalysisLookup
}
