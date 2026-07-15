import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { jobs } from './simplified-screen-config.js'

const outputArgument = process.argv.find((argument) =>
  argument.startsWith('--out='),
)
if (!outputArgument) throw new Error('--out=<browser-served directory> is required')
const outputDirectory = resolve(outputArgument.slice('--out='.length))
mkdirSync(outputDirectory, { recursive: true })

const candidateModule = await import(jobs[0].candidate.moduleUrl)
const candidate = candidateModule.benchmarkCandidate ?? candidateModule.default
if (candidate?.id !== jobs[0].candidate.id) {
  throw new Error('bundled simplified candidate id does not match screen config')
}

const scenes = {}
for (const job of jobs) {
  const result = candidate.generate(job.fixture.payload, job.fixture.payload.t)
  for (const [kind, scene] of [
    ['source', result.scene],
    ['processed', result.processing.scene],
  ]) {
    const id = `${job.fixture.id}--${kind}`
    const file = `${id}.json`
    const serialized = JSON.stringify(scene)
    writeFileSync(resolve(outputDirectory, file), serialized)
    scenes[id] = {
      file,
      sha256: createHash('sha256').update(serialized).digest('hex'),
      primitiveCount: scene.primitives.length,
      pointCount: scene.primitives.reduce(
        (total, primitive) => total + primitive.points.length,
        0,
      ),
    }
  }
}

const manifestPath = resolve(outputDirectory, 'manifest.json')
writeFileSync(manifestPath, JSON.stringify({ scenes }, null, 2))
process.stdout.write(`${manifestPath}\n`)
