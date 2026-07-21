import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpus } from 'node:os'

export function orderedGeometryChecksum(polylines) {
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

function gitValue(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

export function environmentFingerprint() {
  const cpu = cpus()[0]
  return Object.freeze({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpu?.model ?? 'unknown',
    cpuCount: cpus().length,
    sourceCommit: gitValue(['rev-parse', 'HEAD']),
    benchmarkCommit: gitValue(['rev-parse', 'HEAD']),
    dirty: gitValue(['status', '--porcelain']) !== '',
  })
}

export function diagnosticsSnapshot(result) {
  return Object.freeze({
    termination: result.termination,
    distributionError: result.distributionError,
    ...(result.relaxation === undefined
      ? {}
      : { relaxation: result.relaxation }),
  })
}
