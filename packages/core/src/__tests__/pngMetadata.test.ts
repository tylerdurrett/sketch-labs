import { describe, expect, it } from 'vitest'

import {
  REPRO_KEYWORD,
  crc32,
  insertPngMetadata,
  writeITXtChunk,
} from '../pngMetadata'

/**
 * These tests prove the PNG metadata writer produces a STRUCTURALLY VALID PNG —
 * not by pulling an external decoder (disallowed under the locked-down deps), but
 * by walking the chunk stream BY HAND: read each chunk's length/type/data/CRC,
 * locate the new `iTXt` chunk, re-verify its CRC, parse its internal fields, and
 * round-trip the UTF-8 text payload back to the original JSON. This is the #76
 * acceptance gate: valid chunk structure, valid CRC, payload round-trips.
 */

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])

/** Big-endian 4-byte encoding of an unsigned 32-bit integer. */
function uint32BE(value: number): Uint8Array {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ])
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function ascii(s: string): Uint8Array {
  return Uint8Array.from([...s].map((c) => c.charCodeAt(0)))
}

/** Frame a chunk (length | type | data | CRC) the way a real PNG encoder would. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = ascii(type)
  const crc = crc32(concat([typeBytes, data]))
  return concat([uint32BE(data.length), typeBytes, data, uint32BE(crc)])
}

/**
 * Build a minimal but well-formed PNG byte stream: signature + IHDR + IDAT +
 * IEND. The pixel payloads are dummies — the metadata writer only cares about the
 * chunk framing, never the image data.
 */
function minimalPng(): Uint8Array {
  // IHDR for a 1x1 8-bit RGBA image (13 bytes; values are plausible but unused).
  const ihdr = Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])
  const idat = Uint8Array.from([0, 1, 2, 3])
  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ])
}

/** A decoded PNG chunk with its offset, declared length, type, data, and CRC. */
interface DecodedChunk {
  offset: number
  length: number
  type: string
  data: Uint8Array
  crc: number
  /** The CRC recomputed over type+data — must equal `crc` for a valid chunk. */
  computedCrc: number
}

/** Walk a PNG stream and decode every chunk (asserts the signature is intact). */
function decodeChunks(png: Uint8Array): DecodedChunk[] {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    expect(png[i]).toBe(PNG_SIGNATURE[i])
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const chunks: DecodedChunk[] = []
  let offset = PNG_SIGNATURE.length
  while (offset + 8 <= png.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(
      png[offset + 4]!,
      png[offset + 5]!,
      png[offset + 6]!,
      png[offset + 7]!,
    )
    const data = png.subarray(offset + 8, offset + 8 + length)
    const crc = view.getUint32(offset + 8 + length)
    const computedCrc = crc32(png.subarray(offset + 4, offset + 8 + length))
    chunks.push({ offset, length, type, data, crc, computedCrc })
    offset += 12 + length
    if (type === 'IEND') break
  }
  return chunks
}

/** UTF-8 decode bytes back to a string (Node global; test env only, not core). */
function utf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/** Parse an `iTXt` chunk's internal fields per PNG spec §11.3.4.5. */
function parseITXt(data: Uint8Array) {
  const nul = data.indexOf(0)
  const keyword = utf8(data.subarray(0, nul))
  const compressionFlag = data[nul + 1]
  const compressionMethod = data[nul + 2]
  // language tag (NUL-terminated) then translated keyword (NUL-terminated).
  const langStart = nul + 3
  const langEnd = data.indexOf(0, langStart)
  const transEnd = data.indexOf(0, langEnd + 1)
  const text = utf8(data.subarray(transEnd + 1))
  return {
    keyword,
    compressionFlag,
    compressionMethod,
    languageTag: utf8(data.subarray(langStart, langEnd)),
    translatedKeyword: utf8(data.subarray(langEnd + 1, transEnd)),
    text,
  }
}

describe('crc32', () => {
  it('matches the PNG/zlib reference CRC of "IEND"', () => {
    // The empty IEND chunk's CRC is a fixed, well-known constant: 0xAE426082.
    expect(crc32(ascii('IEND'))).toBe(0xae426082)
  })

  it('is deterministic and order-sensitive', () => {
    expect(crc32(ascii('abc'))).toBe(crc32(ascii('abc')))
    expect(crc32(ascii('abc'))).not.toBe(crc32(ascii('cba')))
  })
})

