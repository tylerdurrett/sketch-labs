#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  flowingContoursReferenceProvenance,
  primaryCheckoutRoot,
  workspaceRoot,
} from './lib/flowing-contours-reference-provenance.mjs'

const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const DEFAULT_PORT = 4399
const CASE_NAMES = Object.freeze(['flower', 'pinecone'])
const fixtureRoot = fileURLToPath(
  new URL(
    '../../../packages/core/src/__tests__/fixtures/flowing-contours/',
    import.meta.url,
  ),
)
const studioRoot = fileURLToPath(new URL('..', import.meta.url))
const referenceModulePath =
  `${workspaceRoot}/packages/core/src/__tests__/helpers/` +
  'flowingContoursReferenceCases.ts'

const HELP = `Usage:
  node apps/studio/scripts/prepare-flowing-contours-reference.mjs
  node apps/studio/scripts/prepare-flowing-contours-reference.mjs --write \\
    --provenance-commit <40-character lowercase SHA>
  node apps/studio/scripts/prepare-flowing-contours-reference.mjs --dry-run \\
    --provenance-commit <40-character lowercase SHA>
  node apps/studio/scripts/prepare-flowing-contours-reference.mjs --self-test

Options:
  --write                 Replace the two canonical prepared-input fixtures.
  --dry-run               Capture twice but do not read or write fixtures.
  --provenance-commit SHA Required for --write/--dry-run.
  --port PORT             Vite port (default ${DEFAULT_PORT}).
  --self-test             Exercise argument/schema guards without a browser.
  --help                  Print this help.

This command decodes the two pinned Image Assets in pinned Chrome and runs only
prepareFlowingContoursRaster. It never generates Scenes, metrics, PNGs, or
review evidence.`

export function argumentsFrom(commandLine) {
  const options = {
    help: false,
    dryRun: false,
    port: DEFAULT_PORT,
    provenanceCommit: undefined,
    selfTest: false,
    write: false,
  }
  for (let index = 0; index < commandLine.length; index += 1) {
    const argument = commandLine[index]
    if (argument === '--help' || argument === '-h') options.help = true
    else if (argument === '--write') options.write = true
    else if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--self-test') options.selfTest = true
    else if (argument === '--provenance-commit') {
      options.provenanceCommit = commandLine[index + 1]
      index += 1
    } else if (argument === '--port') {
      const port = Number(commandLine[index + 1])
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error('--port must be an integer from 1 through 65535')
      }
      options.port = port
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  if (options.help && commandLine.length > 1) {
    throw new Error('--help cannot be combined with other arguments')
  }
  if (options.selfTest && commandLine.length > 1) {
    throw new Error('--self-test cannot be combined with other arguments')
  }
  if (options.write && options.dryRun) {
    throw new Error('--write and --dry-run cannot be combined')
  }
  if (
    (options.write || options.dryRun) &&
    !COMMIT_PATTERN.test(options.provenanceCommit ?? '')
  ) {
    throw new Error(
      '--write/--dry-run requires --provenance-commit with a lowercase 40-character SHA',
    )
  }
  if (
    !options.write &&
    !options.dryRun &&
    options.provenanceCommit !== undefined
  ) {
    throw new Error(
      '--provenance-commit is valid only with --write or --dry-run',
    )
  }
  return Object.freeze(options)
}

function fixturePaths(name) {
  return Object.freeze({
    binary: `${fixtureRoot}${name}-prepared.f64le`,
    metadata: `${fixtureRoot}${name}-prepared.json`,
  })
}

async function verificationCommit() {
  let commit
  for (const name of CASE_NAMES) {
    const path = fixturePaths(name).metadata
    let metadata
    try {
      metadata = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`Flowing Contours fixture is missing: ${path}`)
      }
      throw error
    }
    if (!COMMIT_PATTERN.test(metadata.preparedFromCommit)) {
      throw new Error(`Fixture has invalid preparedFromCommit: ${path}`)
    }
    if (commit !== undefined && commit !== metadata.preparedFromCommit) {
      throw new Error('Flowing Contours fixtures pin different commits')
    }
    commit = metadata.preparedFromCommit
  }
  return commit
}

