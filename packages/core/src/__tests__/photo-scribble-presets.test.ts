import { describe, expect, it } from 'vitest'

import type { DecodedPixels, SketchEnvironment } from '../imageAssets'
import {
  IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
  prepareImageDetailAnalysis,
} from '../imageDetailAnalysis'
import { applyPreset, deserialize } from '../preset'
import { photoScribble } from '../sketches/photo-scribble'
import doggo from '../sketches/photo-scribble/presets/doggo.json'
import doggoDetail from '../sketches/photo-scribble/presets/doggo-detail.json'
import flowersDenseChaotic from '../sketches/photo-scribble/presets/flowers-dense-chaotic.json'
import flowersDense from '../sketches/photo-scribble/presets/flowers-dense.json'
import neat from '../sketches/photo-scribble/presets/neat.json'
import nicePinecone from '../sketches/photo-scribble/presets/nice-pinecone.json'

// Constrain this preservation proof to a tiny deterministic Composition Frame;
// visual density at the authored work budget remains human review.
const FRAME = { width: 1, height: 0.75 }
// Exercise the real generator but stop early; this is a geometry-preservation
// regression, not the deferred high-density performance/visual campaign.
const BOUNDED_STOP_POINT = 0.5
const PIXELS: DecodedPixels = {
  width: 2,
  height: 2,
  data: Uint8Array.from([
    0, 0, 0, 255,
    96, 96, 96, 255,
    192, 192, 192, 255,
    255, 255, 255, 255,
  ]),
}

const existingPresets = [
  doggo,
  flowersDenseChaotic,
  flowersDense,
  neat,
  nicePinecone,
] as const

const zeroInfluenceEnvironment: SketchEnvironment = {
  imageAssets: () => PIXELS,
  getPreparedImageDetailAnalysis: () => {
    throw new Error('existing zero-influence presets must not prepare Detail')
  },
}

describe('Photo Scribble production presets', () => {
  it.each(existingPresets.map((value) => [value.name, value] as const))(
    '%s reconciles to zero influence without changing geometry',
    (_name, value) => {
      const preset = deserialize(value)
      const reconciled = applyPreset(photoScribble.schema, preset)
      const beforeParams = {
        ...preset.params,
        stopPoint: BOUNDED_STOP_POINT,
      }
      const afterParams = {
        ...reconciled.params,
        stopPoint: BOUNDED_STOP_POINT,
      }

      expect(preset.params).not.toHaveProperty('detailInfluence')
      expect(reconciled.params.detailInfluence).toBe(0)
      expect(
        photoScribble.generate(
          afterParams,
          reconciled.seed,
          0,
          FRAME,
          zeroInfluenceEnvironment,
        ),
      ).toEqual(
        photoScribble.generate(
          beforeParams,
          preset.seed,
          0,
          FRAME,
          zeroInfluenceEnvironment,
        ),
      )
    },
  )

  it('reloads doggo-detail with enabled Detail and reproduces its artwork', () => {
    const preset = deserialize(doggoDetail)
    const reloaded = applyPreset(photoScribble.schema, preset)
    const prepared = prepareImageDetailAnalysis(PIXELS)
    const environment: SketchEnvironment = {
      imageAssets: (id) =>
        id === 'img-0525-9cded1ad73bb' ? PIXELS : undefined,
      getPreparedImageDetailAnalysis: (id, definitionId) =>
        id === 'img-0525-9cded1ad73bb' &&
        definitionId === IMAGE_DETAIL_ANALYSIS_DEFINITION_ID
          ? prepared
          : undefined,
    }

    expect(preset).toMatchObject({
      version: 2,
      sketch: 'photo-scribble',
      name: 'doggo-detail',
      params: {
        imageAsset: 'img-0525-9cded1ad73bb',
        detailSensitivity: 0.5,
        detailInfluence: 0.5,
        stopPoint: 100,
      },
    })
    const boundedParams = {
      ...reloaded.params,
      stopPoint: BOUNDED_STOP_POINT,
    }
    const first = photoScribble.generate(
      boundedParams,
      reloaded.seed,
      0,
      FRAME,
      environment,
    )
    const second = photoScribble.generate(
      boundedParams,
      reloaded.seed,
      0,
      FRAME,
      environment,
    )

    expect(first.primitives.length).toBeGreaterThan(0)
    expect(second).toEqual(first)
  })
})
