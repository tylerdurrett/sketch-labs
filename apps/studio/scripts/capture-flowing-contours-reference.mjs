#!/usr/bin/env node

import { existsSync } from 'node:fs'
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  primaryCheckoutRoot,
  workspaceRoot,
} from './lib/flowing-contours-reference-provenance.mjs'

const DEFAULT_PORT = 4400
const HARNESS_PATH = '/__flowing-contours-evidence__/'
const HARNESS_MODULE_PATH =
  '/__flowing-contours-evidence__/placeholder.mjs'
const PLACEHOLDER_PAYLOAD = Object.freeze({
  schemaVersion: 1,
  kind: 'flowing-contours-reference-placeholder',
  phase: 'FC24b-phase-1',
})
const studioRoot = fileURLToPath(new URL('..', import.meta.url))

const HELP = `Usage:
  node apps/studio/scripts/capture-flowing-contours-reference.mjs --dry-run
  node apps/studio/scripts/capture-flowing-contours-reference.mjs --write
  node apps/studio/scripts/capture-flowing-contours-reference.mjs --verify
  node apps/studio/scripts/capture-flowing-contours-reference.mjs --self-test

Options:
  --dry-run   Launch the inert pinned-browser harness and return its placeholder.
  --write     Reserved for FC24b's production evidence write phase.
  --verify    Reserved for FC24b's production evidence verification phase.
  --port N    Vite port (default ${DEFAULT_PORT}).
  --self-test Exercise parser, payload, and import-boundary guards.
  --help      Print this help.

Phase 1 contains no generator, compositor, renderer, metric, PNG, manifest, or
artifact capture. --write and --verify fail closed until those later phases.`

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
    selfTest: false,
    verify: false,
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
    } else if (argument === '--self-test') {
      mark(argument)
      options.selfTest = true
    } else if (argument === '--dry-run') {
      mark(argument)
      options.dryRun = true
    } else if (argument === '--write') {
      mark(argument)
      options.write = true
    } else if (argument === '--verify') {
      mark(argument)
      options.verify = true
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

  if (options.help || options.selfTest) {
    if (seen.size !== 1) {
      throw new Error(
        `${options.help ? '--help' : '--self-test'} cannot be combined with other arguments`,
      )
    }
    return Object.freeze(options)
  }
  const modeCount = [
    options.dryRun,
    options.write,
    options.verify,
  ].filter(Boolean).length
  if (modeCount !== 1) {
    throw new Error(
      'Choose exactly one of --dry-run, --write, or --verify',
    )
  }
  return Object.freeze(options)
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
  const [lock, installedPackage, installedBrowsersPackage] =
    await Promise.all([
      readFile(`${directory}/package-lock.json`, 'utf8').then(JSON.parse),
      readFile(
        `${directory}/node_modules/puppeteer/package.json`,
        'utf8',
      ).then(JSON.parse),
      readFile(
        `${directory}/node_modules/@puppeteer/browsers/package.json`,
        'utf8',
      ).then(JSON.parse),
    ])
  const lockedVersion = lock.packages?.['node_modules/puppeteer']?.version
  const lockedBrowsersVersion =
    lock.packages?.['node_modules/@puppeteer/browsers']?.version
  if (
    installedPackage.version !== lockedVersion ||
    installedBrowsersPackage.version !== lockedBrowsersVersion
  ) {
    throw new Error(
      'Installed Puppeteer browser packages differ from their protected lock',
    )
  }
  const chromeRevision = puppeteer.PUPPETEER_REVISIONS.chrome
  const cacheDirectory = join(homedir(), '.cache', 'puppeteer')
  const computedPath = browsers.computeExecutablePath({
    browser: browsers.Browser.CHROME,
    buildId: chromeRevision,
    cacheDir: cacheDirectory,
  })
  if (
    !computedPath.startsWith(`${cacheDirectory}/chrome/`) ||
    !computedPath.includes(chromeRevision) ||
    !existsSync(computedPath)
  ) {
    throw new Error(
      'Exact package-managed Chrome build is unavailable; follow apps/studio/scripts/README.md',
    )
  }
  return Object.freeze({
    browsersVersion: installedBrowsersPackage.version,
    chromeRevision,
    executablePath: await realpath(computedPath),
    puppeteer,
    puppeteerVersion: installedPackage.version,
  })
}

function placeholderModuleSource() {
  return `globalThis.__flowingContoursEvidencePlaceholder = Object.freeze(${JSON.stringify(PLACEHOLDER_PAYLOAD)})
`
}

function placeholderHarnessPlugin() {
  const requestedPaths = new Set()
  const html =
    '<!doctype html><meta charset="utf-8">' +
    '<link rel="icon" href="data:,">' +
    `<script type="module" src="${HARNESS_MODULE_PATH}"></script>`
  const moduleSource = placeholderModuleSource()
  return Object.freeze({
    requestedPaths,
    plugin: {
      name: 'flowing-contours-evidence-placeholder',
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
          next()
        })
      },
    },
  })
}

function assertInertRequests(requestedPaths) {
  const allowed = new Set([HARNESS_PATH, HARNESS_MODULE_PATH])
  for (const path of requestedPaths) {
    if (!allowed.has(path)) {
      throw new Error(`placeholder harness requested unexpected path: ${path}`)
    }
  }
  for (const forbidden of [
    'main.tsx',
    'App.tsx',
    'registry.ts',
    'generator.ts',
    'compositor',
    'renderer',
    'metrics',
    'scene.ts',
  ]) {
    if ([...requestedPaths].some((path) => path.includes(forbidden))) {
      throw new Error(
        `placeholder harness loaded forbidden path: ${forbidden}`,
      )
    }
  }
}

