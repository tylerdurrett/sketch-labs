#!/usr/bin/env node

import { existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
} from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  primaryCheckoutRoot,
  workspaceRoot,
} from './lib/flowing-contours-reference-provenance.mjs'

const DEFAULT_PORT = 4400
const HARNESS_PATH = '/__flowing-contours-evidence__/'
const HARNESS_MODULE_PATH =
  '/__flowing-contours-evidence__/capture.mjs'
const BROWSER_CRYPTO_STUB_ID = '\0flowing-contours-browser-node-crypto'
const ARTIFACT_SCHEMA_VERSION = 1
const COMPARISON_SIZE = Object.freeze({ width: 1600, height: 1640 })
const SYNTHETIC_SIZE = Object.freeze({ width: 1600, height: 820 })
const COMPARISON_LAYOUT = Object.freeze({
  labelOffset: 27,
  footerCenterY: 1626,
  panels: Object.freeze({
    source: Object.freeze({ left: 25, top: 55, size: 750 }),
    pencil: Object.freeze({ left: 825, top: 55, size: 750 }),
    watercolor: Object.freeze({ left: 25, top: 855, size: 750 }),
    flowing: Object.freeze({ left: 825, top: 855, size: 750 }),
  }),
})
const MAX_PNG_BYTES = 32 * 1024 * 1024
const PNG_SPECS = Object.freeze({
  'flower-full-frame-comparison.png': COMPARISON_SIZE,
  'flower-dense-detail-comparison.png': COMPARISON_SIZE,
  'pinecone-full-frame-comparison.png': COMPARISON_SIZE,
  'pinecone-dense-detail-comparison.png': COMPARISON_SIZE,
  'synthetic-smooth-flow-staircase-witness.png': SYNTHETIC_SIZE,
})
const JSON_ARTIFACT_NAMES = Object.freeze([
  'geometry.json',
  'metrics.json',
  'diagnostics.json',
])
const ARTIFACT_NAMES = Object.freeze([
  ...Object.keys(PNG_SPECS),
  ...JSON_ARTIFACT_NAMES,
  'README.md',
  'manifest.json',
])
const SOURCE_ASSETS = Object.freeze({
  '/image-assets/img-0672-79d639daec62.png':
    'assets/image-assets/img-0672-79d639daec62.png',
  '/image-assets/pinecone-4330aa0314f7.png':
    'assets/image-assets/pinecone-4330aa0314f7.png',
})
const studioRoot = fileURLToPath(new URL('..', import.meta.url))
const referenceRoot = join(
  workspaceRoot,
  'packages/core/src/sketches/flowing-contours/reference',
)
const EVIDENCE_SERIALIZATION_LIMITS = Object.freeze({
  // FC03's exact raw/fitted point ceiling and per-analysis-sample maxima.
  maxArrayLength: 524_288,
  maxComparatorPathCount: 65_536,
  maxCoordinateMagnitude: 1_000_000,
  maxDepth: 24,
  // FC03 permits at most 65,536 / 32 accepted Flowing curves.
  maxFlowingPathCount: 2_048,
  maxJsonBytes: 64 * 1024 * 1024,
  maxObjectKeys: 128,
  maxPathPointCount: 524_288,
  maxScenePointCount: 524_288,
  maxStringLength: 4_096,
  maxTotalValues: 2_000_000,
})

function assertSerializableEvidence(
  value,
  label = 'evidence',
  limits = EVIDENCE_SERIALIZATION_LIMITS,
) {
  const ancestors = new WeakSet()
  let valueCount = 0
  const fail = (path, reason) => {
    throw new Error(`${label} is not safely serializable at ${path}: ${reason}`)
  }
  const visit = (current, path, depth) => {
    valueCount += 1
    if (valueCount > limits.maxTotalValues) {
      fail(path, 'payload inventory exceeds bound')
    }
    if (depth > limits.maxDepth) fail(path, 'payload nesting exceeds bound')
    if (current === null || typeof current === 'boolean') return
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) fail(path, 'number is not finite')
      return
    }
    if (typeof current === 'string') {
      if (current.length > limits.maxStringLength) {
        fail(path, 'string exceeds bound')
      }
      return
    }
    if (typeof current !== 'object') {
      fail(path, `unsupported ${typeof current}`)
    }
    if (ancestors.has(current)) fail(path, 'cyclic inventory')
    ancestors.add(current)
    try {
      if (Array.isArray(current)) {
        if (
          Object.getPrototypeOf(current) !== Array.prototype ||
          current.length > limits.maxArrayLength
        ) {
          fail(path, 'array shape or inventory exceeds bound')
        }
        const keys = Reflect.ownKeys(current)
        if (
          keys.length !== current.length + 1 ||
          keys.some(
            (key) =>
              key !== 'length' &&
              (typeof key !== 'string' ||
                !/^(0|[1-9][0-9]*)$/.test(key) ||
                Number(key) >= current.length),
          )
        ) {
          fail(path, 'array is sparse or has extra properties')
        }
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, index)
          if (descriptor === undefined || !('value' in descriptor)) {
            fail(`${path}[${index}]`, 'array entry is not a data property')
          }
          visit(descriptor.value, `${path}[${index}]`, depth + 1)
        }
        return
      }
      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) {
        fail(path, 'object prototype is not plain')
      }
      const keys = Reflect.ownKeys(current)
      if (
        keys.length > limits.maxObjectKeys ||
        keys.some((key) => typeof key !== 'string')
      ) {
        fail(path, 'object key inventory exceeds bound')
      }
      if (keys.includes('toJSON')) fail(path, 'custom JSON conversion')
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (
          descriptor === undefined ||
          !('value' in descriptor) ||
          descriptor.enumerable !== true
        ) {
          fail(`${path}.${key}`, 'object entry is not enumerable data')
        }
        visit(descriptor.value, `${path}.${key}`, depth + 1)
      }
    } finally {
      ancestors.delete(current)
    }
  }
  visit(value, '$', 0)
  return value
}

function safeEvidenceJson(value, label = 'evidence') {
  assertSerializableEvidence(value, label)
  const text = JSON.stringify(value)
  if (
    typeof text !== 'string' ||
    new TextEncoder().encode(text).byteLength >
      EVIDENCE_SERIALIZATION_LIMITS.maxJsonBytes
  ) {
    throw new Error(`${label} JSON exceeds its byte bound`)
  }
  return text
}

function canonicalSceneSnapshot(
  scene,
  maxPathCount = EVIDENCE_SERIALIZATION_LIMITS.maxComparatorPathCount,
) {
  if (
    scene === null ||
    typeof scene !== 'object' ||
    scene.space === null ||
    typeof scene.space !== 'object' ||
    !Number.isFinite(scene.space.width) ||
    scene.space.width <= 0 ||
    scene.space.width >
      EVIDENCE_SERIALIZATION_LIMITS.maxCoordinateMagnitude ||
    !Number.isFinite(scene.space.height) ||
    scene.space.height <= 0 ||
    scene.space.height >
      EVIDENCE_SERIALIZATION_LIMITS.maxCoordinateMagnitude ||
    !Array.isArray(scene.primitives) ||
    scene.primitives.length > maxPathCount
  ) {
    throw new Error('Scene has invalid space or path inventory')
  }
  let totalPointCount = 0
  const paths = scene.primitives.map((primitive, order) => {
    if (
      primitive === null ||
      typeof primitive !== 'object' ||
      typeof primitive.closed !== 'boolean' ||
      !Array.isArray(primitive.points) ||
      primitive.points.length < 2 ||
      primitive.points.length >
        EVIDENCE_SERIALIZATION_LIMITS.maxPathPointCount
    ) {
      throw new Error(`Scene path ${order} has invalid shape or inventory`)
    }
    totalPointCount += primitive.points.length
    if (
      totalPointCount >
      EVIDENCE_SERIALIZATION_LIMITS.maxScenePointCount
    ) {
      throw new Error('Scene point inventory exceeds bound')
    }
    const points = primitive.points.map((point, pointIndex) => {
      if (
        !Array.isArray(point) ||
        point.length !== 2 ||
        !Number.isFinite(point[0]) ||
        !Number.isFinite(point[1]) ||
        Math.abs(point[0]) >
          EVIDENCE_SERIALIZATION_LIMITS.maxCoordinateMagnitude ||
        Math.abs(point[1]) >
          EVIDENCE_SERIALIZATION_LIMITS.maxCoordinateMagnitude
      ) {
        throw new Error(
          `Scene path ${order} point ${pointIndex} is invalid`,
        )
      }
      return [point[0], point[1]]
    })
    return {
      order,
      closed: primitive.closed,
      hiddenLineRole: primitive.hiddenLineRole ?? null,
      stroke: primitive.stroke ?? null,
      fill: primitive.fill ?? null,
      pointCount: points.length,
      endpoints: {
        start: points[0],
        end: points.at(-1),
      },
      points,
    }
  })
  const canonical = {
    space: { width: scene.space.width, height: scene.space.height },
    pathCount: paths.length,
    paths,
  }
  assertSerializableEvidence(canonical, 'canonical Scene geometry')
  return canonical
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function validatePng(bytes, expected, label = 'PNG') {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 67 ||
    bytes.length > MAX_PNG_BYTES ||
    !Number.isSafeInteger(expected?.width) ||
    expected.width < 1 ||
    !Number.isSafeInteger(expected?.height) ||
    expected.height < 1
  ) {
    throw new Error(`${label} has invalid bytes, dimensions, or size`)
  }
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ])
  if (!bytes.subarray(0, 8).equals(signature)) {
    throw new Error(`${label} has an invalid PNG signature`)
  }
  let offset = 8
  let chunkIndex = 0
  let imageDataCount = 0
  let ended = false
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw new Error(`${label} has a truncated PNG chunk`)
    }
    const length = bytes.readUInt32BE(offset)
    const chunkEnd = offset + 12 + length
    if (chunkEnd > bytes.length) {
      throw new Error(`${label} has an out-of-bounds PNG chunk`)
    }
    const typeBytes = bytes.subarray(offset + 4, offset + 8)
    const type = typeBytes.toString('ascii')
    if (!/^[A-Za-z]{4}$/.test(type)) {
      throw new Error(`${label} has an invalid PNG chunk type`)
    }
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length)
    const actualCrc = crc32(Buffer.concat([typeBytes, data]))
    if (expectedCrc !== actualCrc) {
      throw new Error(`${label} has a PNG CRC mismatch`)
    }
    if (chunkIndex === 0) {
      if (
        type !== 'IHDR' ||
        length !== 13 ||
        data.readUInt32BE(0) !== expected.width ||
        data.readUInt32BE(4) !== expected.height ||
        data[8] !== 8 ||
        ![0, 2, 3, 4, 6].includes(data[9]) ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      ) {
        throw new Error(`${label} has invalid PNG IHDR metadata`)
      }
    } else if (type === 'IHDR') {
      throw new Error(`${label} has multiple PNG IHDR chunks`)
    }
    if (type === 'IDAT') imageDataCount += 1
    if (type === 'IEND') {
      if (
        length !== 0 ||
        imageDataCount === 0 ||
        chunkEnd !== bytes.length
      ) {
        throw new Error(`${label} has an invalid PNG terminator`)
      }
      ended = true
    }
    offset = chunkEnd
    chunkIndex += 1
  }
  if (!ended) throw new Error(`${label} is missing its PNG terminator`)
  return Object.freeze({
    width: expected.width,
    height: expected.height,
    bytes: bytes.length,
    sha256: sha256(bytes),
  })
}

