#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const FRAME = Object.freeze({ width: 1000, height: 1000 })
const CASES = Object.freeze([
  Object.freeze({
    key: 'watercolorFlower',
    pipeline: 'watercolor-forms',
    assetId: 'img-0672-79d639daec62',
    binaryName: 'flower-prepared.f64le',
    metadataName: 'flower-prepared.json',
  }),
  Object.freeze({
    key: 'watercolorPinecone',
    pipeline: 'watercolor-forms',
    assetId: 'pinecone-4330aa0314f7',
    binaryName: 'pinecone-prepared.f64le',
    metadataName: 'pinecone-prepared.json',
  }),
  Object.freeze({
    key: 'pencilPinecone',
    pipeline: 'pencil-contour',
    assetId: 'pinecone-4330aa0314f7',
    binaryName: 'pinecone-analysis.f64le',
    metadataName: 'pinecone-analysis.json',
  }),
])
const COMMIT_PATTERN = /^[0-9a-f]{40}$/

const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url))
const studioRoot = fileURLToPath(new URL('..', import.meta.url))
const fixtureRoot = fileURLToPath(
  new URL('../../../packages/core/src/__tests__/fixtures/', import.meta.url),
)
const browserToolsDirectory = `${workspaceRoot}/.agents/skills/chrome-devtools/scripts`
const browserToolsBootstrap =
  'npm --prefix .agents/skills/chrome-devtools/scripts ci --ignore-scripts'
const chromeBootstrap =
  'npm --prefix .agents/skills/chrome-devtools/scripts exec -- puppeteer browsers install chrome'

function argumentsFrom(commandLine) {
  const args = {
    port: 4398,
    provenanceCommit: undefined,
    scope: undefined,
    write: false,
  }
  for (let index = 0; index < commandLine.length; index += 1) {
    const argument = commandLine[index]
    if (argument === '--write') args.write = true
    else if (argument === '--scope') {
      args.scope = commandLine[index + 1]
      index += 1
    } else if (argument === '--provenance-commit') {
      args.provenanceCommit = commandLine[index + 1]
      index += 1
    } else if (argument === '--port') {
      const value = Number(commandLine[index + 1])
      if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
        throw new Error('--port must be an integer from 1 through 65535')
      }
      args.port = value
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }

  if (args.scope !== 'fixtures') {
    throw new Error('--scope must be fixtures')
  }
  if (args.write) {
    if (
      args.provenanceCommit === undefined ||
      !COMMIT_PATTERN.test(args.provenanceCommit)
    ) {
      throw new Error(
        '--write requires --provenance-commit with a lowercase 40-character SHA',
      )
    }
  } else if (args.provenanceCommit !== undefined) {
    throw new Error('--provenance-commit is valid only with --write')
  }
  return args
}

function fixtureDirectory(pipeline) {
  return `${fixtureRoot}${pipeline}/`
}

function fixturePath(reference, kind) {
  const name =
    kind === 'binary' ? reference.binaryName : reference.metadataName
  return `${fixtureDirectory(reference.pipeline)}${name}`
}

function requireStudioVite() {
  const binary = `${studioRoot}node_modules/.bin/vite${
    process.platform === 'win32' ? '.cmd' : ''
  }`
  if (!existsSync(binary)) {
    throw new Error(
      [
        'Studio dependencies are not installed in this worktree.',
        'Run from the repository root:',
        '  pnpm install',
        'The documented ERR_PNPM_IGNORED_BUILDS exit is benign for this repo.',
      ].join('\n'),
    )
  }
  return binary
}

function requireBrowserTools() {
  const skillRequire = createRequire(`${browserToolsDirectory}/package.json`)
  let puppeteer
  try {
    skillRequire.resolve('puppeteer')
    puppeteer = skillRequire('puppeteer')
  } catch {
    throw new Error(
      [
        'Watercolor Forms capture browser tools are not installed.',
        'Bootstrap the pinned, skill-local dependencies from the repository root:',
        `  ${browserToolsBootstrap}`,
        `  ${chromeBootstrap}`,
        'Then rerun this command. This does not change workspace dependencies.',
      ].join('\n'),
    )
  }

  let executablePath
  try {
    executablePath = puppeteer.executablePath()
  } catch {
    executablePath = undefined
  }
  if (executablePath === undefined || !existsSync(executablePath)) {
    throw new Error(
      [
        'Puppeteer is installed, but its pinned Chrome binary is unavailable.',
        'Install that browser from the repository root:',
        `  ${chromeBootstrap}`,
        'Then rerun this command.',
      ].join('\n'),
    )
  }
  return puppeteer
}

