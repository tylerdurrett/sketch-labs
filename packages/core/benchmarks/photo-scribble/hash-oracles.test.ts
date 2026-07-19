import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import type { DecodedPixels, SketchEnvironment } from '../../src/imageAssets'
import type { CoordinateSpace, Scene } from '../../src/scene'
import type { Params } from '../../src/sketch'
import {
  createPhotoScribbleSchema,
  createPhotoScribbleSource,
  generatePhotoScribbleArtwork,
} from '../../src/sketches/photo-scribble'
import type { ScribbleControls } from '../../src/scribbleStrategy'
import {
  reconcileLegacyPhotoScribbleParams,
  resolvePhotoScribbleBenchmark,
} from './benchmark-artwork'
import {
  CANONICAL_HASHED_KEYS,
  canonicalArtworkHashes,
  canonicalSceneHash,
  canonicalScribbleDiagnosticsHash,
  canonicalScribbleTargetHash,
  isExactPresetReproduction,
} from './hash-oracles'

interface FixtureRecord {
  readonly fixtureId: string
  readonly assetId: string
  readonly path: string
  readonly dimensions: { readonly width: number; readonly height: number }
}

interface ScenarioRecord {
  readonly scenarioId: string
  readonly fixtureId: string
  readonly seed: number
  readonly reseed: number
  readonly params: Params & Omit<ScribbleControls, 'stopPoint'>
}

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../../..')
const fixtures = JSON.parse(
  readFileSync(resolve(here, 'fixtures.json'), 'utf8'),
) as { readonly fixtures: readonly FixtureRecord[] }
const protocol = JSON.parse(
  readFileSync(resolve(here, 'protocol.json'), 'utf8'),
) as {
  readonly frame: CoordinateSpace
  readonly scenarios: readonly ScenarioRecord[]
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft
  const leftDistance = Math.abs(estimate - left)
  const aboveDistance = Math.abs(estimate - above)
  const upperLeftDistance = Math.abs(estimate - upperLeft)
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
    ? left
    : aboveDistance <= upperLeftDistance
      ? above
      : upperLeft
}

/** Decode the committed non-interlaced RGBA8 protocol fixtures for core. */
function decodeFixture(fixture: FixtureRecord): DecodedPixels {
  const bytes = readFileSync(resolve(root, fixture.path))
  const chunks: Buffer[] = []
  let offset = 8
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii')
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (
      type === 'IHDR' &&
      !data.subarray(8, 13).equals(Buffer.from([8, 6, 0, 0, 0]))
    ) {
      throw new Error(`${fixture.fixtureId} is not non-interlaced RGBA8`)
    }
    if (type === 'IDAT') chunks.push(data)
    offset += 12 + length
  }

  const inflated = inflateSync(Buffer.concat(chunks))
  const stride = fixture.dimensions.width * 4
  const previous = Buffer.alloc(stride)
  const current = Buffer.alloc(stride)
  const rgba = Buffer.alloc(stride * fixture.dimensions.height)
  let sourceOffset = 0

  for (let row = 0; row < fixture.dimensions.height; row += 1) {
    const filter = inflated[sourceOffset++]
    if (filter === undefined || filter > 4) {
      throw new Error(`unsupported PNG row filter ${filter}`)
    }
    for (let index = 0; index < stride; index += 1) {
      const encoded = inflated[sourceOffset + index]!
      const left = index >= 4 ? current[index - 4]! : 0
      const above = previous[index]!
      const upperLeft = index >= 4 ? previous[index - 4]! : 0
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : paeth(left, above, upperLeft)
      current[index] = (encoded + predictor) & 0xff
    }
    sourceOffset += stride
    current.copy(rgba, row * stride)
    previous.set(current)
  }

  if (sourceOffset !== inflated.length) {
    throw new Error(`${fixture.fixtureId} has unexpected decoded bytes`)
  }
  return {
    width: fixture.dimensions.width,
    height: fixture.dimensions.height,
    data: rgba,
  }
}

function controlsFrom(
  params: Readonly<ScenarioRecord['params']>,
): ScribbleControls {
  const reconciled = reconcileLegacyPhotoScribbleParams(params)
  return {
    pathDensity: reconciled.pathDensity,
    scribbleScale: reconciled.scribbleScale,
    momentum: reconciled.momentum,
    chaos: reconciled.chaos,
    toneFidelity: reconciled.toneFidelity,
    stopPoint: reconciled.stopPoint,
  }
}

