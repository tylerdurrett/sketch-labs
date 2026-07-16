import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus, hostname, platform, release, totalmem } from 'node:os'

import { clipSceneToBounds } from '../../src/clipToBounds.ts'
import {
  DEFAULT_STROKE,
  analyzeHiddenLinePlan,
  hiddenLinePass,
} from '../../src/hiddenLine.ts'
import { computePlotMapping } from '../../src/plotMapping.ts'
import { plotDrawableRectangle } from '../../src/plotProfile.ts'
import { renderPlotterSVG } from '../../src/plotterSvg.ts'
import { applyPreset, deserialize } from '../../src/preset.ts'
import { renderToSVG } from '../../src/renderer.ts'
import { resolveCompositionFrame } from '../../src/compositionFrame.ts'
import { grassHills } from '../../src/sketches/grass-hills/index.ts'
import {
  GRASS_HILLS_TOOL_WIDTH_MILLIMETERS,
  grassHillsOutlineSource,
} from '../../src/sketches/grass-hills/outline.ts'
import denseGrassPreset from '../../src/sketches/grass-hills/presets/dense-grass.json'
import { pairedReviewPng, renderSceneReviewPng } from './review-png.js'

export const PRODUCTION_REFERENCE_ID = 'grass-hills-faithful-visible-line'
export const PRODUCTION_PRESET_NAME = 'dense-grass'
export const PRODUCTION_OUTLINE_TOLERANCE = 0
export const ADOPTED_BLADE_DENSITY = 2
export const CEILING_BLADE_DENSITY = 10
export const REVIEW_RASTER_SIZE = 900
export const PRODUCTION_REVIEW_ATTESTATION_FILE = 'review-attestation.json'
export const PRODUCTION_STUDIO_WORKER_OBSERVATIONS_FILE =
  'studio-worker-observations.json'

const PRODUCTION_STUDIO_WORKER_OBSERVATIONS_SHA256 =
  '529a84dc1067097b8db51449c5ec93c454dedb0721821ec884981af772b0970f'
const STUDIO_WORKER_REPRODUCTION_COMMAND =
  'node packages/core/benchmarks/grass-hills-density/studio-worker-browser-cli.js --out=packages/core/src/sketches/grass-hills/reference/studio-worker-observations.json'

const REPRODUCTION_COMMANDS = Object.freeze([
  'node packages/core/benchmarks/grass-hills-density/bundle-cli.js --entry=packages/core/benchmarks/grass-hills-density/production-reference-cli.js --out=/tmp/issue-309-production-reference-cli.mjs',
  'node --expose-gc /tmp/issue-309-production-reference-cli.mjs --out=packages/core/src/sketches/grass-hills/reference',
  'node --expose-gc /tmp/issue-309-production-reference-cli.mjs --out=/tmp/issue-309-reference --full-50k-out=/tmp/issue-309-reference/full-50k',
])

/**
 * Exercise the worker-equivalent production pipeline at adopted and ceiling
 * density. Fill is sampled once; the exact sampled value is then role-annotated
 * for indexed Hidden-line processing. No alternate topology or root selection
 * is available to this harness.
 */
export function generateProductionReference({
  retainCeilingArtifacts = false,
} = {}) {
  const adopted = generateScenario({
    id: 'adopted-10k',
    bladeDensity: ADOPTED_BLADE_DENSITY,
    retainArtifacts: true,
  })
  const ceiling = generateScenario({
    id: 'supported-ceiling-50k',
    bladeDensity: CEILING_BLADE_DENSITY,
    retainArtifacts: retainCeilingArtifacts,
  })
  return { adopted, ceiling }
}

