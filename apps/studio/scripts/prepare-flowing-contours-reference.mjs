#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  flowingContoursReferenceProvenance,
  PENCIL_CONTOUR_REVISION,
  primaryCheckoutRoot,
  WATERCOLOR_FORMS_REVISION,
  workspaceRoot,
} from './lib/flowing-contours-reference-provenance.mjs'

const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const DEFAULT_PORT = 4399
const CASE_NAMES = Object.freeze(['flower', 'pinecone'])
const HARNESS_PATH = '/__flowing-contours-reference__/'
const HARNESS_MODULE_PATH = '/__flowing-contours-reference__/capture.mjs'
const HARNESS_IMPORTS = Object.freeze([
  '/src/imageAssetResolver.ts',
  `/@fs${workspaceRoot}/packages/core/src/sketches/flowing-contours/raster.ts`,
  `/@fs${workspaceRoot}/packages/core/src/sketches/flowing-contours/accounting.ts`,
])
const FIXTURE_METADATA_KEYS = Object.freeze([
  'formatVersion',
  'fixtureStatus',
  'preparationVersion',
  'preparedFromCommit',
  'source',
  'frame',
  'controls',
  'crops',
  'regions',
  'topologyChecks',
  'comparators',
  'analysis',
  'encoding',
  'fixtureSha256',
])
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
  --write                 Transactionally replace both prepared-input fixtures.
  --dry-run               Capture twice but do not read or write fixtures.
  --provenance-commit SHA Required for --write/--dry-run.
  --port PORT             Vite port (default ${DEFAULT_PORT}).
  --self-test             Exercise parser, schema, import, and transaction guards.
  --help                  Print this help.

This command uses an inert script-owned Vite harness to decode the two pinned
Image Assets in package-managed Chrome and run only prepareFlowingContoursRaster.
It never boots Studio, generates Scenes, computes metrics, or creates PNGs or
review evidence.`

function optionValue(commandLine, index, option) {
  const value = commandLine[index + 1]
  if (
    value === undefined ||
    value === '' ||
    value.startsWith('-')
  ) {
    throw new Error(`${option} requires a value`)
  }
  return value
}

export function argumentsFrom(commandLine) {
  const options = {
    dryRun: false,
    help: false,
    port: DEFAULT_PORT,
    provenanceCommit: undefined,
    selfTest: false,
    write: false,
  }
  const seen = new Set()
  const mark = (name) => {
    if (seen.has(name)) throw new Error(`Duplicate argument: ${name}`)
    seen.add(name)
  }
  for (let index = 0; index < commandLine.length; index += 1) {
    const argument = commandLine[index]
    if (argument === '--help' || argument === '-h') {
      mark('--help')
      options.help = true
    } else if (argument === '--write') {
      mark(argument)
      options.write = true
    } else if (argument === '--dry-run') {
      mark(argument)
      options.dryRun = true
    } else if (argument === '--self-test') {
      mark(argument)
      options.selfTest = true
    } else if (argument === '--provenance-commit') {
      mark(argument)
      options.provenanceCommit = optionValue(
        commandLine,
        index,
        argument,
      )
      index += 1
    } else if (argument === '--port') {
      mark(argument)
      const port = Number(optionValue(commandLine, index, argument))
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error('--port must be an integer from 1 through 65535')
      }
      options.port = port
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  if (options.help && seen.size > 1) {
    throw new Error('--help cannot be combined with other arguments')
  }
  if (options.selfTest && seen.size > 1) {
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

function expectedViteVersion(lockText, studioPackage) {
  const importer = lockText.match(
    /\n  apps\/studio:\n([\s\S]*?)(?=\n  [^\s]|\npackages:)/,
  )?.[1]
  const match = importer?.match(
    /\n      vite:\n        specifier: ([^\n]+)\n        version: ([0-9]+\.[0-9]+\.[0-9]+)/,
  )
  if (
    match === undefined ||
    studioPackage.devDependencies?.vite !== match[1]
  ) {
    throw new Error('Studio Vite package and protected pnpm lock disagree')
  }
  return match[2]
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
  const [lockText, studioPackage, installedPackage] = await Promise.all([
    readFile(`${workspaceRoot}/pnpm-lock.yaml`, 'utf8'),
    readFile(`${workspaceRoot}/apps/studio/package.json`, 'utf8').then(
      JSON.parse,
    ),
    readFile(modulePath.replace('/dist/node/index.js', '/package.json'), 'utf8')
      .then(JSON.parse),
  ])
  const lockedVersion = expectedViteVersion(lockText, studioPackage)
  if (installedPackage.version !== lockedVersion) {
    throw new Error(
      `Installed Vite ${installedPackage.version} differs from protected lock ${lockedVersion}`,
    )
  }
  return Object.freeze({
    api: await import(pathToFileURL(modulePath).href),
    version: installedPackage.version,
  })
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
  let browsers
  let puppeteer
  try {
    puppeteer = skillRequire('puppeteer')
    browsers = skillRequire('@puppeteer/browsers')
  } catch {
    throw new Error(
      'Pinned browser tools are unavailable; follow apps/studio/scripts/README.md',
    )
  }
  const [lock, installedPackage] = await Promise.all([
    readFile(`${directory}/package-lock.json`, 'utf8').then(JSON.parse),
    readFile(`${directory}/node_modules/puppeteer/package.json`, 'utf8').then(
      JSON.parse,
    ),
  ])
  const lockedVersion = lock.packages?.['node_modules/puppeteer']?.version
  if (
    typeof lockedVersion !== 'string' ||
    installedPackage.version !== lockedVersion
  ) {
    throw new Error('Installed Puppeteer differs from its protected lock')
  }
  const pinnedChromeRevision = puppeteer.PUPPETEER_REVISIONS.chrome
  const cacheDirectory = join(homedir(), '.cache', 'puppeteer')
  const computedPath = browsers.computeExecutablePath({
    browser: browsers.Browser.CHROME,
    buildId: pinnedChromeRevision,
    cacheDir: cacheDirectory,
  })
  if (
    !computedPath.startsWith(
      `${cacheDirectory}/chrome/`,
    ) ||
    !computedPath.includes(pinnedChromeRevision) ||
    !existsSync(computedPath)
  ) {
    throw new Error(
      'Exact package-managed Chrome build is unavailable; follow apps/studio/scripts/README.md',
    )
  }
  return Object.freeze({
    executablePath: await realpath(computedPath),
    pinnedChromeRevision,
    puppeteer,
    version: installedPackage.version,
  })
}

function harnessModuleSource() {
  return `import { decodeImageAsset } from '${HARNESS_IMPORTS[0]}'
