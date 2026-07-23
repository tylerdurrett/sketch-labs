#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const FRAME = Object.freeze({ width: 1000, height: 1000 })
const PENCIL_REVISION = 'b6147366448d37021e20d48326045a6cba3039ca'
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const EVIDENCE_SCHEMA_VERSION = 1
const COMPARISON_SIZE = Object.freeze({ width: 2160, height: 1120 })
const CASES = Object.freeze([
  Object.freeze({
    key: 'watercolorFlower',
    name: 'flower',
    pipeline: 'watercolor-forms',
    assetId: 'img-0672-79d639daec62',
    binaryName: 'flower-prepared.f64le',
    metadataName: 'flower-prepared.json',
  }),
  Object.freeze({
    key: 'watercolorPinecone',
    name: 'pinecone',
    pipeline: 'watercolor-forms',
    assetId: 'pinecone-4330aa0314f7',
    binaryName: 'pinecone-prepared.f64le',
    metadataName: 'pinecone-prepared.json',
  }),
  Object.freeze({
    key: 'pencilPinecone',
    name: 'pinecone',
    pipeline: 'pencil-contour',
    assetId: 'pinecone-4330aa0314f7',
    binaryName: 'pinecone-analysis.f64le',
    metadataName: 'pinecone-analysis.json',
  }),
])
const EVIDENCE_CASES = Object.freeze([
  Object.freeze({
    name: 'flower',
    assetId: 'img-0672-79d639daec62',
    watercolorFixture: Object.freeze({
      binaryName: 'flower-prepared.f64le',
      metadataName: 'flower-prepared.json',
    }),
    pencilFixture: Object.freeze({
      binaryName: 'flower-analysis.f64le',
      metadataName: 'flower-analysis.json',
    }),
    denseCrop: Object.freeze({ x: 250, y: 40, width: 500, height: 500 }),
  }),
  Object.freeze({
    name: 'pinecone',
    assetId: 'pinecone-4330aa0314f7',
    watercolorFixture: Object.freeze({
      binaryName: 'pinecone-prepared.f64le',
      metadataName: 'pinecone-prepared.json',
    }),
    pencilFixture: Object.freeze({
      binaryName: 'pinecone-analysis.f64le',
      metadataName: 'pinecone-analysis.json',
    }),
    denseCrop: Object.freeze({ x: 200, y: 180, width: 600, height: 600 }),
  }),
])

const workspaceRoot = fileURLToPath(
  new URL('../../..', import.meta.url),
).replace(/\/$/, '')
const studioRoot = fileURLToPath(new URL('..', import.meta.url))
const fixtureRoot = fileURLToPath(
  new URL('../../../packages/core/src/__tests__/fixtures/', import.meta.url),
)
const referenceRoot = fileURLToPath(
  new URL(
    '../../../packages/core/src/sketches/watercolor-forms/reference/',
    import.meta.url,
  ),
)
const watercolorProductionRoot =
  'packages/core/src/sketches/watercolor-forms'
const pencilProductionRoot = 'packages/core/src/sketches/pencil-contour'
const browserToolsDirectory = `${workspaceRoot}/.agents/skills/chrome-devtools/scripts`
const browserToolsBootstrap =
  'npm --prefix .agents/skills/chrome-devtools/scripts ci --ignore-scripts'
const chromeBootstrap =
  'npm --prefix .agents/skills/chrome-devtools/scripts exec -- puppeteer browsers install chrome'
const execFile = promisify(execFileCallback)