function decodeBrowserPng(base64, expected, label) {
  if (
    typeof base64 !== 'string' ||
    base64.length === 0 ||
    base64.length > Math.ceil((MAX_PNG_BYTES * 4) / 3) + 8 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
  ) {
    throw new Error(`${label} has invalid bounded base64`)
  }
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.toString('base64') !== base64) {
    throw new Error(`${label} has non-canonical base64`)
  }
  return { bytes, metadata: validatePng(bytes, expected, label) }
}

function serializeJsonArtifact(value, label) {
  assertSerializableEvidence(value, label)
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  if (bytes.length > EVIDENCE_SERIALIZATION_LIMITS.maxJsonBytes) {
    throw new Error(`${label} exceeds its JSON byte bound`)
  }
  return bytes
}

function serializeBrowserCapture(capture) {
  if (
    capture === null ||
    typeof capture !== 'object' ||
    capture.evidence === null ||
    typeof capture.evidence !== 'object' ||
    capture.images === null ||
    typeof capture.images !== 'object' ||
    Array.isArray(capture.images)
  ) {
    throw new Error('Browser capture payload has invalid shape')
  }
  safeEvidenceJson(capture.evidence, 'browser evidence')
  const imageNames = Object.keys(capture.images).sort()
  const expectedNames = Object.keys(PNG_SPECS).sort()
  if (JSON.stringify(imageNames) !== JSON.stringify(expectedNames)) {
    throw new Error('Browser PNG artifact inventory differs from policy')
  }
  const images = {}
  for (const name of expectedNames) {
    images[name] = decodeBrowserPng(
      capture.images[name],
      PNG_SPECS[name],
      name,
    )
  }
  return { evidence: capture.evidence, images }
}

function assertCaptureIdentity(first, second) {
  if (
    safeEvidenceJson(first.evidence, 'first browser evidence') !==
    safeEvidenceJson(second.evidence, 'second browser evidence')
  ) {
    throw new Error('Independent browser evidence payloads differed')
  }
  for (const name of Object.keys(PNG_SPECS)) {
    if (!first.images[name].bytes.equals(second.images[name].bytes)) {
      throw new Error(`Independent browser PNG bytes differed: ${name}`)
    }
  }
}

function evidenceReadme() {
  return `# Flowing Contours comparison evidence

These deterministic artifacts are review inputs for issue #403. Each reference
PNG places the exact source image, Pencil Contour, Watercolor Forms, and Flowing
Contours in four equally scaled labeled panels. Full-frame and dense-detail
crops use the FC23 contract. The synthetic witness separately exposes smooth
flow, stump, staircase, and orthogonal-grid regressions.

\`manifest.json\` pins browser versions, source identities, controls, crops,
artifact hashes, and current automated findings. The JSON companions preserve
canonical geometry, metrics, and bounded diagnostics without relying on PNG
inspection.

Status is **awaiting independent review**. Generated metrics and images are not
a visual-review verdict, and this directory contains no generated attestation.

## Reproduce

\`\`\`sh
node apps/studio/scripts/capture-flowing-contours-reference.mjs --write
node apps/studio/scripts/capture-flowing-contours-reference.mjs --verify
\`\`\`

Both commands recompute production geometry and PNG bytes in two fresh contexts
using the pinned browser. Verify refuses missing, extra, stale, or byte-drifted
artifacts.
`
}

function buildArtifactBundle(capture, runtime) {
  const { evidence } = capture
  const geometry = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    status: 'generated-comparison-evidence-awaiting-independent-review',
    cases: Object.fromEntries(
      Object.entries(evidence.cases).map(([name, value]) => [
        name,
        {
          flowing: value.flowing.geometry,
          pencil: value.pencil.geometry,
          watercolor: value.watercolor.geometry,
        },
      ]),
    ),
    synthetic: evidence.synthetic.geometry,
  }
  const metrics = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    status: 'generated-comparison-evidence-awaiting-independent-review',
    cases: Object.fromEntries(
      Object.entries(evidence.cases).map(([name, value]) => [
        name,
        {
          flowing: value.flowing.metrics,
          collection: value.flowing.collectionEvidence,
          topology: value.flowing.topologyEvidence,
          gateFindings: value.flowing.gateFindings,
          pencilComparator: value.flowing.pencilComparator,
          pencil: value.pencil.metrics,
        },
      ]),
    ),
    synthetic: {
      antiStaircaseMetrics: evidence.synthetic.antiStaircaseMetrics,
      collection: evidence.synthetic.collectionEvidence,
      regressionGuard: evidence.synthetic.regressionGuard,
    },
  }
  const diagnostics = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    status: 'generated-comparison-evidence-awaiting-independent-review',
    cases: Object.fromEntries(
      Object.entries(evidence.cases).map(([name, value]) => [
        name,
        {
          flowing: value.flowing.diagnostics,
          flowingStageProof: value.flowing.stageProof,
          watercolor: value.watercolor.diagnostics,
        },
      ]),
    ),
    synthetic: {
      flowing: evidence.synthetic.diagnostics,
      flowingStageProof: evidence.synthetic.stageProof,
    },
  }
  const files = Object.fromEntries(
    Object.entries(capture.images).map(([name, value]) => [
      name,
      value.bytes,
    ]),
  )
  files['geometry.json'] = serializeJsonArtifact(
    geometry,
    'geometry artifact',
  )
  files['metrics.json'] = serializeJsonArtifact(metrics, 'metrics artifact')
  files['diagnostics.json'] = serializeJsonArtifact(
    diagnostics,
    'diagnostics artifact',
  )
  files['README.md'] = Buffer.from(evidenceReadme())
  const describedArtifacts = Object.fromEntries(
    Object.keys(files)
      .sort()
      .map((name) => {
        const png = capture.images[name]?.metadata
        return [
          name,
          {
            file: name,
            bytes: files[name].length,
            sha256: sha256(files[name]),
            ...(png === undefined
              ? {}
              : { width: png.width, height: png.height }),
          },
        ]
      }),
  )
  const manifest = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    referenceId: 'flowing-contours-comparison-evidence',
    issue: 403,
    status: 'generated-comparison-evidence-awaiting-independent-review',
    runtime,
    sources: Object.fromEntries(
      Object.entries(evidence.cases).map(([name, value]) => [
        name,
        value.source,
      ]),
    ),
    frame: evidence.cases.flower.frame,
    controls: evidence.cases.flower.controls,
    crops: {
      flower: {
        fullFrame: {
          x: 0,
          y: 0,
          width: 1000,
          height: 1000,
        },
        denseDetail: { x: 250, y: 40, width: 500, height: 500 },
      },
      pinecone: {
        fullFrame: {
          x: 0,
          y: 0,
          width: 1000,
          height: 1000,
        },
        denseDetail: { x: 200, y: 180, width: 600, height: 600 },
      },
    },
    artifacts: describedArtifacts,
    findings: {
      flower: evidence.cases.flower.flowing.gateFindings,
      pinecone: evidence.cases.pinecone.flowing.gateFindings,
      synthetic: evidence.synthetic.regressionGuard.findings,
    },
    review: {
      state: 'awaiting-independent-review',
      verdict: 'NOT-RECORDED',
      generatedAttestation: false,
      note: 'Generated evidence is not an independent visual-review verdict.',
    },
  }
  files['manifest.json'] = serializeJsonArtifact(
    manifest,
    'manifest artifact',
  )
  const names = Object.keys(files).sort()
  if (
    JSON.stringify(names) !==
    JSON.stringify([...ARTIFACT_NAMES].sort())
  ) {
    throw new Error('Serialized artifact inventory differs from policy')
  }
  return { files, manifest }
}

