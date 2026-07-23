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
  '/__flowing-contours-evidence__/capture.mjs'
const BROWSER_CRYPTO_STUB_ID = '\0flowing-contours-browser-node-crypto'
const SOURCE_ASSETS = Object.freeze({
  '/image-assets/img-0672-79d639daec62.png':
    'assets/image-assets/img-0672-79d639daec62.png',
  '/image-assets/pinecone-4330aa0314f7.png':
    'assets/image-assets/pinecone-4330aa0314f7.png',
})
const studioRoot = fileURLToPath(new URL('..', import.meta.url))
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

const HELP = `Usage:
  node apps/studio/scripts/capture-flowing-contours-reference.mjs --dry-run
  node apps/studio/scripts/capture-flowing-contours-reference.mjs --write
  node apps/studio/scripts/capture-flowing-contours-reference.mjs --verify
  node apps/studio/scripts/capture-flowing-contours-reference.mjs --self-test

Options:
  --dry-run   Compute deterministic nonvisual production evidence.
  --write     Reserved for FC24b's PNG/manifest write phase.
  --verify    Reserved for FC24b's PNG/manifest verification phase.
  --port N    Vite port (default ${DEFAULT_PORT}).
  --self-test Exercise parser, import-boundary, and regression-shape guards.
  --help      Print this help.

Phase 2 runs the real Pencil, Watercolor, and Flowing pipelines and computes
geometry, provenance, diagnostics, and quality gates in-browser. It has no
compositor, renderer, PNG, manifest, or artifact writes; --write and --verify
remain fail closed until Phase 3.`

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
  return evidence
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
  const flowing = mapFlowingStages(
    syntheticDiagonalCurve(),
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
  return evidence
}
globalThis.__captureFlowingContoursEvidence = async () => {
  const payload = {
    schemaVersion: 1,
    kind: 'flowing-contours-nonvisual-reference-evidence',
    phase: 'FC24b-phase-2',
    cases: {
      flower: await captureReferenceCase(
        'flower',
        FLOWING_CONTOURS_REFERENCE_CASES.flower,
      ),
      pinecone: await captureReferenceCase(
        'pinecone',
        FLOWING_CONTOURS_REFERENCE_CASES.pinecone,
      ),
    },
    synthetic: await captureSynthetic(),
  }
  assertSerializableEvidence(payload, 'complete evidence payload')
  safeEvidenceJson(payload, 'complete evidence payload')
  return payload
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
    page.setDefaultTimeout(180_000)
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
    const first = await captureInFreshContext(browser, url)
    const second = await captureInFreshContext(browser, url)
    const firstJson = safeEvidenceJson(first, 'first browser evidence')
    const secondJson = safeEvidenceJson(second, 'second browser evidence')
    if (firstJson !== secondJson) {
      throw new Error('Independent nonvisual evidence captures differed')
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
      evidence: first,
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
  const moduleSource = captureModuleSource()
  for (const required of [
    'generateFlowingContours',
    'generatePencilContour',
    'generateWatercolorForms',
    'prepareFlowingContoursRaster',
    'buildFlowingContoursField',
    'runFlowingContoursPipeline',
    'measureFlowingContoursReference',
    'flowingContoursReferenceGateFindings',
  ]) {
    if (!moduleSource.includes(required)) {
      throw new Error(`nonvisual capture import is missing: ${required}`)
    }
  }
  for (const forbidden of [
    'renderToSVG',
    'drawScene',
    'CanvasRenderingContext',
    'toDataURL',
    'image/png',
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
  const result = await runDryRun(options)
  console.log(safeEvidenceJson(result, 'capture command result'))
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