function argumentsFrom(commandLine) {
  const args = {
    fixtureCommit: undefined,
    port: 4398,
    provenanceCommit: undefined,
    scope: undefined,
    tuningCommit: undefined,
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
    } else if (argument === '--tuning-commit') {
      args.tuningCommit = commandLine[index + 1]
      index += 1
    } else if (argument === '--fixture-commit') {
      args.fixtureCommit = commandLine[index + 1]
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

  if (
    args.scope !== undefined &&
    args.scope !== 'fixtures' &&
    args.scope !== 'evidence'
  ) {
    throw new Error('--scope must be fixtures or evidence')
  }
  if (args.write && args.scope === undefined) {
    throw new Error('--write requires an explicit --scope')
  }
  if (args.write && args.scope === 'fixtures') {
    if (
      args.provenanceCommit === undefined ||
      !COMMIT_PATTERN.test(args.provenanceCommit)
    ) {
      throw new Error(
        '--scope fixtures --write requires --provenance-commit with a lowercase 40-character SHA',
      )
    }
    if (args.tuningCommit !== undefined || args.fixtureCommit !== undefined) {
      throw new Error(
        '--tuning-commit and --fixture-commit are valid only for evidence writes',
      )
    }
  } else if (args.write && args.scope === 'evidence') {
    if (
      args.tuningCommit === undefined ||
      !COMMIT_PATTERN.test(args.tuningCommit) ||
      args.fixtureCommit === undefined ||
      !COMMIT_PATTERN.test(args.fixtureCommit)
    ) {
      throw new Error(
        '--scope evidence --write requires lowercase 40-character --tuning-commit and --fixture-commit SHAs',
      )
    }
    if (args.provenanceCommit !== undefined) {
      throw new Error('--provenance-commit is valid only for fixture writes')
    }
  } else if (
    args.provenanceCommit !== undefined ||
    args.tuningCommit !== undefined ||
    args.fixtureCommit !== undefined
  ) {
    throw new Error('commit arguments are valid only with --write')
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

function evidenceFixturePath(reference, pipeline, kind) {
  const fixture =
    pipeline === 'watercolor-forms'
      ? reference.watercolorFixture
      : reference.pencilFixture
  const name = kind === 'binary' ? fixture.binaryName : fixture.metadataName
  return `${fixtureDirectory(pipeline)}${name}`
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

async function git(args, options = {}) {
  const { stdout = '' } = await execFile('git', args, {
    cwd: workspaceRoot,
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  })
  return stdout.trim()
}

async function isAncestor(ancestor, descendant) {
  try {
    await git(['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch (error) {
    if (error?.code === 1) return false
    throw error
  }
}

async function requireCommit(commit, label) {
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error(`${label} must be a lowercase 40-character SHA`)
  }
  let resolved
  try {
    resolved = await git(['rev-parse', '--verify', `${commit}^{commit}`])
  } catch {
    throw new Error(`${label} is not an available commit: ${commit}`)
  }
  if (resolved !== commit) {
    throw new Error(`${label} did not resolve exactly to ${commit}`)
  }
}

async function trackedFilesAt(commit, root) {
  const output = await git(['ls-tree', '-r', '--name-only', commit, '--', root])
  return output === ''
    ? []
    : output
        .split('\n')
        .filter((path) => path.endsWith('.ts'))
        .sort()
}

async function requireCleanSnapshot(commit, root, label) {
  await requireCommit(commit, `${label} commit`)
  const atCommit = await trackedFilesAt(commit, root)
  const currentOutput = await git(['ls-files', '--', root])
  const current = currentOutput
    .split('\n')
    .filter((path) => path.endsWith('.ts'))
    .sort()
  if (JSON.stringify(atCommit) !== JSON.stringify(current)) {
    throw new Error(`${label} tracked file inventory differs from ${commit}`)
  }
  const statusOutput = await git([
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    root,
  ])
  const status = statusOutput
    .split('\n')
    .filter(
      (line) =>
        line.endsWith('.ts') && !line.includes('/reference/'),
    )
    .join('\n')
  if (status !== '') {
    throw new Error(`${label} files are dirty:\n${status}`)
  }
  const diff = await git(['diff', '--name-only', commit, '--', ...current])
  if (diff !== '') {
    throw new Error(`${label} files differ from ${commit}:\n${diff}`)
  }
  return current
}

function evidenceFixturePaths() {
  return EVIDENCE_CASES.flatMap((reference) =>
    ['watercolor-forms', 'pencil-contour'].flatMap((pipeline) => [
      evidenceFixturePath(reference, pipeline, 'binary'),
      evidenceFixturePath(reference, pipeline, 'metadata'),
    ]),
  )
}

function repositoryPath(absolutePath) {
  return absolutePath.slice(workspaceRoot.length + 1)
}

async function requireCleanFixtures(commit) {
  await requireCommit(commit, 'fixture commit')
  const paths = evidenceFixturePaths().map(repositoryPath).sort()
  const status = await git([
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    ...paths,
  ])
  if (status !== '') {
    throw new Error(`Watercolor evidence fixture files are dirty:\n${status}`)
  }
  const diff = await git(['diff', '--name-only', commit, '--', ...paths])
  if (diff !== '') {
    throw new Error(
      `Watercolor evidence fixture files differ from ${commit}:\n${diff}`,
    )
  }
  return paths
}

async function sha256Files(paths) {
  const hash = createHash('sha256')
  for (const path of paths.slice().sort()) {
    const bytes = await readFile(`${workspaceRoot}/${path}`)
    hash.update(path)
    hash.update('\0')
    hash.update(bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function evidenceProvenance(tuningCommit, fixtureCommit) {
  if (!(await isAncestor(tuningCommit, fixtureCommit))) {
    throw new Error('tuning commit must be an ancestor of fixture commit')
  }
  if (!(await isAncestor(fixtureCommit, 'HEAD'))) {
    throw new Error('fixture commit must be an ancestor of HEAD')
  }
  if (!(await isAncestor(PENCIL_REVISION, tuningCommit))) {
    throw new Error(
      `Pencil revision ${PENCIL_REVISION} must be an ancestor of tuning commit`,
    )
  }
  const watercolorPaths = await requireCleanSnapshot(
    tuningCommit,
    watercolorProductionRoot,
    'Watercolor Forms production',
  )
  const pencilPaths = await requireCleanSnapshot(
    PENCIL_REVISION,
    pencilProductionRoot,
    'Pencil Contour production',
  )
  const fixturePaths = await requireCleanFixtures(fixtureCommit)
  return {
    tuningCommit,
    fixtureCommit,
    watercolorProduction: {
      algorithm: 'sha256(path + NUL + bytes + NUL), paths sorted',
      paths: watercolorPaths,
      sha256: await sha256Files(watercolorPaths),
    },
    pencilProduction: {
      revision: PENCIL_REVISION,
      algorithm: 'sha256(path + NUL + bytes + NUL), paths sorted',
      paths: pencilPaths,
      sha256: await sha256Files(pencilPaths),
    },
    fixtures: {
      paths: fixturePaths,
      sha256: await sha256Files(fixturePaths),
    },
  }
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

async function captureFixtures(page, url, provenanceByCase) {
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

async function captureEvidence(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2' })
  return page.evaluate(
    async ({ cases, comparisonSize, frame, pencilRevision, root }) => {
      const resolver = await import('/src/imageAssetResolver.ts')
      const watercolorAnalysis = await import(
        `/@fs${root}/packages/core/src/sketches/watercolor-forms/analysis.ts`
      )
      const watercolorControls = await import(
        `/@fs${root}/packages/core/src/sketches/watercolor-forms/controls.ts`
      )
      const watercolorGenerator = await import(
        `/@fs${root}/packages/core/src/sketches/watercolor-forms/generator.ts`
      )
      const watercolorLimits = await import(
        `/@fs${root}/packages/core/src/sketches/watercolor-forms/limits.ts`
      )
      const pencilAnalysis = await import(
        `/@fs${root}/packages/core/src/sketches/pencil-contour/analysis.ts`
      )
      const pencilControls = await import(
        `/@fs${root}/packages/core/src/sketches/pencil-contour/controls.ts`
      )
      const pencilGenerator = await import(
        `/@fs${root}/packages/core/src/sketches/pencil-contour/generator.ts`
      )
      const metrics = await import(
        `/@fs${root}/packages/core/src/__tests__/helpers/watercolorFormsReferenceMetrics.ts`
      )
      const rasterSampling = await import(
        `/@fs${root}/packages/core/src/rasterSampling.ts`
      )
      const renderer = await import(
        `/@fs${root}/packages/core/src/renderer.ts`
      )

      const hexDigest = async (bytes) => {
        const digest = new Uint8Array(
          await crypto.subtle.digest('SHA-256', bytes),
        )
        return [...digest]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('')
      }
      const utf8Digest = async (value) =>
        hexDigest(new TextEncoder().encode(value))
      const geometry = async (scene) => {
        const geometryValue = scene.primitives.map((primitive) => ({
          points: primitive.points,
          closed: primitive.closed === true,
        }))
        return {
          sha256: await utf8Digest(JSON.stringify(geometryValue)),
          primitiveCount: scene.primitives.length,
          pointCount: scene.primitives.reduce(
            (total, primitive) => total + primitive.points.length,
            0,
          ),
        }
      }
      const coverage = (scene, source) => {
        const fit = rasterSampling.createRasterContainFit(
          { width: source.decodedWidth, height: source.decodedHeight },
          frame,
        )
        if (fit === null) throw new Error('Evidence source did not contain-fit')
        const bins = new Set()
        for (const primitive of scene.primitives) {
          for (const [x, y] of primitive.points) {
            const column = Math.min(
              3,
              Math.max(
                0,
                Math.floor(((x - fit.left) / fit.fittedWidth) * 4),
              ),
            )
            const row = Math.min(
              3,
              Math.max(
                0,
                Math.floor(((y - fit.top) / fit.fittedHeight) * 4),
              ),
            )
            bins.add(`${column},${row}`)
          }
        }
        return {
          occupiedBins: [...bins].sort(),
          occupiedBinCount: bins.size,
          centralBinCount: ['1,1', '2,1', '1,2', '2,2'].filter((bin) =>
            bins.has(bin),
          ).length,
          occupiedColumnCount: new Set(
            [...bins].map((bin) => bin.split(',')[0]),
          ).size,
          occupiedRowCount: new Set(
            [...bins].map((bin) => bin.split(',')[1]),
          ).size,
        }
      }
      const dataUrlBytes = (dataUrl) => dataUrl.slice(dataUrl.indexOf(',') + 1)
      const comparison = (pencilScene, watercolorScene, crop, title) => {
        const canvas = document.createElement('canvas')
        canvas.width = comparisonSize.width
        canvas.height = comparisonSize.height
        const context = canvas.getContext('2d')
        if (context === null) throw new Error('Canvas2D unavailable')
        context.fillStyle = '#f5f2ea'
        context.fillRect(0, 0, canvas.width, canvas.height)
        const drawPanel = (scene, left) => {
          const top = 70
          const size = 1000
          context.save()
          context.fillStyle = '#fff'
          context.fillRect(left, top, size, size)
          context.beginPath()
          context.rect(left, top, size, size)
          context.clip()
          context.translate(left, top)
          context.scale(size / crop.width, size / crop.height)
          context.translate(-crop.x, -crop.y)
          renderer.renderToCanvas(context, scene)
          context.restore()
          context.strokeStyle = '#c8c2b6'
          context.lineWidth = 1
          context.strokeRect(left + 0.5, top + 0.5, size - 1, size - 1)
        }
        drawPanel(pencilScene, 40)
        drawPanel(watercolorScene, 1120)
        context.fillStyle = '#191919'
        context.font = '600 24px system-ui, sans-serif'
        context.textAlign = 'center'
        context.fillText(
          `Pencil Contour · ${pencilRevision.slice(0, 7)}`,
          540,
          43,
        )
        context.fillText('Watercolor Forms', 1620, 43)
        context.font = '16px system-ui, sans-serif'
        context.fillStyle = '#555'
        context.fillText(title, canvas.width / 2, 1098)
        return dataUrlBytes(canvas.toDataURL('image/png'))
      }
      const source = async (assetId) => {
        const response = await fetch(`/image-assets/${assetId}.png`)
        if (!response.ok) {
          throw new Error(
            `Reference Image Asset ${assetId} returned ${response.status}`,
          )
        }
        const bytes = await response.arrayBuffer()
        const pixels = await resolver.decodeImageAsset(assetId)
        return {
          pixels,
          metadata: {
            assetId,
            repositoryPath: `assets/image-assets/${assetId}.png`,
            sha256: await hexDigest(bytes),
            decodedWidth: pixels.width,
            decodedHeight: pixels.height,
          },
        }
      }

      const watercolorControlValues =
        watercolorControls.defaultWatercolorFormsControls
      const pencilControlValues = {
        ...pencilControls.defaultPencilContourControls,
        contourSmoothing: 1,
      }
      const results = {}
      for (const reference of cases) {
        const resolved = await source(reference.assetId)
        const watercolorRaster =
          watercolorAnalysis.prepareWatercolorFormsRaster(
            resolved.pixels,
            frame,
          )
        const pencilRaster = pencilAnalysis.analyzePencilContourRaster(
          resolved.pixels,
          frame,
          pencilControlValues,
        )
        const watercolor = watercolorGenerator.generateWatercolorForms({
          pixels: resolved.pixels,
          frame,
          controls: watercolorControlValues,
        })
        const pencil = pencilGenerator.generatePencilContour({
          pixels: resolved.pixels,
          frame,
          controls: pencilControlValues,
        })
        const fullCrop = { x: 0, y: 0, width: frame.width, height: frame.height }
        results[reference.name] = {
          source: resolved.metadata,
          controls: {
            watercolor: watercolorControlValues,
            pencil: pencilControlValues,
          },
          analysis: {
            watercolor: {
              width: watercolorRaster.width,
              height: watercolorRaster.height,
              sampleCount:
                watercolorRaster.width * watercolorRaster.height,
            },
            pencil: {
              width: pencilRaster.width,
              height: pencilRaster.height,
              sampleCount: pencilRaster.width * pencilRaster.height,
            },
          },
          metrics: {
            watercolor: metrics.watercolorFormsReferenceMetrics({
              raster: watercolorRaster,
              controls: watercolorControlValues,
              frame,
            }),
            pencil: metrics.pencilContourReferenceMetrics({
              raster: pencilRaster,
              controls: pencilControlValues,
              frame,
            }),
          },
          geometry: {
            watercolor: await geometry(watercolor.scene),
            pencil: await geometry(pencil.scene),
          },
          watercolorCoverage: coverage(
            watercolor.scene,
            resolved.metadata,
          ),
          watercolorDiagnostics: watercolor.diagnostics,
          cropRects: {
            fullFrame: fullCrop,
            denseDetail: reference.denseCrop,
          },
          images: {
            fullFrame: comparison(
              pencil.scene,
              watercolor.scene,
              fullCrop,
              `${reference.name} · full Composition Frame`,
            ),
            denseDetail: comparison(
              pencil.scene,
              watercolor.scene,
              reference.denseCrop,
              `${reference.name} · shared dense-detail crop`,
            ),
          },
        }
      }
      return {
        cases: results,
        limits: watercolorLimits.WATERCOLOR_FORMS_LIMITS,
        metricDefinitions: {
          lengthNormalization: metrics.REFERENCE_LENGTH_NORMALIZATION,
          shortPathMaximumNormalizedLength:
            metrics.REFERENCE_SHORT_PATH_MAXIMUM_NORMALIZED_LENGTH,
          longPathMinimumNormalizedLength:
            metrics.REFERENCE_LONG_PATH_MINIMUM_NORMALIZED_LENGTH,
        },
      }
    },
    {
      cases: EVIDENCE_CASES,
      comparisonSize: COMPARISON_SIZE,
      frame: FRAME,
      pencilRevision: PENCIL_REVISION,
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
      throw new Error(`Reference artifact is missing: ${path}`)
    }
    throw error
  }
  if (!actual.equals(expected)) {
    throw new Error(`Reference artifact drifted: ${path}`)
  }
}

async function writeOrVerifyFixture(reference, serialized, write) {
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

async function fixtureMetadata(reference, pipeline) {
  const metadataPath = evidenceFixturePath(reference, pipeline, 'metadata')
  const binaryPath = evidenceFixturePath(reference, pipeline, 'binary')
  const metadataBytes = await readFile(metadataPath)
  const binaryBytes = await readFile(binaryPath)
  const metadata = JSON.parse(metadataBytes)
  if (sha256(binaryBytes) !== metadata.fixtureSha256) {
    throw new Error(`Fixture hash does not match metadata: ${binaryPath}`)
  }
  return {
    file: repositoryPath(binaryPath),
    metadataFile: repositoryPath(metadataPath),
    fixtureSha256: metadata.fixtureSha256,
    metadataSha256: sha256(metadataBytes),
    preparedFromCommit:
      metadata.preparedFromCommit ?? metadata.productionBaseline,
    preparationVersion: metadata.preparationVersion ?? 'pencil-contour-v2',
    analysis: metadata.analysis,
    source: metadata.source,
    controls: metadata.controls,
  }
}

function evidenceReadme() {
  return `# Watercolor Forms comparison evidence

These four PNGs are deterministic review inputs for issue #402. Each image
places Pencil Contour on the left and Watercolor Forms on the right at the same
scale. The full-frame pair shows the complete 1000 × 1000 Composition Frame;
the dense-detail pair uses the exact shared crop recorded in \`manifest.json\`.
Both sides render the actual production \`Scene\` geometry through the production
Canvas2D Scene Renderer.

\`manifest.json\` pins the Watercolor tuning and fixture commits, stable
path-sorted production-content hashes, source and fixture identities, exact
controls and frame, metric definitions and results, geometry hashes, coverage,
bounded-work diagnostics, crop rectangles, and PNG hashes. The metrics use the
same helper as the committed Watercolor Forms reference gates.

The artifacts are generated comparison evidence, not a visual-review verdict.
This directory intentionally has no generated review attestation; independent
review must remain a separate human action.

## Reproduce

Run from the repository root with the pinned production browser:

\`\`\`sh
node apps/studio/scripts/capture-watercolor-forms-reference.mjs \\
  --scope evidence \\
  --write \\
  --tuning-commit 4375a50acc29737b7719b2edcb6e6fbeee78c022 \\
  --fixture-commit 871311f7c6caefbadb08f4853fc9f904cdff4eb4

node apps/studio/scripts/capture-watercolor-forms-reference.mjs \\
  --scope evidence
\`\`\`

The verify command recomputes the decoded rasters, production Scenes, metrics,
diagnostics, geometry hashes, and PNG bytes, then checks every committed file.
It refuses dirty or commit-divergent Watercolor, Pencil, or fixture inputs.
`
}

async function serializedEvidence(capture, provenance) {
  const files = {}
  const caseManifests = {}
  for (const reference of EVIDENCE_CASES) {
    const captured = capture.cases[reference.name]
    if (captured === undefined) {
      throw new Error(`Browser omitted evidence case: ${reference.name}`)
    }
    const watercolorFixture = await fixtureMetadata(
      reference,
      'watercolor-forms',
    )
    const pencilFixture = await fixtureMetadata(reference, 'pencil-contour')
    if (
      captured.source.sha256 !== watercolorFixture.source.sha256 ||
      captured.source.sha256 !== pencilFixture.source.sha256
    ) {
      throw new Error(`Source identity drifted for ${reference.name}`)
    }
    if (
      JSON.stringify(captured.analysis.watercolor) !==
        JSON.stringify(watercolorFixture.analysis) ||
      JSON.stringify(captured.analysis.pencil) !==
        JSON.stringify(pencilFixture.analysis)
    ) {
      throw new Error(`Analysis dimensions drifted for ${reference.name}`)
    }
    if (
      JSON.stringify(captured.controls.watercolor) !==
        JSON.stringify(watercolorFixture.controls) ||
      JSON.stringify(captured.controls.pencil) !==
        JSON.stringify(pencilFixture.controls)
    ) {
      throw new Error(`Reference controls drifted for ${reference.name}`)
    }
    const artifacts = {}
    for (const [kind, suffix] of [
      ['fullFrame', 'full-frame-comparison.png'],
      ['denseDetail', 'dense-detail-comparison.png'],
    ]) {
      const file = `${reference.name}-${suffix}`
      const bytes = Buffer.from(captured.images[kind], 'base64')
      files[file] = bytes
      artifacts[kind] = {
        file,
        width: COMPARISON_SIZE.width,
        height: COMPARISON_SIZE.height,
        bytes: bytes.length,
        sha256: sha256(bytes),
      }
    }
    caseManifests[reference.name] = {
      source: captured.source,
      fixtures: {
        watercolor: watercolorFixture,
        pencil: pencilFixture,
      },
      frame: FRAME,
      controls: captured.controls,
      metrics: captured.metrics,
      geometry: captured.geometry,
      watercolorCoverage: captured.watercolorCoverage,
      watercolorDiagnostics: captured.watercolorDiagnostics,
      cropRects: captured.cropRects,
      artifacts,
    }
  }
  const manifest = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    referenceId: 'watercolor-forms-pencil-comparison',
    status: 'generated-comparison-evidence-awaiting-independent-review',
    provenance: {
      tuningCommit: provenance.tuningCommit,
      fixtureCommit: provenance.fixtureCommit,
      watercolorProduction: provenance.watercolorProduction,
      pencilProduction: provenance.pencilProduction,
      fixtures: provenance.fixtures,
    },
    pencilComparison: {
      revision: PENCIL_REVISION,
      settings: caseManifests.flower.controls.pencil,
    },
    metricDefinitions: capture.metricDefinitions,
    safetyCaps: capture.limits,
    cases: caseManifests,
    review: {
      verdict: 'NOT-RECORDED',
      generatedAttestation: false,
      note: 'Generated evidence is not an independent visual-review verdict.',
    },
  }
  files['README.md'] = Buffer.from(evidenceReadme())
  files['manifest.json'] = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  return { files, manifest }
}

async function writeOrVerifyEvidence(serialized, write) {
  if (write) await mkdir(referenceRoot, { recursive: true })
  for (const [name, bytes] of Object.entries(serialized.files)) {
    const path = `${referenceRoot}${name}`
    if (write) await writeFile(path, bytes)
    else await assertExisting(path, bytes)
  }
}

async function evidenceCommitsForVerification() {
  const path = `${referenceRoot}manifest.json`
  let manifest
  try {
    manifest = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Reference evidence is missing: ${path}`)
    }
    throw error
  }
  const { tuningCommit, fixtureCommit } = manifest?.provenance ?? {}
  if (
    !COMMIT_PATTERN.test(tuningCommit ?? '') ||
    !COMMIT_PATTERN.test(fixtureCommit ?? '')
  ) {
    throw new Error('Evidence manifest has invalid pinned commits')
  }
  return { tuningCommit, fixtureCommit }
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2))
  const scopes =
    options.scope === undefined
      ? [
          'fixtures',
          ...(existsSync(`${referenceRoot}manifest.json`) ? ['evidence'] : []),
        ]
      : [options.scope]
  let provenanceByCase
  let evidenceProvenanceValue
  if (scopes.includes('fixtures')) {
    provenanceByCase =
      options.provenanceCommit === undefined
        ? await existingProvenanceByCase()
        : Object.fromEntries(
            CASES.map((reference) => [
              reference.key,
              options.provenanceCommit,
            ]),
          )
  }
  if (scopes.includes('evidence')) {
    const commits = options.write
      ? {
          tuningCommit: options.tuningCommit,
          fixtureCommit: options.fixtureCommit,
        }
      : await evidenceCommitsForVerification()
    evidenceProvenanceValue = await evidenceProvenance(
      commits.tuningCommit,
      commits.fixtureCommit,
    )
  }

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
    const output = {
      success: true,
      scopes,
      mode: options.write ? 'write' : 'verify',
    }
    try {
      const page = await browser.newPage()
      if (scopes.includes('fixtures')) {
        const first = await captureFixtures(page, url, provenanceByCase)
        const second = await captureFixtures(page, url, provenanceByCase)
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
          await writeOrVerifyFixture(
            reference,
            firstSerialized,
            options.write,
          )
          summaries.push({
            case: reference.key,
            sourceSha256: first[reference.key].metadata.source.sha256,
            fixtureSha256: first[reference.key].metadata.fixtureSha256,
            analysis: first[reference.key].metadata.analysis,
            preparedFromCommit:
              first[reference.key].metadata.preparedFromCommit,
          })
        }
        output.fixtures = summaries
      }
      if (scopes.includes('evidence')) {
        const first = await captureEvidence(page, url)
        const second = await captureEvidence(page, url)
        const firstSerialized = await serializedEvidence(
          first,
          evidenceProvenanceValue,
        )
        const secondSerialized = await serializedEvidence(
          second,
          evidenceProvenanceValue,
        )
        for (const name of Object.keys(firstSerialized.files)) {
          if (
            !firstSerialized.files[name].equals(secondSerialized.files[name])
          ) {
            throw new Error(
              `Two browser evidence captures were not byte-identical: ${name}`,
            )
          }
        }
        await writeOrVerifyEvidence(firstSerialized, options.write)
        output.evidence = {
          tuningCommit: evidenceProvenanceValue.tuningCommit,
          fixtureCommit: evidenceProvenanceValue.fixtureCommit,
          watercolorProductionSha256:
            evidenceProvenanceValue.watercolorProduction.sha256,
          files: Object.keys(firstSerialized.files).sort(),
          cases: Object.fromEntries(
            Object.entries(firstSerialized.manifest.cases).map(
              ([name, reference]) => [
                name,
                {
                  metrics: reference.metrics,
                  geometry: reference.geometry,
                  diagnostics: reference.watercolorDiagnostics,
                  artifacts: reference.artifacts,
                },
              ],
            ),
          ),
        }
      }
    } finally {
      await browser.close()
    }
    console.log(JSON.stringify(output))
  } finally {
    vite.kill('SIGTERM')
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
