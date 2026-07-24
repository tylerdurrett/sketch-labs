import { generateFlowingContours } from '../../../src/sketches/flowing-contours/generator.ts'

const CONTROL_NAMES = Object.freeze([
  'gamma',
  'contrast',
  'pivot',
  'curveDetail',
  'continuity',
  'flowSmoothing',
  'minimumStrokeLength',
])

globalThis.__FLOWING_CONTOURS_SYNC_ORACLE__ = async (identity) => {
  const params = Object.fromEntries(
    identity.params.map(({ key, value }) => [key, value]),
  )
  const pixels = await decodeRgba8(
    `/image-assets/${params.imageAsset}.png`,
  )
  const controls = Object.fromEntries(
    CONTROL_NAMES.map((name) => [name, params[name]]),
  )
  const startedAt = performance.now()
  const result = generateFlowingContours({
    pixels,
    frame: identity.compositionFrame,
    controls,
  })
  const generationMs = performance.now() - startedAt
  return Object.freeze({
    generationMs,
    sceneChecksum: await sha256Text(JSON.stringify(result.scene)),
    primitiveCount: result.scene.primitives.length,
    pointCount: result.scene.primitives.reduce(
      (sum, primitive) => sum + primitive.points.length,
      0,
    ),
  })
}

async function decodeRgba8(url) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`failed to load fixture: ${response.status}`)
  }
  const bitmap = await createImageBitmap(await response.blob())
  const surface = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = surface.getContext('2d', { willReadFrequently: true })
  if (context === null) throw new Error('Canvas2D is unavailable')
  context.drawImage(bitmap, 0, 0)
  const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data
  bitmap.close()
  return Object.freeze({
    width: surface.width,
    height: surface.height,
    data: new Uint8Array(data),
  })
}

async function sha256Text(value) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