function artifactReport(bundle) {
  return Object.fromEntries(
    Object.keys(bundle.files)
      .sort()
      .map((name) => {
        const png = PNG_SPECS[name]
        return [
          name,
          {
            bytes: bundle.files[name].length,
            sha256: sha256(bundle.files[name]),
            ...(png === undefined ? {} : png),
          },
        ]
      }),
  )
}

const HELP = `Usage:
  node apps/studio/scripts/capture-flowing-contours-reference.mjs --dry-run
  node apps/studio/scripts/capture-flowing-contours-reference.mjs --write
  node apps/studio/scripts/capture-flowing-contours-reference.mjs --verify
  node apps/studio/scripts/capture-flowing-contours-reference.mjs --self-test

Options:
  --dry-run   Compute evidence and PNGs without repository writes.
  --write     Transactionally replace the complete artifact bundle.
  --verify    Recompute and exactly verify the committed artifact bundle.
  --port N    Vite port (default ${DEFAULT_PORT}).
  --self-test Exercise parser, import-boundary, and regression-shape guards.
  --help      Print this help.

Phase 3 runs the real Pencil, Watercolor, and Flowing pipelines and composes
deterministic Canvas2D review panels in the pinned browser. It does not import
Studio App, registry, compositor, or Scene renderer code. No mode records an
independent review verdict; generated artifacts remain awaiting review.`

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