import { prepareFlowingContoursRaster } from '${HARNESS_IMPORTS[1]}'
import { createFlowingContoursAccounting } from '${HARNESS_IMPORTS[2]}'

globalThis.__flowingContoursReferenceHarness = Object.freeze({
  decodeImageAsset,
  prepareFlowingContoursRaster,
  createFlowingContoursAccounting,
})
`
}

function captureHarnessPlugin(referenceCases) {
  const sourceByUrl = new Map(
    CASE_NAMES.map((name) => {
      const source = referenceCases[name].source
      return [
        `/image-assets/${source.assetId}.png`,
        `${workspaceRoot}/${source.repositoryPath}`,
      ]
    }),
  )
  const requestedPaths = new Set()
  const html =
    '<!doctype html><meta charset="utf-8">' +
    `<script type="module" src="${HARNESS_MODULE_PATH}"></script>`
  const moduleSource = harnessModuleSource()
  return Object.freeze({
    requestedPaths,
    plugin: {
      name: 'flowing-contours-reference-harness',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const path = request.url?.split('?', 1)[0] ?? ''
          requestedPaths.add(path)
          if (path === HARNESS_PATH) {
            response.statusCode = 200
            response.setHeader('Content-Type', 'text/html; charset=utf-8')
            response.end(html)
            return
          }
          if (path === HARNESS_MODULE_PATH) {
            response.statusCode = 200
            response.setHeader(
              'Content-Type',
              'application/javascript; charset=utf-8',
            )
            response.end(moduleSource)
            return
          }
          const sourcePath = sourceByUrl.get(path)
          if (sourcePath !== undefined) {
            readFile(sourcePath).then(
              (bytes) => {
                response.statusCode = 200
                response.setHeader('Content-Type', 'image/png')
                response.end(bytes)
              },
              next,
            )
            return
          }
          if (path.startsWith('/image-assets/')) {
            response.statusCode = 404
            response.end()
            return
          }
          next()
        })
      },
    },
  })
}

async function capturePreparedRaster(page, url, referenceCases) {
  await page.goto(url, { waitUntil: 'networkidle0' })
  await page.waitForFunction(
    () => globalThis.__flowingContoursReferenceHarness !== undefined,
  )
  return page.evaluate(async (cases) => {
    const harness = globalThis.__flowingContoursReferenceHarness
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
      const pixels = await harness.decodeImageAsset(
        reference.source.assetId,
      )
      const accounting = harness.createFlowingContoursAccounting()
      const raster = harness.prepareFlowingContoursRaster(
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
  }, referenceCases)
}

async function captureInFreshContext(browser, url, referenceCases) {
  const context = await browser.createBrowserContext()
  let primaryError
  let result
  try {
    const page = await context.newPage()
    result = await capturePreparedRaster(page, url, referenceCases)
  } catch (error) {
    primaryError = error
  }
  const [closed] = await Promise.allSettled([context.close()])
  if (primaryError !== undefined) throw primaryError
  if (closed.status === 'rejected') throw closed.reason
  return result
}

function bytesEqual(first, second) {
  return (
    first.byteLength === second.byteLength &&
    first.every((byte, index) => byte === second[index])
  )
}

function exactMetadataBoundary(metadata) {
  const keys = Reflect.ownKeys(metadata)
  return (
    keys.length === FIXTURE_METADATA_KEYS.length &&
    keys.every((key) => typeof key === 'string') &&
    FIXTURE_METADATA_KEYS.every((key) => keys.includes(key))
  )
}

function assertComparatorRevisions(referenceModule) {
  const revisions = referenceModule.FLOWING_CONTOURS_REFERENCE_COMPARATORS
  if (
    revisions.pencilContour.revision !== PENCIL_CONTOUR_REVISION ||
    revisions.watercolorForms.revision !== WATERCOLOR_FORMS_REVISION
  ) {
    throw new Error(
      'Protected comparator revisions differ from the FC23 contract',
    )
  }
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
    if (metadata === null || !exactMetadataBoundary(metadata)) {
      throw new Error(`${name} did not match the exact FC23 fixture schema`)
    }
    if (
      referenceModule.decodeFlowingContoursPreparedRaster(
        bytes,
        metadata,
      ) === null
    ) {
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

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function unlinkIfPresent(path) {
  try {
    await unlink(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function syncDirectory(path) {
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

async function stageReplacement(target, bytes, token) {
  const staged = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${token}.tmp`,
  )
  const file = await open(staged, 'wx', 0o644)
  let primaryError
  try {
    await file.writeFile(bytes)
    await file.sync()
  } catch (error) {
    primaryError = error
  }
  const [closed] = await Promise.allSettled([file.close()])
  if (primaryError !== undefined) {
    await unlinkIfPresent(staged)
    throw primaryError
  }
  if (closed.status === 'rejected') {
    await unlinkIfPresent(staged)
    throw closed.reason
  }
  return staged
}

