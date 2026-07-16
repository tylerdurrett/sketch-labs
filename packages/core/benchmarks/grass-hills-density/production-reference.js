import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'

import { clipSceneToBounds } from '../../src/clipToBounds.ts'
import {
  DEFAULT_STROKE,
  analyzeHiddenLineWorkload,
  hiddenLinePass,
} from '../../src/hiddenLine.ts'
import { computePlotMapping } from '../../src/plotMapping.ts'
import { plotDrawableRectangle } from '../../src/plotProfile.ts'
import { renderPlotterSVG } from '../../src/plotterSvg.ts'
import { applyPreset, deserialize } from '../../src/preset.ts'
import { renderToSVG } from '../../src/renderer.ts'
import { resolveCompositionFrame } from '../../src/compositionFrame.ts'
import { grassHills } from '../../src/sketches/grass-hills/index.ts'
import { layoutHillBands } from '../../src/sketches/grass-hills/depth.ts'
import { allocateGrassRootCounts } from '../../src/sketches/grass-hills/grass-selection.ts'
import { GRASS_HILLS_TOOL_WIDTH_MILLIMETERS } from '../../src/sketches/grass-hills/outline.ts'
import denseGrassPreset from '../../src/sketches/grass-hills/presets/dense-grass.json'

export const PRODUCTION_REFERENCE_ID =
  'grass-hills-production-inverse-square-10k'
export const PRODUCTION_PRESET_NAME = 'dense-grass'
export const PRODUCTION_OUTLINE_TOLERANCE = 0

const APPROVED_ARTIFACT_HASHES = Object.freeze({
  fill: '385b37a4f07ba842dcd10600df42164f1dd254726c5fd0d551ccd93cc106eb28',
  outline:
    '720ed77598cc0feac36f3794bc85651a1b83f989b1ab68a501d9cfa72f2f4b36',
  physicalPlot:
    'ff7ae34fbec456a09c95127b8df3943927d77e0a71962756149cbe4eb18687d8',
})

/**
 * Reproduce the production Fill → specialized Outline → physical plot pipeline.
 *
 * The generator intentionally starts at the committed Preset and calls the
 * shipped Grass Hills implementation. It mirrors Studio's worker boundary:
 * generateOutlineSource → hiddenLinePass(tolerance 0) → optional Composition
 * Frame → clipSceneToBounds, then hands that exact clipped Scene to both the
 * ordinary Outline serializer and renderPlotterSVG.
 */