function generateScenario({ id, bladeDensity, retainArtifacts }) {
  globalThis.gc?.()
  const observations = []
  const started = performance.now()
  observeMemory(observations, 'start')

  const preset = deserialize(denseGrassPreset)
  const reconciled = applyPreset(grassHills.schema, {
    ...preset,
    params: { ...preset.params, bladeDensity },
  })
  if (reconciled.profile === undefined) {
    throw new Error('dense-grass production preset must carry a Plot Profile')
  }
  const profile = reconciled.profile
  const drawable = plotDrawableRectangle(profile)
  const frame = resolveCompositionFrame(drawable.width / drawable.height)
  const mapping = computePlotMapping(frame, profile)
  const target = {
    toolWidthMillimeters: GRASS_HILLS_TOOL_WIDTH_MILLIMETERS,
    millimetersPerSceneUnit: mapping.scale,
  }

  const preparation = timed(() => {
    if (grassHills.prepare === undefined) {
      throw new Error(
        'Grass Hills must retain its production prepared-frame seam',
      )
    }
    return grassHills.prepare(reconciled.params, reconciled.seed, frame)
  })
  observeMemory(observations, 'prepared')
  const fillGeneration = timed(() => preparation.value(0))
  const fillScene = fillGeneration.value
  observeMemory(observations, 'fill-generated')

  const sourceDerivation = timed(() =>
    grassHillsOutlineSource(fillScene, target),
  )
  const outlineSource = sourceDerivation.value
  const fidelity = assertFaithfulSource(fillScene, outlineSource, bladeDensity)
  observeMemory(observations, 'outline-source-derived')

  const planning = timed(() => analyzeHiddenLinePlan(outlineSource))
  observeMemory(observations, 'plan-analyzed')
  let progressEvents = 0
  const processing = timed(() =>
    hiddenLinePass(outlineSource, {
      tolerance: PRODUCTION_OUTLINE_TOLERANCE,
      observer(progress) {
        progressEvents++
        if ((progressEvents & 511) === 0 || progress.terminal) {
          observeMemory(observations, `hidden-line-${progressEvents}`)
        }
      },
    }),
  )
  observeMemory(observations, 'hidden-line-complete')

  const fillClip = timed(() => clipSceneToBounds(fillScene))
  const framedOutline = withCompositionFrame(
    processing.value,
    profile.includeFrame,
  )
  const outlineClip = timed(() => clipSceneToBounds(framedOutline))
  const clippedFillScene = fillClip.value
  const outlineScene = outlineClip.value
  observeMemory(observations, 'bounds-clipped')

  const fillSerialization = timed(() => renderToSVG(clippedFillScene))
  const outlineSerialization = timed(() =>
    renderToSVG(outlineScene, undefined, 'transparent'),
  )
  const plotSerialization = timed(() => renderPlotterSVG(outlineScene, profile))
  observeMemory(observations, 'vector-artifacts-serialized')

  const fillReview = timed(() =>
    renderSceneReviewPng(clippedFillScene, {
      width: REVIEW_RASTER_SIZE,
      height: REVIEW_RASTER_SIZE,
    }),
  )
  const outlineReview = timed(() =>
    renderSceneReviewPng(outlineScene, {
      width: REVIEW_RASTER_SIZE,
      height: REVIEW_RASTER_SIZE,
    }),
  )
  const contactSheet = timed(() =>
    pairedReviewPng(fillReview.value, outlineReview.value),
  )
  observeMemory(observations, 'review-images-rendered')

  const artifacts = {
    fillSvg: artifact('fill.svg', fillSerialization.value, clippedFillScene),
    outlineSvg: artifact(
      'outline.svg',
      outlineSerialization.value,
      outlineScene,
    ),
    physicalPlotSvg: {
      ...artifact('physical-plot.svg', plotSerialization.value, outlineScene),
      derivedFrom: 'outlineScene.sha256',
    },
    fillReviewPng: binaryArtifact(`${id}-fill.png`, fillReview.value),
    outlineReviewPng: binaryArtifact(`${id}-outline.png`, outlineReview.value),
    contactSheetPng: binaryArtifact(
      `${id}-fill-outline-contact-sheet.png`,
      contactSheet.value,
    ),
  }
  const completedAt = performance.now()
  const finalResourcePeakRssBytes = process.resourceUsage().maxRSS * 1024

  return {
    deterministic: {
      id,
      preset: {
        ...preset,
        params: { ...preset.params, bladeDensity },
      },
      time: 0,
      frame,
      profile,
      mapping,
      target,
      outlineTolerance: PRODUCTION_OUTLINE_TOLERANCE,
      fidelity,
      fillScene: sceneInventory(fillScene),
      outlineSource: sceneInventory(outlineSource),
      hiddenLinePlan: planning.value,
      outlineScene: sceneInventory(outlineScene),
      artifacts,
    },
    observations: {
      id,
      contract:
        'single local run; durations and memory are observations, never pass/fail limits or SLAs',
      durationsMs: {
        preparation: preparation.durationMs,
        fillGeneration: fillGeneration.durationMs,
        fillDerivedOutlineSource: sourceDerivation.durationMs,
        standalonePlanAnalysis: planning.durationMs,
        indexedHiddenLineIncludingItsOwnPlan: processing.durationMs,
        fillBoundsClip: fillClip.durationMs,
        outlineBoundsClip: outlineClip.durationMs,
        fillSvgSerialization: fillSerialization.durationMs,
        outlineSvgSerialization: outlineSerialization.durationMs,
        physicalPlotSerialization: plotSerialization.durationMs,
        fillReviewRaster: fillReview.durationMs,
        outlineReviewRaster: outlineReview.durationMs,
        contactSheetAssembly: contactSheet.durationMs,
        total: completedAt - started,
      },
      memory: {
        sampling:
          'process.memoryUsage at stage boundaries and every 512 Hidden-line progress events',
        peakObservedRssBytes: Math.max(
          ...observations.map(({ rssBytes }) => rssBytes),
        ),
        peakObservedHeapUsedBytes: Math.max(
          ...observations.map(({ heapUsedBytes }) => heapUsedBytes),
        ),
        processLifetimeMaxRssBytes: finalResourcePeakRssBytes,
        samples: observations,
      },
      progressEvents,
    },
    reviewImages: {
      fill: fillReview.value,
      outline: outlineReview.value,
      contactSheet: contactSheet.value,
    },
    ...(retainArtifacts
      ? {
          fullArtifacts: {
            fillSvg: fillSerialization.value,
            outlineSvg: outlineSerialization.value,
            physicalPlotSvg: plotSerialization.value,
            fillScene: JSON.stringify(clippedFillScene),
            outlineScene: JSON.stringify(outlineScene),
          },
        }
      : {}),
  }
}

