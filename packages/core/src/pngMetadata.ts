/**
 * Dep-free PNG metadata writer — splices a reproduction envelope into an exported
 * PNG as an `iTXt` text chunk so the file traces back to the exact frame that
 * produced it (issue #76, the PNG leg of "self-describing exports").
 *
 * Pure byte work, DOM-free: it takes the raw bytes of a `toBlob('image/png')`
 * stream (a `Uint8Array`) and returns a new `Uint8Array` with one extra chunk
 * inserted. The Blob ⇄ ArrayBuffer ceremony is the Studio's concern; this module
 * owns only the byte-splice and its CRC-32, which is exactly why it lives in
 * `core` — it is unit-testable without a browser or a canvas (#76 acceptance: the
 * chunk-writer is tested in core), and a future export consumer reuses it.
 *
 * Why `iTXt` and not `tEXt`/`zTXt`: `tEXt` is Latin-1 only, but a reproduction
 * envelope carries arbitrary param values that may contain non-Latin-1
 * characters, so the text payload must be UTF-8. `iTXt` is the PNG text chunk
 * whose text field is UTF-8 (PNG spec §11.3.4.5). We write it UNCOMPRESSED
 * (compression flag 0) to stay dep-free — no zlib stream to deflate.
 *
 * Scope: this WRITES the metadata only. Reading it back to restore Studio state
 * (re-import) is explicitly out of scope for #76.
 */

/** The 8-byte PNG signature every valid PNG stream begins with. */
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])

/**
 * The default `iTXt` keyword for the reproduction envelope.
 *
 * A stable, Latin-1, 1–79-byte keyword (PNG spec §11.3.4.5 caps the keyword at
 * 79 bytes) under which the envelope JSON is stored, so a reader knows which
 * chunk holds the reproduction payload.
 */
export const REPRO_KEYWORD = 'Reproduction'

/**
 * The CRC-32 lookup table (IEEE 802.3 / zlib polynomial `0xEDB88320`), built
 * once and reused. Hand-rolling CRC-32 keeps this module dep-free and
 * self-testing — no reliance on Node 22's `zlib.crc32` or any external package.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

/**
 * Compute the standard PNG/zlib CRC-32 of a byte span.
 *
 * The IEEE 802.3 CRC-32 (polynomial `0xEDB88320`) PNG uses to checksum each
 * chunk's type+data (PNG spec §5.4). Pure: it reads `bytes` and returns the
 * 32-bit unsigned checksum.
 *
 * @param bytes - The bytes to checksum (a chunk's type field followed by its data).
 * @returns The CRC-32 as an unsigned 32-bit integer.
 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Latin-1 encode a string to bytes (each code unit is one byte). */
function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

/**
 * UTF-8 encode a string to bytes, hand-rolled to stay DOM-free.
 *
 * `TextEncoder` is a runtime global but is NOT in core's `lib: ["ES2022"]` type
 * surface (no `"DOM"`), so encoding by hand keeps this module compiling under the
 * headless guardrail without widening the lib. Iterating with `for...of` yields
 * whole code points (surrogate pairs handled), so astral characters in arbitrary
 * param values encode correctly.
 */
function utf8Bytes(s: string): Uint8Array {
  const out: number[] = []
  for (const ch of s) {
    let code = ch.codePointAt(0)!
    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      out.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return Uint8Array.from(out)
}

/** Concatenate byte spans into one `Uint8Array`. */
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

/** Big-endian 4-byte encoding of an unsigned 32-bit integer. */
function uint32BE(value: number): Uint8Array {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ])
}