async function browserDependencies(primaryRoot) {
  const localDirectory =
    `${workspaceRoot}/.agents/skills/chrome-devtools/scripts`
  const primaryDirectory =
    `${primaryRoot}/.agents/skills/chrome-devtools/scripts`
  const directory = existsSync(`${localDirectory}/node_modules/puppeteer`)
    ? localDirectory
    : primaryDirectory
  const skillRequire = createRequire(`${directory}/package.json`)
  let puppeteer
  try {
    puppeteer = skillRequire('puppeteer')
  } catch {
    throw new Error(
      'Pinned browser tools are unavailable; follow apps/studio/scripts/README.md',
    )
  }
  const executablePath = puppeteer.executablePath()
  if (!existsSync(executablePath)) {
    throw new Error(
      'Pinned Chrome is unavailable; follow apps/studio/scripts/README.md',
    )
  }
  return Object.freeze({
    executablePath,
    pinnedChromeRevision: puppeteer.PUPPETEER_REVISIONS.chrome,
    puppeteer,
  })
}

async function viteApi(primaryRoot) {
  const local = `${studioRoot}node_modules/vite/dist/node/index.js`
  const primary =
    `${primaryRoot}/apps/studio/node_modules/vite/dist/node/index.js`
  const modulePath = existsSync(local) ? local : primary
  if (!existsSync(modulePath)) {
    throw new Error(
      'Studio Vite is unavailable; follow apps/studio/scripts/README.md',
    )
  }
  return import(pathToFileURL(modulePath).href)
}

async function capturePreparedRaster(page, url, referenceCases) {
  await page.goto(url, { waitUntil: 'networkidle2' })
  return page.evaluate(
    async ({ cases, root }) => {
      const resolver = await import('/src/imageAssetResolver.ts')
      const rasterModule = await import(
        `/@fs${root}/packages/core/src/sketches/flowing-contours/raster.ts`
      )
      const accountingModule = await import(
        `/@fs${root}/packages/core/src/sketches/flowing-contours/accounting.ts`
      )
      const digest = async (bytes) => {
        const hashed = new Uint8Array(
          await crypto.subtle.digest('SHA-256', bytes),
        )
        return [...hashed]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('')
      }

      const captures = {}
      for (const [name, reference] of Object.entries(cases)) {
        const response = await fetch(
          `/image-assets/${reference.source.assetId}.png`,
        )
        if (!response.ok) {
          throw new Error(`${name} source returned ${response.status}`)
        }
        const sourceBytes = await response.arrayBuffer()
        const pixels = await resolver.decodeImageAsset(
          reference.source.assetId,
        )
        const accounting =
          accountingModule.createFlowingContoursAccounting()
        const raster = rasterModule.prepareFlowingContoursRaster(
          pixels,
          accounting,
        )
        captures[name] = {
          source: {
            assetId: reference.source.assetId,
            repositoryPath: reference.source.repositoryPath,
            sha256: await digest(sourceBytes),
            decodedWidth: pixels.width,
            decodedHeight: pixels.height,
          },
          raster,
          accounting,
        }
      }
      return captures
    },
    { cases: referenceCases, root: workspaceRoot },
  )
}

function bytesEqual(first, second) {
  return (
    first.byteLength === second.byteLength &&
    first.every((byte, index) => byte === second[index])
  )
}

function canonicalCapture(referenceModule, captures, preparationCommit) {
  const output = {}
  for (const name of CASE_NAMES) {
    const capture = captures[name]
    const reference = referenceModule.FLOWING_CONTOURS_REFERENCE_CASES[name]
    if (JSON.stringify(capture.source) !== JSON.stringify(reference.source)) {
      throw new Error(`${name} source identity or decoded dimensions drifted`)
    }
    if (
      capture.accounting.termination !== 'complete' ||
      capture.accounting.limitedBy !== null ||
      capture.accounting.analysisWidth !== reference.analysis.width ||
      capture.accounting.analysisHeight !== reference.analysis.height ||
      capture.accounting.analysisSampleCount !==
        reference.analysis.sampleCount
    ) {
      throw new Error(`${name} preparation did not complete exactly`)
    }
    const bytes =
      referenceModule.encodeFlowingContoursPreparedRaster(capture.raster)
    if (bytes === null) {
      throw new Error(`${name} produced a non-canonical prepared raster`)
    }
    const fixtureSha256 = createHash('sha256').update(bytes).digest('hex')
    const metadata =
      referenceModule.createFlowingContoursFixtureMetadata(
        name,
        capture.raster,
        fixtureSha256,
        preparationCommit,
      )
    if (metadata === null) {
      throw new Error(`${name} did not match the FC23 fixture contract`)
    }
    const decoded = referenceModule.decodeFlowingContoursPreparedRaster(
      bytes,
      metadata,
    )
    if (decoded === null) {
      throw new Error(`${name} canonical round-trip failed`)
    }
    output[name] = Object.freeze({
      bytes,
      metadata,
      metadataBytes: Buffer.from(
        `${JSON.stringify(metadata, null, 2)}\n`,
      ),
    })
  }
  return Object.freeze(output)
}

