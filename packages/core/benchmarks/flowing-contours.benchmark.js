import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { createFlowingContoursAccounting } from '../src/sketches/flowing-contours/accounting'
import { defaultFlowingContoursControls } from '../src/sketches/flowing-contours/controls'
import { buildFlowingContoursFieldEnsemble } from '../src/sketches/flowing-contours/field'
import { generateFlowingContours } from '../src/sketches/flowing-contours/generator'
import { FLOWING_CONTOURS_LIMITS } from '../src/sketches/flowing-contours/limits'
import { runFlowingContoursFieldEnsemblePipeline } from '../src/sketches/flowing-contours/pipeline'
import {
  applyFlowingContoursToneControls,
  prepareFlowingContoursRaster,
} from '../src/sketches/flowing-contours/raster'

const FRAME = Object.freeze({ width: 1000, height: 1000 })
const DEFAULT_SAMPLES = 5
const DEFAULT_WARMUPS = 1

const CASES = Object.freeze({
  flower: Object.freeze({
    path: fileURLToPath(
      new URL(
        '../../../assets/image-assets/img-0672-79d639daec62.png',
        import.meta.url,
      ),
    ),
    expectedWidth: 1536,
    expectedHeight: 2048,
    expectedChecksum:
      '5cca872ad48b725449bd8575ddfac8c01ba248ccbd5fc5e6917d40929ee4bdd1',
  }),
  pinecone: Object.freeze({
    path: fileURLToPath(
      new URL(
        '../../../assets/image-assets/pinecone-4330aa0314f7.png',
        import.meta.url,
      ),
    ),
    expectedWidth: 512,
    expectedHeight: 768,
    expectedChecksum:
      '0fab1114c582b8a20d4afb26722884b2cde4f70e6f8e9b17b43362c5a78181ec',
  }),
})

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
  return Object.freeze({
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    samples: Object.freeze([...samples]),
  })
}

function timed(operation, warmups, samples, verify = () => {}) {
  for (let index = 0; index < warmups; index += 1) operation()
  const durations = []
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now()
    const result = operation()
    durations.push(performance.now() - started)
    verify(result)
  }
  return stats(durations)
}

function formatMs(value) {
  return `${value.toFixed(2)} ms`
}

