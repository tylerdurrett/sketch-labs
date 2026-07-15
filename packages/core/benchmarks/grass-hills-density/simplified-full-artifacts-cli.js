import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { clipSceneToBounds } from '../../src/clipToBounds.ts'
import { renderToSVG } from '../../src/renderer.ts'
import { DENSITY_FIXTURES } from './fixtures.js'
import { sceneInventory } from './metrics.js'
import { benchmarkCandidate } from './simplified-candidate.js'

const manifestPath = argument('manifest')
const finalist = Object.freeze({
  occluderMode: 'hill-and-clump',
  densityMode: 'plotter-lod',
})
const artifacts = []

for (const fixture of DENSITY_FIXTURES.slice(1)) {
  const payload = { ...fixture.payload, simplified: finalist }
  const generated = benchmarkCandidate.generate(payload, payload.t)
  for (const [kind, scene] of [
    ['fill', generated.scene],
    ['outline', generated.processing.scene],
  ]) {
    const clipped = clipSceneToBounds(scene)
    const svg = renderToSVG(clipped)
    const path = `/tmp/issue-305-y3b-${fixture.id}-${kind}.svg`
    writeFileSync(path, svg)
    artifacts.push({
      fixtureId: fixture.id,
      kind,
      path,
      sha256: createHash('sha256').update(svg).digest('hex'),
      bytes: Buffer.byteLength(svg),
      pathCount: (svg.match(/<path\b/g) ?? []).length,
      scene: sceneInventory(clipped),
    })
  }
}

const manifest = {
  recordedAt: '2026-07-15',
  candidate: {
    id: benchmarkCandidate.id,
    representation: 'open six-point blades/stable five-member tufts',
    ...finalist,
  },
  serializer: 'core renderToSVG after core clipSceneToBounds',
  artifactCount: artifacts.length,
  artifacts,
}
mkdirSync(dirname(manifestPath), { recursive: true })
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(`${manifestPath}\n`)

function argument(name) {
  const prefix = `--${name}=`
  const value = process.argv.find((item) => item.startsWith(prefix))?.slice(
    prefix.length,
  )
  if (!value) throw new Error(`${prefix}<path> is required`)
  return value
}