function captureModuleSource() {
  return `import { decodeImageAsset } from '/src/imageAssetResolver.ts'
import { createFlowingContoursAccounting } from '/@fs${workspaceRoot}/packages/core/src/sketches/flowing-contours/accounting.ts'
import { prepareFlowingContoursRaster } from '/@fs${workspaceRoot}/packages/core/src/sketches/flowing-contours/raster.ts'
import { buildFlowingContoursField } from '/@fs${workspaceRoot}/packages/core/src/sketches/flowing-contours/field.ts'
import { runFlowingContoursPipeline } from '/@fs${workspaceRoot}/packages/core/src/sketches/flowing-contours/pipeline.ts'
import { generateFlowingContours } from '/@fs${workspaceRoot}/packages/core/src/sketches/flowing-contours/generator.ts'
import { createFlowingContoursEvidenceTube, validateFlowingContoursTubeCurve } from '/@fs${workspaceRoot}/packages/core/src/sketches/flowing-contours/tube.ts'
import { FLOWING_CONTOURS_LIMITS } from '/@fs${workspaceRoot}/packages/core/src/sketches/flowing-contours/limits.ts'
import { createFlowingContoursSuppressionState } from '/@fs${workspaceRoot}/packages/core/src/sketches/flowing-contours/suppression.ts'
import { createRasterContainFit } from '/@fs${workspaceRoot}/packages/core/src/rasterSampling.ts'
import { generatePencilContour } from '/@fs${workspaceRoot}/packages/core/src/sketches/pencil-contour/generator.ts'
import { generateWatercolorForms } from '/@fs${workspaceRoot}/packages/core/src/sketches/watercolor-forms/generator.ts'
import { measureFlowingContoursReference } from '/@fs${workspaceRoot}/packages/core/src/__tests__/helpers/flowingContoursReferenceMetrics.ts'
import {
  FLOWING_CONTOURS_REFERENCE_CASES,
  FLOWING_CONTOURS_REFERENCE_CONTROLS,
  FLOWING_CONTOURS_REFERENCE_FRAME,
  PENCIL_CONTOUR_REFERENCE_CONTROLS,
  WATERCOLOR_FORMS_REFERENCE_CONTROLS,
  flowingContoursPencilComparisonFindings,
  flowingContoursReferenceGateFindings,
  measureFlowingContoursReferenceGeometryEvidence,
} from '/@fs${workspaceRoot}/packages/core/src/__tests__/helpers/flowingContoursReferenceCases.ts'

const EVIDENCE_SERIALIZATION_LIMITS = Object.freeze(${JSON.stringify(EVIDENCE_SERIALIZATION_LIMITS)})
const COMPARISON_SIZE = Object.freeze(${JSON.stringify(COMPARISON_SIZE)})
const SYNTHETIC_SIZE = Object.freeze(${JSON.stringify(SYNTHETIC_SIZE)})
const COMPARISON_LAYOUT = Object.freeze(${JSON.stringify(COMPARISON_LAYOUT)})
const PNG_SPECS = Object.freeze(${JSON.stringify(PNG_SPECS)})
const MAX_PNG_BYTES = ${MAX_PNG_BYTES}
${assertSerializableEvidence.toString()}
${safeEvidenceJson.toString()}
${canonicalSceneSnapshot.toString()}
${regressionShapeFindings.toString()}

const sameJson = (first, second) =>
  safeEvidenceJson(first, 'comparison lhs') ===
  safeEvidenceJson(second, 'comparison rhs')
const samePoint = (first, second) =>
  Object.is(first[0], second[0]) && Object.is(first[1], second[1])
const pathLength = (points, closed) => {
  let length = 0
  for (let index = 1; index < points.length; index += 1) {
    length += Math.hypot(
      points[index][0] - points[index - 1][0],
      points[index][1] - points[index - 1][1],
    )
  }
  if (closed && points.length > 1 && !samePoint(points[0], points.at(-1))) {
    length += Math.hypot(
      points[0][0] - points.at(-1)[0],
      points[0][1] - points.at(-1)[1],
    )
  }
  return length
}
const percentile = (values, probability) => {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((first, second) => first - second)
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const amount = position - lower
  return (
    sorted[lower] +
    (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) *
      amount
  )
}
const hexDigest = async (bytes) => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
const canonicalSceneGeometry = async (
  scene,
  maxPathCount = EVIDENCE_SERIALIZATION_LIMITS.maxComparatorPathCount,
) => {
  const canonical = canonicalSceneSnapshot(scene, maxPathCount)
  const serialization = safeEvidenceJson(
    canonical,
    'canonical Scene geometry',
  )
  return {
    canonical,
    canonicalSha256: await hexDigest(
      new TextEncoder().encode(serialization),
    ),
  }
}
const genericLengthMetrics = (scene) => {
  const diagonal = Math.hypot(scene.space.width, scene.space.height)
  const lengths = scene.primitives.map((primitive) =>
    pathLength(primitive.points, primitive.closed === true),
  )
  const shortThreshold = diagonal * 0.015
  return {
    shortPathShare:
      lengths.length === 0
        ? 0
        : lengths.filter((length) => length < shortThreshold).length /
          lengths.length,
    medianPathLength: percentile(lengths, 0.5),
    upperQuartilePathLength: percentile(lengths, 0.75),
    longestPathLength: lengths.length === 0 ? 0 : Math.max(...lengths),
  }
}
const canvasPngBase64 = (canvas) => {
  const dataUrl = canvas.toDataURL('image/png')
  const prefix = 'data:image/png;base64,'
  if (
    !dataUrl.startsWith(prefix) ||
    dataUrl.length - prefix.length > Math.ceil((MAX_PNG_BYTES * 4) / 3) + 8
  ) {
    throw new Error('Canvas PNG encoding is invalid or exceeds its bound')
  }
  return dataUrl.slice(prefix.length)
}
const sourceCanvas = (pixels) => {
  const canvas = document.createElement('canvas')
  canvas.width = pixels.width
  canvas.height = pixels.height
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('Source Canvas2D unavailable')
  context.putImageData(
    new ImageData(
      new Uint8ClampedArray(pixels.data),
      pixels.width,
      pixels.height,
    ),
    0,
    0,
  )
  return canvas
}
const renderSceneGeometry = (context, scene) => {
  context.save()
  for (const primitive of scene.primitives) {
    context.beginPath()
    const first = primitive.points[0]
    if (first !== undefined) {
      context.moveTo(first[0], first[1])
      for (let index = 1; index < primitive.points.length; index += 1) {
        context.lineTo(
          primitive.points[index][0],
          primitive.points[index][1],
        )
      }
    }
    if (primitive.closed) context.closePath()
    if (primitive.fill !== undefined) {
      context.fillStyle = primitive.fill.color
      context.fill()
    }
    if (primitive.stroke !== undefined) {
      context.strokeStyle = primitive.stroke.color
      context.lineCap = primitive.stroke.lineCap ?? 'butt'
      context.lineJoin = 'miter'
      context.miterLimit = 10
      context.lineWidth = primitive.stroke.width
      context.stroke()
    }
  }
  context.restore()
}
const configureCanvas = (canvas) => {
  const context = canvas.getContext('2d', {
    alpha: false,
    colorSpace: 'srgb',
    willReadFrequently: false,
  })
  if (context === null) throw new Error('Artifact Canvas2D unavailable')
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.globalAlpha = 1
  context.globalCompositeOperation = 'source-over'
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.textAlign = 'center'
  context.textBaseline = 'alphabetic'
  return context
}
const LABEL_GLYPHS = Object.freeze({
  ' ': ['00000','00000','00000','00000','00000','00000','00000'],
  '-': ['00000','00000','00000','11111','00000','00000','00000'],
  '+': ['00000','00100','00100','11111','00100','00100','00000'],
  '/': ['00001','00010','00100','01000','10000','00000','00000'],
  ':': ['00000','00100','00100','00000','00100','00100','00000'],
  '.': ['00000','00000','00000','00000','00000','00100','00100'],
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00010','00100','01000','11111'],
  '3': ['11110','00001','00001','01110','00001','00001','11110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','10000','11110','00001','00001','11110'],
  '6': ['01110','10000','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','00001','01110'],
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  B: ['11110','10001','10001','11110','10001','10001','11110'],
  C: ['01111','10000','10000','10000','10000','10000','01111'],
  D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  F: ['11111','10000','10000','11110','10000','10000','10000'],
  G: ['01111','10000','10000','10111','10001','10001','01111'],
  H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['01110','00100','00100','00100','00100','00100','01110'],
  J: ['00001','00001','00001','00001','10001','10001','01110'],
  K: ['10001','10010','10100','11000','10100','10010','10001'],
  L: ['10000','10000','10000','10000','10000','10000','11111'],
  M: ['10001','11011','10101','10101','10001','10001','10001'],
  N: ['10001','11001','10101','10011','10001','10001','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'],
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  Q: ['01110','10001','10001','10001','10101','10010','01101'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  S: ['01111','10000','10000','01110','00001','00001','11110'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'],
  V: ['10001','10001','10001','10001','10001','01010','00100'],
  W: ['10001','10001','10001','10101','10101','10101','01010'],
  X: ['10001','10001','01010','00100','01010','10001','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'],
  Z: ['11111','00001','00010','00100','01000','10000','11111'],
})
const drawPanelLabel = (context, label, centerX, centerY, color) => {
  context.save()
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.fillStyle = color
  const value = label.toUpperCase()
  const scale = value.length > 52 ? 2 : 3
  const advance = 6 * scale
  const width = value.length * advance - scale
  const left = Math.round(centerX - width / 2)
  const top = Math.round(centerY - (7 * scale) / 2)
  for (let characterIndex = 0; characterIndex < value.length; characterIndex += 1) {
    const glyph = LABEL_GLYPHS[value[characterIndex]]
    if (glyph === undefined) {
      throw new Error('Unsupported artifact label glyph: ' + value[characterIndex])
    }
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] === '1') {
          context.fillRect(
            left + characterIndex * advance + column * scale,
            top + row * scale,
            scale,
            scale,
          )
        }
      }
    }
  }
  context.restore()
}
const drawPanel = ({
  context,
  crop,
  panel,
  scene,
  source,
  sourceMetadata,
}) => {
  context.save()
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.fillStyle = '#ffffff'
  context.fillRect(panel.left, panel.top, panel.size, panel.size)
  context.beginPath()
  context.rect(panel.left, panel.top, panel.size, panel.size)
  context.clip()
  context.translate(panel.left, panel.top)
  context.scale(panel.size / crop.width, panel.size / crop.height)
  context.translate(-crop.x, -crop.y)
  if (source !== undefined) {
    const scale = Math.min(
      1000 / sourceMetadata.decodedWidth,
      1000 / sourceMetadata.decodedHeight,
    )
    const width = sourceMetadata.decodedWidth * scale
    const height = sourceMetadata.decodedHeight * scale
    context.drawImage(
      source,
      (1000 - width) / 2,
      (1000 - height) / 2,
      width,
      height,
    )
  } else {
    renderSceneGeometry(context, scene)
  }
  context.restore()
  context.save()
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.strokeStyle = '#a9a49a'
  context.lineWidth = 1
  context.strokeRect(
    panel.left + 0.5,
    panel.top + 0.5,
    panel.size - 1,
    panel.size - 1,
  )
  context.restore()
}
const comparisonPng = ({
  crop,
  label,
  pixels,
  sourceMetadata,
  pencil,
  watercolor,
  flowing,
}) => {
  const canvas = document.createElement('canvas')
  canvas.width = COMPARISON_SIZE.width
  canvas.height = COMPARISON_SIZE.height
  const context = configureCanvas(canvas)
  context.fillStyle = '#ece9e1'
  context.fillRect(0, 0, canvas.width, canvas.height)
  const source = sourceCanvas(pixels)
  const panels = [
    {
      label: 'SOURCE IMAGE',
      color: '#3d4f63',
      panel: COMPARISON_LAYOUT.panels.source,
      source,
    },
    {
      label: 'PENCIL CONTOUR',
      color: '#59423b',
      panel: COMPARISON_LAYOUT.panels.pencil,
      scene: pencil,
    },
    {
      label: 'WATERCOLOR FORMS',
      color: '#315a58',
      panel: COMPARISON_LAYOUT.panels.watercolor,
      scene: watercolor,
    },
    {
      label: 'FLOWING CONTOURS',
      color: '#583f6e',
      panel: COMPARISON_LAYOUT.panels.flowing,
      scene: flowing,
    },
  ]
  for (const item of panels) {
    drawPanel({
      context,
      crop,
      panel: item.panel,
      scene: item.scene,
      source: item.source,
      sourceMetadata,
    })
    drawPanelLabel(
      context,
      item.label,
      item.panel.left + item.panel.size / 2,
      item.panel.top - COMPARISON_LAYOUT.labelOffset,
      item.color,
    )
  }
  drawPanelLabel(
    context,
    label,
    canvas.width / 2,
    COMPARISON_LAYOUT.footerCenterY,
    '#252525',
  )
  return canvasPngBase64(canvas)
}
const syntheticWitnessPng = ({
  pixels,
  sourceMetadata,
  flowing,
  regressionGuard,
}) => {
  const canvas = document.createElement('canvas')
  canvas.width = SYNTHETIC_SIZE.width
  canvas.height = SYNTHETIC_SIZE.height
  const context = configureCanvas(canvas)
  context.fillStyle = '#ece9e1'
  context.fillRect(0, 0, canvas.width, canvas.height)
  const crop = { x: 0, y: 0, width: 1000, height: 1000 }
  const source = sourceCanvas(pixels)
  const panels = [
    {
      label: 'SYNTHETIC DIAGONAL + CURVE',
      color: '#3d4f63',
      panel: { left: 50, top: 70, size: 700 },
      source,
    },
    {
      label: 'FLOWING CONTOURS OUTPUT',
      color: '#583f6e',
      panel: { left: 850, top: 70, size: 700 },
      scene: flowing,
    },
  ]
  for (const item of panels) {
    drawPanel({
      context,
      crop,
      panel: item.panel,
      scene: item.scene,
      source: item.source,
      sourceMetadata,
    })
    drawPanelLabel(
      context,
      item.label,
      item.panel.left + item.panel.size / 2,
      33,
      item.color,
    )
  }
  drawPanelLabel(
    context,
    'SMOOTH-FLOW / STAIRCASE WITNESS: ' +
      regressionGuard.verdict.toUpperCase() +
      ' - FINDINGS ' +
      String(regressionGuard.findings.length),
    canvas.width / 2,
    796,
    regressionGuard.verdict === 'pass' ? '#205c3b' : '#8b2c2c',
  )
  return canvasPngBase64(canvas)
}
const mapFlowingStages = (pixels, controls, frame) => {
  const accounting = createFlowingContoursAccounting()
  const raster = prepareFlowingContoursRaster(pixels, accounting)
  if (accounting.termination !== 'complete') {
    throw new Error('Flowing preparation did not complete')
  }
  const field = buildFlowingContoursField(raster, accounting)
  if (accounting.termination !== 'complete') {
    throw new Error('Flowing field construction did not complete')
  }
  const suppression = createFlowingContoursSuppressionState({
    field,
    limits: FLOWING_CONTOURS_LIMITS,
  })
  if (suppression === null) {
    throw new Error(
      'Flowing suppression rejected field: ' +
        JSON.stringify({
          dimensions: [
            field.sourceWidth,
            field.sourceHeight,
            field.width,
            field.height,
          ],
          frozen: Object.isFrozen(field),
          channelKinds: Object.fromEntries(
            [
              'luminance',
              'alpha',
              'positiveSupport',
              'contourEvidence',
              'tangentX',
              'tangentY',
              'tangentCoherence',
              'ambiguity',
              'ridgeScale',
            ].map((name) => [
              name,
              {
                array: Array.isArray(field[name]),
                frozen: Object.isFrozen(field[name]),
                length: field[name]?.length,
              },
            ]),
          ),
        }),
    )
  }
  const pipeline = runFlowingContoursPipeline(
    field,
    controls,
    FLOWING_CONTOURS_LIMITS,
  )
  if (pipeline.diagnostics.termination === 'invalid-input') {
    const direct = generateFlowingContours({ pixels, frame, controls })
    if (
      direct.scene.primitives.length !== 0 ||
      !sameJson(direct.diagnostics, pipeline.diagnostics)
    ) {
      throw new Error(
        'Flowing invalid-stage/generator reconciliation failed',
      )
    }
    return {
      generated: direct,
      retainedTrajectories: [],
      stageProof: {
        pipelineTermination: 'invalid-input',
        acceptedTrajectoryCount: 0,
        retainedTrajectoryCount: 0,
        generatorPrimitiveCount: 0,
        exactBijection: true,
        exactOrder: true,
        exactPointEquality: true,
        exactDiagnosticsAggregates: true,
      },
    }
  }
  if (pipeline.acceptedTrajectories.length !== pipeline.fittedCurves.length) {
    throw new Error('Flowing pipeline raw/fitted inventory diverged')
  }
  const fit = createRasterContainFit(
    { width: raster.sourceWidth, height: raster.sourceHeight },
    frame,
  )
  if (fit === null) throw new Error('Flowing contain fit failed')
  const retained = []
  for (let index = 0; index < pipeline.fittedCurves.length; index += 1) {
    const trajectory = pipeline.acceptedTrajectories[index]
    const curve = pipeline.fittedCurves[index]
    if (
      curve.provenance.sourceTrajectoryId !== trajectory.id ||
      curve.points.length !== curve.provenance.sourceSampleIndices.length
    ) {
      throw new Error('Flowing fitted provenance diverged')
    }
    const tube = createFlowingContoursEvidenceTube(field, trajectory)
    if (
      tube === null ||
      validateFlowingContoursTubeCurve(field, tube, {
        points: curve.points,
        sourceSampleIndices: curve.provenance.sourceSampleIndices,
      }) === null
    ) {
      continue
    }
    const points = curve.points.map((point) => [
      fit.left + ((point[0] + 0.5) / field.width) * fit.fittedWidth,
      fit.top + ((point[1] + 0.5) / field.height) * fit.fittedHeight,
    ])
    const closed =
      trajectory.samples.length >= 4 &&
      samePoint(
        trajectory.samples[0].point,
        trajectory.samples.at(-1).point,
      )
    const length = pathLength(points, closed)
    const minimum =
      controls.minimumStrokeLength *
      Math.hypot(fit.fittedWidth, fit.fittedHeight)
    if (length + 1e-9 < minimum) continue
    retained.push({
      trajectory,
      curve,
      primitive: {
        points,
        closed,
        stroke: { color: 'black', width: 1 },
        hiddenLineRole: 'source',
      },
    })
  }
  const generated = generateFlowingContours({ pixels, frame, controls })
  if (generated.scene.primitives.length !== retained.length) {
    throw new Error('Flowing generator/stage path bijection failed')
  }
  for (let index = 0; index < retained.length; index += 1) {
    const expected = retained[index].primitive
    const actual = generated.scene.primitives[index]
    if (
      actual.closed !== expected.closed ||
      actual.hiddenLineRole !== expected.hiddenLineRole ||
      !sameJson(actual.stroke, expected.stroke) ||
      actual.points.length !== expected.points.length ||
      !actual.points.every((point, pointIndex) =>
        samePoint(point, expected.points[pointIndex]),
      )
    ) {
      throw new Error(
        'Flowing generator/stage order or exact point equality failed',
      )
    }
  }
  const endpointReasonCounts = Object.fromEntries(
    Object.keys(pipeline.diagnostics.endpointReasonCounts).map((name) => [
      name,
      0,
    ]),
  )
  let rawPointCount = 0
  let fittedPointCount = 0
  let maximumUnsupported = 0
  let totalUnsupported = 0
  for (const item of retained) {
    rawPointCount += item.trajectory.samples.length
    fittedPointCount += item.curve.points.length
    maximumUnsupported = Math.max(
      maximumUnsupported,
      item.trajectory.maximumUnsupportedSpanLength,
    )
    totalUnsupported += item.trajectory.totalUnsupportedSpanLength
    endpointReasonCounts[item.trajectory.startEndpointReason] += 1
    endpointReasonCounts[item.trajectory.endEndpointReason] += 1
  }
  const expectedDiagnostics = {
    ...pipeline.diagnostics,
    acceptedCandidateCount: retained.length,
    rejectedCandidateCount:
      pipeline.diagnostics.candidateCount - retained.length,
    endpointReasonCounts,
    rawTrajectoryCount: retained.length,
    rawTrajectoryPointCount: rawPointCount,
    acceptedMaximumUnsupportedSpanLength: maximumUnsupported,
    acceptedTotalUnsupportedSpanLength: totalUnsupported,
    fittedCurveCount: retained.length,
    fittedCurvePointCount: fittedPointCount,
    primitiveCount: retained.length,
  }
  if (!sameJson(generated.diagnostics, expectedDiagnostics)) {
    throw new Error('Flowing generator/stage diagnostics aggregate failed')
  }
  return {
    generated,
    retainedTrajectories: retained.map((item) => item.trajectory),
    stageProof: {
      pipelineTermination: pipeline.diagnostics.termination,
      acceptedTrajectoryCount: pipeline.acceptedTrajectories.length,
      retainedTrajectoryCount: retained.length,
      generatorPrimitiveCount: generated.scene.primitives.length,
      exactBijection: true,
      exactOrder: true,
      exactPointEquality: true,
      exactDiagnosticsAggregates: true,
    },
  }
}
const regionHit = (primitive, region, frame) => {
  const points = primitive.points
  for (let index = 1; index < points.length; index += 1) {
    const first = points[index - 1]
    const second = points[index]
    for (let step = 0; step <= 16; step += 1) {
      const amount = step / 16
      const x =
        (first[0] + (second[0] - first[0]) * amount) / frame.width
      const y =
        (first[1] + (second[1] - first[1]) * amount) / frame.height
      if (
        x >= region.left &&
        x <= region.right &&
        y >= region.top &&
        y <= region.bottom
      ) {
        return true
      }
    }
  }
  return false
}
const topologyEvidence = (name, reference, flowing) => {
  const hits = flowing.generated.scene.primitives.map((primitive) =>
    Object.fromEntries(
      reference.regions.map((region) => [
        region.name,
        regionHit(primitive, region, reference.frame),
      ]),
    ),
  )
  const unsupported = flowing.retainedTrajectories.map(
    (trajectory) => trajectory.totalUnsupportedSpanLength,
  )
  const anyHit = (regionName) => hits.some((path) => path[regionName])
  const connected = (first, second, supportedOnly) =>
    hits.some(
      (path, index) =>
        path[first] &&
        path[second] &&
        (!supportedOnly || unsupported[index] === 0),
    )
  if (name === 'flower') {
    return [
      {
        name: reference.topologyChecks[0],
        sourceConnectionVerified:
          connected('left-petals', 'flower-center', true) &&
          connected('flower-center', 'right-petals', true),
        forbiddenBridgeObserved: false,
      },
      {
        name: reference.topologyChecks[1],
        sourceConnectionVerified:
          anyHit('flower-center') && anyHit('lower-gesture'),
        forbiddenBridgeObserved:
          connected('flower-center', 'lower-gesture', false) &&
          hits.some(
            (path, index) =>
              path['flower-center'] &&
              path['lower-gesture'] &&
              unsupported[index] > 0,
          ),
      },
    ]
  }
  return [
    {
      name: reference.topologyChecks[0],
      sourceConnectionVerified:
        connected('upper-scales', 'middle-scales', true) &&
        connected('middle-scales', 'lower-scales', true),
      forbiddenBridgeObserved: false,
    },
    {
      name: reference.topologyChecks[1],
      sourceConnectionVerified:
        anyHit('left-interior') && anyHit('right-interior'),
      forbiddenBridgeObserved:
        connected('left-interior', 'right-interior', false) &&
        hits.some(
          (path, index) =>
            path['left-interior'] &&
            path['right-interior'] &&
            unsupported[index] > 0,
        ),
    },
  ]
}
const source = async (reference) => {
  const response = await fetch(
    '/image-assets/' + reference.source.assetId + '.png',
  )
  if (!response.ok) {
    throw new Error(
      'Reference source returned ' + String(response.status),
    )
  }
  const bytes = await response.arrayBuffer()
  const pixels = await decodeImageAsset(reference.source.assetId)
  const metadata = {
    assetId: reference.source.assetId,
    repositoryPath: reference.source.repositoryPath,
    sha256: await hexDigest(bytes),
    decodedWidth: pixels.width,
    decodedHeight: pixels.height,
  }
  if (!sameJson(metadata, reference.source)) {
    throw new Error('Reference source identity drifted')
  }
  return { pixels, metadata }
}
const captureReferenceCase = async (name, reference) => {
  const resolved = await source(reference)
  const flowing = mapFlowingStages(
    resolved.pixels,
    FLOWING_CONTOURS_REFERENCE_CONTROLS,
    FLOWING_CONTOURS_REFERENCE_FRAME,
  )
  const pencil = generatePencilContour({
    pixels: resolved.pixels,
    frame: FLOWING_CONTOURS_REFERENCE_FRAME,
    controls: PENCIL_CONTOUR_REFERENCE_CONTROLS,
  })
  const watercolor = generateWatercolorForms({
    pixels: resolved.pixels,
    frame: FLOWING_CONTOURS_REFERENCE_FRAME,
    controls: WATERCOLOR_FORMS_REFERENCE_CONTROLS,
  })
  const flowingMetrics = measureFlowingContoursReference({
    scene: flowing.generated.scene,
    acceptedTrajectories: flowing.retainedTrajectories,
    diagnostics: flowing.generated.diagnostics,
    options: { regions: reference.regions },
  })
  const collectionEvidence =
    measureFlowingContoursReferenceGeometryEvidence(
      flowing.generated.scene,
    )
  if (collectionEvidence === null) {
    throw new Error('Flowing collection evidence failed')
  }
  const topology = topologyEvidence(name, reference, flowing)
  const gateFindings = flowingContoursReferenceGateFindings(
    name,
    flowingMetrics,
    { geometry: collectionEvidence, topology },
  )
  const pencilMetrics = genericLengthMetrics(pencil.scene)
  const pencilFindings = flowingContoursPencilComparisonFindings(
    flowingMetrics,
    pencilMetrics,
  )
  const evidence = {
    source: resolved.metadata,
    frame: FLOWING_CONTOURS_REFERENCE_FRAME,
    controls: {
      flowing: FLOWING_CONTOURS_REFERENCE_CONTROLS,
      pencil: PENCIL_CONTOUR_REFERENCE_CONTROLS,
      watercolor: WATERCOLOR_FORMS_REFERENCE_CONTROLS,
    },
    flowing: {
      geometry: await canonicalSceneGeometry(
        flowing.generated.scene,
        EVIDENCE_SERIALIZATION_LIMITS.maxFlowingPathCount,
      ),
      diagnostics: flowing.generated.diagnostics,
      stageProof: flowing.stageProof,
      metrics: flowingMetrics,
      collectionEvidence,
      topologyEvidence: topology,
      gateFindings,
      pencilComparator: {
        metrics: pencilMetrics,
        deltas: {
          shortPathShare:
            flowingMetrics.shortPathShare - pencilMetrics.shortPathShare,
          medianPathLength:
            flowingMetrics.medianPathLength -
            pencilMetrics.medianPathLength,
          upperQuartilePathLength:
            flowingMetrics.upperQuartilePathLength -
            pencilMetrics.upperQuartilePathLength,
          longestPathLength:
            flowingMetrics.longestPathLength -
            pencilMetrics.longestPathLength,
        },
        findings: pencilFindings,
      },
    },
    pencil: {
      geometry: await canonicalSceneGeometry(pencil.scene),
      metrics: pencilMetrics,
    },
    watercolor: {
      geometry: await canonicalSceneGeometry(watercolor.scene),
      diagnostics: watercolor.diagnostics,
    },
  }
  assertSerializableEvidence(evidence, name + ' reference evidence')
  return {
    evidence,
    images: {
      [name + '-full-frame-comparison.png']: comparisonPng({
        crop: reference.crops.fullFrame,
        label: name.toUpperCase() + ' - FULL COMPOSITION FRAME',
        pixels: resolved.pixels,
        sourceMetadata: resolved.metadata,
        pencil: pencil.scene,
        watercolor: watercolor.scene,
        flowing: flowing.generated.scene,
      }),
      [name + '-dense-detail-comparison.png']: comparisonPng({
        crop: reference.crops.denseDetail,
        label: name.toUpperCase() + ' - SHARED DENSE-DETAIL CROP',
        pixels: resolved.pixels,
        sourceMetadata: resolved.metadata,
        pencil: pencil.scene,
        watercolor: watercolor.scene,
        flowing: flowing.generated.scene,
      }),
    },
  }
}
const syntheticDiagonalCurve = () => {
  const width = 128
  const height = 96
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const diagonal = 14 + x * 0.52
      const curve =
        68 + Math.sin((x / (width - 1)) * Math.PI * 2) * 12
      const ink =
        Math.abs(y - diagonal) <= 2 || Math.abs(y - curve) <= 2
      const value = ink ? 18 : 244
      const offset = (y * width + x) * 4
      data[offset] = value
      data[offset + 1] = value
      data[offset + 2] = value
      data[offset + 3] = 255
    }
  }
  return { width, height, data }
}
const captureSynthetic = async () => {
  const pixels = syntheticDiagonalCurve()
  const flowing = mapFlowingStages(
    pixels,
    FLOWING_CONTOURS_REFERENCE_CONTROLS,
    FLOWING_CONTOURS_REFERENCE_FRAME,
  )
  const metrics = measureFlowingContoursReference({
    scene: flowing.generated.scene,
    acceptedTrajectories: flowing.retainedTrajectories,
    diagnostics: flowing.generated.diagnostics,
  })
  const collectionEvidence =
    measureFlowingContoursReferenceGeometryEvidence(
      flowing.generated.scene,
    )
  if (collectionEvidence === null) {
    throw new Error('Synthetic collection evidence failed')
  }
  const summary = {
    termination: flowing.generated.diagnostics.termination,
    pathCount: metrics.pathCount,
    shortPathShare: metrics.shortPathShare,
    medianPathDiagonalFraction:
      metrics.medianPathLength /
      Math.hypot(
        flowing.generated.scene.space.width,
        flowing.generated.scene.space.height,
      ),
    longestPathDiagonalFraction:
      metrics.longestPathLength /
      Math.hypot(
        flowing.generated.scene.space.width,
        flowing.generated.scene.space.height,
      ),
    longGeometryShare: metrics.longGeometryShare,
    turnsOver25DegreesShare: metrics.turnsOver25DegreesShare,
    turnsOver45DegreesShare: metrics.turnsOver45DegreesShare,
    staircasePairCount: metrics.staircasePairCount,
    orthogonalStaircaseSignature:
      metrics.orthogonalStaircaseSignature,
    occupiedCoverageBinCount: metrics.occupiedCoverageBinCount,
    gridFamilyObserved:
      collectionEvidence.primaryAxisLengthShare >= 0.2 &&
      collectionEvidence.perpendicularAxisLengthShare >= 0.2 &&
      collectionEvidence.primaryAxisPathCount >= 3 &&
      collectionEvidence.perpendicularAxisPathCount >= 3,
    gateFindings: [],
  }
  const findings = regressionShapeFindings(summary)
  const evidence = {
    identity: 'opaque-128x96-diagonal-plus-sinusoidal-curve-v1',
    geometry: await canonicalSceneGeometry(
      flowing.generated.scene,
      EVIDENCE_SERIALIZATION_LIMITS.maxFlowingPathCount,
    ),
    diagnostics: flowing.generated.diagnostics,
    stageProof: flowing.stageProof,
    collectionEvidence,
    antiStaircaseMetrics: {
      pathCount: metrics.pathCount,
      shortPathShare: metrics.shortPathShare,
      medianPathLength: metrics.medianPathLength,
      longestPathLength: metrics.longestPathLength,
      turnsOver25DegreesShare: metrics.turnsOver25DegreesShare,
      turnsOver45DegreesShare: metrics.turnsOver45DegreesShare,
      staircasePairCount: metrics.staircasePairCount,
      orthogonalStaircaseSignature:
        metrics.orthogonalStaircaseSignature,
    },
    regressionGuard: {
      summary,
      findings,
      verdict: findings.length === 0 ? 'pass' : 'fail',
    },
  }
  assertSerializableEvidence(evidence, 'synthetic evidence')
  return {
    evidence,
    images: {
      'synthetic-smooth-flow-staircase-witness.png':
        syntheticWitnessPng({
          pixels,
          sourceMetadata: {
            decodedWidth: pixels.width,
            decodedHeight: pixels.height,
          },
          flowing: flowing.generated.scene,
          regressionGuard: evidence.regressionGuard,
        }),
    },
  }
}
globalThis.__captureFlowingContoursEvidence = async () => {
  const flower = await captureReferenceCase(
    'flower',
    FLOWING_CONTOURS_REFERENCE_CASES.flower,
  )
  const pinecone = await captureReferenceCase(
    'pinecone',
    FLOWING_CONTOURS_REFERENCE_CASES.pinecone,
  )
  const synthetic = await captureSynthetic()
  const payload = {
    schemaVersion: 1,
    kind: 'flowing-contours-nonvisual-reference-evidence',
    phase: 'FC24b-phase-3',
    cases: {
      flower: flower.evidence,
      pinecone: pinecone.evidence,
    },
    synthetic: synthetic.evidence,
  }
  assertSerializableEvidence(payload, 'complete evidence payload')
  safeEvidenceJson(payload, 'complete evidence payload')
  const images = {
    ...flower.images,
    ...pinecone.images,
    ...synthetic.images,
  }
  if (
    Object.keys(images).length !== Object.keys(PNG_SPECS).length ||
    Object.keys(PNG_SPECS).some(
      (name) =>
        typeof images[name] !== 'string' ||
        images[name].length === 0,
    )
  ) {
    throw new Error('Browser PNG artifact inventory is invalid')
  }
  return { evidence: payload, images }
}
`
}

