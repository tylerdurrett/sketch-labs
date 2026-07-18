import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../../..')
const fixtures = JSON.parse(readFileSync(resolve(here, 'fixtures.json'), 'utf8'))
const protocol = JSON.parse(readFileSync(resolve(here, 'protocol.json'), 'utf8'))

function pngDimensions(bytes) {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft
  const leftDistance = Math.abs(estimate - left)
  const aboveDistance = Math.abs(estimate - above)
  const upperLeftDistance = Math.abs(estimate - upperLeft)
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left
  }
  return aboveDistance <= upperLeftDistance ? above : upperLeft
}

function pngAlphaDistribution(bytes, { width, height }) {
  const chunks = []
  let offset = 8
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii')
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      expect([...data.subarray(8, 13)]).toEqual([8, 6, 0, 0, 0])
    } else if (type === 'IDAT') {
      chunks.push(data)
    }
    offset += 12 + length
  }

  const inflated = inflateSync(Buffer.concat(chunks))
  const stride = width * 4
  const previous = Buffer.alloc(stride)
  const current = Buffer.alloc(stride)
  const counts = { fullyTransparent: 0, partial: 0, fullyOpaque: 0 }
  let source = 0
  for (let row = 0; row < height; row += 1) {
    const filter = inflated[source]
    if (filter > 4) throw new Error(`unsupported PNG row filter ${filter}`)
    source += 1
    for (let index = 0; index < stride; index += 1) {
      const encoded = inflated[source + index]
      const left = index >= 4 ? current[index - 4] : 0
      const above = previous[index]
      const upperLeft = index >= 4 ? previous[index - 4] : 0
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
    source += stride
    for (let alpha = 3; alpha < stride; alpha += 4) {
      if (current[alpha] === 0) counts.fullyTransparent += 1
      else if (current[alpha] === 255) counts.fullyOpaque += 1
      else counts.partial += 1
    }
    previous.set(current)
  }
  expect(source).toBe(inflated.length)
  return counts
}

describe('Photo Scribble issue 336 protocol', () => {
  it('pins each committed input by stable ID, full digest, bytes, and dimensions', () => {
    for (const fixture of fixtures.fixtures) {
      const bytes = readFileSync(resolve(root, fixture.path))
      expect(bytes.byteLength).toBe(fixture.byteLength)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        fixture.sha256,
      )
      expect(fixture.assetId.endsWith(fixture.sha256.slice(0, 12))).toBe(true)
      expect(pngDimensions(bytes)).toEqual({
        width: fixture.dimensions.width,
        height: fixture.dimensions.height,
      })
      expect(pngAlphaDistribution(bytes, fixture.dimensions)).toEqual({
        fullyTransparent: fixture.alphaDistribution.fullyTransparent,
        partial: fixture.alphaDistribution.partial,
        fullyOpaque: fixture.alphaDistribution.fullyOpaque,
      })
      expect(
        fixture.alphaDistribution.fullyTransparent +
          fixture.alphaDistribution.partial +
          fixture.alphaDistribution.fullyOpaque,
      ).toBe(fixture.alphaDistribution.pixelCount)
      expect(fixture.alphaDistribution.pixelCount).toBe(
        fixture.dimensions.width * fixture.dimensions.height,
      )
      expect(fixture.origin.externalSource).toBeNull()
      expect(fixture.ownership.redistributionStatementRecorded).toBe(false)
    }
  })

  it('covers every required category without an extra binary', () => {
    const fixtureIds = new Set(
      fixtures.fixtures.map(({ fixtureId }) => fixtureId),
    )
    expect(Object.keys(fixtures.requiredCategoryCoverage).sort()).toEqual(
      [
        'flat-or-dark',
        'mismatched-aspect',
        'ordinary-opaque',
        'partial-and-fully-transparent',
      ].sort(),
    )
    for (const coveredBy of Object.values(fixtures.requiredCategoryCoverage)) {
      expect(coveredBy.length).toBeGreaterThan(0)
      expect(coveredBy.every((fixtureId) => fixtureIds.has(fixtureId))).toBe(
        true,
      )
    }
  })

  it('freezes unique scenarios, capture names, thresholds, and ordered complete tuples', () => {
    expect(protocol.artifactPrefix).toBe('issue-336-trial-')
    expect(protocol.frame).toEqual({ width: 1000, height: 1000 })

    const scenarioIds = protocol.scenarios.map(({ scenarioId }) => scenarioId)
    const captureStems = protocol.scenarios.map(({ captureStem }) => captureStem)
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length)
    expect(new Set(captureStems).size).toBe(captureStems.length)
    expect(
      captureStems.every((stem) => stem.startsWith(protocol.artifactPrefix)),
    ).toBe(true)
    expect(new Set(protocol.captureSuffixes).size).toBe(
      protocol.captureSuffixes.length,
    )

    const fixtureIds = new Set(
      fixtures.fixtures.map(({ fixtureId }) => fixtureId),
    )
    expect(
      protocol.scenarios.every(({ fixtureId }) => fixtureIds.has(fixtureId)),
    ).toBe(true)
    expect(
      protocol.scenarios.filter(({ roles }) =>
        roles.includes('budget-calibration'),
      ),
    ).toHaveLength(2)

    expect(protocol.thresholds).toEqual({
      jobTimeoutMs: 300000,
      maxProgressHeartbeatGapMs: 1000,
      maxUiRoundtripMs: 250,
      maxCancellationRoundtripMs: 500,
      maxTerminalProgressToDisplayMs: 5000,
      minimumRelativeResidualImprovement: 0.2,
    })

    const limitKeys = [
      'maxAcceptedSegments',
      'maxPolylines',
      'maxStagnations',
      'maxRestarts',
    ]
    for (
      let index = 0;
      index < protocol.orderedLimitCandidates.length;
      index += 1
    ) {
      const candidate = protocol.orderedLimitCandidates[index]
      expect(Object.keys(candidate).sort()).toEqual(
        ['candidateId', ...limitKeys].sort(),
      )
      for (const key of limitKeys) {
        expect(Number.isSafeInteger(candidate[key])).toBe(true)
        expect(candidate[key]).toBeGreaterThan(0)
        if (index > 0) {
          expect(candidate[key]).toBeGreaterThan(
            protocol.orderedLimitCandidates[index - 1][key],
          )
        }
      }
    }
  })
})
