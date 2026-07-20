import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { resolveCompositionFrame } from '../src/compositionFrame'
import {
  IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
  prepareImageDetailAnalysis,
} from '../src/imageDetailAnalysis'
import { photoScribble } from '../src/sketches/photo-scribble'

const IMAGE_ASSET_ID = 'img-0525-9cded1ad73bb'
const IMAGE_PATH = fileURLToPath(
  new URL(
    '../../../assets/image-assets/img-0525-9cded1ad73bb.png',
    import.meta.url,
  ),
)
const SEED = 8408904470317508

// This is intentionally explicit rather than loaded from the Preset. A later
// Preset edit must not silently change the workload used to compare candidates.
const DETAIL_PARAMS = Object.freeze({
  imageAsset: IMAGE_ASSET_ID,
  toneContrast: 0.77,
  tonePivot: 1,
  toneGamma: 0.5,
  detailSensitivity: 0.5,
  detailInfluence: 0.5,
  pathDensity: 17.6,
  scribbleScale: 0.55,
  momentum: 0.75,
  chaos: 0.25,
  toneFidelity: 0.99,
  stopPoint: 100,
})
const UNIFORM_PARAMS = Object.freeze({ ...DETAIL_PARAMS, detailInfluence: 0 })

// The Preset's 200 x 155 mm profile has 10 mm insets on every edge, yielding
// the 180 x 135 (4:3) drawable area from which Studio derives this exact frame.
const FRAME = Object.freeze(resolveCompositionFrame(4 / 3))
const DEFAULT_SAMPLES = 5
const DEFAULT_WARMUPS = 1
const EXPECTED_IMAGE_WIDTH = 2048
const EXPECTED_IMAGE_HEIGHT = 1536

// Filled in from the first independently verified run. The benchmark refuses
// a speedup that changes termination, residual, diagnostics, or any coordinate.
const EXPECTED_DETAIL_CHECKSUM = 'f822710f351bf391'
const EXPECTED_UNIFORM_CHECKSUM = 'e9502e94cb2ff101'
const EXPECTED_DETAIL_WORK_UNITS = 64251
const EXPECTED_UNIFORM_WORK_UNITS = 178765
const EXPECTED_DETAIL_POLYLINES = 657
const EXPECTED_DETAIL_POINTS = 256882
const EXPECTED_UNIFORM_POLYLINES = 806
const EXPECTED_UNIFORM_POINTS = 714988

