import { drawSceneFitted } from '../../../src/renderer.ts'
import { BROWSER_SCENE_FIXTURES } from './fixture-manifest.js'

const canvas = document.querySelector('#surface')
const status = document.querySelector('#status')
const context = canvas.getContext('2d')
if (context === null) throw new Error('Canvas2D is unavailable')

const scenes = {}
for (const [kind, fixture] of Object.entries(BROWSER_SCENE_FIXTURES)) {
  const response = await fetch(fixture.file)
  if (!response.ok) throw new Error(`failed to load ${fixture.file}: ${response.status}`)
  const serialized = await response.text()
  const actual = await sha256(serialized)
  if (actual !== fixture.sha256) {
    throw new Error(`${kind} Scene checksum mismatch: expected ${fixture.sha256}, received ${actual}`)
  }
  scenes[kind] = JSON.parse(serialized)
}

function draw(kind = 'fill') {
  const scene = scenes[kind]
  if (scene === undefined) throw new Error(`unknown Scene kind ${kind}`)
  const started = performance.now()
  // This is intentionally core's actual shared Canvas path, not an SVG image
  // draw or a benchmark-local renderer lookalike.
  drawSceneFitted(context, scene, canvas.width, canvas.height)
  return performance.now() - started
}

function drawMany({ kind = 'fill', iterations = 30 } = {}) {
  const samples = []
  for (let index = 0; index < iterations; index++) samples.push(draw(kind))
  return samples
}

async function loadScene(kind, file, expectedSha256) {
  const response = await fetch(file)
  if (!response.ok) throw new Error(`failed to load ${file}: ${response.status}`)
  const serialized = await response.text()
  const actualSha256 = await sha256(serialized)
  if (expectedSha256 !== undefined && actualSha256 !== expectedSha256) {
    throw new Error(
      `${kind} Scene checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`,
    )
  }
  scenes[kind] = JSON.parse(serialized)
  return {
    kind,
    sha256: actualSha256,
    bytes: new TextEncoder().encode(serialized).byteLength,
    primitiveCount: scenes[kind].primitives.length,
  }
}

async function screenScenes(manifestFile, { redraws = 12 } = {}) {
  const response = await fetch(manifestFile)
  if (!response.ok) {
    throw new Error(`failed to load ${manifestFile}: ${response.status}`)
  }
  const manifest = await response.json()
  const observations = []

  for (const [kind, fixture] of Object.entries(manifest.scenes)) {
    const loadStarted = performance.now()
    const loaded = await loadScene(
      kind,
      new URL(fixture.file, new URL(manifestFile, location.href)).href,
      fixture.sha256,
    )
    const loadMs = performance.now() - loadStarted
    const firstDrawMs = draw(kind)
    const redrawSamplesMs = drawMany({ kind, iterations: redraws })
    observations.push({
      ...loaded,
      pointCount: fixture.pointCount,
      loadMs,
      firstDrawMs,
      redrawSamplesMs,
    })
  }
  return {
    machine,
    canvas: { width: canvas.width, height: canvas.height },
    observations,
  }
}

const firstSubmissionMs = draw('fill')
const machine = {
  userAgent: navigator.userAgent,
  platform: navigator.userAgentData?.platform ?? navigator.platform,
  logicalCpuCount: navigator.hardwareConcurrency ?? null,
  deviceMemoryGiB: navigator.deviceMemory ?? null,
  devicePixelRatio,
}

// Stable Chrome DevTools seam: profile draw()/drawMany(), inspect loaded Scenes,
// or wrap calls with tracing without changing production Studio code.
globalThis.__GRASS_HILLS_DENSITY_BENCHMARK__ = Object.freeze({
  canvas,
  context,
  scenes,
  fixtures: BROWSER_SCENE_FIXTURES,
  machine: Object.freeze(machine),
  draw,
  drawMany,
  loadScene,
  screenScenes,
})

const query = new URLSearchParams(location.search)
const manifestFile = query.get('manifest')
const sceneId = query.get('scene')
if (manifestFile !== null && sceneId !== null) {
  const response = await fetch(manifestFile)
  if (!response.ok) {
    throw new Error(`failed to load ${manifestFile}: ${response.status}`)
  }
  const fixture = (await response.json()).scenes[sceneId]
  if (fixture === undefined) throw new Error(`unknown screen Scene ${sceneId}`)
  const loaded = await loadScene(
    sceneId,
    new URL(fixture.file, new URL(manifestFile, location.href)).href,
    fixture.sha256,
  )
  const selectedSubmissionMs = draw(sceneId)
  status.textContent = JSON.stringify(
    { selectedSubmissionMs, loaded, machine },
    null,
    2,
  )
} else {
  status.textContent = JSON.stringify({ firstSubmissionMs, machine }, null, 2)
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