/** Deterministic manifest; machine-specific measurements live beside it. */
export function productionReferenceManifest(
  generated = generateProductionReference(),
) {
  return {
    schemaVersion: 4,
    referenceId: PRODUCTION_REFERENCE_ID,
    status: 'generated-evidence-with-separate-review-attestation',
    pipeline: [
      'production prepared Fill sample',
      'exact Fill-derived role annotation',
      'production indexed Hidden-line pass at tolerance 0',
      'Composition Frame policy',
      'bounds clipping',
      'ordinary/physical serialization or bounded review rasterization',
    ],
    qualityFallbackPolicy: {
      allowed: false,
      enforcedBy:
        'source/fill geometry identity, exact blade inventory, both-role inventory, tolerance 0, and runtime assertions',
    },
    scenarios: {
      adopted10k: scenarioManifest(generated.adopted, {
        committedVectorPair: true,
        reviewArtifacts: ['fill.svg', 'outline.svg', 'physical-plot.svg'],
      }),
      supportedCeiling50k: scenarioManifest(generated.ceiling, {
        committedVectorPair: false,
        reviewArtifacts: [
          'supported-ceiling-50k-fill.png',
          'supported-ceiling-50k-outline.png',
          'supported-ceiling-50k-fill-outline-contact-sheet.png',
        ],
        boundedReviewRationale:
          'Lossless 900x900 PNG projections and a paired contact sheet are committed; exact full vector/Scene hashes are pinned here and the reproduction command writes those large duplicate values outside git.',
      }),
    },
    review: {
      status: 'RECORDED-SEPARATELY',
      attestationFile: PRODUCTION_REVIEW_ATTESTATION_FILE,
      provenance:
        'Generated evidence never writes reviewer identity or verdict; the separately maintained attestation records the independent comparative review.',
    },
    browserWorkerEvidence: {
      status: 'RECORDED-SEPARATELY',
      observationsFile: PRODUCTION_STUDIO_WORKER_OBSERVATIONS_FILE,
      sha256: PRODUCTION_STUDIO_WORKER_OBSERVATIONS_SHA256,
      contract:
        'real Studio coordinator and DedicatedWorker module path, postMessage structured clone, validated responses, session cache, terminal progress, and cached physical export reuse at adopted 10k and supported 50k',
      reproductionCommand: STUDIO_WORKER_REPRODUCTION_COMMAND,
      provenance:
        'Browser observations are captured independently from Node artifact generation; regeneration does not synthesize or overwrite them.',
    },
    reproduction: {
      workingDirectory: 'repository root',
      commands: [...REPRODUCTION_COMMANDS],
    },
  }
}

