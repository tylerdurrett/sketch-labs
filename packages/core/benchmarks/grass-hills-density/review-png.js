import { deflateSync, inflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/**
 * Deterministic, dependency-free review rasterization for dense reference runs.
 *
 * This is deliberately a review projection, not a production renderer. It uses
 * the committed Scene geometry and painter order to make the 50k Fill/Outline
 * pair inspectable without committing the multi-megabyte Scene/SVG values. The
 * full vector hashes remain in the reference manifest and the CLI can write the
 * exact vector artifacts to a temporary directory for detailed inspection.
 */
export function renderSceneReviewPng(
  scene,
  { width = 900, height = 900, background = '#ffffff' } = {},
) {
  const pixels = Buffer.alloc(width * height * 4)
  fillPixels(pixels, parseColor(scene.background?.color ?? background))
  const scale = Math.min(width / scene.space.width, height / scene.space.height)
  const offsetX = (width - scene.space.width * scale) / 2
  const offsetY = (height - scene.space.height * scale) / 2

  for (const primitive of scene.primitives) {
    if (primitive.points.length === 0) continue
    const points = primitive.points.map(([x, y]) => [
      offsetX + x * scale,
      offsetY + y * scale,
    ])
    if (primitive.fill !== undefined && points.length >= 3) {
      fillPolygon(
        pixels,
        width,
        height,
        points,
        parseColor(primitive.fill.color),
      )
    }
    if (primitive.stroke !== undefined && points.length >= 2) {
      const stroke = parseColor(primitive.stroke.color)
      const lineWidth = Math.max(1, primitive.stroke.width * scale)
      for (let index = 1; index < points.length; index++) {
        drawLine(
          pixels,
          width,
          height,
          points[index - 1],
          points[index],
          stroke,
          lineWidth,
        )
      }
      if (primitive.closed) {
        const first = points[0]
        const last = points.at(-1)
        if (first[0] !== last[0] || first[1] !== last[1]) {
          drawLine(pixels, width, height, last, first, stroke, lineWidth)
        }
      }
    }
  }

  return encodePng(width, height, pixels)
}

/** Place two same-sized lossless review PNGs side by side with a fixed gutter. */
export function pairedReviewPng(left, right, { gutter = 8 } = {}) {
  const a = decodeOwnedPng(left)
  const b = decodeOwnedPng(right)
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error('paired review images must have identical dimensions')
  }
  const width = a.width * 2 + gutter
  const pixels = Buffer.alloc(width * a.height * 4)
  fillPixels(pixels, [238, 238, 238, 255])
  copyRows(a.pixels, a.width, pixels, width, 0)
  copyRows(b.pixels, b.width, pixels, width, a.width + gutter)
  return encodePng(width, a.height, pixels)
}

function fillPixels(pixels, color) {
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = color[0]
    pixels[offset + 1] = color[1]
    pixels[offset + 2] = color[2]
    pixels[offset + 3] = color[3]
  }
}

function fillPolygon(pixels, width, height, points, color) {
  let minY = height - 1
  let maxY = 0
  for (const [, y] of points) {
    minY = Math.min(minY, Math.floor(y))
    maxY = Math.max(maxY, Math.ceil(y))
  }
  minY = Math.max(0, minY)
  maxY = Math.min(height - 1, maxY)
  const intersections = []
  for (let y = minY; y <= maxY; y++) {
    intersections.length = 0
    const scanY = y + 0.5
    for (let index = 0; index < points.length; index++) {
      const a = points[index]
      const b = points[(index + 1) % points.length]
      if ((a[1] > scanY) === (b[1] > scanY)) continue
      intersections.push(
        a[0] + ((scanY - a[1]) * (b[0] - a[0])) / (b[1] - a[1]),
      )
    }
    intersections.sort((a, b) => a - b)
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      const start = Math.max(0, Math.ceil(intersections[index] - 0.5))
      const end = Math.min(
        width - 1,
        Math.floor(intersections[index + 1] - 0.5),
      )
      for (let x = start; x <= end; x++) setPixel(pixels, width, x, y, color)
    }
  }
}

function drawLine(pixels, width, height, a, b, color, lineWidth) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))))
  const radius = Math.max(0.5, lineWidth / 2)
  for (let step = 0; step <= steps; step++) {
    const ratio = step / steps
    drawDisc(
      pixels,
      width,
      height,
      a[0] + dx * ratio,
      a[1] + dy * ratio,
      radius,
      color,
    )
  }
}

function drawDisc(pixels, width, height, centerX, centerY, radius, color) {
  const minX = Math.max(0, Math.floor(centerX - radius))
  const maxX = Math.min(width - 1, Math.ceil(centerX + radius))
  const minY = Math.max(0, Math.floor(centerY - radius))
  const maxY = Math.min(height - 1, Math.ceil(centerY + radius))
  const radiusSquared = radius * radius
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x + 0.5 - centerX
      const dy = y + 0.5 - centerY
      if (dx * dx + dy * dy <= radiusSquared) {
        setPixel(pixels, width, x, y, color)
      }
    }
  }
}

function setPixel(pixels, width, x, y, color) {
  const offset = (y * width + x) * 4
  pixels[offset] = color[0]
  pixels[offset + 1] = color[1]
  pixels[offset + 2] = color[2]
  pixels[offset + 3] = color[3]
}

function parseColor(value) {
  if (value === 'black') return [0, 0, 0, 255]
  if (value === 'white') return [255, 255, 255, 255]
  if (/^#[0-9a-f]{6}$/i.test(value)) {
    return [
      Number.parseInt(value.slice(1, 3), 16),
      Number.parseInt(value.slice(3, 5), 16),
      Number.parseInt(value.slice(5, 7), 16),
      255,
    ]
  }
  throw new Error(
    `review rasterizer only accepts six-digit hex colors: ${value}`,
  )
}

function encodePng(width, height, pixels) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const target = y * (stride + 1)
    raw[target] = 0
    pixels.copy(raw, target + 1, y * stride, (y + 1) * stride)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function decodeOwnedPng(png) {
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('invalid review PNG signature')
  }
  let offset = PNG_SIGNATURE.length
  let width
  let height
  const compressed = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
    } else if (type === 'IDAT') compressed.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (width === undefined || height === undefined) {
    throw new Error('review PNG lacks IHDR')
  }
  // Every image produced above uses filter 0. Keep this private decoder narrow.
  const raw = inflateSync(Buffer.concat(compressed))
  const stride = width * 4
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const source = y * (stride + 1)
    if (raw[source] !== 0) throw new Error('unsupported review PNG filter')
    raw.copy(pixels, y * stride, source + 1, source + 1 + stride)
  }
  return { width, height, pixels }
}

function copyRows(source, sourceWidth, target, targetWidth, targetX) {
  const stride = sourceWidth * 4
  for (let y = 0; y < source.length / stride; y++) {
    source.copy(
      target,
      (y * targetWidth + targetX) * 4,
      y * stride,
      (y + 1) * stride,
    )
  }
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type)
  const output = Buffer.alloc(data.length + 12)
  output.writeUInt32BE(data.length, 0)
  typeBytes.copy(output, 4)
  data.copy(output, 8)
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.length + 8)
  return output
}

function crc32(value) {
  let crc = 0xffffffff
  for (const byte of value) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