async function transactionallyReplace(replacements, failAfterInstall) {
  if (replacements.length === 0) return
  const directory = dirname(replacements[0].target)
  if (
    replacements.some(
      (replacement) => dirname(replacement.target) !== directory,
    )
  ) {
    throw new Error('Transactional fixture targets must share one directory')
  }
  await mkdir(directory, { recursive: true })
  await syncDirectory(directory)
  const token = randomBytes(8).toString('hex')
  const records = []
  let committed = false
  try {
    for (const replacement of replacements) {
      records.push({
        ...replacement,
        backup: join(
          directory,
          `.${basename(replacement.target)}.${process.pid}.${token}.rollback`,
        ),
        staged: await stageReplacement(
          replacement.target,
          replacement.bytes,
          token,
        ),
        moved: false,
        installed: false,
      })
    }
    for (const record of records) {
      if (await pathExists(record.target)) {
        await rename(record.target, record.backup)
        record.moved = true
      }
    }
    let installedCount = 0
    for (const record of records) {
      await rename(record.staged, record.target)
      record.installed = true
      installedCount += 1
      if (installedCount === failAfterInstall) {
        throw new Error('injected transactional replacement failure')
      }
    }
    await syncDirectory(directory)
    committed = true
    const backupCleanup = await Promise.allSettled(
      records
        .filter((record) => record.moved)
        .map((record) => unlink(record.backup)),
    )
    const backupFailures = backupCleanup
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason)
    if (backupFailures.length > 0) {
      throw new AggregateError(
        backupFailures,
        'Fixture transaction committed but rollback-file cleanup failed',
      )
    }
    await syncDirectory(directory)
  } catch (primaryError) {
    if (committed) throw primaryError
    const rollbackErrors = []
    for (const record of records.slice().reverse()) {
      if (!record.installed && !record.moved) continue
      try {
        if (record.installed) await unlinkIfPresent(record.target)
        if (record.moved) await rename(record.backup, record.target)
      } catch (error) {
        rollbackErrors.push(error)
      }
    }
    const cleanup = await Promise.allSettled(
      records.flatMap((record) => [
        unlinkIfPresent(record.staged),
        unlinkIfPresent(record.backup),
      ]),
    )
    rollbackErrors.push(
      ...cleanup
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason),
    )
    try {
      await syncDirectory(directory)
    } catch (error) {
      rollbackErrors.push(error)
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...rollbackErrors],
        'Fixture transaction failed and rollback was incomplete',
        { cause: primaryError },
      )
    }
    throw primaryError
  } finally {
    await Promise.allSettled(
      records.flatMap((record) => [
        unlinkIfPresent(record.staged),
        unlinkIfPresent(record.backup),
      ]),
    )
  }
}

