import { sceneInventory } from './metrics.js'

function scene(payload, t) {
  return {
    space: { width: 10, height: 10 },
    primitives: [
      {
        points: [[payload.base, t], [payload.base + 1, t + 1]],
        stroke: { color: 'black', width: 1 },
      },
    ],
  }
}

export const benchmarkCandidate = {
  id: 'bundled-core-import',
  complexity: 'linear',
  prepare(payload) {
    return (t) => scene(payload, t)
  },
  generate(payload, t) {
    return scene(payload, t)
  },
  guard(value) {
    return value.primitives[0].points.length
  },
  inspect({ value }) {
    const resolved = typeof value === 'function' ? value(0) : value
    return { inventory: sceneInventory(resolved) }
  },
}