async function captureInFreshContext(browser, url) {
  const context = await browser.createBrowserContext()
  let primaryError
  let payload
  try {
    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'networkidle0' })
    await page.waitForFunction(
      () =>
        globalThis.__flowingContoursEvidencePlaceholder !== undefined,
    )
    payload = await page.evaluate(
      () => globalThis.__flowingContoursEvidencePlaceholder,
    )
  } catch (error) {
    primaryError = error
  }
  const [closed] = await Promise.allSettled([context.close()])
  if (primaryError !== undefined) throw primaryError
  if (closed.status === 'rejected') throw closed.reason
  return payload
}

async function closeRuntime(
  browser,
  server,
  runtimeDirectory,
  primaryError,
) {
  const shutdownResults = await Promise.allSettled([
    Promise.resolve().then(() => browser?.close()),
    Promise.resolve().then(() => server?.close()),
  ])
  const removalResults = await Promise.allSettled([
    Promise.resolve().then(() =>
      runtimeDirectory === undefined
        ? undefined
        : rm(runtimeDirectory, { recursive: true, force: true }),
    ),
  ])
  const failures = [...shutdownResults, ...removalResults]
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason)
  if (primaryError !== undefined && failures.length > 0) {
    throw new AggregateError(
      [primaryError, ...failures],
      'Placeholder capture failed and runtime cleanup was incomplete',
      { cause: primaryError },
    )
  }
  if (primaryError !== undefined) throw primaryError
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'Placeholder capture runtime cleanup failed',
    )
  }
}

async function runDryRun(options) {
  const primaryRoot = await primaryCheckoutRoot()
  const [vite, browserTools] = await Promise.all([
    viteApi(primaryRoot),
    browserDependencies(primaryRoot),
  ])
  let browser
  let primaryError
  let runtimeDirectory
  let server
  let output
  try {
    runtimeDirectory = await mkdtemp(
      join(tmpdir(), 'flowing-contours-evidence-vite-'),
    )
    const harness = placeholderHarnessPlugin()
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
    const product = await browser.version()
    const launchedPath = await realpath(browser.process().spawnfile)
    if (
      product !== `Chrome/${browserTools.chromeRevision}` ||
      launchedPath !== browserTools.executablePath
    ) {
      throw new Error(
        'Launched browser identity differs from package-managed Chrome pin',
      )
    }
    const url = `http://127.0.0.1:${options.port}${HARNESS_PATH}`
    const first = await captureInFreshContext(browser, url)
    const second = await captureInFreshContext(browser, url)
    if (
      JSON.stringify(first) !== JSON.stringify(PLACEHOLDER_PAYLOAD) ||
      JSON.stringify(second) !== JSON.stringify(PLACEHOLDER_PAYLOAD)
    ) {
      throw new Error('Independent placeholder captures differed')
    }
    assertInertRequests(harness.requestedPaths)
    output = {
      success: true,
      mode: 'dry-run',
      runtime: {
        chrome: product,
        chromeRevision: browserTools.chromeRevision,
        puppeteer: browserTools.puppeteerVersion,
        puppeteerBrowsers: browserTools.browsersVersion,
        vite: vite.version,
      },
      payload: first,
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

function expectArgumentError(args, fragment) {
  try {
    argumentsFrom(args)
  } catch (error) {
    if (String(error.message).includes(fragment)) return
    throw error
  }
  throw new Error(`Expected parser rejection containing: ${fragment}`)
}

function selfTest() {
  for (const mode of ['--dry-run', '--write', '--verify']) {
    const parsed = argumentsFrom([mode, '--port', '4401'])
    if (!parsed[mode.slice(2).replace('-run', 'Run')] && mode !== '--verify') {
      throw new Error(`valid ${mode} parser case failed`)
    }
    if (mode === '--verify' && !parsed.verify) {
      throw new Error('valid --verify parser case failed')
    }
  }
  for (const [args, fragment] of [
    [[], 'Choose exactly one'],
    [['--port'], 'requires a value'],
    [['--port', '--dry-run'], 'requires a value'],
    [['--port', '4400', '--port', '4401'], 'Duplicate'],
    [['--write', '--write'], 'Duplicate'],
    [['--write', '--verify'], 'Choose exactly one'],
    [['--self-test', '--dry-run'], 'cannot be combined'],
  ]) {
    expectArgumentError(args, fragment)
  }
  if (
    JSON.stringify(
      JSON.parse(
        placeholderModuleSource()
          .match(/Object\.freeze\((\{.*\})\)/)?.[1] ?? '',
      ),
    ) !== JSON.stringify(PLACEHOLDER_PAYLOAD) ||
    /\b(import|require)\b/.test(placeholderModuleSource())
  ) {
    throw new Error('placeholder payload or import boundary drifted')
  }
  assertInertRequests(new Set([HARNESS_PATH, HARNESS_MODULE_PATH]))
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
  if (!options.dryRun) {
    throw new Error(
      `${options.write ? '--write' : '--verify'} is reserved until FC24b production capture is implemented`,
    )
  }
  console.log(JSON.stringify(await runDryRun(options)))
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
