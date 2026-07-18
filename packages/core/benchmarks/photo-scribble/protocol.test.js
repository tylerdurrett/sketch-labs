import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../../..')
const fixtures = JSON.parse(readFileSync(resolve(here, 'fixtures.json'), 'utf8'))
const protocol = JSON.parse(readFileSync(resolve(here, 'protocol.json'), 'utf8'))
const LIMIT_KEYS = [
  'maxAcceptedSegments',
  'maxPolylines',
  'maxStagnations',
  'maxRestarts',
]

function tupleToken(candidate) {
  return `s${candidate.maxAcceptedSegments}-p${candidate.maxPolylines}-g${candidate.maxStagnations}-r${candidate.maxRestarts}`
}

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

function decodePng(bytes, { width, height }) {
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
  const rgba = Buffer.alloc(stride * height)
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
    current.copy(rgba, row * stride)
    previous.set(current)
  }
  expect(source).toBe(inflated.length)
  return { counts, rgba }
}

function srgbByteToLinear(byte) {
  const encoded = byte / 255
  return encoded <= 0.04045
    ? encoded / 12.92
    : ((encoded + 0.055) / 1.055) ** 2.4
}

function rawTone(rgba, width, x, y) {
  const offset = (y * width + x) * 4
  return (
    1 -
    (0.2126 * srgbByteToLinear(rgba[offset]) +
      0.7152 * srgbByteToLinear(rgba[offset + 1]) +
      0.0722 * srgbByteToLinear(rgba[offset + 2]))
  )
}

function opaqueToneDistribution(rgba) {
  let sampleCount = 0
  let minimum = Infinity
  let maximum = -Infinity
  let total = 0
  for (let offset = 0; offset < rgba.length; offset += 4) {
    if (rgba[offset + 3] !== 255) continue
    const tone =
      1 -
      (0.2126 * srgbByteToLinear(rgba[offset]) +
        0.7152 * srgbByteToLinear(rgba[offset + 1]) +
        0.0722 * srgbByteToLinear(rgba[offset + 2]))
    sampleCount += 1
    minimum = Math.min(minimum, tone)
    maximum = Math.max(maximum, tone)
    total += tone
  }
  return { sampleCount, minimum, maximum, mean: total / sampleCount }
}

function toneGamma(tone, control) {
  return tone ** 2 ** (2 * (control - 0.5))
}

function toneContrast(tone, control) {
  return Math.max(0, Math.min(1, 0.5 + (tone - 0.5) * (0.15 + 1.7 * control)))
}

