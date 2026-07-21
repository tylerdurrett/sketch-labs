import { performance } from 'node:perf_hooks'

import { createRandom } from '../../src/random.ts'
import {
  createShadingMask,
  createToneField,
} from '../../src/shadingFields.ts'
import {
  materializeStipple,
  resolveProductionStipplingExecutionLimits,
  stipplingStrategy,
} from '../../src/stipplingStrategy/index.ts'
import { createStipplingModel } from '../../src/stipplingStrategy/model.ts'
import { placeInitialStipples } from '../../src/stipplingStrategy/placement.ts'
import {
  computeStipplingDistributionError,
  refineStipples,
  resolveStipplingRefinementAttempts,
} from '../../src/stipplingStrategy/refinement.ts'
import { relocateStipplesToVoronoiCentroids } from '../../src/stipplingStrategy/relocation.ts'
import { runStipplingRelaxation } from '../../src/stipplingStrategy/relaxation.ts'
import { assignStipplingVoronoi } from '../../src/stipplingStrategy/voronoi.ts'
import { diagnosticsSnapshot, orderedGeometryChecksum } from './artifacts.js'
import { PREREGISTERED_PINS } from './pins.js'
import { FRAME, SEED } from './protocol.js'

const DISTRIBUTION_FIDELITY = 0.5

function sourceFor(target) {
  if (target === 'flat') {
    return Object.freeze({
      toneField: createToneField(() => 0.65),
      shadingMask: createShadingMask(() => 1),
    })
  }
  if (target === 'ramp') {
    return Object.freeze({
      toneField: createToneField(([x]) => x / FRAME.width),
      shadingMask: createShadingMask(() => 1),
    })
  }
  if (target === 'exact-zero-barrier') {
    return Object.freeze({
      toneField: createToneField(([x, y]) =>
        0.2 + 0.8 * (0.65 * x / FRAME.width + 0.35 * y / FRAME.height),
      ),
      shadingMask: createShadingMask(([x]) =>
        x >= FRAME.width * 0.48 && x <= FRAME.width * 0.52 ? 0 : 1,
      ),
    })
  }
  throw new Error(`unknown target ${String(target)}`)
}

function inputFor(benchmarkCase) {
  return Object.freeze({
    source: sourceFor(benchmarkCase.target),
    frame: FRAME,
    controls: Object.freeze({
      stippleDensity: benchmarkCase.density,
      distributionFidelity: DISTRIBUTION_FIDELITY,
      voronoiRelaxation: benchmarkCase.relaxation,
    }),
    seed: SEED,
  })
}

function prepareStages(benchmarkCase) {
  const input = inputFor(benchmarkCase)
  const model = createStipplingModel(input.source, input.frame, input.controls)
  const limits = resolveProductionStipplingExecutionLimits(model)
  const rng = createRandom(SEED)
  const placement = placeInitialStipples(model, rng, {
    maxAttempts: limits.maxPlacementAttempts,
  })
  const requestedRefinementAttempts = resolveStipplingRefinementAttempts(
    placement.marks.length,
    model.controls.distributionFidelity,
  )
  const refinement = refineStipples(model, rng, placement.marks, {
    maxAttempts: Math.min(
      requestedRefinementAttempts,
      limits.maxRefinementAttempts,
    ),
  })
  const assignment =
    benchmarkCase.relaxation === 0
      ? undefined
      : assignStipplingVoronoi(model, refinement.marks)
  const relocation =
    assignment === undefined
      ? undefined
      : relocateStipplesToVoronoiCentroids(
          model,
          refinement.marks,
          assignment,
          refinement.error,
        )
  const relaxation =
    benchmarkCase.relaxation === 0
      ? undefined
      : runStipplingRelaxation({
          model,
          marks: refinement.marks,
          distributionError: refinement.error,
          limits: { maxPasses: limits.maxRelaxationPasses },
        })
  const finalMarks = relaxation?.marks ?? refinement.marks
  return {
    input,
    model,
    limits,
    placement,
    refinement,
    assignment,
    relocation,
    relaxation,
    finalMarks,
  }
}

function timed(operation) {
  const startedAt = performance.now()
  const value = operation()
  return { elapsedMs: performance.now() - startedAt, value }
}

function sameJson(first, second) {
  return JSON.stringify(first) === JSON.stringify(second)
}

function casePin(stages) {
  const result = stipplingStrategy(stages.input)
  const checksum = orderedGeometryChecksum(result.polylines)
  const stagedChecksum = orderedGeometryChecksum(
    stages.finalMarks.map((mark) =>
      materializeStipple(mark, stages.model.scales.stippleLength),
    ),
  )
  if (stagedChecksum !== checksum) {
    throw new Error('staged benchmark output differs from end-to-end output')
  }
  return Object.freeze({
    orderedChecksum: checksum,
    termination: result.termination,
    work: Object.freeze({
      placementAttempts: stages.placement.attemptsUsed,
      refinementAttempts: stages.refinement.attemptsUsed,
      voronoi: stages.assignment?.work ?? null,
      relocationAccepted: stages.relocation?.acceptedRelocationCount ?? 0,
    }),
    diagnostics: diagnosticsSnapshot(result),
  })
}