function evidenceHarnessPlugin() {
  const requestedPaths = new Set()
  const html =
    '<!doctype html><meta charset="utf-8">' +
    '<link rel="icon" href="data:,">' +
    `<script type="module" src="${HARNESS_MODULE_PATH}"></script>`
  const moduleSource = captureModuleSource()
  return Object.freeze({
    requestedPaths,
    plugin: {
      name: 'flowing-contours-nonvisual-evidence',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'node:crypto') return BROWSER_CRYPTO_STUB_ID
      },
      load(id) {
        if (id === BROWSER_CRYPTO_STUB_ID) {
          return `export function createHash() {
  throw new Error('node:crypto hash is outside the browser evidence path')
}
`
        }
      },
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
          const asset = SOURCE_ASSETS[path]
          if (asset !== undefined) {
            readFile(`${workspaceRoot}/${asset}`).then(
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

function assertInertRequests(requestedPaths) {
  for (const forbidden of [
    'main.tsx',
    'App.tsx',
    'registry.ts',
    'compositor',
    'renderer',
    'renderTo',
    'Canvas',
  ]) {
    if ([...requestedPaths].some((path) => path.includes(forbidden))) {
      throw new Error(
        `nonvisual harness loaded forbidden path: ${forbidden}`,
      )
    }
  }
}

async function pathState(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
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

async function assertArtifactDirectory(path, create) {
  const state = await pathState(path)
  if (state?.isSymbolicLink()) {
    throw new Error(`Artifact directory must not be a symlink: ${path}`)
  }
  if (state !== null && !state.isDirectory()) {
    throw new Error(`Artifact root is not a directory: ${path}`)
  }
  if (state === null) {
    if (!create) throw new Error(`Artifact directory is missing: ${path}`)
    await mkdir(path, { recursive: true })
    const created = await lstat(path)
    if (!created.isDirectory() || created.isSymbolicLink()) {
      throw new Error(`Artifact directory creation was unsafe: ${path}`)
    }
  }
}

async function assertArtifactTarget(path) {
  const state = await pathState(path)
  if (state?.isSymbolicLink()) {
    throw new Error(`Artifact target must not be a symlink: ${path}`)
  }
  if (state !== null && !state.isFile()) {
    throw new Error(`Artifact target is not a regular file: ${path}`)
  }
}

async function stageReplacement(target, bytes, token) {
  await assertArtifactTarget(target)
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

async function transactionallyReplace(replacements, testFaults = {}) {
  if (replacements.length === 0) return
  const directory = dirname(replacements[0].target)
  if (
    replacements.some(
      (replacement) => dirname(replacement.target) !== directory,
    )
  ) {
    throw new Error('Transactional artifact targets must share one directory')
  }
  await assertArtifactDirectory(directory, true)
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
      if ((await pathState(record.target)) !== null) {
        await rename(record.target, record.backup)
        record.moved = true
      }
    }
    let installedCount = 0
    for (const record of records) {
      await rename(record.staged, record.target)
      record.installed = true
      installedCount += 1
      if (installedCount === testFaults.failAfterInstall) {
        throw new Error('injected transactional artifact failure')
      }
    }
    await syncDirectory(directory)
    committed = true
    const cleanup = await Promise.allSettled(
      records
        .filter((record) => record.moved)
        .map((record) => unlink(record.backup)),
    )
    const failures = cleanup
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason)
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'Artifact transaction committed but backup cleanup failed',
      )
    }
    await syncDirectory(directory)
  } catch (primaryError) {
    if (committed) throw primaryError
    const rollbackErrors = []
    const recoveryBackups = []
    for (const record of records.slice().reverse()) {
      if (!record.installed && !record.moved) continue
      try {
        if (record.installed) await unlinkIfPresent(record.target)
        if (record.moved) {
          if (record.target === testFaults.failRestoreTarget) {
            throw new Error(
              `injected rollback restore failure: ${record.backup}`,
            )
          }
          await rename(record.backup, record.target)
        }
      } catch (error) {
        rollbackErrors.push(error)
        if (record.moved && (await pathState(record.backup)) !== null) {
          recoveryBackups.push(record.backup)
        }
      }
    }
    const cleanup = await Promise.allSettled(
      records.map((record) => unlinkIfPresent(record.staged)),
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
        [
          'Artifact transaction failed and rollback was incomplete.',
          `Manual recovery backups: ${recoveryBackups.join(', ')}`,
        ].join('\n'),
        { cause: primaryError },
      )
    }
    throw primaryError
  } finally {
    await Promise.allSettled(
      records.map((record) => unlinkIfPresent(record.staged)),
    )
  }
}

