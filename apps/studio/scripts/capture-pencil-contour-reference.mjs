#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const REFERENCE_ASSET_ID = 'img-0672-79d639daec62'
const PRODUCTION_BASELINE = '85b4d854d29ec2ac27bf1b8016bc263fec3ccd43'
const FRAME = Object.freeze({ width: 1000, height: 1000 })
const CONTROLS = Object.freeze({
  gamma: 0.5,
  contrast: 0.5,
  pivot: 0.5,
  contourDetail: 0.5,
  contourSmoothing: 1,
})

const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url))
const studioRoot = fileURLToPath(new URL('..', import.meta.url))
const fixtureDirectory = fileURLToPath(
  new URL(
    '../../../packages/core/src/__tests__/fixtures/pencil-contour/',
    import.meta.url,
  ),
)
const fixtureBinary = `${fixtureDirectory}flower-analysis.f64le`
const fixtureMetadata = `${fixtureDirectory}flower-analysis.json`

function argumentsFrom(commandLine) {
  const args = { port: 4397, write: false }
  for (let index = 0; index < commandLine.length; index += 1) {
    const argument = commandLine[index]
    if (argument === '--write') args.write = true
    else if (argument === '--port') {
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
  return args
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

async function capture(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2' })
  return page.evaluate(
    async ({ assetId, baseline, controls, frame, root }) => {
      const resolver = await import('/src/imageAssetResolver.ts')
      const analysis = await import(
        `/@fs${root}/packages/core/src/sketches/pencil-contour/analysis.ts`
      )
      const reference = await import(
        `/@fs${root}/packages/core/src/__tests__/helpers/pencilContourReferenceMetrics.ts`
      )

      const assetUrl = `/image-assets/${assetId}.png`
      const sourceResponse = await fetch(assetUrl)
      if (!sourceResponse.ok) {
        throw new Error(`Reference Image Asset returned ${sourceResponse.status}`)
      }
      const sourceBytes = await sourceResponse.arrayBuffer()
      const sourceDigest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', sourceBytes),
      )
      const sourceSha256 = [...sourceDigest]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')

      const pixels = await resolver.decodeImageAsset(assetId)
      const analyzed = analysis.analyzePencilContourRaster(
        pixels,
        frame,
        controls,
      )
      const bytes = reference.encodePencilContourAnalyzedRaster(analyzed)
      const fixtureDigest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', bytes),
      )
      const fixtureSha256 = [...fixtureDigest]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 32_768) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
      }

      const sampleCount = analyzed.width * analyzed.height
      const planeBytes = sampleCount * 8
      return {
        bytesBase64: btoa(binary),
        metadata: {
          formatVersion: 1,
          productionBaseline: baseline,
          source: {
            assetId,
            repositoryPath: `assets/image-assets/${assetId}.png`,
            sha256: sourceSha256,
            decodedWidth: pixels.width,
            decodedHeight: pixels.height,
          },
          frame,
          controls,
          analysis: {
            width: analyzed.width,
            height: analyzed.height,
            sampleCount,
          },
          encoding: {
            byteOrder: 'little-endian',
            valueType: 'float64',
            planes: [
              { name: 'luminance', offsetBytes: 0, valueCount: sampleCount },
              { name: 'alpha', offsetBytes: planeBytes, valueCount: sampleCount },
              {
                name: 'positiveSupport',
                offsetBytes: planeBytes * 2,
                valueCount: sampleCount,
                values: '0=false, 1=true',
              },
            ],
          },
          fixtureSha256,
          diagnostics: reference.pencilContourReferenceDiagnostics(
            analyzed,
            controls.contourDetail,
          ),
        },
      }
    },
    {
      assetId: REFERENCE_ASSET_ID,
      baseline: PRODUCTION_BASELINE,
      controls: CONTROLS,
      frame: FRAME,
      root: workspaceRoot,
    },
  )
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

async function main() {
  const options = argumentsFrom(process.argv.slice(2))
  const viteBinary = `${studioRoot}node_modules/.bin/vite${
    process.platform === 'win32' ? '.cmd' : ''
  }`
  const vite = spawn(
    viteBinary,
    ['--host', '127.0.0.1', '--port', String(options.port), '--strictPort'],
    { cwd: studioRoot, stdio: 'ignore' },
  )
  const url = `http://127.0.0.1:${options.port}/`

  try {
    await waitForVite(url, vite)
    // Browser capture intentionally reuses the Puppeteer installation owned by
    // the repository's chrome-devtools skill rather than adding it to Studio.
    const skillRequire = createRequire(
      `${workspaceRoot}/.agents/skills/chrome-devtools/scripts/package.json`,
    )
    const puppeteer = skillRequire('puppeteer')
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })
    let first
    let second
    try {
      const page = await browser.newPage()
      first = await capture(page, url)
      second = await capture(page, url)
    } finally {
      await browser.close()
    }

    const firstBytes = Buffer.from(first.bytesBase64, 'base64')
    const secondBytes = Buffer.from(second.bytesBase64, 'base64')
    const firstJson = Buffer.from(
      `${JSON.stringify(first.metadata, null, 2)}\n`,
    )
    const secondJson = Buffer.from(
      `${JSON.stringify(second.metadata, null, 2)}\n`,
    )
    if (!firstBytes.equals(secondBytes) || !firstJson.equals(secondJson)) {
      throw new Error('Two browser captures were not byte-identical')
    }

    if (options.write) {
      await mkdir(fixtureDirectory, { recursive: true })
      await writeFile(fixtureBinary, firstBytes)
      await writeFile(fixtureMetadata, firstJson)
    } else {
      await assertExisting(fixtureBinary, firstBytes)
      await assertExisting(fixtureMetadata, firstJson)
    }

    const withoutSampledPaths = ({ sampledPaths: _sampledPaths, ...metrics }) =>
      metrics
    console.log(
      JSON.stringify({
        success: true,
        mode: options.write ? 'write' : 'verify',
        sourceSha256: first.metadata.source.sha256,
        fixtureSha256: first.metadata.fixtureSha256,
        analysis: first.metadata.analysis,
        diagnostics: {
          candidateCounts: {
            beforeNms: first.metadata.diagnostics.candidates.beforeNms,
            afterNms: first.metadata.diagnostics.candidates.afterNms,
            afterStrengthFloor:
              first.metadata.diagnostics.candidates.afterStrengthFloor,
            afterSelectionLimit:
              first.metadata.diagnostics.candidates.afterSelectionLimit,
            afterDetailSelection:
              first.metadata.diagnostics.candidates.afterDetailSelection,
          },
          smoothing075: withoutSampledPaths(
            first.metadata.diagnostics.smoothing075,
          ),
          smoothing100: withoutSampledPaths(
            first.metadata.diagnostics.smoothing100,
          ),
        },
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