function operationFactoryFor(phase, stages) {
  if (phase === 'placement') {
    return () => {
      const rng = createRandom(SEED)
      return () => placeInitialStipples(stages.model, rng, {
        maxAttempts: stages.limits.maxPlacementAttempts,
      })
    }
  }
  if (phase === 'distribution-refinement') {
    return () => {
      const rng = createRandom(SEED)
      const placement = placeInitialStipples(stages.model, rng, {
        maxAttempts: stages.limits.maxPlacementAttempts,
      })
      return () =>
        refineStipples(stages.model, rng, placement.marks, {
          maxAttempts: stages.refinement.attemptsUsed,
        })
    }
  }
  if (phase === 'voronoi-assignment-centroid') {
    return stages.assignment === undefined
      ? undefined
      : () => () =>
          assignStipplingVoronoi(stages.model, stages.refinement.marks)
  }
  if (phase === 'safe-relocation') {
    return stages.assignment === undefined
      ? undefined
      : () => () =>
        relocateStipplesToVoronoiCentroids(
          stages.model,
          stages.refinement.marks,
          stages.assignment,
          stages.refinement.error,
        )
  }
  if (phase === 'geometry-materialization') {
    return () => () =>
      stages.finalMarks.map((mark) =>
        materializeStipple(mark, stages.model.scales.stippleLength),
      )
  }
  if (phase === 'end-to-end-preparation') {
    return () => () => stipplingStrategy(stages.input)
  }
  throw new Error(`unknown benchmark phase ${phase}`)
}

function validateResult(phase, result, pin, stages) {
  if (phase === 'placement') {
    if (!sameJson(result, stages.placement)) {
      throw new Error('placement pin changed')
    }
  } else if (phase === 'distribution-refinement') {
    if (!sameJson(result, stages.refinement)) {
      throw new Error('refinement pin changed')
    }
  } else if (phase === 'voronoi-assignment-centroid') {
    if (!sameJson(result, stages.assignment)) {
      throw new Error('assignment pin changed')
    }
  } else if (phase === 'safe-relocation') {
    if (!sameJson(result, stages.relocation)) {
      throw new Error('relocation pin changed')
    }
  } else if (phase === 'geometry-materialization') {
    if (orderedGeometryChecksum(result) !== pin.orderedChecksum) {
      throw new Error('materialized geometry checksum changed')
    }
  } else if (
    orderedGeometryChecksum(result.polylines) !== pin.orderedChecksum ||
    !sameJson(diagnosticsSnapshot(result), pin.diagnostics)
  ) {
    throw new Error('end-to-end output pin changed')
  }
}

export function runBenchmarkCase(
  benchmarkCase,
  phases,
  warmups,
  samples,
  completedIds = new Set(),
) {
  const stages = prepareStages(benchmarkCase)
  const pin = casePin(stages)
  const expectedPin = PREREGISTERED_PINS[benchmarkCase.id]
  if (expectedPin !== undefined && !sameJson(pin, expectedPin)) {
    throw new Error(`preregistered benchmark pin changed for ${benchmarkCase.id}`)
  }
  const records = []
  for (const phase of phases) {
    const operationFactory = operationFactoryFor(phase, stages)
    if (operationFactory === undefined) {
      for (let sampleIndex = 0; sampleIndex < samples; sampleIndex++) {
        const id = `${benchmarkCase.id}/${phase}/${sampleIndex}`
        if (!completedIds.has(id)) {
          records.push(Object.freeze({
            id,
            caseId: benchmarkCase.id,
            phase,
            sampleIndex,
            elapsedMs: null,
            status: 'skipped-zero-relaxation',
            pin,
          }))
        }
      }
      continue
    }
    for (let index = 0; index < warmups; index++) {
      validateResult(phase, operationFactory()(), pin, stages)
    }
    for (let sampleIndex = 0; sampleIndex < samples; sampleIndex++) {
      const id = `${benchmarkCase.id}/${phase}/${sampleIndex}`
      if (completedIds.has(id)) continue
      const measurement = timed(operationFactory())
      validateResult(phase, measurement.value, pin, stages)
      records.push(Object.freeze({
        id,
        caseId: benchmarkCase.id,
        phase,
        sampleIndex,
        elapsedMs: measurement.elapsedMs,
        status: 'ok',
        pin,
      }))
    }
  }
  return records
}
