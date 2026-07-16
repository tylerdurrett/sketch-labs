import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'

import { clipSceneToBounds } from '../../src/clipToBounds.ts'
import {
  preparePolygon,
  subtractPreparedPolygonsFromPolyline,
} from '../../src/polygonClip.ts'
import { renderPlotterSVG } from '../../src/plotterSvg.ts'
import { renderToSVG } from '../../src/renderer.ts'
import { prepareExactComposition, simpleBlade } from './exact-common.js'
import { DENSITY_FIXTURES } from './fixtures.js'
import { processSimplifiedStrokes } from './simplified-processing.js'

export const DECISION_REFERENCE_ID = 'stratified-7-centerline-lod'
export const DECISION_FIXTURE_ID = 'full-10000'

const LIVE_PALETTE = Object.freeze({
  background: '#f7f4e8',
  hillFill: '#dce8d3',
  hillStroke: '#496a43',
  blade: '#24643a',
})
const LIVE_RIDGE_WIDTH = 1
const LIVE_BLADE_WIDTH = 0.7
const OUTLINE_COLOR = '#111111'
const BASELINE_LEAN = 0.32

/**
 * Regenerate the architecture-decision fixture from one shared descriptor set.
 *
 * The live Scene uses filled seven-point silhouettes. Outline/plot instead trace
 * each silhouette's spine, select a deterministic tool-width LOD, and subtract
 * only nearer hill masks. Both output modes therefore share roots, variation,
 * terrain reprojection and lean while intentionally differing in mark density.
 */
export function generateDecisionReference(payload = decisionFixture().payload) {
  const prepared = prepareExactComposition(payload, {
    rootStrategy: 'stratified',
    bladeGeometry: 'simple-7',
  })
  const fillPrimitives = []
  const strokeEntries = []
  const hillRidges = prepared.hills.map((hill) => ({ points: hill.ridge }))

  for (const [hillIndex, hill] of prepared.hills.entries()) {
    fillPrimitives.push({
      points: hill.ridge.map(copyPoint),
      closed: false,
      fill: { color: LIVE_PALETTE.hillFill },
      stroke: { color: LIVE_PALETTE.hillStroke, width: LIVE_RIDGE_WIDTH },
    })

    for (const descriptor of hill.blades) {
      const shape = decisionShape(descriptor)
      const [rootX, rootY] = descriptor.projected
      fillPrimitives.push({
        points: simpleBlade(shape).map(([x, y]) => [x + rootX, y + rootY]),
        closed: true,
        fill: { color: LIVE_PALETTE.blade },
        stroke: { color: LIVE_PALETTE.blade, width: LIVE_BLADE_WIDTH },
      })

      const primitive = {
        points: centerline(descriptor.projected, shape),
        closed: false,
        stroke: {
          color: OUTLINE_COLOR,
          width: payload.pen.nibWidthSceneUnits,
        },
      }
      strokeEntries.push({
        primitive,
        descriptor: {
          ...descriptor,
          shape,
          lod: {
            rank: descriptor.identity.ordinal,
            tieBreak: descriptor.rolls.width,
          },
        },
        hillIndex,
        rootKey: descriptor.identity.rootKey,
        tuftKey: `${descriptor.identity.hillKey}:cell:${descriptor.identity.ordinal}`,
      })
    }
  }

  const fillScene = clipSceneToBounds({
    space: { ...prepared.frame },
    background: { color: LIVE_PALETTE.background },
    primitives: fillPrimitives,
  })
  const sourceStrokeScene = {
    space: { ...prepared.frame },
    primitives: strokeEntries.map((entry) => entry.primitive),
  }
  const processingStarted = performance.now()
  const processed = processSimplifiedStrokes({
    sourceScene: sourceStrokeScene,
    sourceEntries: strokeEntries,
    hillRidges,
    occluderMode: 'hill-only',
    densityMode: 'plotter-lod',
    millimetersPerSceneUnit: payload.pen.millimetersPerSceneUnit,
    nibWidthSceneUnits: payload.pen.nibWidthSceneUnits,
  })
  const ridgePrimitives = visibleRidges(
    prepared.hills,
    payload.pen.nibWidthSceneUnits,
  )
  const outlineScene = clipSceneToBounds({
    space: { ...prepared.frame },
    primitives: [...ridgePrimitives, ...processed.scene.primitives],
  })
  const processingDurationMs = performance.now() - processingStarted

  return {
    fillScene,
    outlineScene,
    fillSvg: renderToSVG(fillScene),
    outlineSvg: renderToSVG(outlineScene, undefined, 'transparent'),
    plotterSvg: renderPlotterSVG(outlineScene, payload.profile),
    evidence: {
      bladeCount: prepared.bladeCount,
      selectedRootCount: processed.evidence.lod.selectedCount,
      outlinePathCount: outlineScene.primitives.length,
      processingDurationMs,
      rootKeys: prepared.hills.flatMap((hill) =>
        hill.blades.map((descriptor) => descriptor.identity.rootKey),
      ),
      selectedRootKeys: processed.evidence.lod.includedRootKeys,
    },
  }
}