async function writeOrVerify(capture, write) {
  if (write) {
    await transactionallyReplace(
      CASE_NAMES.flatMap((name) => {
        const paths = fixturePaths(name)
        return [
          { target: paths.binary, bytes: capture[name].bytes },
          { target: paths.metadata, bytes: capture[name].metadataBytes },
        ]
      }),
    )
    return
  }
  for (const name of CASE_NAMES) {
    const paths = fixturePaths(name)
    const current = capture[name]
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

function expectArgumentError(args, fragment) {
  try {
    argumentsFrom(args)
  } catch (error) {
    if (String(error.message).includes(fragment)) return
    throw error
  }
  throw new Error(`Expected parser rejection containing: ${fragment}`)
}

async function transactionSelfTest() {
  const directory = await mkdtemp(
    join(tmpdir(), 'flowing-contours-reference-transaction-'),
  )
  try {
    const targets = Array.from(
      { length: 4 },
      (_, index) => join(directory, `fixture-${index}`),
    )
    const originals = targets.map((_, index) =>
      index < 2 ? Buffer.from(`original-${index}`) : null,
    )
    await Promise.all(
      targets.slice(0, 2).map(async (target, index) => {
        const file = await open(target, 'wx', 0o600)
        try {
          await file.writeFile(originals[index])
          await file.sync()
        } finally {
          await file.close()
        }
      }),
    )
    const replacements = targets.map((target, index) => ({
      target,
      bytes: Buffer.from(`replacement-${index}`),
    }))
    await transactionallyReplace(replacements, 3).then(
      () => {
        throw new Error('injected transaction unexpectedly succeeded')
      },
      (error) => {
        if (!String(error.message).includes('injected')) throw error
      },
    )
    const rolledBack = await Promise.all(
      targets.map(async (path) =>
        (await pathExists(path)) ? readFile(path) : null,
      ),
    )
    if (
      !rolledBack.every((bytes, index) =>
        originals[index] === null
          ? bytes === null
          : bytes?.equals(originals[index]),
      )
    ) {
      throw new Error('transaction rollback left a mixed fixture set')
    }
    await transactionallyReplace(replacements)
    const replaced = await Promise.all(targets.map((path) => readFile(path)))
    if (
      !replaced.every((bytes, index) =>
        bytes.equals(replacements[index].bytes),
      )
    ) {
      throw new Error('transaction commit left a mixed fixture set')
    }
    if ((await readdir(directory)).length !== 4) {
      throw new Error('transaction left temporary or rollback files')
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function selfTest() {
  const write = argumentsFrom([
    '--write',
    '--provenance-commit',
    'a'.repeat(40),
    '--port',
    '4400',
  ])
  if (!write.write || write.port !== 4400) {
    throw new Error('valid argument parser case failed')
  }
  for (const [args, fragment] of [
    [['--port'], 'requires a value'],
    [['--port', '--write'], 'requires a value'],
    [['--port', '4400', '--port', '4401'], 'Duplicate'],
    [['--write', '--write'], 'Duplicate'],
    [
      ['--provenance-commit', 'a'.repeat(40), '--provenance-commit', 'b'.repeat(40)],
      'Duplicate',
    ],
    [['--write', '--dry-run'], 'cannot be combined'],
  ]) {
    expectArgumentError(args, fragment)
  }
  const imports = [
    ...harnessModuleSource().matchAll(/from '([^']+)'/g),
  ].map((match) => match[1])
  if (JSON.stringify(imports) !== JSON.stringify(HARNESS_IMPORTS)) {
    throw new Error('capture harness import boundary drifted')
  }
  for (const forbidden of ['/generator', '/scene', '/metrics', '/App', '/main']) {
    if (harnessModuleSource().includes(forbidden)) {
      throw new Error(`capture harness imports forbidden module: ${forbidden}`)
    }
  }
  const exact = Object.fromEntries(
    FIXTURE_METADATA_KEYS.map((key) => [key, null]),
  )
  if (
    !exactMetadataBoundary(exact) ||
    exactMetadataBoundary({ ...exact, metrics: {} })
  ) {
    throw new Error('exact FC23 metadata boundary guard failed')
  }
  await transactionSelfTest()
  return { success: true, mode: 'self-test' }
}

function assertInertRequests(requestedPaths) {
  for (const forbidden of [
    '/src/main.tsx',
    '/src/App.tsx',
    '/@fs/packages/core/src/registry.ts',
  ]) {
    if ([...requestedPaths].some((path) => path.endsWith(forbidden))) {
      throw new Error(`inert harness loaded forbidden application path: ${forbidden}`)
    }
  }
}

async function closeRuntime(
  browser,
  server,
  runtimeDirectory,
  primaryError,
) {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => browser?.close()),
    Promise.resolve().then(() => server?.close()),
    Promise.resolve().then(() =>
      runtimeDirectory === undefined
        ? undefined
        : rm(runtimeDirectory, { recursive: true, force: true }),
    ),
  ])
  if (primaryError !== undefined) throw primaryError
  const failures = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason)
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Reference runtime cleanup failed')
  }
}