async function waitForVite(url, process) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`Vite exited before capture (status ${process.exitCode})`)
    }
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // The server has not bound its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for the Studio Vite server')
}

async function existingProvenanceByCase() {
  const provenance = {}
  for (const reference of CASES) {
    const path = fixturePath(reference, 'metadata')
    let metadata
    try {
      metadata = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`Reference fixture is missing: ${path}`)
      }
      throw error
    }
    if (!COMMIT_PATTERN.test(metadata.preparedFromCommit)) {
      throw new Error(`Reference fixture has invalid provenance: ${path}`)
    }
    provenance[reference.key] = metadata.preparedFromCommit
  }
  return provenance
}

async function capture(page, url, provenanceByCase) {
  await page.goto(url, { waitUntil: 'networkidle2' })
  return page.evaluate(
    async ({ cases, frame, provenance, root }) => {
      const resolver = await import('/src/imageAssetResolver.ts')
      const watercolorAnalysis = await import(
        `/@fs${root}/packages/core/src/sketches/watercolor-forms/analysis.ts`
      )
      const watercolorControls = await import(
        `/@fs${root}/packages/core/src/sketches/watercolor-forms/controls.ts`
      )
      const pencilAnalysis = await import(
        `/@fs${root}/packages/core/src/sketches/pencil-contour/analysis.ts`
      )
      const pencilControls = await import(
        `/@fs${root}/packages/core/src/sketches/pencil-contour/controls.ts`
      )

      const hexDigest = async (bytes) => {
        const digest = new Uint8Array(
          await crypto.subtle.digest('SHA-256', bytes),
        )
        return [...digest]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('')
      }
      const encodePlanes = (planes, sampleCount) => {
        const bytes = new Uint8Array(planes.length * sampleCount * 8)
        const view = new DataView(bytes.buffer)
        for (let planeIndex = 0; planeIndex < planes.length; planeIndex += 1) {
          const values = planes[planeIndex].values
          if (values.length !== sampleCount) {
            throw new Error(`Unexpected ${planes[planeIndex].name} plane size`)
          }
          for (let index = 0; index < sampleCount; index += 1) {
            const value =
              typeof values[index] === 'boolean'
                ? Number(values[index])
                : values[index]
            view.setFloat64(
              (planeIndex * sampleCount + index) * 8,
              value,
              true,
            )
          }
        }
        return bytes
      }
      const base64 = (bytes) => {
        let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 32_768) {
          binary += String.fromCharCode(
            ...bytes.subarray(offset, offset + 32_768),
          )
        }
        return btoa(binary)
      }
      const sourceByAsset = new Map()
      const source = async (assetId) => {
        const cached = sourceByAsset.get(assetId)
        if (cached !== undefined) return cached
        const assetUrl = `/image-assets/${assetId}.png`
        const response = await fetch(assetUrl)
        if (!response.ok) {
          throw new Error(
            `Reference Image Asset ${assetId} returned ${response.status}`,
          )
        }
        const sourceBytes = await response.arrayBuffer()
        const pixels = await resolver.decodeImageAsset(assetId)
        const resolved = {
          pixels,
          metadata: {
            assetId,
            repositoryPath: `assets/image-assets/${assetId}.png`,
            sha256: await hexDigest(sourceBytes),
            decodedWidth: pixels.width,
            decodedHeight: pixels.height,
          },
        }
        sourceByAsset.set(assetId, resolved)
        return resolved
      }

      const results = {}
      for (const reference of cases) {
        const resolved = await source(reference.assetId)
        let raster
        let controls
        let planes
        let preparationVersion
        if (reference.pipeline === 'watercolor-forms') {
          controls = watercolorControls.defaultWatercolorFormsControls
          raster = watercolorAnalysis.prepareWatercolorFormsRaster(
            resolved.pixels,
            frame,
          )
          planes = [
            { name: 'linearRed', values: raster.linearRed },
            { name: 'linearGreen', values: raster.linearGreen },
            { name: 'linearBlue', values: raster.linearBlue },
            { name: 'luminance', values: raster.luminance },
            { name: 'alpha', values: raster.alpha },
            {
              name: 'positiveSupport',
              values: raster.positiveSupport,
              description: '0=false, 1=true',
            },
          ]
          preparationVersion = 'watercolor-forms-prepared-raster-v1'
        } else {
          // Match the reviewed Pencil flower tuple. Smoothing is downstream of
          // this analyzed raster, but recording it here keeps both comparison
          // cases ready for the same later evidence pass.
          controls = {
            ...pencilControls.defaultPencilContourControls,
            contourSmoothing: 1,
          }
          raster = pencilAnalysis.analyzePencilContourRaster(
            resolved.pixels,
            frame,
            controls,
          )
          planes = [
            { name: 'luminance', values: raster.luminance },
            { name: 'alpha', values: raster.alpha },
            {
              name: 'positiveSupport',
              values: raster.positiveSupport,
              description: '0=false, 1=true',
            },
          ]
          preparationVersion = 'pencil-contour-analyzed-raster-v1'
        }

        const sampleCount = raster.width * raster.height
        const bytes = encodePlanes(planes, sampleCount)
        const planeBytes = sampleCount * 8
        results[reference.key] = {
          bytesBase64: base64(bytes),
          metadata: {
            formatVersion: 1,
            ...(reference.pipeline === 'watercolor-forms'
              ? { fixtureStatus: 'provisional' }
              : {}),
            preparedFromCommit: provenance[reference.key],
            preparationVersion,
            source: resolved.metadata,
            frame,
            controls,
            analysis: {
              width: raster.width,
              height: raster.height,
              sampleCount,
            },
            encoding: {
              byteOrder: 'little-endian',
              valueType: 'float64',
              planes: planes.map((plane, index) => ({
                name: plane.name,
                offsetBytes: planeBytes * index,
                valueCount: sampleCount,
                ...(plane.description === undefined
                  ? {}
                  : { values: plane.description }),
              })),
            },
            fixtureSha256: await hexDigest(bytes),
          },
        }
      }
      return results
    },
    {
      cases: CASES,
      frame: FRAME,
      provenance: provenanceByCase,
      root: workspaceRoot,
    },
  )
}