function decisionShape(descriptor) {
  return {
    ...descriptor.shape,
    lean:
      descriptor.shape.lean + (descriptor.rolls.lean * 2 - 1) * BASELINE_LEAN,
  }
}

function centerline([rootX, rootY], shape) {
  return Array.from({ length: 6 }, (_, index) => {
    const t = index / 5
    return [
      rootX + shape.lean * shape.length * t ** (shape.stiffness + 1),
      rootY - shape.length * t,
    ]
  })
}

function visibleRidges(hills, width) {
  return hills.flatMap((hill, hillIndex) => {
    const ridge = hill.ridge.slice(0, -3).map(copyPoint)
    const masks = hills
      .slice(hillIndex + 1)
      .map((nearer) => preparePolygon(nearer.ridge))
    const fragments =
      masks.length === 0
        ? [ridge]
        : subtractPreparedPolygonsFromPolyline(ridge, masks)
    return fragments
      .filter((points) => points.length >= 2)
      .map((points) => ({
        points,
        closed: false,
        stroke: { color: OUTLINE_COLOR, width },
      }))
  })
}

function decisionFixture() {
  const fixture = DENSITY_FIXTURES.find(({ id }) => id === DECISION_FIXTURE_ID)
  if (fixture === undefined) throw new Error(`missing ${DECISION_FIXTURE_ID}`)
  return fixture
}

function copyPoint([x, y]) {
  return [x, y]
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

export function writeDecisionReference(out) {
  const fixture = decisionFixture()
  const generated = generateDecisionReference(fixture.payload)
  mkdirSync(out, { recursive: true })
  writeFileSync(`${out}/fill.svg`, generated.fillSvg)
  writeFileSync(`${out}/outline.svg`, generated.outlineSvg)
  const {
    rootKeys,
    selectedRootKeys,
    processingDurationMs: _processingDurationMs,
    ...evidence
  } = generated.evidence
  const manifest = {
    schemaVersion: 1,
    candidateId: DECISION_REFERENCE_ID,
    fixtureId: fixture.id,
    seed: fixture.payload.seed,
    time: fixture.payload.t,
    frame: fixture.payload.frame,
    request: fixture.payload.request,
    profile: fixture.payload.profile,
    tool: { widthMillimeters: fixture.payload.pen.finelinerMillimeters },
    contract: {
      rootGenerator:
        '100x100 seeded stratified stable-cell bank; nested priority prefix',
      fill: 'seven-point closed silhouettes from shared descriptors',
      outline:
        'six-point shared spines; hill-only occlusion; deterministic tool-width LOD',
      previewExportGeometry:
        'Outline preview and physical plot serialization consume the identical processed Scene',
    },
    evidence: {
      ...evidence,
      rootKeysSha256: checksum(JSON.stringify(rootKeys)),
      selectedRootKeysSha256: checksum(JSON.stringify(selectedRootKeys)),
    },
    artifacts: {
      fill: {
        file: 'fill.svg',
        sha256: checksum(generated.fillSvg),
        bytes: Buffer.byteLength(generated.fillSvg),
        scene: sceneInventory(generated.fillScene),
      },
      outline: {
        file: 'outline.svg',
        sha256: checksum(generated.outlineSvg),
        bytes: Buffer.byteLength(generated.outlineSvg),
        scene: sceneInventory(generated.outlineScene),
      },
      physicalPlot: {
        derivedFrom: 'the exact processed Scene pinned by outline.scene.sha256',
        sha256: checksum(generated.plotterSvg),
        bytes: Buffer.byteLength(generated.plotterSvg),
        sceneSha256: sceneInventory(generated.outlineScene).sha256,
      },
    },
    reproduction: {
      commands: [
        'node packages/core/benchmarks/grass-hills-density/bundle-cli.js --entry=packages/core/benchmarks/grass-hills-density/decision-reference-cli.js --out=/tmp/issue-305-decision-reference-cli.mjs',
        'node /tmp/issue-305-decision-reference-cli.mjs --out=packages/core/src/sketches/grass-hills/reference/decision-prototype',
      ],
      workingDirectory: 'repository root',
    },
  }
  writeFileSync(
    `${out}/manifest.json`,
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  return manifest
}
