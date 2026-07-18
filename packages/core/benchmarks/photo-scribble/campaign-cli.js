import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createDefaultBrowserBoundary } from './browser-boundary.js'
import { runCampaign, validateCampaignManifest } from './campaign-runner.js'

function argument(name, fallback) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback
}

const manifestArgument = argument('manifest')
if (manifestArgument === undefined) {
  throw new Error('--manifest=<explicit screen or promotion job manifest> is required')
}
const root = process.cwd()
const protocolPath = resolve(root, 'packages/core/benchmarks/photo-scribble/protocol.json')
const fixturePath = resolve(root, 'packages/core/benchmarks/photo-scribble/fixtures.json')
const manifestPath = resolve(manifestArgument)
const outputRoot = resolve(argument(
  'out-dir',
  'packages/core/benchmarks/photo-scribble/results',
))
const source = (path) => readFileSync(path)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const protocolBytes = source(protocolPath)
const fixtureBytes = source(fixturePath)
const manifestBytes = source(manifestPath)
const protocol = JSON.parse(protocolBytes)
const manifest = JSON.parse(manifestBytes)

// Validate all scenario/candidate inputs before resolving Puppeteer.
validateCampaignManifest(manifest, protocol)
const boundary = await createDefaultBrowserBoundary(root)
const result = await runCampaign({
  manifest,
  protocol,
  outputRoot,
  boundary,
  inputDigests: {
    protocolSha256: sha256(protocolBytes),
    fixtureManifestSha256: sha256(fixtureBytes),
    jobManifestSha256: sha256(manifestBytes),
  },
})
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