function serializedCapture(capture, reference) {
  const result = capture[reference.key]
  if (result === undefined) {
    throw new Error(`Browser omitted reference case: ${reference.key}`)
  }
  return {
    bytes: Buffer.from(result.bytesBase64, 'base64'),
    metadata: Buffer.from(`${JSON.stringify(result.metadata, null, 2)}\n`),
  }
}

async function assertExisting(path, expected) {
  let actual
  try {
    actual = await readFile(path)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Reference fixture is missing: ${path}`)
    }
    throw error
  }
  if (!actual.equals(expected)) {
    throw new Error(`Reference fixture drifted: ${path}`)
  }
}

async function writeOrVerify(reference, serialized, write) {
  const binaryPath = fixturePath(reference, 'binary')
  const metadataPath = fixturePath(reference, 'metadata')
  if (write) {
    await mkdir(fixtureDirectory(reference.pipeline), { recursive: true })
    await writeFile(binaryPath, serialized.bytes)
    await writeFile(metadataPath, serialized.metadata)
  } else {
    await assertExisting(binaryPath, serialized.bytes)
    await assertExisting(metadataPath, serialized.metadata)
  }
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2))
  const provenanceByCase =
    options.provenanceCommit === undefined
      ? await existingProvenanceByCase()
      : Object.fromEntries(
          CASES.map((reference) => [
            reference.key,
            options.provenanceCommit,
          ]),
        )
  // Check every non-workspace prerequisite before starting a child process so
  // a fresh worktree fails immediately with one reproducible bootstrap path.
  const viteBinary = requireStudioVite()
  const puppeteer = requireBrowserTools()
  const vite = spawn(
    viteBinary,
    ['--host', '127.0.0.1', '--port', String(options.port), '--strictPort'],
    { cwd: studioRoot, stdio: 'ignore' },
  )
  const url = `http://127.0.0.1:${options.port}/`

  try {
    await waitForVite(url, vite)
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })
    let first
    let second
    try {
      const page = await browser.newPage()
      first = await capture(page, url, provenanceByCase)
      second = await capture(page, url, provenanceByCase)
    } finally {
      await browser.close()
    }

    const summaries = []
    for (const reference of CASES) {
      const firstSerialized = serializedCapture(first, reference)
      const secondSerialized = serializedCapture(second, reference)
      if (
        !firstSerialized.bytes.equals(secondSerialized.bytes) ||
        !firstSerialized.metadata.equals(secondSerialized.metadata)
      ) {
        throw new Error(
          `Two browser captures were not byte-identical: ${reference.key}`,
        )
      }
      await writeOrVerify(reference, firstSerialized, options.write)
      summaries.push({
        case: reference.key,
        sourceSha256: first[reference.key].metadata.source.sha256,
        fixtureSha256: first[reference.key].metadata.fixtureSha256,
        analysis: first[reference.key].metadata.analysis,
        preparedFromCommit:
          first[reference.key].metadata.preparedFromCommit,
      })
    }

    console.log(
      JSON.stringify({
        success: true,
        scope: options.scope,
        mode: options.write ? 'write' : 'verify',
        fixtures: summaries,
      }),
    )
  } finally {
    vite.kill('SIGTERM')
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
