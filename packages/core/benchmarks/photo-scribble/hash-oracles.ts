/**
 * Benchmark-only exact hash oracles for the issue #336 browser review.
 *
 * These helpers deliberately live outside `src/`: they describe evidence
 * encodings, not a product or package-root contract. Values are written with
 * explicit field tags and big-endian IEEE-754 numbers, so hashes do not depend
 * on object insertion order, JSON formatting, or a host's byte order.
 */

import { createHash, type Hash } from 'node:crypto'

import type {
  CoordinateSpace,
  Fill,
  Primitive,
  Scene,
  Stroke,
} from '../../src/scene'
import type {
  ScribbleArtwork,
  ScribbleDiagnostics,
} from '../../src/sketch'
import { createScribbleModel } from '../../src/scribbleStrategy/model'
import type { ScribbleControls } from '../../src/scribbleStrategy/types'
import type { ToneSource } from '../../src/shadingFields'

const textEncoder = new TextEncoder()

/**
 * Compile-time contract sentinels for every record encoded below.
 *
 * Adding a field to one of these production records fails the focused
 * benchmark typecheck until the canonical encoding and this inventory are
 * updated together. Exported only from this benchmark module so tests can also
 * pin the inventories; none is part of the package-root contract.
 */
export const CANONICAL_HASHED_KEYS = Object.freeze({
  scene: {
    space: true,
    primitives: true,
    background: true,
  } as const satisfies Record<keyof Scene, true>,
  coordinateSpace: {
    width: true,
    height: true,
  } as const satisfies Record<keyof CoordinateSpace, true>,
  primitive: {
    points: true,
    closed: true,
    fill: true,
    stroke: true,
    hiddenLineRole: true,
  } as const satisfies Record<keyof Primitive, true>,
  fill: {
    color: true,
  } as const satisfies Record<keyof Fill, true>,
  stroke: {
    color: true,
    width: true,
  } as const satisfies Record<keyof Stroke, true>,
  scribbleDiagnostics: {
    termination: true,
    residualError: true,
    pathLength: true,
    polylineCount: true,
    penLiftCount: true,
  } as const satisfies Record<keyof ScribbleDiagnostics, true>,
})

class CanonicalHash {
  readonly #hash: Hash = createHash('sha256')
  readonly #numberBytes = new Uint8Array(8)
  readonly #numberView = new DataView(this.#numberBytes.buffer)

  tag(value: string): void {
    const bytes = textEncoder.encode(value)
    this.uint32(bytes.byteLength)
    this.#hash.update(bytes)
  }

  byte(value: number): void {
    this.#hash.update(Uint8Array.of(value))
  }

  uint32(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new Error(`canonical hash integer is outside uint32: ${value}`)
    }
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint32(0, value, false)
    this.#hash.update(bytes)
  }

  number(value: number): void {
    this.#numberView.setFloat64(0, value, false)
    this.#hash.update(this.#numberBytes)
  }

  optional<T>(value: T | undefined, write: (present: T) => void): void {
    this.byte(value === undefined ? 0 : 1)
    if (value !== undefined) write(value)
  }

  digest(): string {
    return this.#hash.digest('hex')
  }
}

/**
 * Hash the exact target presented to Scribble at its production lattice.
 *
 * `createScribbleModel` owns control normalization, lattice resolution, sample
 * positions, and bounded source sampling. Its snapshots are already stable
 * row-major values. Coverage and residual are intentionally absent: this is an
 * input-target oracle, independent of routing, seed, or execution limits.
 */
