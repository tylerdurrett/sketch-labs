import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { arch, cpus, platform, release } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'

const FRAME = Object.freeze({ width: 100, height: 100 })
const SEED = 'stippling-relaxation-benchmark-v1'
const CONTROLS = Object.freeze({
  stippleDensity: 100,
  distributionFidelity: 0.5,
  voronoiRelaxation: 0,
})
const WARMUPS = 2
const SAMPLES = 9

function requiredPath(name) {
  const value = process.env[name]
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`)
  }
  return resolve(value)
}

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
  }).trim()
}

function percentile(values, quantile) {
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.ceil(quantile * ordered.length) - 1]
}

function orderedGeometryChecksum(polylines) {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(8)
  hash.update(`polylines:${polylines.length}\n`)
  for (const polyline of polylines) {
    hash.update(`points:${polyline.length}\n`)
    for (const point of polyline) {
      for (const coordinate of point) {
        buffer.writeDoubleBE(coordinate)
        hash.update(buffer)
      }
    }
  }
  return hash.digest('hex')
}

function diagnostics(result) {
  return {
    termination: result.termination,
    distributionError: result.distributionError,
    ...(result.relaxation === undefined
      ? {}
      : { relaxation: result.relaxation }),
  }
}

async function loadSource(root) {
  const [fields, strategy] = await Promise.all([
    import(
      /* @vite-ignore */ pathToFileURL(
        join(root, 'packages/core/src/shadingFields.ts'),
      ).href
    ),
    import(
      /* @vite-ignore */ pathToFileURL(
        join(root, 'packages/core/src/stipplingStrategy/index.ts'),
      ).href
    ),
  ])
  return { fields, strategy }
}

async function measure(label, root) {
  const { fields, strategy } = await loadSource(root)
  const input = Object.freeze({
    source: Object.freeze({
      toneField: fields.createToneField(([x]) => x / FRAME.width),
      shadingMask: fields.createShadingMask(() => 1),
    }),
    frame: FRAME,
    controls: CONTROLS,
    seed: SEED,
  })
  let pinned
  const run = () => {
    const startedAt = performance.now()
    const result = strategy.stipplingStrategy(input)
    const elapsedMs = performance.now() - startedAt
    const observed = {
      orderedGeometryChecksum: orderedGeometryChecksum(result.polylines),
      diagnostics: diagnostics(result),
    }
    if (pinned === undefined) pinned = observed
    else if (JSON.stringify(observed) !== JSON.stringify(pinned)) {
      throw new Error(`${label} output changed between samples`)
    }
    return elapsedMs
  }

  for (let index = 0; index < WARMUPS; index++) run()
  const elapsedMs = Array.from({ length: SAMPLES }, run)
  return {
    label,
    root,
    commit: git(root, 'rev-parse', 'HEAD'),
    dirty: git(root, 'status', '--porcelain') !== '',
    warmupCount: WARMUPS,
    sampleCount: SAMPLES,
    elapsedMs,
    medianMs: percentile(elapsedMs, 0.5),
    p95Ms: percentile(elapsedMs, 0.95),
    ...pinned,
  }
}

describe('pre-slice zero-relaxation comparison', () => {
  it('runs pinned base then candidate in one Node process', async () => {
    const baseRoot = requiredPath('STIPPLING_RELAXATION_BASE_ROOT')
    const candidateRoot = requiredPath('STIPPLING_RELAXATION_CANDIDATE_ROOT')
    const output = requiredPath('STIPPLING_RELAXATION_ZERO_OUTPUT')
    const base = await measure('pre-slice-base', baseRoot)
    const candidate = await measure('candidate-zero', candidateRoot)
    const medianRatio = candidate.medianMs / base.medianMs
    const p95Ratio = candidate.p95Ms / base.p95Ms
    const artifact = {
      schemaVersion: 1,
      environment: {
        node: process.version,
        nodeExecutable: process.execPath,
        platform: platform(),
        release: release(),
        arch: arch(),
        cpu: cpus()[0]?.model ?? 'unknown',
        cpuCount: cpus().length,
        benchmarkCommit: git(candidateRoot, 'rev-parse', 'HEAD'),
      },
      config: {
        order: ['pre-slice-base', 'candidate-zero'],
        target: 'analytic-ramp',
        frame: FRAME,
        seed: SEED,
        controls: CONTROLS,
        warmups: WARMUPS,
        samples: SAMPLES,
      },
      runs: { base, candidate },
      comparison: {
        exactOrderedGeometry:
          candidate.orderedGeometryChecksum === base.orderedGeometryChecksum,
        exactDiagnosticsJson:
          JSON.stringify(candidate.diagnostics) ===
          JSON.stringify(base.diagnostics),
        medianRatio,
        p95Ratio,
        medianWithinFivePercent: medianRatio <= 1.05,
        p95WithinFivePercent: p95Ratio <= 1.05,
      },
    }
    writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`)

    expect(base.dirty).toBe(false)
    expect(candidate.dirty).toBe(false)
    expect(artifact.comparison.exactOrderedGeometry).toBe(true)
    expect(artifact.comparison.exactDiagnosticsJson).toBe(true)
    expect(artifact.comparison.medianWithinFivePercent).toBe(true)
    expect(artifact.comparison.p95WithinFivePercent).toBe(true)
  })
})