async function runCapture(options) {
  const preparationCommit =
    options.provenanceCommit ?? (await verificationCommit())
  const provenance =
    await flowingContoursReferenceProvenance(preparationCommit)
  const primaryRoot = await primaryCheckoutRoot()
  const [vite, browserTools] = await Promise.all([
    viteApi(primaryRoot),
    browserDependencies(primaryRoot),
  ])
  let server
  let browser
  let runtimeDirectory
  let primaryError
  let output
  try {
    runtimeDirectory = await mkdtemp(
      join(tmpdir(), 'flowing-contours-reference-vite-'),
    )
    const referenceBootstrap = await vite.api.createServer({
      appType: 'custom',
      cacheDir: runtimeDirectory,
      configFile: false,
      logLevel: 'silent',
      root: studioRoot,
      server: {
        fs: { allow: [workspaceRoot] },
        host: '127.0.0.1',
        port: options.port,
        strictPort: true,
      },
    })
    server = referenceBootstrap
    await server.listen()
    const referenceModule = await server.ssrLoadModule(
      `/@fs${referenceModulePath}`,
    )
    assertComparatorRevisions(referenceModule)
    const harness = captureHarnessPlugin(
      referenceModule.FLOWING_CONTOURS_REFERENCE_CASES,
    )
    await server.close()
    server = await vite.api.createServer({
      appType: 'custom',
      cacheDir: runtimeDirectory,
      configFile: false,
      logLevel: 'silent',
      plugins: [harness.plugin],
      root: studioRoot,
      server: {
        fs: { allow: [workspaceRoot] },
        host: '127.0.0.1',
        port: options.port,
        strictPort: true,
      },
    })
    await server.listen()
    browser = await browserTools.puppeteer.launch({
      executablePath: browserTools.executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })
    const launchedProduct = await browser.version()
    const launchedPath = await realpath(browser.process().spawnfile)
    if (
      launchedProduct !== `Chrome/${browserTools.pinnedChromeRevision}` ||
      launchedPath !== browserTools.executablePath
    ) {
      throw new Error(
        'Launched browser identity differs from package-managed Chrome pin',
      )
    }
    const url = `http://127.0.0.1:${options.port}${HARNESS_PATH}`
    const first = canonicalCapture(
      referenceModule,
      await captureInFreshContext(
        browser,
        url,
        referenceModule.FLOWING_CONTOURS_REFERENCE_CASES,
      ),
      preparationCommit,
    )
    const second = canonicalCapture(
      referenceModule,
      await captureInFreshContext(
        browser,
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
        throw new Error(`Two independent preparations differed: ${name}`)
      }
    }
    assertInertRequests(harness.requestedPaths)
    if (!options.dryRun) await writeOrVerify(first, options.write)
    output = {
      success: true,
      mode: options.write
        ? 'write'
        : options.dryRun
          ? 'dry-run'
          : 'verify',
      preparationCommit,
      runtime: {
        chrome: launchedProduct,
        chromeRevision: browserTools.pinnedChromeRevision,
        puppeteer: browserTools.version,
        vite: vite.version,
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
    }
  } catch (error) {
    primaryError = error
  }
  await closeRuntime(
    browser,
    server,
    runtimeDirectory,
    primaryError,
  )
  return output
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2))
  if (options.help) {
    console.log(HELP)
    return
  }
  if (options.selfTest) {
    console.log(JSON.stringify(await selfTest()))
    return
  }
  console.log(JSON.stringify(await runCapture(options)))
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