/**
 * Build a complete, framed `iTXt` chunk carrying `text` under `keyword`.
 *
 * The returned bytes are the full on-disk chunk: a 4-byte big-endian length, the
 * 4-byte `iTXt` type, the data, and a 4-byte CRC-32 over type+data (PNG chunk
 * framing, spec §5.3). The DATA is the `iTXt` internal layout (spec §11.3.4.5),
 * in order:
 *
 *   keyword (Latin-1, 1–79 bytes) | NUL | compression flag (0 = uncompressed)
 *   | compression method (0) | language tag + NUL (empty here) | translated
 *   keyword + NUL (empty here) | UTF-8 text
 *
 * The keyword is Latin-1; the text is UTF-8 (the reason for `iTXt` over `tEXt`).
 * The two empty trailing-NUL fields (language tag, translated keyword) are
 * required by the layout even when empty.
 *
 * @param keyword - The chunk keyword (Latin-1, 1–79 bytes).
 * @param text - The UTF-8 text payload (the reproduction JSON).
 * @returns The complete framed `iTXt` chunk bytes.
 * @throws If `keyword` is not 1–79 bytes once Latin-1 encoded.
 */
export function writeITXtChunk(keyword: string, text: string): Uint8Array {
  const keywordBytes = latin1Bytes(keyword)
  if (keywordBytes.length < 1 || keywordBytes.length > 79) {
    throw new Error(
      `writeITXtChunk: keyword must be 1–79 bytes, got ${keywordBytes.length}`,
    )
  }

  const data = concat([
    keywordBytes,
    // The six fixed header fields, all zero here:
    //   NUL separator | compression flag (0=uncompressed) | compression method
    //   (0) | language tag (empty)+NUL | translated keyword (empty)+NUL
    Uint8Array.from([0, 0, 0, 0, 0]),
    utf8Bytes(text), // UTF-8 text payload
  ])

  const type = latin1Bytes('iTXt')
  const crc = crc32(concat([type, data]))

  return concat([uint32BE(data.length), type, data, uint32BE(crc)])
}

/**
 * Splice a reproduction-envelope `iTXt` chunk into a PNG byte stream, immediately
 * before its terminal `IEND` chunk.
 *
 * `IEND` must be the last chunk of a valid PNG (spec §11.2.5), so a new ancillary
 * chunk is inserted just before it. The function walks the stream's chunk list
 * from the 8-byte signature to locate `IEND`, then returns a fresh `Uint8Array`
 * = everything up to `IEND` + the new `iTXt` chunk + `IEND` and onward. The input
 * is not mutated.
 *
 * @param pngBytes - The raw PNG stream (e.g. a `toBlob` ArrayBuffer view).
 * @param keyword - The `iTXt` keyword (default {@link REPRO_KEYWORD}).
 * @param jsonText - The UTF-8 JSON reproduction payload.
 * @returns A new PNG stream with the `iTXt` chunk inserted before `IEND`.
 * @throws If `pngBytes` lacks the PNG signature or has no `IEND` chunk.
 */
export function insertPngMetadata(
  pngBytes: Uint8Array,
  jsonText: string,
  keyword: string = REPRO_KEYWORD,
): Uint8Array {
  if (pngBytes.length < PNG_SIGNATURE.length) {
    throw new Error('insertPngMetadata: input too short to be a PNG')
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (pngBytes[i] !== PNG_SIGNATURE[i]) {
      throw new Error('insertPngMetadata: missing PNG signature')
    }
  }

  // Walk the chunk list to find IEND's start offset. Each chunk is:
  // 4-byte length | 4-byte type | <length> bytes data | 4-byte CRC.
  const view = new DataView(
    pngBytes.buffer,
    pngBytes.byteOffset,
    pngBytes.byteLength,
  )
  let offset = PNG_SIGNATURE.length
  let iendOffset = -1
  while (offset + 8 <= pngBytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(
      pngBytes[offset + 4]!,
      pngBytes[offset + 5]!,
      pngBytes[offset + 6]!,
      pngBytes[offset + 7]!,
    )
    if (type === 'IEND') {
      iendOffset = offset
      break
    }
    // Advance past length(4) + type(4) + data(length) + crc(4).
    offset += 12 + length
  }
  if (iendOffset === -1) {
    throw new Error('insertPngMetadata: no IEND chunk found')
  }

  const chunk = writeITXtChunk(keyword, jsonText)
  return concat([
    pngBytes.subarray(0, iendOffset),
    chunk,
    pngBytes.subarray(iendOffset),
  ])
}
