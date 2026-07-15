import { readFileSync } from 'node:fs'

const nodePath = argument('node')
const browserPath = argument('browser')
const campaign = JSON.parse(readFileSync(nodePath, 'utf8'))
const browserEnvelope = JSON.parse(readFileSync(browserPath, 'utf8'))
if (browserEnvelope.success !== true) throw new Error('browser screening failed')
const browser = browserEnvelope.result
const browserByKind = new Map(
  browser.observations.map((observation) => [observation.kind, observation]),
)

const results = campaign.results.map((result) => {
  if (result.status !== 'ok') {
    return {
      fixtureId: result.fixtureId,
      status: result.status,
      censor: result.censor,
    }
  }

  const metrics = result.phases.preparation.samples[0].metrics
  const representation = metrics.representation
  return {
    fixtureId: result.fixtureId,
    status: 'ok',
    variant: {
      occluderMode: representation.occluderMode,
      densityMode: representation.densityMode,
    },
    phaseMedianMs: {
      preparation: median(
        result.phases.preparation.samples.map((sample) => sample.durationMs),
      ),
      cold: median(result.phases.cold.samples.map((sample) => sample.durationMs)),
      warm: median(result.phases.warm.samples.map((sample) => sample.durationMs)),
    },
    maxRssMiB:
      Math.max(
        ...Object.values(result.phases).flatMap((phase) =>
          phase.samples.map((sample) => sample.memory.after.maxRssBytes),
        ),
      ) /
      1024 /
      1024,
    representation: {
      bladeCount: representation.bladeCount,
      tuftCount: representation.tuftCount,
      processedRootCount: representation.processedRootCount,
    },
    source: {
      primitiveCount: metrics.source.primitiveCount,
      pointCount: metrics.source.pointCount,
      checksum: metrics.source.checksum,
      serializedBytes: metrics.source.serializedBytes,
      structuralCanvasSubmissionMs: metrics.canvas.submissionMs,
    },
    processing: {
      durationMs: metrics.processing.durationMs,
      primitiveCount: metrics.processing.processed.primitiveCount,
      pointCount: metrics.processing.processed.pointCount,
      checksum: metrics.processing.processed.checksum,
    },
    plotter: {
      pathCount: metrics.plotter.pathCount,
      svgBytes: metrics.plotter.svgBytes,
      serializationMs: metrics.plotter.durationMs,
    },
    physicalSpacing: {
      nibWidthMillimeters: metrics.physicalSpacing.nibWidthMillimeters,
      rootMinimumMillimeters: metrics.physicalSpacing.roots.min,
      rootMedianMillimeters: metrics.physicalSpacing.roots.p50,
      pathClearanceMedianMillimeters:
        metrics.physicalSpacing.clearances.paths.millimeters.p50,
      collidingPathPairCount:
        metrics.physicalSpacing.clearances.collisions.pathPairCount,
    },
    browser: {
      source: browserSummary(browserByKind.get(`${result.fixtureId}--source`)),
      processed: browserSummary(
        browserByKind.get(`${result.fixtureId}--processed`),
      ),
    },
  }
})

const report = {
  recordedAt: '2026-07-15',
  campaign: {
    protocolVersion: campaign.protocolVersion,
    mode: campaign.mode,
    policy: campaign.policy,
    candidateBundle: 'generated; not committed',
    resultCount: campaign.results.length,
    okCount: campaign.results.filter((result) => result.status === 'ok').length,
    censoredCount: campaign.results.filter(
      (result) => result.status === 'censored',
    ).length,
    runtime: campaign.results.find((result) => result.runtime)?.runtime ?? null,
  },
  browser: {
    harness: 'core drawSceneFitted',
    canvas: browser.canvas,
    machine: browser.machine,
    redrawsPerScene: browser.observations[0]?.redrawSamplesMs.length ?? 0,
    observationCount: browser.observations.length,
  },
  results,
  finalist: {
    representation: 'open six-point blades/stable five-member tufts',
    occluderMode: 'hill-and-clump',
    densityMode: 'plotter-lod',
    selectedCount: 1,
    reasons: [
      'all baseline and one-hill 5k screen jobs completed inside the pinned 90 second/1 GiB policy',
      'the one-hill 5k processed Scene retains the grass-covered hill silhouette with 2,950 paths instead of 5,000',
      'deterministic LOD raises retained-root minimum spacing from 0.038 mm to 0.302 mm, above the pinned 0.30 mm nib',
      'actual 1000x1000 Canvas redraw median is about 0.6 ms for the processed 5k Scene',
      'clump processing costs about 34 ms, but generation preparation remains the dominant roughly 2.3 second operation',
    ],
  },
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)

function argument(name) {
  const prefix = `--${name}=`
  const value = process.argv.find((item) => item.startsWith(prefix))?.slice(
    prefix.length,
  )
  if (!value) throw new Error(`${prefix}<path> is required`)
  return value
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function browserSummary(observation) {
  if (observation === undefined) throw new Error('missing browser observation')
  return {
    checksum: observation.sha256,
    primitiveCount: observation.primitiveCount,
    pointCount: observation.pointCount,
    serializedBytes: observation.bytes,
    loadMs: observation.loadMs,
    firstDrawMs: observation.firstDrawMs,
    redrawMedianMs: median(observation.redrawSamplesMs),
    redrawMinMs: Math.min(...observation.redrawSamplesMs),
    redrawMaxMs: Math.max(...observation.redrawSamplesMs),
  }
}
