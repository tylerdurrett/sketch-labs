import { describe, expect, it } from 'vitest'

import {
  defaultFlowingContoursControls,
  flowingContoursControlSchema,
  normalizeFlowingContoursControls,
  type FlowingContoursControlInput,
} from '../sketches/flowing-contours/controls'

const AUTHORED_ORDER = [
  'curveDetail',
  'continuity',
  'flowSmoothing',
  'minimumStrokeLength',
] as const

describe('Flowing Contours authored controls', () => {
  it('declares exactly four independent controls in stable authored order', () => {
    expect(Object.keys(flowingContoursControlSchema)).toEqual(AUTHORED_ORDER)
    expect(flowingContoursControlSchema).toEqual({
      curveDetail: {
        kind: 'number',
        min: 0,
        max: 1,
        default: 0.45,
        step: 0.01,
      },
      continuity: {
        kind: 'number',
        min: 0,
        max: 1,
        default: 0.45,
        step: 0.01,
      },
      flowSmoothing: {
        kind: 'number',
        min: 0,
        max: 1,
        default: 0.7,
        step: 0.01,
      },
      minimumStrokeLength: {
        kind: 'number',
        min: 0.005,
        max: 0.25,
        default: 0.04,
        step: 0.005,
      },
    })

    for (const [name, spec] of Object.entries(
      flowingContoursControlSchema,
    )) {
      expect(Object.isFrozen(spec), name).toBe(true)
    }
    expect(Object.isFrozen(flowingContoursControlSchema)).toBe(true)
  })

  it('does not inherit Pencil Contour or Watercolor Forms keys', () => {
    const keys = new Set(Object.keys(flowingContoursControlSchema))

    for (const siblingKey of [
      'gamma',
      'contrast',
      'pivot',
      'contourDetail',
      'contourSmoothing',
      'formDetail',
      'colorSensitivity',
      'boundaryStrength',
      'boundarySmoothing',
    ]) {
      expect(keys.has(siblingKey), siblingKey).toBe(false)
    }
    expect(keys.size).toBe(4)
  })

  it('derives stable frozen defaults from the authored schema', () => {
    expect(defaultFlowingContoursControls).toEqual({
      curveDetail: 0.45,
      continuity: 0.45,
      flowSmoothing: 0.7,
      minimumStrokeLength: 0.04,
    })

    for (const name of AUTHORED_ORDER) {
      expect(defaultFlowingContoursControls[name], name).toBe(
        flowingContoursControlSchema[name].default,
      )
    }
    expect(Object.isFrozen(defaultFlowingContoursControls)).toBe(true)
    expect(normalizeFlowingContoursControls()).toEqual(
      defaultFlowingContoursControls,
    )
  })

  it('defaults missing, malformed, and non-finite values independently', () => {
    const malformed = {
      curveDetail: Number.NaN,
      continuity: '0.8',
      flowSmoothing: Number.POSITIVE_INFINITY,
      minimumStrokeLength: Number.NEGATIVE_INFINITY,
    } satisfies FlowingContoursControlInput

    expect(normalizeFlowingContoursControls(malformed)).toEqual(
      defaultFlowingContoursControls,
    )
    expect(
      normalizeFlowingContoursControls({
        curveDetail: 0.2,
        flowSmoothing: null,
      }),
    ).toEqual({
      ...defaultFlowingContoursControls,
      curveDetail: 0.2,
    })
    expect(normalizeFlowingContoursControls(null)).toEqual(
      defaultFlowingContoursControls,
    )
  })

  it('clamps each finite value only to its own declared bounds', () => {
    expect(
      normalizeFlowingContoursControls({
        curveDetail: -10,
        continuity: 10,
        flowSmoothing: -20,
        minimumStrokeLength: 20,
      }),
    ).toEqual({
      curveDetail: 0,
      continuity: 1,
      flowSmoothing: 0,
      minimumStrokeLength: 0.25,
    })

    expect(
      normalizeFlowingContoursControls({
        curveDetail: 10,
        continuity: -10,
        flowSmoothing: 20,
        minimumStrokeLength: -20,
      }),
    ).toEqual({
      curveDetail: 1,
      continuity: 0,
      flowSmoothing: 1,
      minimumStrokeLength: 0.005,
    })
  })

  it('retains independently authored in-range values and freezes output', () => {
    const authored = {
      curveDetail: 0.13,
      continuity: 0.29,
      flowSmoothing: 0.83,
      minimumStrokeLength: 0.115,
    }
    const normalized = normalizeFlowingContoursControls(authored)

    expect(normalized).toEqual(authored)
    expect(Object.isFrozen(normalized)).toBe(true)

    for (const changedName of AUTHORED_ORDER) {
      const changed = normalizeFlowingContoursControls({
        ...defaultFlowingContoursControls,
        [changedName]: 0.125,
      })
      for (const observedName of AUTHORED_ORDER) {
        if (observedName === changedName) {
          expect(changed[observedName], observedName).toBe(0.125)
        } else {
          expect(changed[observedName], observedName).toBe(
            defaultFlowingContoursControls[observedName],
          )
        }
      }
    }
  })

  it('stores minimum stroke length as a fitted-image-diagonal fraction', () => {
    const fittedImageDiagonal = Math.hypot(800, 600)
    const controls = normalizeFlowingContoursControls()

    expect(fittedImageDiagonal).toBe(1_000)
    expect(controls.minimumStrokeLength * fittedImageDiagonal).toBe(40)
  })
})