function scenarioManifest(scenario, review) {
  return {
    ...scenario.deterministic,
    review: {
      ...review,
      status: 'RECORDED-SEPARATELY',
      attestationFile: PRODUCTION_REVIEW_ATTESTATION_FILE,
      provenance:
        'Generated artifacts and hashes are review inputs; reviewer identity and verdict live only in the separate attestation.',
    },
  }
}

export function productionReferenceObservations(generated) {
  const processors = cpus()
  return {
    schemaVersion: 1,
    referenceId: PRODUCTION_REFERENCE_ID,
    capturedAt: new Date().toISOString(),
    warning: 'Observations from one machine/run; not SLAs and not test limits.',
    machine: {
      hostname: hostname(),
      os: { platform: platform(), release: release() },
      runtime: { node: process.version, v8: process.versions.v8 },
      architecture: process.arch,
      cpu: {
        model: processors[0]?.model ?? 'unknown',
        logicalCount: processors.length,
      },
      totalMemoryBytes: totalmem(),
    },
    scenarios: {
      adopted10k: generated.adopted.observations,
      supportedCeiling50k: generated.ceiling.observations,
    },
    browserWorkerEvidence: {
      status: 'RECORDED-SEPARATELY',
      observationsFile: PRODUCTION_STUDIO_WORKER_OBSERVATIONS_FILE,
      sha256: PRODUCTION_STUDIO_WORKER_OBSERVATIONS_SHA256,
      warning:
        'Browser timings and memory are one-machine observations, not SLAs or test limits.',
    },
  }
}