async function directoryInventory(path) {
  await assertArtifactDirectory(path, false)
  return (await readdir(path)).sort()
}

async function writeArtifactBundle(bundle, root = referenceRoot) {
  const state = await pathState(root)
  if (state !== null) {
    const names = await directoryInventory(root)
    const extras = names.filter((name) => !ARTIFACT_NAMES.includes(name))
    if (extras.length > 0) {
      throw new Error(`Artifact directory has extra files: ${extras.join(', ')}`)
    }
  }
  await transactionallyReplace(
    ARTIFACT_NAMES.map((name) => ({
      target: join(root, name),
      bytes: bundle.files[name],
    })),
  )
}

async function verifyArtifactBundle(bundle, root = referenceRoot) {
  const names = await directoryInventory(root)
  const expected = [...ARTIFACT_NAMES].sort()
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    const missing = expected.filter((name) => !names.includes(name))
    const extra = names.filter((name) => !expected.includes(name))
    throw new Error(
      `Artifact inventory mismatch; missing=${missing.join(',')}; extra=${extra.join(',')}`,
    )
  }
  for (const name of expected) {
    const path = join(root, name)
    await assertArtifactTarget(path)
    const actual = await readFile(path)
    if (!actual.equals(bundle.files[name])) {
      throw new Error(`Artifact bytes are stale or mismatched: ${path}`)
    }
  }
}

