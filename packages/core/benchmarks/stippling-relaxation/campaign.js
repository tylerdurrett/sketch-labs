import { renameSync, writeFileSync } from 'node:fs'

import { resumeCompatibilityKey } from './protocol.js'

function rawArtifact(environment, config, samples) {
  return {
    schemaVersion: 1,
    environment,
    config,
    samples: [...samples].sort((first, second) =>
      first.id.localeCompare(second.id),
    ),
  }
}

/**
 * Execute incomplete cases and checkpoint after each completed case.
 *
 * Dependencies are injected so crash/resume behavior can be tested without
 * executing benchmark workloads or touching the filesystem.
 */
export function runBenchmarkCampaign({
  config,
  environment,
  previous,
  runCase,
  checkpoint,
}) {
  const candidate = rawArtifact(environment, config, [])
  if (
    previous !== undefined &&
    resumeCompatibilityKey(previous) !== resumeCompatibilityKey(candidate)
  ) {
    throw new Error('existing raw artifact is incompatible with this exact run')
  }

  const samples = [...(previous?.samples ?? [])]
  const completedIds = new Set(samples.map(({ id }) => id))
  let artifact = rawArtifact(environment, config, samples)
  for (const benchmarkCase of config.cases) {
    const selectedIds = config.phases.flatMap((phase) =>
      Array.from(
        { length: config.samples },
        (_, sampleIndex) => `${benchmarkCase.id}/${phase}/${sampleIndex}`,
      ),
    )
    if (selectedIds.every((id) => completedIds.has(id))) continue

    const completed = runCase(
      benchmarkCase,
      config.phases,
      config.warmups,
      config.samples,
      completedIds,
    )
    for (const sample of completed) {
      samples.push(sample)
      completedIds.add(sample.id)
    }
    artifact = rawArtifact(environment, config, samples)
    checkpoint(artifact)
  }

  // Persist a valid empty/already-complete selection and normalize ordering.
  checkpoint(artifact)
  return artifact
}

/** Write a complete JSON value and atomically replace the destination. */
export function atomicWriteRawArtifact(outputPath, artifact) {
  const temporaryPath = `${outputPath}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`)
  renameSync(temporaryPath, outputPath)
}