describe('writeITXtChunk', () => {
  it('frames a valid iTXt chunk: length, type, internal fields, and CRC', () => {
    const json = '{"hello":"world"}'
    const framed = writeITXtChunk(REPRO_KEYWORD, json)

    const view = new DataView(
      framed.buffer,
      framed.byteOffset,
      framed.byteLength,
    )
    const declaredLength = view.getUint32(0)
    const type = utf8(framed.subarray(4, 8))
    const data = framed.subarray(8, 8 + declaredLength)
    const crc = view.getUint32(8 + declaredLength)

    expect(type).toBe('iTXt')
    // Declared length matches the actual data span: full frame is 4+4+len+4.
    expect(framed.length).toBe(12 + declaredLength)
    // CRC over type+data validates.
    expect(crc).toBe(crc32(framed.subarray(4, 8 + declaredLength)))

    const fields = parseITXt(data)
    expect(fields.keyword).toBe(REPRO_KEYWORD)
    expect(fields.compressionFlag).toBe(0)
    expect(fields.compressionMethod).toBe(0)
    expect(fields.languageTag).toBe('')
    expect(fields.translatedKeyword).toBe('')
    expect(fields.text).toBe(json)
  })

  it('round-trips a UTF-8 payload with non-Latin-1 characters', () => {
    const json = '{"label":"café ☕ 日本語"}'
    const framed = writeITXtChunk(REPRO_KEYWORD, json)
    const view = new DataView(
      framed.buffer,
      framed.byteOffset,
      framed.byteLength,
    )
    const declaredLength = view.getUint32(0)
    const data = framed.subarray(8, 8 + declaredLength)

    expect(parseITXt(data).text).toBe(json)
  })

  it('rejects a keyword outside the 1–79 byte range', () => {
    expect(() => writeITXtChunk('', 'x')).toThrow(/1–79/)
    expect(() => writeITXtChunk('k'.repeat(80), 'x')).toThrow(/1–79/)
  })
})

describe('insertPngMetadata', () => {
  it('inserts a valid iTXt chunk immediately before IEND', () => {
    const png = minimalPng()
    const json = '{"version":1,"sketch":"circles"}'
    const out = insertPngMetadata(png, json)

    const chunks = decodeChunks(out)
    const types = chunks.map((c) => c.type)

    // The iTXt chunk sits right before the terminal IEND.
    expect(types).toEqual(['IHDR', 'IDAT', 'iTXt', 'IEND'])
    expect(types[types.length - 1]).toBe('IEND')

    const itxt = chunks.find((c) => c.type === 'iTXt')!
    // Declared length matches the actual data span, and the CRC validates.
    expect(itxt.data.length).toBe(itxt.length)
    expect(itxt.computedCrc).toBe(itxt.crc)

    // Every surrounding chunk's CRC still validates (stream stays well-formed).
    for (const c of chunks) expect(c.computedCrc).toBe(c.crc)

    // The UTF-8 text payload round-trips back to the original JSON.
    expect(parseITXt(itxt.data).text).toBe(json)
  })

  it('honors a custom keyword', () => {
    const out = insertPngMetadata(minimalPng(), '{}', 'MyKeyword')
    const itxt = decodeChunks(out).find((c) => c.type === 'iTXt')!
    expect(parseITXt(itxt.data).keyword).toBe('MyKeyword')
  })

  it('does not mutate the input stream', () => {
    const png = minimalPng()
    const before = png.slice()
    insertPngMetadata(png, '{"x":1}')
    expect(png).toEqual(before)
  })

  it('throws on a stream missing the PNG signature', () => {
    const notPng = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(() => insertPngMetadata(notPng, '{}')).toThrow(/signature/)
  })

  it('throws on a stream with no IEND chunk', () => {
    const noIend = concat([
      PNG_SIGNATURE,
      chunk('IHDR', Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
    ])
    expect(() => insertPngMetadata(noIend, '{}')).toThrow(/IEND/)
  })
})