export function canonicalScribbleTargetHash(
  source: ToneSource,
  frame: Readonly<CoordinateSpace>,
  controls: Readonly<ScribbleControls>,
): string {
  const model = createScribbleModel(source, frame, controls)
  const { lattice } = model
  const hash = new CanonicalHash()

  hash.tag('photo-scribble-target-v1')
  hash.tag('frame-width')
  hash.number(frame.width)
  hash.tag('frame-height')
  hash.number(frame.height)
  hash.tag('lattice-frame-width')
  hash.number(lattice.frame.width)
  hash.tag('lattice-frame-height')
  hash.number(lattice.frame.height)
  hash.tag('lattice-columns')
  hash.number(lattice.columns)
  hash.tag('lattice-rows')
  hash.number(lattice.rows)
  hash.tag('lattice-cell-width')
  hash.number(lattice.cellWidth)
  hash.tag('lattice-cell-height')
  hash.number(lattice.cellHeight)
  hash.tag('lattice-cell-area')
  hash.number(lattice.cellArea)
  hash.tag('lattice-sample-count')
  hash.number(lattice.sampleCount)
  hash.tag('row-major-tone-permission-effective-tone')

  const samples = model.samples()
  if (samples.length !== lattice.sampleCount) {
    throw new Error(
      `Scribble lattice declared ${lattice.sampleCount} samples, received ${samples.length}`,
    )
  }
  for (const sample of samples) {
    hash.number(sample.tone)
    hash.number(sample.permission)
    hash.number(sample.tone * sample.permission)
  }

  return hash.digest()
}

/** Hash every current Scene field and every coordinate in painter's order. */
export function canonicalSceneHash(scene: Readonly<Scene>): string {
  const hash = new CanonicalHash()
  hash.tag('scene-v1')
  hash.tag('space-width')
  hash.number(scene.space.width)
  hash.tag('space-height')
  hash.number(scene.space.height)
  hash.tag('background')
  hash.optional(scene.background, (background) => hash.tag(background.color))
  hash.tag('primitives')
  hash.uint32(scene.primitives.length)

  for (const primitive of scene.primitives) {
    hash.tag('primitive')
    hash.optional(primitive.closed, (closed) => hash.byte(closed ? 1 : 0))
    hash.optional(primitive.fill, (fill) => hash.tag(fill.color))
    hash.optional(primitive.stroke, (stroke) => {
      hash.tag(stroke.color)
      hash.number(stroke.width)
    })
    hash.optional(primitive.hiddenLineRole, (role) => hash.tag(role))
    hash.uint32(primitive.points.length)
    for (const point of primitive.points) {
      hash.number(point[0])
      hash.number(point[1])
    }
  }

  return hash.digest()
}

/**
 * Hash deterministic Scribble diagnostics only. Timing and other observation
 * metadata are excluded by selecting the five production diagnostic fields.
 */
export function canonicalScribbleDiagnosticsHash(
  diagnostics: Readonly<ScribbleDiagnostics>,
): string {
  const hash = new CanonicalHash()
  hash.tag('scribble-diagnostics-v1')
  hash.tag('termination')
  hash.tag(diagnostics.termination)
  hash.tag('residual-error')
  hash.number(diagnostics.residualError)
  hash.tag('path-length')
  hash.number(diagnostics.pathLength)
  hash.tag('polyline-count')
  hash.number(diagnostics.polylineCount)
  hash.tag('pen-lift-count')
  hash.number(diagnostics.penLiftCount)
  return hash.digest()
}

export interface CanonicalArtworkHashes {
  readonly scene: string
  readonly diagnostics: string
}

/** The two exact hashes a saved Preset must reproduce after reload. */
export function canonicalArtworkHashes(
  artwork: Readonly<ScribbleArtwork>,
): CanonicalArtworkHashes {
  return Object.freeze({
    scene: canonicalSceneHash(artwork.scene),
    diagnostics: canonicalScribbleDiagnosticsHash(artwork.diagnostics),
  })
}

/** Exact Preset reproduction means both Scene and diagnostics hashes match. */
export function isExactPresetReproduction(
  expected: Readonly<ScribbleArtwork>,
  actual: Readonly<ScribbleArtwork>,
): boolean {
  const expectedHashes = canonicalArtworkHashes(expected)
  const actualHashes = canonicalArtworkHashes(actual)
  return (
    expectedHashes.scene === actualHashes.scene &&
    expectedHashes.diagnostics === actualHashes.diagnostics
  )
}