function centeredTargetHash(scenario: ScenarioRecord): string {
  const fixture = fixtures.fixtures.find(
    ({ fixtureId }) => fixtureId === scenario.fixtureId,
  )
  if (fixture === undefined) {
    throw new Error(`missing fixture ${scenario.fixtureId}`)
  }
  const environment: SketchEnvironment = {
    imageAssets: (id) =>
      id === fixture.assetId ? decodeFixture(fixture) : undefined,
  }
  const schema = createPhotoScribbleSchema(fixture.assetId)
  const centeredParams = {
    ...scenario.params,
    toneGamma: 0.5,
    toneContrast: 0.5,
  }
  const source = createPhotoScribbleSource(
    centeredParams,
    protocol.frame,
    schema,
    environment,
  )
  return canonicalScribbleTargetHash(
    source,
    protocol.frame,
    controlsFrom(scenario.params),
  )
}

const SYNTHETIC_ASSET_ID = 'issue-336-hash-fixture'
const SYNTHETIC_FRAME = Object.freeze({ width: 48, height: 32 })
const SYNTHETIC_PIXELS: DecodedPixels = Object.freeze({
  width: 4,
  height: 3,
  data: Uint8Array.from([
    0, 0, 0, 255, 96, 96, 96, 255, 255, 255, 255, 255, 255, 0, 0, 128,
    0, 0, 255, 255, 32, 32, 32, 255, 0, 255, 0, 192, 0, 0, 0, 255,
    255, 255, 255, 0, 128, 128, 128, 64, 255, 0, 255, 255, 16, 16, 16, 255,
  ]),
})
const SYNTHETIC_PARAMS = Object.freeze({
  imageAsset: SYNTHETIC_ASSET_ID,
  toneGamma: 0.5,
  toneContrast: 0.5,
  pathDensity: 0.5,
  scribbleScale: 2,
  momentum: 0.5,
  chaos: 0.75,
  toneFidelity: 0,
  stopPoint: 100,
}) satisfies Params & ScribbleControls
const SYNTHETIC_PRIMARY_SEED = 336_001
const SYNTHETIC_RESEED = 336_002

function syntheticArtwork(seed: number) {
  const schema = createPhotoScribbleSchema(SYNTHETIC_ASSET_ID)
  return generatePhotoScribbleArtwork(
    SYNTHETIC_PARAMS,
    seed,
    SYNTHETIC_FRAME,
    schema,
    undefined,
    {
      imageAssets: (id) =>
        id === SYNTHETIC_ASSET_ID ? SYNTHETIC_PIXELS : undefined,
    },
  )
}

/**
 * Exercise one complete deterministic input. Seed participates in artwork
 * routing, while the target is intentionally derived only from the production
 * source, frame, Tone controls, and Scribble lattice controls.
 */
function syntheticEvidence(seed: number) {
  const schema = createPhotoScribbleSchema(SYNTHETIC_ASSET_ID)
  const environment: SketchEnvironment = {
    imageAssets: (id) =>
      id === SYNTHETIC_ASSET_ID ? SYNTHETIC_PIXELS : undefined,
  }
  const source = createPhotoScribbleSource(
    SYNTHETIC_PARAMS,
    SYNTHETIC_FRAME,
    schema,
    environment,
  )
  return {
    seed,
    target: canonicalScribbleTargetHash(
      source,
      SYNTHETIC_FRAME,
      controlsFrom(SYNTHETIC_PARAMS),
    ),
    artwork: generatePhotoScribbleArtwork(
      SYNTHETIC_PARAMS,
      seed,
      SYNTHETIC_FRAME,
      schema,
      undefined,
      environment,
    ),
  }
}

const COMPLETE_SCENE: Scene = {
  space: { width: 100, height: 80 },
  background: { color: '#fefefe' },
  primitives: [
    {
      points: [
        [1.25, 2.5],
        [30.75, 4.125],
        [10.5, 25.875],
      ],
      closed: true,
      fill: { color: '#123456' },
      stroke: { color: '#abcdef', width: 0.75 },
      hiddenLineRole: 'both',
    },
    {
      points: [
        [50, 60],
        [70, 65],
      ],
      closed: false,
      stroke: { color: 'black', width: 1.5 },
      hiddenLineRole: 'source',
    },
  ],
}

function mutateCompleteScene(mutate: (scene: Scene) => void): Scene {
  const scene = structuredClone(COMPLETE_SCENE)
  mutate(scene)
  return scene
}