async function captureInFreshContext(browser, url) {
  const context = await browser.createBrowserContext()
  let primaryError
  let payload
  try {
    const page = await context.newPage()
    page.setDefaultTimeout(30_000)
    const pageErrors = []
    page.on('pageerror', (error) => {
      pageErrors.push(error instanceof Error ? error.message : String(error))
    })
    await page.goto(url, { waitUntil: 'networkidle0' })
    try {
      await page.waitForFunction(
        () => globalThis.__captureFlowingContoursEvidence !== undefined,
      )
    } catch (error) {
      if (pageErrors.length > 0) {
        throw new Error(
          `nonvisual harness module failed: ${pageErrors.join(' | ')}`,
          { cause: error },
        )
      }
      throw error
    }
    page.setDefaultTimeout(300_000)
    payload = await page.evaluate(
      () => globalThis.__captureFlowingContoursEvidence(),
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
      'Artifact capture failed and runtime cleanup was incomplete',
      { cause: primaryError },
    )
  }
  if (primaryError !== undefined) throw primaryError
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'Artifact capture runtime cleanup failed',
    )
  }
}

async function runCapture(options) {
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
    const harness = evidenceHarnessPlugin()
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
    const first = serializeBrowserCapture(
      await captureInFreshContext(browser, url),
    )
    const second = serializeBrowserCapture(
      await captureInFreshContext(browser, url),
    )
    assertCaptureIdentity(first, second)
    assertInertRequests(harness.requestedPaths)
    const runtime = {
      chrome: product,
      chromeRevision: browserTools.chromeRevision,
      puppeteer: browserTools.puppeteerVersion,
      puppeteerBrowsers: browserTools.browsersVersion,
      vite: vite.version,
    }
    const bundle = buildArtifactBundle(first, runtime)
    output = {
      bundle,
      report: {
        success: true,
        mode:
          options.dryRun ? 'dry-run' : options.write ? 'write' : 'verify',
        runtime,
        evidence: first.evidence,
        artifacts: artifactReport(bundle),
        review: {
          state: 'awaiting-independent-review',
          verdict: 'NOT-RECORDED',
        },
      },
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

function regressionShapeFindings(summary) {
  const findings = []
  if (
    summary.termination !== 'complete' &&
    summary.termination !== 'limit-reached'
  ) {
    findings.push('invalid-termination')
  }
  if (summary.pathCount === 0) findings.push('zero-paths')
  if (
    summary.medianPathDiagonalFraction < 0.03 ||
    summary.longestPathDiagonalFraction < 0.08 ||
    summary.longGeometryShare < 0.7
  ) {
    findings.push('insufficient-length')
  }
  if (summary.occupiedCoverageBinCount < 8) {
    findings.push('insufficient-coverage')
  }
  if (summary.shortPathShare > 0.15) findings.push('stumpy')
  if (
    summary.turnsOver25DegreesShare > 0.1 ||
    summary.turnsOver45DegreesShare > 0.025 ||
    summary.staircasePairCount > 3 ||
    summary.orthogonalStaircaseSignature > 0.025
  ) {
    findings.push('staircase')
  }
  if (summary.gridFamilyObserved) findings.push('orthogonal-grid-family')
  if (
    summary.gateFindings.some(
      (finding) =>
        finding === 'coverage' ||
        finding.startsWith('region:') ||
        finding.startsWith('topology:'),
    )
  ) {
    findings.push('smooth-but-wrong')
  }
  return findings
}

function expectEvidenceError(callback, fragment) {
  try {
    callback()
  } catch (error) {
    if (String(error.message).includes(fragment)) return
    throw error
  }
  throw new Error(`Expected evidence rejection containing: ${fragment}`)
}

async function expectAsyncError(promise, fragment) {
  try {
    await promise
  } catch (error) {
    if (String(error.message).includes(fragment)) return
    throw error
  }
  throw new Error(`Expected async rejection containing: ${fragment}`)
}

async function artifactSelfTest() {
  const validPng = await readFile(
    join(
      workspaceRoot,
      'assets/image-assets/pinecone-4330aa0314f7.png',
    ),
  )
  validatePng(validPng, { width: 512, height: 768 }, 'self-test PNG')
  expectEvidenceError(
    () => validatePng(validPng, { width: 513, height: 768 }, 'dimension PNG'),
    'IHDR',
  )
  const damagedPng = Buffer.from(validPng)
  damagedPng[0] = 0
  expectEvidenceError(
    () => validatePng(damagedPng, { width: 1, height: 1 }, 'damaged PNG'),
    'signature',
  )
  expectEvidenceError(
    () => validatePng(Buffer.alloc(8), { width: 1, height: 1 }),
    'size',
  )
  const firstCapture = {
    evidence: { witness: true },
    images: Object.fromEntries(
      Object.keys(PNG_SPECS).map((name) => [
        name,
        { bytes: Buffer.from('same') },
      ]),
    ),
  }
  const secondCapture = {
    evidence: { witness: true },
    images: Object.fromEntries(
      Object.keys(PNG_SPECS).map((name) => [
        name,
        { bytes: Buffer.from('same') },
      ]),
    ),
  }
  assertCaptureIdentity(firstCapture, secondCapture)
  secondCapture.images[Object.keys(PNG_SPECS)[0]].bytes =
    Buffer.from('different')
  expectEvidenceError(
    () => assertCaptureIdentity(firstCapture, secondCapture),
    'PNG bytes differed',
  )

  const directory = await mkdtemp(
    join(tmpdir(), 'flowing-contours-artifact-self-test-'),
  )
  try {
    const root = join(directory, 'reference')
    const files = Object.fromEntries(
      ARTIFACT_NAMES.map((name) => [
        name,
        Buffer.from(`original:${name}`),
      ]),
    )
    const bundle = { files }
    await writeArtifactBundle(bundle, root)
    await verifyArtifactBundle(bundle, root)

    const replacements = ARTIFACT_NAMES.map((name) => ({
      target: join(root, name),
      bytes: Buffer.from(`replacement:${name}`),
    }))
    await expectAsyncError(
      transactionallyReplace(replacements, { failAfterInstall: 3 }),
      'injected',
    )
    await verifyArtifactBundle(bundle, root)

    const missingName = ARTIFACT_NAMES[0]
    await unlink(join(root, missingName))
    await expectAsyncError(
      verifyArtifactBundle(bundle, root),
      'missing=',
    )
    await transactionallyReplace([
      { target: join(root, missingName), bytes: files[missingName] },
    ])

    const extraPath = join(root, 'stale-extra.txt')
    await transactionallyReplace([
      { target: extraPath, bytes: Buffer.from('extra') },
    ])
    await expectAsyncError(
      verifyArtifactBundle(bundle, root),
      'extra=',
    )
    await unlink(extraPath)

    const staleName = ARTIFACT_NAMES[1]
    await transactionallyReplace([
      { target: join(root, staleName), bytes: Buffer.from('stale') },
    ])
    await expectAsyncError(
      verifyArtifactBundle(bundle, root),
      'stale or mismatched',
    )
    await transactionallyReplace([
      { target: join(root, staleName), bytes: files[staleName] },
    ])

    const symlinkName = ARTIFACT_NAMES[2]
    await unlink(join(root, symlinkName))
    await symlink(files[symlinkName].toString(), join(root, symlinkName))
    await expectAsyncError(
      verifyArtifactBundle(bundle, root),
      'must not be a symlink',
    )
    await unlink(join(root, symlinkName))
    await transactionallyReplace([
      { target: join(root, symlinkName), bytes: files[symlinkName] },
    ])

    const linkedRoot = join(directory, 'linked-reference')
    await symlink(root, linkedRoot)
    await expectAsyncError(
      verifyArtifactBundle(bundle, linkedRoot),
      'must not be a symlink',
    )
    const remaining = (await readdir(root)).filter(
      (name) => name.includes('.tmp') || name.includes('.rollback'),
    )
    if (remaining.length !== 0) {
      throw new Error('Artifact transaction left temporary recovery files')
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function assertComparisonLayout() {
  const panels = Object.values(COMPARISON_LAYOUT.panels)
  const labelHalfHeight = 11
  for (const panel of panels) {
    const labelCenterY = panel.top - COMPARISON_LAYOUT.labelOffset
    if (
      panel.left < 0 ||
      panel.top < 0 ||
      panel.size < 1 ||
      panel.left + panel.size > COMPARISON_SIZE.width ||
      panel.top + panel.size > COMPARISON_SIZE.height ||
      labelCenterY - labelHalfHeight < 0 ||
      labelCenterY + labelHalfHeight >= panel.top
    ) {
      throw new Error('Comparison panel or identity-space label is out of bounds')
    }
  }
  for (let first = 0; first < panels.length; first += 1) {
    for (let second = first + 1; second < panels.length; second += 1) {
      const a = panels[first]
      const b = panels[second]
      if (
        a.left < b.left + b.size &&
        a.left + a.size > b.left &&
        a.top < b.top + b.size &&
        a.top + a.size > b.top
      ) {
        throw new Error('Comparison panels overlap')
      }
    }
  }
  if (
    COMPARISON_LAYOUT.footerCenterY + labelHalfHeight >=
    COMPARISON_SIZE.height
  ) {
    throw new Error('Comparison footer label is out of bounds')
  }
}

async function selfTest() {
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
  const moduleSource = captureModuleSource()
  assertComparisonLayout()
  if (
    !moduleSource.includes(
      "const drawPanelLabel = (context, label, centerX, centerY, color) =>",
    ) ||
    !moduleSource.includes(
      "context.setTransform(1, 0, 0, 1, 0, 0)",
    )
  ) {
    throw new Error('Panel labels are not pinned to identity-space rendering')
  }
  for (const required of [
    'generateFlowingContours',
    'generatePencilContour',
    'generateWatercolorForms',
    'prepareFlowingContoursRaster',
    'buildFlowingContoursField',
    'runFlowingContoursPipeline',
    'measureFlowingContoursReference',
    'flowingContoursReferenceGateFindings',
    'comparisonPng',
    'syntheticWitnessPng',
  ]) {
    if (!moduleSource.includes(required)) {
      throw new Error(`nonvisual capture import is missing: ${required}`)
    }
  }
  for (const forbidden of [
    'renderToSVG',
    'drawScene',
    "from '/@fs${workspaceRoot}/packages/core/src/renderer",
    "from '/src/App",
    "from '/src/registry",
  ]) {
    if (moduleSource.includes(forbidden)) {
      throw new Error(`nonvisual capture imported output path: ${forbidden}`)
    }
  }
  const base = {
    termination: 'complete',
    pathCount: 12,
    shortPathShare: 0,
    medianPathDiagonalFraction: 0.08,
    longestPathDiagonalFraction: 0.3,
    longGeometryShare: 0.9,
    turnsOver25DegreesShare: 0,
    turnsOver45DegreesShare: 0,
    staircasePairCount: 0,
    orthogonalStaircaseSignature: 0,
    occupiedCoverageBinCount: 12,
    gridFamilyObserved: false,
    gateFindings: [],
  }
  const negatives = {
    invalid: regressionShapeFindings({
      ...base,
      termination: 'invalid-input',
    }),
    zero: regressionShapeFindings({
      ...base,
      pathCount: 0,
    }),
    short: regressionShapeFindings({
      ...base,
      medianPathDiagonalFraction: 0.01,
      longestPathDiagonalFraction: 0.03,
      longGeometryShare: 0.2,
    }),
    sparse: regressionShapeFindings({
      ...base,
      occupiedCoverageBinCount: 2,
    }),
    stump: regressionShapeFindings({
      ...base,
      shortPathShare: 0.8,
    }),
    stair: regressionShapeFindings({
      ...base,
      turnsOver25DegreesShare: 0.4,
      turnsOver45DegreesShare: 0.3,
      staircasePairCount: 45,
      orthogonalStaircaseSignature: 0.75,
    }),
    smoothWrong: regressionShapeFindings({
      ...base,
      gateFindings: ['coverage', 'region:subject'],
    }),
    grid: regressionShapeFindings({
      ...base,
      gridFamilyObserved: true,
    }),
  }
  const witness = regressionShapeFindings(base)
  if (
    !negatives.invalid.includes('invalid-termination') ||
    !negatives.zero.includes('zero-paths') ||
    !negatives.short.includes('insufficient-length') ||
    !negatives.sparse.includes('insufficient-coverage') ||
    !negatives.stump.includes('stumpy') ||
    !negatives.stair.includes('staircase') ||
    !negatives.smoothWrong.includes('smooth-but-wrong') ||
    !negatives.grid.includes('orthogonal-grid-family') ||
    witness.length !== 0
  ) {
    throw new Error('live regression-shape guards failed')
  }
  const canonicalWitness = canonicalSceneSnapshot({
    space: { width: 10, height: 10 },
    primitives: [
      {
        points: [
          [1, 1],
          [9, 9],
        ],
        closed: false,
        stroke: { color: 'black', width: 1 },
      },
    ],
  })
  safeEvidenceJson(
    { canonicalWitness, verdict: 'pass', findings: witness },
    'self-test witness',
  )
  expectEvidenceError(
    () => safeEvidenceJson({ value: Number.NaN }),
    'not finite',
  )
  expectEvidenceError(
    () => safeEvidenceJson({ value: Number.POSITIVE_INFINITY }),
    'not finite',
  )
  expectEvidenceError(
    () => safeEvidenceJson({ value: undefined }),
    'unsupported undefined',
  )
  expectEvidenceError(
    () => safeEvidenceJson({ values: Array(1) }),
    'sparse',
  )
  const accessor = {}
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get: () => 1,
  })
  expectEvidenceError(
    () => safeEvidenceJson(accessor),
    'enumerable data',
  )
  const cycle = {}
  cycle.self = cycle
  expectEvidenceError(
    () => safeEvidenceJson(cycle),
    'cyclic inventory',
  )
  expectEvidenceError(
    () =>
      assertSerializableEvidence(
        [1, 2],
        'bounded array',
        { ...EVIDENCE_SERIALIZATION_LIMITS, maxArrayLength: 1 },
      ),
    'inventory exceeds bound',
  )
  expectEvidenceError(
    () =>
      canonicalSceneSnapshot(
        {
          space: { width: 10, height: 10 },
          primitives: [
            {
              points: [[Number.NaN, 1], [2, 2]],
              closed: false,
            },
          ],
        },
      ),
    'point 0 is invalid',
  )
  expectEvidenceError(
    () =>
      canonicalSceneSnapshot(
        {
          space: { width: 10, height: 10 },
          primitives: [
            {
              points: [[1, 1], [2, 2]],
              closed: false,
            },
          ],
        },
        0,
      ),
    'path inventory',
  )
  assertInertRequests(
    new Set([
      HARNESS_PATH,
      HARNESS_MODULE_PATH,
      ...Object.keys(SOURCE_ASSETS),
    ]),
  )
  await artifactSelfTest()
  return { success: true, mode: 'self-test' }
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
  const captured = await runCapture(options)
  if (options.write) await writeArtifactBundle(captured.bundle)
  if (options.verify) await verifyArtifactBundle(captured.bundle)
  console.log(
    safeEvidenceJson(captured.report, 'capture command result'),
  )
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