describe('Photo Scribble issue 336 protocol', () => {
  it('pins bytes, decoded alpha, unknown rights, and actual introduction commits', () => {
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
      const decoded = decodePng(bytes, fixture.dimensions)
      expect(decoded.counts).toEqual({
        fullyTransparent: fixture.alphaDistribution.fullyTransparent,
        partial: fixture.alphaDistribution.partial,
        fullyOpaque: fixture.alphaDistribution.fullyOpaque,
      })
      const toneStats = opaqueToneDistribution(decoded.rgba)
      expect(toneStats.sampleCount).toBe(
        fixture.opaqueToneDistribution.sampleCount,
      )
      for (const key of ['minimum', 'maximum', 'mean']) {
        expect(toneStats[key]).toBeCloseTo(
          fixture.opaqueToneDistribution[key],
          11,
        )
      }
      expect(
        fixture.alphaDistribution.fullyTransparent +
          fixture.alphaDistribution.partial +
          fixture.alphaDistribution.fullyOpaque,
      ).toBe(fixture.alphaDistribution.pixelCount)
      expect(fixture.alphaDistribution.pixelCount).toBe(
        fixture.dimensions.width * fixture.dimensions.height,
      )
      expect(fixture.origin.externalSource).toBeNull()
      expect(fixture.origin.kind).toBe('unknown-acquisition')
      expect(fixture.origin.introducedByCommit).toMatch(/^[0-9a-f]{40}$/)
      const introducedPaths = execFileSync(
        'git',
        [
          'show',
          '--format=',
          '--name-only',
          fixture.origin.introducedByCommit,
        ],
        { cwd: root, encoding: 'utf8' },
      )
        .trim()
        .split('\n')
      expect(introducedPaths).toContain(fixture.path)
      expect(
        execFileSync(
          'git',
          [
            'diff-tree',
            '--no-commit-id',
            '--name-status',
            '-r',
            fixture.origin.introducedByCommit,
            '--',
            fixture.path,
          ],
          { cwd: root, encoding: 'utf8' },
        ).trim(),
      ).toBe(`A\t${fixture.path}`)
      expect(
        execFileSync(
          'git',
          ['show', '-s', '--format=%cI', fixture.origin.introducedByCommit],
          { cwd: root, encoding: 'utf8' },
        ).trim(),
      ).toBe(fixture.origin.introducedAt)
      expect(fixture.ownership).toMatchObject({
        recordedStatus: 'unknown-pending-maintainer-attestation',
        rightsHolder: null,
        license: null,
      })
      expect(fixture.ownership.redistributionStatementRecorded).toBe(false)
    }
  })

  it('keeps fixture identity unique and declared categories byte-derived', () => {
    expect(new Set(fixtures.fixtures.map(({ fixtureId }) => fixtureId)).size).toBe(
      fixtures.fixtures.length,
    )
    expect(new Set(fixtures.fixtures.map(({ path }) => path)).size).toBe(
      fixtures.fixtures.length,
    )
    for (const fixture of fixtures.fixtures) {
      const decoded = decodePng(
        readFileSync(resolve(root, fixture.path)),
        fixture.dimensions,
      )
      const categories = new Set(fixture.categories)
      if (categories.has('ordinary-opaque')) {
        expect(decoded.counts).toEqual({
          fullyTransparent: 0,
          partial: 0,
          fullyOpaque: fixture.alphaDistribution.pixelCount,
        })
      }
      if (categories.has('flat-or-dark')) {
        expect(opaqueToneDistribution(decoded.rgba).mean).toBeGreaterThanOrEqual(
          0.75,
        )
      }
      if (categories.has('mismatched-aspect')) {
        expect(fixture.dimensions.width).not.toBe(fixture.dimensions.height)
      }
      if (categories.has('partial-and-fully-transparent')) {
        expect(decoded.counts.fullyTransparent).toBeGreaterThan(0)
        expect(decoded.counts.partial).toBeGreaterThan(0)
      }
    }
  })

  it('maps category coverage and scenarios to the fixture that actually declares them', () => {
    const fixtureById = new Map(
      fixtures.fixtures.map((fixture) => [fixture.fixtureId, fixture]),
    )
    expect(Object.keys(fixtures.requiredCategoryCoverage).sort()).toEqual(
      [
        'flat-or-dark',
        'mismatched-aspect',
        'ordinary-opaque',
        'partial-and-fully-transparent',
      ].sort(),
    )
    for (const [category, coveredBy] of Object.entries(
      fixtures.requiredCategoryCoverage,
    )) {
      expect(coveredBy.length).toBeGreaterThan(0)
      for (const fixtureId of coveredBy) {
        expect(fixtureById.get(fixtureId)?.categories).toContain(category)
      }
    }
    for (const scenario of protocol.scenarios) {
      const fixture = fixtureById.get(scenario.fixtureId)
      expect(fixture).toBeDefined()
      expect(scenario.params.imageAsset).toBe(fixture.assetId)
      for (const role of scenario.roles) {
        if (!['workflow-control', 'budget-calibration'].includes(role)) {
          expect(fixture.categories).toContain(role)
        }
      }
    }
  })

  it('freezes the rights gate, environment, frame, profile, and scenarios', () => {
    expect(protocol.artifactPrefix).toBe('issue-336-trial-')
    expect(protocol.rightsGate).toEqual({
      defaultExecutionAllowed: false,
      status: 'blocked-pending-rights-evidence',
      acceptedEvidence: [
        'dated-maintainer-attestation-of-ownership-and-redistribution-rights',
        'replacement-fixture-with-recorded-owned-or-compatible-license-provenance',
      ],
      rule: expect.stringContaining('Before any browser campaign'),
    })
    expect(protocol.reviewEnvironment).toEqual({
      viewportWidth: 1440,
      viewportHeight: 1000,
      deviceScaleFactor: 1,
    })
    expect(protocol.frame).toEqual({ width: 1000, height: 1000 })
    expect(protocol.profile).toEqual({
      width: 200,
      height: 200,
      insets: { top: 10, right: 10, bottom: 10, left: 10 },
      includeFrame: true,
      toolWidthMillimeters: 0.3,
    })

    expect(
      protocol.scenarios.map((scenario) => ({
        scenarioId: scenario.scenarioId,
        fixtureId: scenario.fixtureId,
        captureStem: scenario.captureStem,
        seed: scenario.seed,
        reseed: scenario.reseed,
        params: scenario.params,
        roles: scenario.roles,
      })),
    ).toEqual([
      {
        scenarioId: 'flowers-opaque-control',
        fixtureId: 'flowers-opaque-portrait',
        captureStem: 'issue-336-trial-flowers-opaque-control',
        seed: 2381065623916958,
        reseed: 2381065623916959,
        params: {
          imageAsset: 'img-0672-79d639daec62',
          toneContrast: 0.96,
          toneGamma: 1,
          pathDensity: 20,
          scribbleScale: 0.35,
          momentum: 0.98,
          chaos: 0.02,
          toneFidelity: 0.99,
        },
        roles: ['ordinary-opaque', 'mismatched-aspect', 'workflow-control'],
      },
      {
        scenarioId: 'pinecone-dark-alpha-control',
        fixtureId: 'pinecone-dark-alpha-portrait',
        captureStem: 'issue-336-trial-pinecone-dark-alpha-control',
        seed: 5036310400360331,
        reseed: 5036310400360332,
        params: {
          imageAsset: 'pinecone-4330aa0314f7',
          toneContrast: 1,
          toneGamma: 1,
          pathDensity: 20,
          scribbleScale: 0.5,
          momentum: 1,
          chaos: 0.72,
          toneFidelity: 1,
        },
        roles: [
          'flat-or-dark',
          'partial-and-fully-transparent',
          'mismatched-aspect',
          'workflow-control',
        ],
      },
      {
        scenarioId: 'flowers-opaque-fine',
        fixtureId: 'flowers-opaque-portrait',
        captureStem: 'issue-336-trial-flowers-opaque-fine',
        seed: 2381065623916958,
        reseed: 2381065623916959,
        params: {
          imageAsset: 'img-0672-79d639daec62',
          toneContrast: 0.96,
          toneGamma: 1,
          pathDensity: 20,
          scribbleScale: 0.1,
          momentum: 0.98,
          chaos: 0.02,
          toneFidelity: 0.99,
        },
        roles: ['budget-calibration'],
      },
      {
        scenarioId: 'pinecone-dark-alpha-fine',
        fixtureId: 'pinecone-dark-alpha-portrait',
        captureStem: 'issue-336-trial-pinecone-dark-alpha-fine',
        seed: 5036310400360331,
        reseed: 5036310400360332,
        params: {
          imageAsset: 'pinecone-4330aa0314f7',
          toneContrast: 1,
          toneGamma: 1,
          pathDensity: 20,
          scribbleScale: 0.1,
          momentum: 1,
          chaos: 0.72,
          toneFidelity: 1,
        },
        roles: ['budget-calibration'],
      },
    ])

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

  })

  it('freezes thresholds and concrete heartbeat, interaction, and cancellation boundaries', () => {
    expect(protocol.thresholds).toEqual({
      jobTimeoutMs: 300000,
      maxProgressHeartbeatGapMs: 1000,
      maxUiRoundtripMs: 250,
      maxCancellationRoundtripMs: 500,
      maxTerminalProgressToDisplayMs: 5000,
      minimumRelativeResidualImprovement: 0.2,
    })
    expect(protocol.measurement.heartbeat).toEqual({
      start: expect.stringContaining('immediately before'),
      samples: expect.stringContaining('every accepted progress message'),
      end: expect.stringContaining('terminal progress'),
      gaps: expect.stringContaining('request-to-first'),
    })
    expect(protocol.measurement.interactionProbes).toHaveLength(3)
    expect(
      protocol.measurement.interactionProbes.map((probe) => probe.probeId),
    ).toEqual([
      'hide-inspector',
      'show-inspector',
      'toggle-shading-disclosure',
    ])
    for (const probe of protocol.measurement.interactionProbes) {
      expect(probe.coordinate).toEqual({
        space: 'target-border-box',
        xFraction: 0.5,
        yFraction: 0.5,
      })
      expect(probe.target).not.toBe('')
      expect(probe.action).not.toBe('')
      expect(probe.start).toContain('immediately before')
      expect(probe.end).toContain('first requestAnimationFrame')
    }
    expect(protocol.measurement.cancellation).toMatchObject({
      target: 'input#control-chaos',
      coordinate: {
        space: 'target-border-box',
        xFraction: 0.5,
        yFraction: 0.5,
      },
      action: expect.stringContaining('exactly 0.01 below'),
      start: expect.stringContaining('immediately before'),
      end: expect.stringContaining('resolves cancelled'),
    })
  })

  it('pins Tone probes to decoded texels and proves the declared comparisons', () => {
    const fixtureByScenario = new Map(
      protocol.scenarios.map((scenario) => [scenario.scenarioId, scenario]),
    )
    const probeIds = new Set()
    for (const group of protocol.measurement.toneSampling.scenarioProbes) {
      const scenario = fixtureByScenario.get(group.scenarioId)
      expect(scenario.roles).toContain('workflow-control')
      const fixture = fixtures.fixtures.find(
        ({ fixtureId }) => fixtureId === scenario.fixtureId,
      )
      const decoded = decodePng(
        readFileSync(resolve(root, fixture.path)),
        fixture.dimensions,
      )
      const scale = Math.min(
        protocol.frame.width / fixture.dimensions.width,
        protocol.frame.height / fixture.dimensions.height,
      )
      const left = (protocol.frame.width - fixture.dimensions.width * scale) / 2
      const top = (protocol.frame.height - fixture.dimensions.height * scale) / 2
      for (const probe of group.probes) {
        expect(probeIds.has(probe.probeId)).toBe(false)
        probeIds.add(probe.probeId)
        if (probe.sourcePixel === null) {
          expect(probe.framePoint.x < left || probe.framePoint.y < top).toBe(true)
          expect(probe.expectedEffectiveTone).toBe(0)
          continue
        }
        const { x, y } = probe.sourcePixel
        expect(probe.framePoint.x).toBeCloseTo(left + (x + 0.5) * scale, 11)
        expect(probe.framePoint.y).toBeCloseTo(top + (y + 0.5) * scale, 11)
        const offset = (y * fixture.dimensions.width + x) * 4
        expect(decoded.rgba[offset + 3]).toBe(probe.expectedAlphaByte)
        const permission = decoded.rgba[offset + 3] / 255
        expect(permission).toBeCloseTo(probe.expectedAlphaByte / 255, 12)
        if (probe.expectedEffectiveTone === 0) {
          const tone = rawTone(decoded.rgba, fixture.dimensions.width, x, y)
          for (const gamma of [0, 0.5, 1]) {
            for (const contrast of [0, 0.5, 1]) {
              expect(
                toneContrast(toneGamma(tone, gamma), contrast) * permission,
              ).toBe(0)
            }
          }
        }
        if (probe.expectedRawTone !== undefined) {
          const tone = rawTone(decoded.rgba, fixture.dimensions.width, x, y)
          expect(tone).toBeCloseTo(probe.expectedRawTone, 11)
          const gamma = [0, 0.5, 1].map((control) => toneGamma(tone, control))
          expect(gamma[0]).toBeGreaterThan(gamma[1])
          expect(gamma[1]).toBeGreaterThan(gamma[2])
          expect(gamma[1]).toBeCloseTo(tone, 12)
          const contrast = [0, 0.5, 1].map((control) =>
            toneContrast(tone, control),
          )
          expect(contrast[1]).toBeCloseTo(tone, 12)
          if (tone < 0.5) {
            expect(contrast[0]).toBeGreaterThan(contrast[1])
            expect(contrast[1]).toBeGreaterThan(contrast[2])
          } else {
            expect(contrast[0]).toBeLessThan(contrast[1])
            expect(contrast[1]).toBeLessThan(contrast[2])
          }
        }
      }
    }
    expect(protocol.measurement.toneSampling).toMatchObject({
      gammaSweep: { toneGammaValues: [0, 0.5, 1], fixedToneContrast: 0.5 },
      contrastSweep: { toneContrastValues: [0, 0.5, 1], fixedToneGamma: 0.5 },
      comparisonTolerance: 1e-12,
    })
    expect(protocol.measurement.toneSampling.rules).toHaveLength(5)
  })

  it('pins ordered tuples and collision-proof evidence names', () => {
    expect(protocol.orderedLimitCandidates).toEqual([
      {
        candidateId: 'current-fine-baseline',
        maxAcceptedSegments: 50000,
        maxPolylines: 4000,
        maxStagnations: 8000,
        maxRestarts: 4000,
      },
      {
        candidateId: 'fine-100k',
        maxAcceptedSegments: 100000,
        maxPolylines: 8000,
        maxStagnations: 16000,
        maxRestarts: 8000,
      },
      {
        candidateId: 'fine-250k',
        maxAcceptedSegments: 250000,
        maxPolylines: 16000,
        maxStagnations: 32000,
        maxRestarts: 16000,
      },
      {
        candidateId: 'fine-500k',
        maxAcceptedSegments: 500000,
        maxPolylines: 32000,
        maxStagnations: 64000,
        maxRestarts: 32000,
      },
      {
        candidateId: 'fine-1000k',
        maxAcceptedSegments: 1000000,
        maxPolylines: 64000,
        maxStagnations: 128000,
        maxRestarts: 64000,
      },
    ])

    const candidateIds = new Set()
    const tuples = new Set()
    const evidencePaths = new Set()
    for (
      let index = 0;
      index < protocol.orderedLimitCandidates.length;
      index += 1
    ) {
      const candidate = protocol.orderedLimitCandidates[index]
      expect(Object.keys(candidate).sort()).toEqual(
        ['candidateId', ...LIMIT_KEYS].sort(),
      )
      expect(candidate.candidateId).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      expect(candidateIds.has(candidate.candidateId)).toBe(false)
      candidateIds.add(candidate.candidateId)
      expect(tuples.has(tupleToken(candidate))).toBe(false)
      tuples.add(tupleToken(candidate))
      for (const key of LIMIT_KEYS) {
        expect(Number.isSafeInteger(candidate[key])).toBe(true)
        expect(candidate[key]).toBeGreaterThan(0)
        if (index > 0) {
          expect(candidate[key]).toBeGreaterThan(
            protocol.orderedLimitCandidates[index - 1][key],
          )
        }
      }
      for (const scenario of protocol.scenarios) {
        for (const suffix of protocol.captureSuffixes) {
          const path = `results/issue-336-20260718T120000Z/${scenario.scenarioId}/${candidate.candidateId}--${tupleToken(candidate)}/${scenario.captureStem}--${candidate.candidateId}--${tupleToken(candidate)}--${suffix}`
          expect(evidencePaths.has(path)).toBe(false)
          evidencePaths.add(path)
        }
      }
    }
    expect(protocol.evidenceNaming).toMatchObject({
      campaignIdPattern: 'issue-336-[0-9]{8}T[0-9]{6}Z',
      tupleTokenTemplate:
        's{maxAcceptedSegments}-p{maxPolylines}-g{maxStagnations}-r{maxRestarts}',
      directoryTemplate:
        'results/{campaignId}/{scenarioId}/{candidateId}--{tupleToken}',
      captureTemplate:
        '{captureStem}--{candidateId}--{tupleToken}--{captureSuffix}',
      controlCandidateId: 'production-control',
    })
  })
})