describe('Photo Scribble canonical hash oracles', () => {
  it('reconciles a legacy stop point before target and artwork hashing', () => {
    const { stopPoint: _stopPoint, ...legacyParams } = SYNTHETIC_PARAMS
    const environment: SketchEnvironment = {
      imageAssets: (id) =>
        id === SYNTHETIC_ASSET_ID ? SYNTHETIC_PIXELS : undefined,
    }
    const legacy = resolvePhotoScribbleBenchmark(
      legacyParams,
      SYNTHETIC_FRAME,
      environment,
    )
    const current = resolvePhotoScribbleBenchmark(
      SYNTHETIC_PARAMS,
      SYNTHETIC_FRAME,
      environment,
    )

    expect(legacy.controls).toEqual(current.controls)
    expect(legacy.productionLimits).toEqual(current.productionLimits)
    expect(legacy.model.samples()).toEqual(current.model.samples())
    expect(
      canonicalScribbleTargetHash(
        legacy.source,
        SYNTHETIC_FRAME,
        legacy.controls,
      ),
    ).toBe(
      canonicalScribbleTargetHash(
        current.source,
        SYNTHETIC_FRAME,
        current.controls,
      ),
    )

    const schema = createPhotoScribbleSchema(SYNTHETIC_ASSET_ID)
    const legacyArtwork = generatePhotoScribbleArtwork(
      legacyParams,
      SYNTHETIC_PRIMARY_SEED,
      SYNTHETIC_FRAME,
      schema,
      undefined,
      environment,
    )
    const currentArtwork = syntheticArtwork(SYNTHETIC_PRIMARY_SEED)
    expect(canonicalArtworkHashes(legacyArtwork)).toEqual(
      canonicalArtworkHashes(currentArtwork),
    )
    expect(legacyArtwork).toEqual(currentArtwork)
  })

  it('pins the pre-change centered-control target for both fixed control scenarios', () => {
    expect(
      protocol.scenarios.every(
        (scenario) => scenario.params.stopPoint === undefined,
      ),
    ).toBe(true)
    expect(
      protocol.scenarios.every(
        (scenario) =>
          reconcileLegacyPhotoScribbleParams(scenario.params).stopPoint === 100,
      ),
    ).toBe(true)
    const scenarioById = new Map(
      protocol.scenarios.map((scenario) => [scenario.scenarioId, scenario]),
    )
    const hashes = Object.fromEntries(
      ['flowers-opaque-control', 'pinecone-dark-alpha-control'].map(
        (scenarioId) => {
          const scenario = scenarioById.get(scenarioId)
          if (scenario === undefined) {
            throw new Error(`missing scenario ${scenarioId}`)
          }
          return [scenarioId, centeredTargetHash(scenario)]
        },
      ),
    )

    expect(hashes).toEqual({
      'flowers-opaque-control':
        '2db86d269fc1310e09b12577e2ad14e9d9d17eaeb79bf05263941bcda6da5b70',
      'pinecone-dark-alpha-control':
        'a25d47810e9be35021694b74bfa654c7b4cd71acbf3cdd264478b9a0567dc983',
    })
  })

  it('keeps the target seed-independent while a fixed re-seed changes routing', () => {
    const primary = syntheticEvidence(SYNTHETIC_PRIMARY_SEED)
    const reseed = syntheticEvidence(SYNTHETIC_RESEED)
    const primaryHashes = canonicalArtworkHashes(primary.artwork)
    const reseedHashes = canonicalArtworkHashes(reseed.artwork)

    expect(primary.seed).not.toBe(reseed.seed)
    expect(reseed.target).toBe(primary.target)
    expect({
      primaryTarget: primary.target,
      primaryHashes,
      reseedHashes,
    }).toEqual({
      primaryTarget:
        'a7bc92a8e96b42aeefdff1671245528a6b907ea9c1537ed18b33b3c65f853679',
      primaryHashes: {
        scene:
          '31148669c471fb3327cc84003e4ab1150f58e1a5148299dab538f59332254ee1',
        diagnostics:
          '0246b9f290c5e563940e9fac63d14553f22a3c0b80a1db830daecd2c899e37b9',
      },
      reseedHashes: {
        scene:
          '2e9b79b8909d0eecb6b3c28d64c6c7c944eef141de8fab6423d29b8c991dccb1',
        diagnostics:
          '20c86a128d4c57259a3ce27c40557a110c9cd0e47cda954d878630ea88b6687b',
      },
    })
    expect(reseedHashes.scene).not.toBe(primaryHashes.scene)
  })

  it('hashes every Scene contract field and remains sensitive to each value', () => {
    expect(CANONICAL_HASHED_KEYS).toEqual({
      scene: { space: true, primitives: true, background: true },
      coordinateSpace: { width: true, height: true },
      primitive: {
        points: true,
        closed: true,
        fill: true,
        stroke: true,
        hiddenLineRole: true,
      },
      fill: { color: true },
      stroke: { color: true, width: true },
      scribbleDiagnostics: {
        termination: true,
        residualError: true,
        pathLength: true,
        polylineCount: true,
        penLiftCount: true,
      },
    })

    const referenceHash = canonicalSceneHash(COMPLETE_SCENE)
    const mutations = [
      mutateCompleteScene((scene) => {
        scene.space.width += 1
      }),
      mutateCompleteScene((scene) => {
        scene.space.height += 1
      }),
      mutateCompleteScene((scene) => {
        scene.background = { color: '#ffffff' }
      }),
      mutateCompleteScene((scene) => {
        delete scene.background
      }),
      mutateCompleteScene((scene) => {
        scene.primitives[0]!.fill = { color: '#654321' }
      }),
      mutateCompleteScene((scene) => {
        delete scene.primitives[0]!.fill
      }),
      mutateCompleteScene((scene) => {
        scene.primitives[0]!.stroke = { color: '#fedcba', width: 0.75 }
      }),
      mutateCompleteScene((scene) => {
        scene.primitives[0]!.stroke = { color: '#abcdef', width: 0.5 }
      }),
      mutateCompleteScene((scene) => {
        delete scene.primitives[0]!.stroke
      }),
      mutateCompleteScene((scene) => {
        scene.primitives[0]!.closed = false
      }),
      mutateCompleteScene((scene) => {
        delete scene.primitives[0]!.closed
      }),
      mutateCompleteScene((scene) => {
        scene.primitives[0]!.hiddenLineRole = 'source'
      }),
      mutateCompleteScene((scene) => {
        delete scene.primitives[0]!.hiddenLineRole
      }),
      mutateCompleteScene((scene) => {
        scene.primitives.reverse()
      }),
      mutateCompleteScene((scene) => {
        scene.primitives[0]!.points[0]![0] += Number.EPSILON
      }),
      mutateCompleteScene((scene) => {
        scene.primitives[0]!.points.reverse()
      }),
    ]

    expect(referenceHash).toBe(
      'f9b13945f401525f210a6e7d58b2e425503cac67d5aa1dc20c500ac8c55ca68e',
    )
    for (const mutation of mutations) {
      expect(canonicalSceneHash(mutation)).not.toBe(referenceHash)
    }
  })

  it('repeats identical inputs exactly and requires Scene plus diagnostics equality', () => {
    const first = syntheticArtwork(SYNTHETIC_PRIMARY_SEED)
    const repeated = syntheticArtwork(SYNTHETIC_PRIMARY_SEED)
    expect(canonicalArtworkHashes(repeated)).toEqual(
      canonicalArtworkHashes(first),
    )
    expect(isExactPresetReproduction(first, repeated)).toBe(true)

    const changedDiagnostics = {
      ...repeated,
      diagnostics: {
        ...repeated.diagnostics,
        residualError: repeated.diagnostics.residualError + Number.EPSILON,
      },
    }
    expect(canonicalSceneHash(changedDiagnostics.scene)).toBe(
      canonicalSceneHash(first.scene),
    )
    expect(isExactPresetReproduction(first, changedDiagnostics)).toBe(false)

    const changedScene = {
      ...repeated,
      scene: {
        ...repeated.scene,
        space: {
          ...repeated.scene.space,
          width: repeated.scene.space.width + 1,
        },
      },
    }
    expect(canonicalScribbleDiagnosticsHash(changedScene.diagnostics)).toBe(
      canonicalScribbleDiagnosticsHash(first.diagnostics),
    )
    expect(isExactPresetReproduction(first, changedScene)).toBe(false)
  })

  it('excludes compute time from the canonical diagnostics hash', () => {
    const diagnostics = syntheticArtwork(SYNTHETIC_PRIMARY_SEED).diagnostics
    const firstObservation = { ...diagnostics, computeTimeMs: 10 }
    const secondObservation = { ...diagnostics, computeTimeMs: 999 }
    expect(canonicalScribbleDiagnosticsHash(firstObservation)).toBe(
      canonicalScribbleDiagnosticsHash(secondObservation),
    )
  })
})