async function writeOrVerify(capture, write) {
  if (write) await mkdir(fixtureRoot, { recursive: true })
  for (const name of CASE_NAMES) {
    const paths = fixturePaths(name)
    const current = capture[name]
    if (write) {
      await writeFile(paths.binary, current.bytes)
      await writeFile(paths.metadata, current.metadataBytes)
      continue
    }
    let binary
    let metadata
    try {
      ;[binary, metadata] = await Promise.all([
        readFile(paths.binary),
        readFile(paths.metadata),
      ])
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`Flowing Contours fixture is missing: ${error.path}`)
      }
      throw error
    }
    if (
      !bytesEqual(current.bytes, binary) ||
      !current.metadataBytes.equals(metadata)
    ) {
      throw new Error(`${name} fixture differs from production preparation`)
    }
  }
}

function selfTest() {
  const write = argumentsFrom([
    '--write',
    '--provenance-commit',
    'a'.repeat(40),
    '--port',
    '4400',
  ])
  if (!write.write || write.port !== 4400) {
    throw new Error('argument parser self-test failed')
  }
  const dryRun = argumentsFrom([
    '--dry-run',
    '--provenance-commit',
    'b'.repeat(40),
  ])
  if (!dryRun.dryRun || dryRun.write) {
    throw new Error('dry-run argument parser self-test failed')
  }
  for (const forbidden of [
    'acceptedTrajectories',
    'diagnostics',
    'geometry',
    'metrics',
    'pngs',
    'scene',
  ]) {
    if (HELP.includes(`"${forbidden}"`)) {
      throw new Error(`output-evidence field leaked into fixture schema: ${forbidden}`)
    }
  }
  return { success: true, mode: 'self-test' }
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2))
  if (options.help) {
    console.log(HELP)
    return
  }
  if (options.selfTest) {
    console.log(JSON.stringify(selfTest()))
    return
  }

  const preparationCommit =
    options.provenanceCommit ?? (await verificationCommit())
  const provenance =
    await flowingContoursReferenceProvenance(preparationCommit)
  const primaryRoot = await primaryCheckoutRoot()
  const [{ createServer }, browserTools] = await Promise.all([
    viteApi(primaryRoot),
    browserDependencies(primaryRoot),
  ])
  const server = await createServer({
    configFile: `${studioRoot}vite.config.ts`,
    root: studioRoot,
    logLevel: 'silent',
    server: {
      host: '127.0.0.1',
      port: options.port,
      strictPort: true,
    },
  })
  let browser
  try {
    await server.listen()
    const referenceModule = await server.ssrLoadModule(
      `/@fs${referenceModulePath}`,
    )
    browser = await browserTools.puppeteer.launch({
      executablePath: browserTools.executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })
    const page = await browser.newPage()
    const url = `http://127.0.0.1:${options.port}/`
    const first = canonicalCapture(
      referenceModule,
      await capturePreparedRaster(
        page,
        url,
        referenceModule.FLOWING_CONTOURS_REFERENCE_CASES,
      ),
      preparationCommit,
    )
    const second = canonicalCapture(
      referenceModule,
      await capturePreparedRaster(
        page,
        url,
        referenceModule.FLOWING_CONTOURS_REFERENCE_CASES,
      ),
      preparationCommit,
    )
    for (const name of CASE_NAMES) {
      if (
        !bytesEqual(first[name].bytes, second[name].bytes) ||
        !first[name].metadataBytes.equals(second[name].metadataBytes)
      ) {
        throw new Error(`Two pinned-Chrome preparations differed: ${name}`)
      }
    }
    if (!options.dryRun) await writeOrVerify(first, options.write)
    console.log(
      JSON.stringify({
        success: true,
        mode: options.write
          ? 'write'
          : options.dryRun
            ? 'dry-run'
            : 'verify',
        preparationCommit,
        browser: {
          product: await browser.version(),
          pinnedRevision: browserTools.pinnedChromeRevision,
        },
        provenance,
        fixtures: Object.fromEntries(
          CASE_NAMES.map((name) => [
            name,
            {
              sourceSha256: first[name].metadata.source.sha256,
              fixtureSha256: first[name].metadata.fixtureSha256,
              analysis: first[name].metadata.analysis,
              frame: first[name].metadata.frame,
              controls: first[name].metadata.controls,
              crops: first[name].metadata.crops,
              regions: first[name].metadata.regions,
              comparators: first[name].metadata.comparators,
            },
          ]),
        ),
      }),
    )
  } finally {
    if (browser !== undefined) await browser.close()
    await server.close()
  }
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntryPoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