function readNonNegativeInteger(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer; received ${raw}`)
  }
  return parsed
}

function readPositiveInteger(name, fallback) {
  const parsed = readNonNegativeInteger(name, fallback)
  if (parsed < 1) throw new Error(`${name} must be an integer >= 1`)
  return parsed
}

function percentile(sorted, fraction) {
  return sorted[Math.ceil(sorted.length * fraction) - 1]
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  }
}

function formatMs(value) {
  return `${value.toFixed(2)} ms`
}

function report(label, durations) {
  const result = stats(durations)
  console.log(
    `${label.padEnd(34)} median ${formatMs(result.median).padStart(11)}  p95 ${formatMs(result.p95).padStart(11)}  n=${durations.length}`,
  )
}

function paeth(left, above, upperLeft) {
  const prediction = left + above - upperLeft
  const leftDistance = Math.abs(prediction - left)
  const aboveDistance = Math.abs(prediction - above)
  const upperLeftDistance = Math.abs(prediction - upperLeft)
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left
  }
  return aboveDistance <= upperLeftDistance ? above : upperLeft
}

/** Decode the committed non-interlaced RGBA8 fixture without a native addon. */
function decodeRgba8Png(path) {
  const file = readFileSync(path)
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
  expect(file.subarray(0, 8)).toEqual(Buffer.from(signature))

  let offset = 8
  let width
  let height
  const compressed = []
  while (offset < file.length) {
    const length = file.readUInt32BE(offset)
    const type = file.toString('ascii', offset + 4, offset + 8)
    const data = file.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) {
        throw new Error('benchmark fixture must be non-interlaced RGBA8 PNG')
      }
    } else if (type === 'IDAT') {
      compressed.push(data)
    } else if (type === 'IEND') {
      break
    }
  }
  if (width === undefined || height === undefined || compressed.length === 0) {
    throw new Error('benchmark fixture is missing PNG image data')
  }

  const bytesPerPixel = 4
  const rowBytes = width * bytesPerPixel
  const inflated = inflateSync(Buffer.concat(compressed))
  if (inflated.length !== height * (rowBytes + 1)) {
    throw new Error('benchmark fixture has an unexpected decoded byte count')
  }

  const rgba = new Uint8Array(width * height * bytesPerPixel)
  let sourceOffset = 0
  for (let row = 0; row < height; row++) {
    const filter = inflated[sourceOffset++]
    const outputOffset = row * rowBytes
    for (let columnByte = 0; columnByte < rowBytes; columnByte++) {
      const encoded = inflated[sourceOffset++]
      const left =
        columnByte < bytesPerPixel
          ? 0
          : rgba[outputOffset + columnByte - bytesPerPixel]
      const above =
        row === 0 ? 0 : rgba[outputOffset + columnByte - rowBytes]
      const upperLeft =
        row === 0 || columnByte < bytesPerPixel
          ? 0
          : rgba[outputOffset + columnByte - rowBytes - bytesPerPixel]
      let predictor
      if (filter === 0) predictor = 0
      else if (filter === 1) predictor = left
      else if (filter === 2) predictor = above
      else if (filter === 3) predictor = Math.floor((left + above) / 2)
      else if (filter === 4) predictor = paeth(left, above, upperLeft)
      else throw new Error(`unsupported PNG row filter ${filter}`)
      rgba[outputOffset + columnByte] = (encoded + predictor) & 0xff
    }
  }
  return Object.freeze({ width, height, data: rgba })
}

function fnv64() {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  const bytes = new Uint8Array(8)
  const view = new DataView(bytes.buffer)

  const byte = (value) => {
    hash ^= BigInt(value)
    hash = (hash * prime) & mask
  }
  const number = (value) => {
    view.setFloat64(0, value, false)
    for (const valueByte of bytes) byte(valueByte)
  }
  const string = (value) => {
    number(value.length)
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index)
      byte(code >>> 8)
      byte(code & 0xff)
    }
  }
  return {
    number,
    string,
    digest: () => hash.toString(16).padStart(16, '0'),
  }
}

function artworkChecksum(artwork) {
  const hash = fnv64()
  const { scene, diagnostics } = artwork
  hash.number(scene.space.width)
  hash.number(scene.space.height)
  hash.number(scene.background === undefined ? 0 : 1)
  if (scene.background !== undefined) hash.string(scene.background.color)
  hash.number(scene.primitives.length)
  for (const primitive of scene.primitives) {
    hash.number(primitive.closed === true ? 1 : 0)
    hash.number(primitive.fill === undefined ? 0 : 1)
    if (primitive.fill !== undefined) hash.string(primitive.fill.color)
    hash.number(primitive.stroke === undefined ? 0 : 1)
    if (primitive.stroke !== undefined) {
      hash.string(primitive.stroke.color)
      hash.number(primitive.stroke.width)
    }
    hash.number(primitive.hiddenLineRole === undefined ? 0 : 1)
    if (primitive.hiddenLineRole !== undefined) {
      hash.string(primitive.hiddenLineRole)
    }
    hash.number(primitive.points.length)
    for (const [x, y] of primitive.points) {
      hash.number(x)
      hash.number(y)
    }
  }
  hash.string(diagnostics.termination)
  hash.string(diagnostics.fidelity.kind)
  hash.number(diagnostics.fidelity.residualError)
  hash.number(diagnostics.pathLength)
  hash.number(diagnostics.polylineCount)
  hash.number(diagnostics.penLiftCount)
  return hash.digest()
}

function artworkCounts(artwork) {
  let points = 0
  for (const primitive of artwork.scene.primitives) {
    points += primitive.points.length
  }
  return {
    polylines: artwork.scene.primitives.length,
    points,
    segments: points - artwork.scene.primitives.length,
    pathLength: artwork.diagnostics.pathLength,
    penLifts: artwork.diagnostics.penLiftCount,
    termination: artwork.diagnostics.termination,
    residualError: artwork.diagnostics.fidelity.residualError,
  }
}

function createEnvironment(pixels, prepared) {
  return Object.freeze({
    imageAssets: (id) => (id === IMAGE_ASSET_ID ? pixels : undefined),
    getPreparedImageDetailAnalysis: (id, definitionId) =>
      id === IMAGE_ASSET_ID && definitionId === IMAGE_DETAIL_ANALYSIS_DEFINITION_ID
        ? prepared
        : undefined,
  })
}

function generate(params, environment) {
  let finalProgress
  const artwork = photoScribble.generateShadingArtwork(
    params,
    SEED,
    FRAME,
    (progress) => {
      finalProgress = progress
    },
    environment,
  )
  if (finalProgress?.terminal !== true) {
    throw new Error('benchmark generation did not report terminal progress')
  }
  return { artwork, progress: finalProgress }
}

describe('Photo Scribble doggo-detail performance feedback loop', () => {
  it('reports pinned generation and preparation timings', () => {
    const samples = readPositiveInteger(
      'PHOTO_SCRIBBLE_BENCH_SAMPLES',
      DEFAULT_SAMPLES,
    )
    const warmups = readNonNegativeInteger(
      'PHOTO_SCRIBBLE_BENCH_WARMUPS',
      DEFAULT_WARMUPS,
    )
    const pixels = decodeRgba8Png(IMAGE_PATH)
    const prepared = prepareImageDetailAnalysis(pixels)
    const environment = createEnvironment(pixels, prepared)
    const detailReference = generate(DETAIL_PARAMS, environment)
    const uniformReference = generate(UNIFORM_PARAMS, environment)
    const detailDurations = []
    const uniformDurations = []
    const preparationDurations = []
    let lastDetail
    let lastUniform
    let guard = 0

    for (let index = 0; index < warmups + samples; index++) {
      const measured = index >= warmups
      const cases =
        index % 2 === 0
          ? [
              [DETAIL_PARAMS, detailDurations],
              [UNIFORM_PARAMS, uniformDurations],
            ]
          : [
              [UNIFORM_PARAMS, uniformDurations],
              [DETAIL_PARAMS, detailDurations],
            ]
      for (const [params, durations] of cases) {
        const start = performance.now()
        const result = generate(params, environment)
        const elapsed = performance.now() - start
        guard +=
          result.artwork.scene.primitives.length +
          result.progress.completedWorkUnits
        if (params === DETAIL_PARAMS) lastDetail = result
        else lastUniform = result
        if (measured) durations.push(elapsed)
      }

      const preparationStart = performance.now()
      const currentPrepared = prepareImageDetailAnalysis(pixels)
      const preparationElapsed = performance.now() - preparationStart
      guard += currentPrepared.data[0] + currentPrepared.data.length
      if (measured) preparationDurations.push(preparationElapsed)
    }

    if (!Number.isFinite(guard) || guard === 0) {
      throw new Error(`benchmark work guard failed: ${guard}`)
    }

    const detailCounts = artworkCounts(detailReference.artwork)
    const uniformCounts = artworkCounts(uniformReference.artwork)
    const detailChecksum = artworkChecksum(detailReference.artwork)
    const uniformChecksum = artworkChecksum(uniformReference.artwork)

    console.log('\nPhoto Scribble doggo-detail benchmark')
    console.log(`runtime                           ${process.version} ${process.platform}/${process.arch}`)
    console.log(`seed                              ${SEED}`)
    console.log(`frame                             ${FRAME.width} x ${FRAME.height}`)
    console.log(
      `source                            ${pixels.width} x ${pixels.height} committed RGBA8 PNG`,
    )
    console.log(
      `detail analysis                   ${prepared.gridWidth} x ${prepared.gridHeight}`,
    )
    console.log(`detail checksum                   ${detailChecksum}`)
    console.log(`detail output                     ${JSON.stringify(detailCounts)}`)
    console.log(
      `detail work                       ${detailReference.progress.completedWorkUnits}/${detailReference.progress.totalWorkUnits}`,
    )
    console.log(`uniform checksum                  ${uniformChecksum}`)
    console.log(`uniform output                    ${JSON.stringify(uniformCounts)}`)
    console.log(
      `uniform work                      ${uniformReference.progress.completedWorkUnits}/${uniformReference.progress.totalWorkUnits}`,
    )
    report('detail-enabled generation', detailDurations)
    report('zero-influence generation', uniformDurations)
    report('detail analysis preparation', preparationDurations)
    console.log(
      'scope                             synchronous core generation; no worker startup or browser raster',
    )

    expect(pixels.width).toBe(EXPECTED_IMAGE_WIDTH)
    expect(pixels.height).toBe(EXPECTED_IMAGE_HEIGHT)
    expect(detailChecksum).toBe(EXPECTED_DETAIL_CHECKSUM)
    expect(uniformChecksum).toBe(EXPECTED_UNIFORM_CHECKSUM)
    expect(detailReference.progress.completedWorkUnits).toBe(
      EXPECTED_DETAIL_WORK_UNITS,
    )
    expect(uniformReference.progress.completedWorkUnits).toBe(
      EXPECTED_UNIFORM_WORK_UNITS,
    )
    expect(detailCounts.polylines).toBe(EXPECTED_DETAIL_POLYLINES)
    expect(detailCounts.points).toBe(EXPECTED_DETAIL_POINTS)
    expect(uniformCounts.polylines).toBe(EXPECTED_UNIFORM_POLYLINES)
    expect(uniformCounts.points).toBe(EXPECTED_UNIFORM_POINTS)
    expect(artworkChecksum(lastDetail.artwork)).toBe(detailChecksum)
    expect(artworkChecksum(lastUniform.artwork)).toBe(uniformChecksum)
  })
})
