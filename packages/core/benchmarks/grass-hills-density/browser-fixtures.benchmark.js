import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { hiddenLinePass } from '../../src/hiddenLine'
import { grassHills } from '../../src/sketches/grass-hills'
import { BROWSER_SCENE_FIXTURES } from './browser/fixture-manifest.js'
import { HISTORICAL_BASELINE } from './fixtures.js'

const UPDATE_FIXTURES = process.env.UPDATE_GRASS_HILLS_BROWSER_FIXTURES === '1'

describe('checksum-pinned browser Scene fixtures', () => {
  it('keeps exact serialized fill and Outline Scene artifacts', () => {
    if (UPDATE_FIXTURES) writeFixtures()

    for (const [kind, fixture] of Object.entries(BROWSER_SCENE_FIXTURES)) {
      expect(fixture.sha256, `${kind} checksum must be pinned`).not.toBe('PENDING')
      const url = fixture.file
      expect(existsSync(url), `${kind} fixture must exist`).toBe(true)
      const serialized = readFileSync(url, 'utf8')
      expect(sha256(serialized), `${kind} fixture checksum`).toBe(fixture.sha256)
      const scene = JSON.parse(serialized)
      expect(scene.space).toEqual({ width: 1000, height: 1000 })
      expect(scene.primitives.length).toBeGreaterThan(0)
    }
  })
})

function writeFixtures() {
  const { params, seed, t, frame } = HISTORICAL_BASELINE.payload
  const fill = grassHills.generate(params, seed, t, frame)
  const outline = hiddenLinePass(fill, { tolerance: 0 })
  const directory = new URL('./browser/fixtures/', import.meta.url)
  mkdirSync(fileURLToPath(directory), { recursive: true })
  writeFileSync(new URL('historical-baseline-fill.scene.json', directory), JSON.stringify(fill))
  writeFileSync(
    new URL('historical-baseline-outline.scene.json', directory),
    JSON.stringify(outline),
  )
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