export function generateProductionReference() {
  const preset = deserialize(denseGrassPreset)
  const reconciled = applyPreset(grassHills.schema, preset)
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

  const fillScene = grassHills.generate(
    reconciled.params,
    reconciled.seed,
    0,
    frame,
  )
  const clippedFillScene = clipSceneToBounds(fillScene)
  const outlineSource = grassHills.generateOutlineSource(
    reconciled.params,
    reconciled.seed,
    0,
    frame,
    target,
  )
  const processingStarted = performance.now()
  const processedOutline = withCompositionFrame(
    hiddenLinePass(outlineSource, {
      tolerance: PRODUCTION_OUTLINE_TOLERANCE,
    }),
    profile.includeFrame,
  )
  const processingDurationMs = performance.now() - processingStarted
  const outlineScene = clipSceneToBounds(processedOutline)

  const fillSvg = renderToSVG(clippedFillScene)
  const outlineSvg = renderToSVG(outlineScene, undefined, 'transparent')
  const physicalPlotSvg = renderPlotterSVG(outlineScene, profile)
  const allocation = allocateGrassRootCounts(
    layoutHillBands(reconciled.params.hillCount, {
      frame,
      horizonHeight: reconciled.params.horizonHeight,
      depthFalloff: reconciled.params.depthFalloff,
    }).map(({ depth }) => depth),
    reconciled.params.bladeDensity,
  )
  const sourceSpines = outlineSource.primitives.filter(
    ({ hiddenLineRole, points }) =>
      hiddenLineRole === 'source' && points.length === 6,
  )

  return {
    preset,
    frame,
    profile,
    mapping,
    target,
    fillScene,
    clippedFillScene,
    outlineSource,
    outlineScene,
    fillSvg,
    outlineSvg,
    physicalPlotSvg,
    evidence: {
      allocation,
      fillBladeCount: fillScene.primitives.filter(
        ({ closed }) => closed === true,
      ).length,
      fillInventory: sceneInventory(fillScene),
      clippedFillInventory: sceneInventory(clippedFillScene),
      outlineSourceInventory: sceneInventory(outlineSource),
      outlineSelectedBladeCount: sourceSpines.length,
      outlineSourceRidgeCount: outlineSource.primitives.filter(
        ({ hiddenLineRole, points }) =>
          hiddenLineRole === 'source' && points.length !== 6,
      ).length,
      outlineOccluderCount: outlineSource.primitives.filter(
        ({ hiddenLineRole }) => hiddenLineRole === 'occluder',
      ).length,
      outlineInventory: sceneInventory(outlineScene),
      workload: analyzeHiddenLineWorkload(outlineSource),
      processingDurationMs,
    },
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

function checksum(value) {
  return createHash('sha256').update(value).digest('hex')
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

/** Build every deterministic manifest field from one regenerated production value. */
export function productionReferenceManifest(
  generated = generateProductionReference(),
) {
  assertApprovedArtifacts(generated)
  const {
    processingDurationMs: _processingDurationMs,
    ...deterministicEvidence
  } = generated.evidence
  return {
    schemaVersion: 2,
    referenceId: PRODUCTION_REFERENCE_ID,
    status: 'production-acceptance',
    preset: generated.preset,
    time: 0,
    frame: generated.frame,
    profile: generated.profile,
    tool: {
      widthMillimeters: generated.target.toolWidthMillimeters,
      millimetersPerSceneUnit: generated.target.millimetersPerSceneUnit,
    },
    mapping: generated.mapping,
    outline: {
      tolerance: PRODUCTION_OUTLINE_TOLERANCE,
      includeFrame: generated.profile.includeFrame,
      geometryReuse:
        'Outline SVG and physical plot serialize the exact clipped processed Scene pinned below',
      physicalWidthsMillimeters: {
        grassAndRidges: generated.target.toolWidthMillimeters,
        compositionFrame: DEFAULT_STROKE.width * generated.mapping.scale,
      },
    },
    contract: {
      allocation:
        '10,000 blades distributed inverse-square by hill depth; integer remainder resolved deterministically',
      roots:
        '100x100 seeded stratified stable-cell bank per reduced hill identity; nested priority prefix',
      variation:
        'four root-keyed scalar rolls in length, width, stiffness, lean order',
      fill: 'seven-point closed silhouettes from production descriptors',
      outline:
        'six-point shared spines; nearer-hill masks; deterministic physical-tool LOD',
    },
    evidence: deterministicEvidence,
    artifacts: {
      fill: artifact('fill.svg', generated.fillSvg, generated.clippedFillScene),
      outline: artifact(
        'outline.svg',
        generated.outlineSvg,
        generated.outlineScene,
      ),
      physicalPlot: {
        ...artifact(
          'physical-plot.svg',
          generated.physicalPlotSvg,
          generated.outlineScene,
        ),
        derivedFrom: 'artifacts.outline.scene.sha256',
      },
    },
    approval: {
      verdict: 'PASS',
      reviewer: '/root/impl_p4/p4_visual_review',
      reviewedAt: '2026-07-15',
      rubric: {
        fillGrassReading: 'PASS',
        depthAndTerrainBands: 'PASS',
        outlineFidelity: 'PASS',
        physicalPlotLegibility: 'PASS',
      },
      temporaryCaptures: [
        {
          file: '2026-07-15_192900_grass-hills-production-fill.png',
          sha256:
            '889fabbef603c88129b20a2045508c95fbe339f00730ee76ea4e289e1c8f3dbc',
          source: 'actual Studio LiveCanvas at 958x958',
        },
        {
          file: '2026-07-15_192901_grass-hills-production-outline.png',
          sha256:
            '622ecaa875e8c7066623cd2698af5b025c1fc853146de359bc2a4eac6ea2be27',
          source: 'actual Studio LiveCanvas after Fill to Outline',
        },
        {
          file:
            '2026-07-15_193001_grass-hills-production-physical-96dpi.png',
          sha256:
            'cde557793432c76f11a9df7f44247957fb1b97c631dd308e60ae2a41088419a9',
          source: '200mm physical plot at 756x756 CSS pixels (96dpi)',
        },
      ],
      committedLeanRoundtrip: {
        inputMechanism:
          'CDP whole-value text insertion into a browser-selected NumberControl, one animation frame for React draft state, then Enter commit and blur',
        values: [0, 0.25, 0],
        timingRun: {
          forwardMilliseconds: 479.2,
          restoreMilliseconds: 492.9,
          roundtripMilliseconds: 972.1,
          longTasksMilliseconds: [410, 383],
          rafIntervals: {
            samples: 180,
            medianMilliseconds: 8.3,
            p95Milliseconds: 9.2,
            maxMilliseconds: 408.2,
            over16_7Milliseconds: 5,
          },
          canvasSubmissions: {
            draws: 4,
            medianMilliseconds: 4.4,
            p95Milliseconds: 4.6,
            maxMilliseconds: 5.3,
          },
          heapAfterExplicitGc: {
            beforeBytes: 28_483_992,
            afterBytes: 28_650_593,
            deltaBytes: 166_601,
          },
        },
        sceneIdentityRun: {
          initialSvg: {
            sha256:
              '7b42fc609fef2e71dda66a22d3a71e22aaf989ebf3d10475947882a9619ac888',
            bytes: 2_012_905,
          },
          changedSvg: {
            sha256:
              'd3f3031544ca5c31255367590292eb61a63112c603f8dfc03ecb0bd5a6db9b4e',
            bytes: 2_014_171,
          },
          restoredSvg: {
            sha256:
              '7b42fc609fef2e71dda66a22d3a71e22aaf989ebf3d10475947882a9619ac888',
            bytes: 2_012_905,
          },
          exactSceneRestoration: true,
          canvasPixelSha256: {
            initial:
              '4515ee1c96121af84fbea4ec3b33462105792a9b8661e257c47b574765aed962',
            changed:
              'c84a6a1d8cfc9bef631c1085eb1795d2bf1b261a2e3ea455d09c1038827a52ac',
            restored:
              '70ff599b00ef980d2264a6445a530b447113c013f29b5b15d59bd3b7c1fc51ea',
          },
          exactCanvasPixelRestoration: false,
          interpretation:
            'The authored controls and exported displayed Scene restore exactly; Chrome did not reproduce byte-identical Canvas2D backing pixels for that byte-identical geometry.',
        },
      },
      details:
        'benchmarks/grass-hills-density/results/production-acceptance-2026-07-15.md',
    },
    reproduction: {
      workingDirectory: 'repository root',
      commands: [
        'node packages/core/benchmarks/grass-hills-density/bundle-cli.js --entry=packages/core/benchmarks/grass-hills-density/production-reference-cli.js --out=/tmp/issue-305-production-reference-cli.mjs',
        'node /tmp/issue-305-production-reference-cli.mjs --out=packages/core/src/sketches/grass-hills/reference',
      ],
    },
  }
}

export function writeProductionReference(out) {
  const generated = generateProductionReference()
  const manifest = productionReferenceManifest(generated)
  mkdirSync(out, { recursive: true })
  writeFileSync(`${out}/fill.svg`, generated.fillSvg)
  writeFileSync(`${out}/outline.svg`, generated.outlineSvg)
  writeFileSync(`${out}/physical-plot.svg`, generated.physicalPlotSvg)
  writeFileSync(
    `${out}/manifest.json`,
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  return manifest
}

function assertApprovedArtifacts(generated) {
  const observed = {
    fill: checksum(generated.fillSvg),
    outline: checksum(generated.outlineSvg),
    physicalPlot: checksum(generated.physicalPlotSvg),
  }
  for (const [name, approved] of Object.entries(APPROVED_ARTIFACT_HASHES)) {
    if (observed[name] !== approved) {
      throw new Error(
        `production reference ${name} changed: expected approved ${approved}, received ${observed[name]}; run the independent visual gate before updating approval`,
      )
    }
  }
}