export function writeProductionReference(out, { fullCeilingOut } = {}) {
  const generated = generateProductionReference({
    retainCeilingArtifacts: fullCeilingOut !== undefined,
  })
  const manifest = productionReferenceManifest(generated)
  const observations = productionReferenceObservations(generated)
  mkdirSync(out, { recursive: true })
  writeFileSync(`${out}/fill.svg`, generated.adopted.fullArtifacts.fillSvg)
  writeFileSync(
    `${out}/outline.svg`,
    generated.adopted.fullArtifacts.outlineSvg,
  )
  writeFileSync(
    `${out}/physical-plot.svg`,
    generated.adopted.fullArtifacts.physicalPlotSvg,
  )
  writeScenarioReviewImages(out, generated.adopted)
  writeScenarioReviewImages(out, generated.ceiling)
  writeFileSync(
    `${out}/manifest.json`,
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  writeFileSync(
    `${out}/observations.json`,
    `${JSON.stringify(observations, null, 2)}\n`,
  )
  if (fullCeilingOut !== undefined) {
    writeFullScenario(fullCeilingOut, generated.ceiling)
  }
  return { manifest, observations }
}

function writeScenarioReviewImages(out, scenario) {
  mkdirSync(out, { recursive: true })
  writeFileSync(
    `${out}/${scenario.deterministic.artifacts.fillReviewPng.file}`,
    scenario.reviewImages.fill,
  )
  writeFileSync(
    `${out}/${scenario.deterministic.artifacts.outlineReviewPng.file}`,
    scenario.reviewImages.outline,
  )
  writeFileSync(
    `${out}/${scenario.deterministic.artifacts.contactSheetPng.file}`,
    scenario.reviewImages.contactSheet,
  )
}

function writeFullScenario(out, scenario) {
  if (scenario.fullArtifacts === undefined) {
    throw new Error('full ceiling artifacts were not retained')
  }
  mkdirSync(out, { recursive: true })
  writeFileSync(`${out}/fill.svg`, scenario.fullArtifacts.fillSvg)
  writeFileSync(`${out}/outline.svg`, scenario.fullArtifacts.outlineSvg)
  writeFileSync(
    `${out}/physical-plot.svg`,
    scenario.fullArtifacts.physicalPlotSvg,
  )
  writeFileSync(`${out}/fill.scene.json`, scenario.fullArtifacts.fillScene)
  writeFileSync(
    `${out}/outline.scene.json`,
    scenario.fullArtifacts.outlineScene,
  )
  writeScenarioReviewImages(out, scenario)
}

function assertFaithfulSource(fill, source, bladeDensity) {
  const expectedBladeCount = Math.round(bladeDensity * 5_000)
  const bladeCount = fill.primitives.filter(
    ({ points }) => points.length === 7,
  ).length
  if (bladeCount !== expectedBladeCount) {
    throw new Error(
      `expected ${expectedBladeCount} Fill blades, received ${bladeCount}`,
    )
  }
  if (source.primitives.length !== fill.primitives.length) {
    throw new Error(
      'Outline source silently changed the Fill primitive inventory',
    )
  }
  let rejectedPrimitiveCount = 0
  let bothRoleCount = 0
  for (let index = 0; index < fill.primitives.length; index++) {
    const fillPrimitive = fill.primitives[index]
    const sourcePrimitive = source.primitives[index]
    if (
      JSON.stringify(fillPrimitive.points) !==
        JSON.stringify(sourcePrimitive.points) ||
      fillPrimitive.closed !== sourcePrimitive.closed
    ) {
      rejectedPrimitiveCount++
    }
    if (sourcePrimitive.hiddenLineRole === 'both') bothRoleCount++
    if (sourcePrimitive.fill === undefined) {
      throw new Error(`Outline source primitive ${index} cannot occlude`)
    }
  }
  if (
    rejectedPrimitiveCount !== 0 ||
    bothRoleCount !== fill.primitives.length
  ) {
    throw new Error(
      'Outline source is not an exact both-role derivation of Fill',
    )
  }
  const fillGeometrySha256 = geometryChecksum(fill)
  const sourceGeometrySha256 = geometryChecksum(source)
  if (fillGeometrySha256 !== sourceGeometrySha256) {
    throw new Error('Outline source geometry hash differs from Fill')
  }
  return {
    expectedBladeCount,
    fillBladeCount: bladeCount,
    outlineSourceBladeCount: source.primitives.filter(
      ({ points }) => points.length === 7,
    ).length,
    fillPrimitiveCount: fill.primitives.length,
    outlineSourcePrimitiveCount: source.primitives.length,
    bothRoleCount,
    rejectedPrimitiveCount,
    sixPointCenterlineCount: source.primitives.filter(
      ({ points }) => points.length === 6,
    ).length,
    fillGeometrySha256,
    sourceGeometrySha256,
    exactGeometryIdentity: true,
    physicalToolRootRejection: false,
    representationFallbackDetected: false,
  }
}

function withCompositionFrame(scene, includeFrame) {
  if (!includeFrame) return scene
  const { width, height } = scene.space
  return {
    ...scene,
    primitives: [
      ...scene.primitives,
      {
        points: [
          [0, 0],
          [width, 0],
          [width, height],
          [0, height],
          [0, 0],
        ],
        stroke: { ...DEFAULT_STROKE },
      },
    ],
  }
}

function timed(operation) {
  const started = performance.now()
  const value = operation()
  return { value, durationMs: performance.now() - started }
}

function observeMemory(observations, stage) {
  const memory = process.memoryUsage()
  observations.push({
    stage,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  })
}

function checksum(value) {
  return createHash('sha256').update(value).digest('hex')
}

function geometryChecksum(scene) {
  return checksum(
    JSON.stringify({
      space: scene.space,
      primitives: scene.primitives.map(({ points, closed }) => ({
        points,
        closed,
      })),
    }),
  )
}

function sceneInventory(scene) {
  const serialized = JSON.stringify(scene)
  return {
    primitiveCount: scene.primitives.length,
    pointCount: scene.primitives.reduce(
      (total, primitive) => total + primitive.points.length,
      0,
    ),
    sha256: checksum(serialized),
    geometrySha256: geometryChecksum(scene),
    bytes: Buffer.byteLength(serialized),
  }
}

function artifact(file, value, scene) {
  return {
    file,
    sha256: checksum(value),
    bytes: Buffer.byteLength(value),
    scene: sceneInventory(scene),
  }
}

function binaryArtifact(file, value) {
  return { file, sha256: checksum(value), bytes: value.byteLength }
}