function report(caseName, phase, result) {
  console.log(
    `${caseName.padEnd(9)} ${phase.padEnd(24)} median ${formatMs(result.median).padStart(11)}  p95 ${formatMs(result.p95).padStart(11)}  n=${result.samples.length}`,
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

/** Decode the committed non-interlaced RGBA8 fixtures without a native addon. */
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
  for (let row = 0; row < height; row += 1) {
    const filter = inflated[sourceOffset++]
    const outputOffset = row * rowBytes
    for (let columnByte = 0; columnByte < rowBytes; columnByte += 1) {
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

function exactChecksum(value) {
  const hash = createHash('sha256')
  const bytes = new Uint8Array(8)
  const view = new DataView(bytes.buffer)
  const write = (entry) => {
    if (entry === null) {
      hash.update('null;')
    } else if (typeof entry === 'number') {
      view.setFloat64(0, entry, false)
      hash.update('number:')
      hash.update(bytes)
    } else if (typeof entry === 'string') {
      hash.update(`string:${entry.length}:`)
      hash.update(entry)
    } else if (typeof entry === 'boolean') {
      hash.update(entry ? 'true;' : 'false;')
    } else if (Array.isArray(entry)) {
      hash.update(`array:${entry.length}:`)
      for (const item of entry) write(item)
    } else if (typeof entry === 'object') {
      const keys = Object.keys(entry).sort()
      hash.update(`object:${keys.length}:`)
      for (const key of keys) {
        write(key)
        write(entry[key])
      }
    } else {
      hash.update(`other:${String(entry)};`)
    }
  }
  write(value)
  return hash.digest('hex')
}

function prepareInputs(pixels) {
  const accounting = createFlowingContoursAccounting()
  const raster = prepareFlowingContoursRaster(
    pixels,
    accounting,
    FLOWING_CONTOURS_LIMITS,
  )
  expect(accounting.termination).toBe('complete')
  const toned = applyFlowingContoursToneControls(
    raster,
    defaultFlowingContoursControls,
  )
  const ensemble = buildFlowingContoursFieldEnsemble(
    toned,
    accounting,
    FLOWING_CONTOURS_LIMITS,
  )
  expect(accounting.termination).toBe('complete')
  return Object.freeze({ raster, toned, ensemble })
}

function workCounts(result) {
  const diagnostics = result.diagnostics
  let pointCount = 0
  for (const primitive of result.scene.primitives) {
    pointCount += primitive.points.length
  }
  return Object.freeze({
    analysis: `${diagnostics.analysisWidth}x${diagnostics.analysisHeight}`,
    analysisSampleCount: diagnostics.analysisSampleCount,
    contourEvidenceSampleCount: diagnostics.contourEvidenceSampleCount,
    correctedRidgeSampleCount: diagnostics.correctedRidgeSampleCount,
    eligibleAnchorCount: diagnostics.eligibleAnchorCount,
    processedAnchorCount: diagnostics.processedAnchorCount,
    directionalTraceCount: diagnostics.directionalTraceCount,
    searchStepCount: diagnostics.searchStepCount,
    candidateCount: diagnostics.candidateCount,
    acceptedCandidateCount: diagnostics.acceptedCandidateCount,
    suppressedAnchorCount: diagnostics.suppressedAnchorCount,
    rawTrajectoryPointCount: diagnostics.rawTrajectoryPointCount,
    fittedCurvePointCount: diagnostics.fittedCurvePointCount,
    primitiveCount: diagnostics.primitiveCount,
    scenePointCount: pointCount,
  })
}

describe('Flowing Contours deterministic performance baseline', () => {
  const samples = readPositiveInteger(
    'FLOWING_CONTOURS_BENCHMARK_SAMPLES',
    DEFAULT_SAMPLES,
  )
  const warmups = readNonNegativeInteger(
    'FLOWING_CONTOURS_BENCHMARK_WARMUPS',
    DEFAULT_WARMUPS,
  )

  for (const [caseName, fixture] of Object.entries(CASES)) {
    it(
      `measures ${caseName} phases and exact output`,
      () => {
        const pixels = decodeRgba8Png(fixture.path)
        expect(pixels.width).toBe(fixture.expectedWidth)
        expect(pixels.height).toBe(fixture.expectedHeight)

        const prepared = prepareInputs(pixels)
        const generate = () =>
          generateFlowingContours({
            pixels,
            frame: FRAME,
            controls: defaultFlowingContoursControls,
          })
        let exact = null

        const phases = {
          rasterPreparation: timed(() => {
            const accounting = createFlowingContoursAccounting()
            prepareFlowingContoursRaster(
              pixels,
              accounting,
              FLOWING_CONTOURS_LIMITS,
            )
          }, warmups, samples),
          toneTransform: timed(() => {
            applyFlowingContoursToneControls(
              prepared.raster,
              defaultFlowingContoursControls,
            )
          }, warmups, samples),
          fieldEnsemble: timed(() => {
            const accounting = createFlowingContoursAccounting()
            buildFlowingContoursFieldEnsemble(
              prepared.toned,
              accounting,
              FLOWING_CONTOURS_LIMITS,
            )
          }, warmups, samples),
          wholeCurvePipeline: timed(() => {
            runFlowingContoursFieldEnsemblePipeline(
              prepared.ensemble,
              defaultFlowingContoursControls,
              FLOWING_CONTOURS_LIMITS,
            )
          }, warmups, samples),
          endToEndGeneration: timed(() => {
            return generate()
          }, warmups, samples, (result) => {
            expect(exactChecksum(result)).toBe(fixture.expectedChecksum)
            exact ??= result
          }),
        }
        expect(exact).not.toBeNull()
        const checksum = exactChecksum(exact)

        console.log(
          `\nFlowing Contours ${caseName}: checksum ${checksum}\nwork ${JSON.stringify(workCounts(exact))}`,
        )
        for (const [phase, result] of Object.entries(phases)) {
          report(caseName, phase, result)
        }
        console.log(
          `${caseName.padEnd(9)} final validation/mapping/Scene construction is included only in end-to-end generation; do not infer it by subtracting independently timed medians.`,
        )
      },
      600_000,
    )
  }
})
