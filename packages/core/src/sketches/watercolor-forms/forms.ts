/**
 * Immutable hierarchy cuts and pre-boundary form suppression.
 *
 * Form detail moves a monotonic cut through the hierarchy: higher values apply
 * a shorter merge prefix. A decreasing area and persistence floor then admits
 * progressively smaller or shorter-lived forms. Qualifying coarse nodes retain
 * descendant coverage as the cut refines. Work-limited, over-dense cuts retain
 * a fixed minimum drawable area as an adversarial safety policy. Rejected forms
 * are contracted into an admitted neighbor, while never-admitted components
 * disappear before any boundary inventory can be constructed.
 */

import type {
  RegionHierarchy,
  SharedBoundarySegment,
  WatercolorRegionMerge,
} from './types'

const TRANSPARENT_SUPPORT_REGION_ID = -1
const MAX_MINIMUM_FORM_AREA = 16
const MAX_MINIMUM_FORM_PERSISTENCE = 0.04
const ADVERSARIAL_FORM_DENSITY_DIVISOR = 8
const ADVERSARIAL_MINIMUM_FORM_AREA = 20

interface AdjacencyEvidence {
  strengthLengthSum: number
  length: number
}

interface MutableSelectedForm {
  readonly id: number
  readonly persistence: number
  sampleCount: number
  retained: boolean
  readonly neighbors: Map<number, AdjacencyEvidence>
}

interface AncestorResolutionMetrics {
  ancestorTraversalCount: number
}

/**
 * The fully selected and suppressed form state consumed by boundary extraction.
 *
 * `regionBySample` is deliberately part of this intermediate snapshot: it
 * proves suppression is complete before a caller can ask for emitted geometry.
 */
export interface WatercolorFormSelection {
  readonly hierarchy: Readonly<RegionHierarchy>
  readonly regionIds: readonly number[]
  readonly regionBySample: readonly number[]
}

const EMPTY_NUMBERS = Object.freeze([]) as readonly number[]

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function mergeHeight(merge: Readonly<WatercolorRegionMerge>): number {
  return 1 - Math.min(1, Math.max(0, merge.similarity))
}

function pairKey(firstRegionId: number, secondRegionId: number): string {
  return `${Math.min(firstRegionId, secondRegionId)}:${Math.max(
    firstRegionId,
    secondRegionId,
  )}`
}

function boundaryLength(segment: Readonly<SharedBoundarySegment>): number {
  return Math.hypot(
    segment.end[0] - segment.start[0],
    segment.end[1] - segment.start[1],
  )
}

function addEvidence(
  neighbors: Map<number, AdjacencyEvidence>,
  neighborId: number,
  evidence: Readonly<AdjacencyEvidence>,
): void {
  const existing = neighbors.get(neighborId)
  if (existing === undefined) {
    neighbors.set(neighborId, {
      strengthLengthSum: evidence.strengthLengthSum,
      length: evidence.length,
    })
    return
  }
  existing.strengthLengthSum += evidence.strengthLengthSum
  existing.length += evidence.length
}

function selectedAncestors(
  hierarchy: Readonly<RegionHierarchy>,
  cutHeight: number,
  metrics?: AncestorResolutionMetrics,
): Readonly<{
  regionByInitialRegion: ReadonlyMap<number, number>
  selectedRegionIds: readonly number[]
}> {
  const parentByRegion = new Map<number, number>()
  const activeRegionIds = new Set(
    hierarchy.partition.regions.map((region) => region.id),
  )

  for (const merge of hierarchy.merges) {
    if (mergeHeight(merge) > cutHeight) break
    if (
      !activeRegionIds.has(merge.leftRegionId) ||
      !activeRegionIds.has(merge.rightRegionId)
    ) {
      continue
    }
    activeRegionIds.delete(merge.leftRegionId)
    activeRegionIds.delete(merge.rightRegionId)
    activeRegionIds.add(merge.mergedRegion.id)
    parentByRegion.set(merge.leftRegionId, merge.mergedRegion.id)
    parentByRegion.set(merge.rightRegionId, merge.mergedRegion.id)
  }

  const regionByInitialRegion = new Map<number, number>()
  for (const region of hierarchy.partition.regions) {
    const path: number[] = []
    let selectedRegionId = region.id
    while (parentByRegion.has(selectedRegionId)) {
      path.push(selectedRegionId)
      selectedRegionId = parentByRegion.get(selectedRegionId)!
      if (metrics !== undefined) metrics.ancestorTraversalCount += 1
    }
    for (const regionId of path) {
      parentByRegion.set(regionId, selectedRegionId)
    }
    regionByInitialRegion.set(region.id, selectedRegionId)
  }

  return {
    regionByInitialRegion,
    selectedRegionIds: [...activeRegionIds].sort(
      (first, second) => first - second,
    ),
  }
}

function persistenceByRegion(
  hierarchy: Readonly<RegionHierarchy>,
): ReadonlyMap<number, number> {
  const birthByRegion = new Map<number, number>()
  const deathByRegion = new Map<number, number>()
  for (const region of hierarchy.partition.regions) {
    birthByRegion.set(region.id, 0)
  }
  for (const merge of hierarchy.merges) {
    const height = mergeHeight(merge)
    deathByRegion.set(merge.leftRegionId, height)
    deathByRegion.set(merge.rightRegionId, height)
    birthByRegion.set(merge.mergedRegion.id, height)
  }

  return new Map(
    [...birthByRegion].map(([regionId, birth]) => [
      regionId,
      Math.max(0, (deathByRegion.get(regionId) ?? 1) - birth),
    ]),
  )
}

function buildSelectedAdjacency(
  hierarchy: Readonly<RegionHierarchy>,
  regionByInitialRegion: ReadonlyMap<number, number>,
  selectedForms: ReadonlyMap<number, MutableSelectedForm>,
): void {
  const evidenceByPair = new Map<string, AdjacencyEvidence>()
  for (const segment of hierarchy.partition.sharedBoundarySegments) {
    if (
      segment.regionIds[0] === TRANSPARENT_SUPPORT_REGION_ID ||
      segment.regionIds[1] === TRANSPARENT_SUPPORT_REGION_ID
    ) {
      continue
    }
    const firstRegionId = regionByInitialRegion.get(segment.regionIds[0])
    const secondRegionId = regionByInitialRegion.get(segment.regionIds[1])
    if (
      firstRegionId === undefined ||
      secondRegionId === undefined ||
      firstRegionId === secondRegionId
    ) {
      continue
    }
    const length = boundaryLength(segment)
    if (!Number.isFinite(length) || length <= 0) continue
    const key = pairKey(firstRegionId, secondRegionId)
    const evidence = evidenceByPair.get(key)
    if (evidence === undefined) {
      evidenceByPair.set(key, {
        strengthLengthSum:
          Math.min(1, Math.max(0, segment.strength)) * length,
        length,
      })
    } else {
      evidence.strengthLengthSum +=
        Math.min(1, Math.max(0, segment.strength)) * length
      evidence.length += length
    }
  }

  for (const [key, evidence] of [...evidenceByPair].sort(([first], [second]) =>
    first.localeCompare(second),
  )) {
    const [firstRegionId, secondRegionId] = key
      .split(':')
      .map((value) => Number(value)) as [number, number]
    addEvidence(
      selectedForms.get(firstRegionId)!.neighbors,
      secondRegionId,
      evidence,
    )
    addEvidence(
      selectedForms.get(secondRegionId)!.neighbors,
      firstRegionId,
      evidence,
    )
  }
}

function connectedComponents(
  selectedForms: ReadonlyMap<number, MutableSelectedForm>,
): readonly number[][] {
  const unseen = new Set(selectedForms.keys())
  const components: number[][] = []
  while (unseen.size > 0) {
    const start = unseen.values().next().value as number
    unseen.delete(start)
    const component: number[] = []
    const pending = [start]
    let pendingIndex = 0
    while (pendingIndex < pending.length) {
      const regionId = pending[pendingIndex]!
      pendingIndex += 1
      component.push(regionId)
      const neighbors = [...selectedForms.get(regionId)!.neighbors.keys()].sort(
        (first, second) => first - second,
      )
      for (const neighborId of neighbors) {
        if (!unseen.delete(neighborId)) continue
        pending.push(neighborId)
      }
    }
    components.push(component.sort((first, second) => first - second))
  }
  return components
}

function compareFormSignificance(
  first: Readonly<MutableSelectedForm>,
  second: Readonly<MutableSelectedForm>,
): number {
  return (
    second.sampleCount - first.sampleCount ||
    second.persistence - first.persistence ||
    first.id - second.id
  )
}

function preserveQualifiedAncestorCoverage(
  hierarchy: Readonly<RegionHierarchy>,
  selectedForms: ReadonlyMap<number, MutableSelectedForm>,
  qualifies: (regionId: number) => boolean,
): void {
  const bestSelectedDescendant = new Map<number, MutableSelectedForm>()
  const hasRetainedDescendant = new Map<number, boolean>()
  for (const form of selectedForms.values()) {
    bestSelectedDescendant.set(form.id, form)
    hasRetainedDescendant.set(form.id, form.retained)
  }

  for (const merge of hierarchy.merges) {
    const regionId = merge.mergedRegion.id
    const selected = selectedForms.get(regionId)
    const firstBest = bestSelectedDescendant.get(merge.leftRegionId)
    const secondBest = bestSelectedDescendant.get(merge.rightRegionId)
    const best =
      selected ??
      (firstBest === undefined
        ? secondBest
        : secondBest === undefined
          ? firstBest
          : compareFormSignificance(firstBest, secondBest) <= 0
            ? firstBest
            : secondBest)
    if (best === undefined) continue

    let retained =
      selected?.retained === true ||
      hasRetainedDescendant.get(merge.leftRegionId) === true ||
      hasRetainedDescendant.get(merge.rightRegionId) === true
    if (!retained && qualifies(regionId)) {
      best.retained = true
      retained = true
    }
    bestSelectedDescendant.set(regionId, best)
    hasRetainedDescendant.set(regionId, retained)
  }
}

interface AbsorptionTarget {
  readonly regionId: number
  readonly survivor: MutableSelectedForm
  readonly evidence: Readonly<AdjacencyEvidence>
}

function compareAbsorptionTargets(
  first: Readonly<AbsorptionTarget>,
  second: Readonly<AbsorptionTarget>,
): number {
  const firstStrength =
    first.evidence.strengthLengthSum / first.evidence.length
  const secondStrength =
    second.evidence.strengthLengthSum / second.evidence.length
  if (firstStrength !== secondStrength) return firstStrength - secondStrength
  if (first.evidence.length !== second.evidence.length) {
    return second.evidence.length - first.evidence.length
  }
  const significance = compareFormSignificance(
    first.survivor,
    second.survivor,
  )
  if (significance !== 0) return significance
  return first.regionId - second.regionId
}

function bestAdjacentSurvivor(
  form: Readonly<MutableSelectedForm>,
  selectedForms: ReadonlyMap<number, MutableSelectedForm>,
): AbsorptionTarget | undefined {
  const candidates: AbsorptionTarget[] = []
  for (const [neighborId, evidence] of form.neighbors) {
    const neighbor = selectedForms.get(neighborId)
    if (neighbor?.retained === true) {
      candidates.push({
        regionId: neighborId,
        survivor: neighbor,
        evidence,
      })
    }
  }
  return candidates.sort(compareAbsorptionTargets)[0]
}

function absorbForm(
  form: MutableSelectedForm,
  target: Readonly<AbsorptionTarget>,
  selectedForms: ReadonlyMap<number, MutableSelectedForm>,
  absorbedInto: Map<number, number>,
): void {
  absorbedInto.set(form.id, target.regionId)
  target.survivor.sampleCount += form.sampleCount
  for (const [neighborId, evidence] of form.neighbors) {
    if (neighborId === target.regionId) continue
    const neighbor = selectedForms.get(neighborId)
    if (neighbor === undefined) continue
    neighbor.neighbors.delete(form.id)
    addEvidence(neighbor.neighbors, target.regionId, evidence)
    addEvidence(target.survivor.neighbors, neighborId, evidence)
  }
  target.survivor.neighbors.delete(form.id)
  form.neighbors.clear()
}

class FormHeap {
  readonly #forms: MutableSelectedForm[] = []

  get size(): number {
    return this.#forms.length
  }

  push(form: MutableSelectedForm): void {
    let index = this.#forms.length
    this.#forms.push(form)
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (
        compareFormSignificance(
          this.#forms[parent]!,
          this.#forms[index]!,
        ) <= 0
      ) {
        break
      }
      const parentForm = this.#forms[parent]!
      this.#forms[parent] = this.#forms[index]!
      this.#forms[index] = parentForm
      index = parent
    }
  }

  pop(): MutableSelectedForm | undefined {
    const first = this.#forms[0]
    const last = this.#forms.pop()
    if (first === undefined || last === undefined) return first
    if (this.#forms.length === 0) return first
    this.#forms[0] = last

    let index = 0
    while (true) {
      const left = 2 * index + 1
      const right = left + 1
      let best = index
      if (
        left < this.#forms.length &&
        compareFormSignificance(
          this.#forms[left]!,
          this.#forms[best]!,
        ) < 0
      ) {
        best = left
      }
      if (
        right < this.#forms.length &&
        compareFormSignificance(
          this.#forms[right]!,
          this.#forms[best]!,
        ) < 0
      ) {
        best = right
      }
      if (best === index) break
      const currentForm = this.#forms[index]!
      this.#forms[index] = this.#forms[best]!
      this.#forms[best] = currentForm
      index = best
    }
    return first
  }
}

function contractRejectedForms(
  selectedForms: ReadonlyMap<number, MutableSelectedForm>,
): ReadonlyMap<number, number> {
  const absorbedInto = new Map<number, number>()
  for (const component of connectedComponents(selectedForms)) {
    if (component.some((regionId) => selectedForms.get(regionId)!.retained)) {
      continue
    }
    for (const regionId of component) {
      absorbedInto.set(regionId, TRANSPARENT_SUPPORT_REGION_ID)
    }
  }
  const rejected = new Set(
    [...selectedForms.values()]
      .filter((form) => !form.retained && !absorbedInto.has(form.id))
      .map((form) => form.id),
  )
  const queued = new Set<number>()
  const candidates = new FormHeap()
  const enqueueIfReady = (regionId: number): void => {
    if (!rejected.has(regionId) || queued.has(regionId)) return
    const form = selectedForms.get(regionId)!
    if (bestAdjacentSurvivor(form, selectedForms) === undefined) return
    candidates.push(form)
    queued.add(regionId)
  }
  for (const regionId of rejected) enqueueIfReady(regionId)

  while (rejected.size > 0) {
    const form = candidates.pop()
    if (form === undefined) {
      // Malformed residual topology fails closed instead of inventing a form.
      for (const regionId of rejected) {
        absorbedInto.set(regionId, TRANSPARENT_SUPPORT_REGION_ID)
      }
      break
    }
    queued.delete(form.id)
    if (!rejected.has(form.id)) continue
    const target = bestAdjacentSurvivor(form, selectedForms)
    if (target === undefined) continue
    const neighborIds = [...form.neighbors.keys()]
    absorbForm(form, target, selectedForms, absorbedInto)
    rejected.delete(form.id)
    for (const neighborId of neighborIds) enqueueIfReady(neighborId)
  }

  return absorbedInto
}

function finalRegionId(
  regionId: number,
  absorbedInto: ReadonlyMap<number, number>,
): number {
  let finalId = regionId
  while (absorbedInto.has(finalId)) finalId = absorbedInto.get(finalId)!
  return finalId
}

/** Select an authored hierarchy cut and suppress insignificant forms. */
export function selectWatercolorForms(
  hierarchy: Readonly<RegionHierarchy>,
  formDetailInput: number,
): Readonly<WatercolorFormSelection> {
  const formDetail = clampUnit(formDetailInput)
  const cutHeight = 1 - formDetail
  const { regionByInitialRegion, selectedRegionIds } = selectedAncestors(
    hierarchy,
    cutHeight,
  )
  if (selectedRegionIds.length === 0) {
    return Object.freeze({
      hierarchy,
      regionIds: EMPTY_NUMBERS,
      regionBySample: Object.freeze(
        hierarchy.partition.regionBySample.map(
          () => TRANSPARENT_SUPPORT_REGION_ID,
        ),
      ),
    })
  }

  const summaries = new Map(
    hierarchy.regions.map((region) => [region.id, region]),
  )
  const persistences = persistenceByRegion(hierarchy)
  const totalSampleCount = Math.max(
    1,
    hierarchy.partition.raster.width * hierarchy.partition.raster.height,
  )
  const detailRemainder = 1 - formDetail
  const authoredMinimumArea = Math.min(
    totalSampleCount,
    1 +
      Math.floor(
        detailRemainder *
          detailRemainder *
          Math.min(MAX_MINIMUM_FORM_AREA - 1, totalSampleCount - 1),
      ),
  )
  // A work-limited hierarchy over arbitrary high-entropy input can otherwise
  // admit almost one singleton per sample. Once that incomplete hierarchy's
  // form density crosses this fixed safety threshold, require enough
  // hierarchy-backed area to represent a drawable form. Completed hierarchies
  // retain the authored detail policy. Rejected leaves still contract through
  // their weakest selected interface, so this preserves coherent region
  // ownership instead of taking an arbitrary boundary or primitive prefix.
  const underAdversarialFormPressure =
    !hierarchy.complete &&
    selectedRegionIds.length >
    Math.ceil(totalSampleCount / ADVERSARIAL_FORM_DENSITY_DIVISOR)
  const minimumArea = underAdversarialFormPressure
    ? Math.max(authoredMinimumArea, ADVERSARIAL_MINIMUM_FORM_AREA)
    : authoredMinimumArea
  const minimumPersistence =
    detailRemainder *
    detailRemainder *
    MAX_MINIMUM_FORM_PERSISTENCE
  const selectedForms = new Map<number, MutableSelectedForm>()
  const qualifies = (regionId: number): boolean => {
    const summary = summaries.get(regionId)
    return (
      summary !== undefined &&
      summary.sampleCount >= minimumArea &&
      (persistences.get(regionId) ?? 0) >= minimumPersistence
    )
  }
  for (const regionId of selectedRegionIds) {
    const summary = summaries.get(regionId)
    if (summary === undefined) continue
    const persistence = persistences.get(regionId) ?? 0
    selectedForms.set(regionId, {
      id: regionId,
      sampleCount: summary.sampleCount,
      persistence,
      retained: qualifies(regionId),
      neighbors: new Map(),
    })
  }

  buildSelectedAdjacency(hierarchy, regionByInitialRegion, selectedForms)
  preserveQualifiedAncestorCoverage(
    hierarchy,
    selectedForms,
    qualifies,
  )
  const absorbedInto = contractRejectedForms(selectedForms)
  const regionBySample = hierarchy.partition.regionBySample.map(
    (initialRegionId) => {
      if (initialRegionId === TRANSPARENT_SUPPORT_REGION_ID) {
        return TRANSPARENT_SUPPORT_REGION_ID
      }
      const selectedRegionId = regionByInitialRegion.get(initialRegionId)
      return selectedRegionId === undefined
        ? TRANSPARENT_SUPPORT_REGION_ID
        : finalRegionId(selectedRegionId, absorbedInto)
    },
  )
  const regionIds = [...new Set(regionBySample)]
    .filter((regionId) => regionId !== TRANSPARENT_SUPPORT_REGION_ID)
    .sort((first, second) => first - second)

  return Object.freeze({
    hierarchy,
    regionIds: Object.freeze(regionIds),
    regionBySample: Object.freeze(regionBySample),
  })
}

/**
 * @internal Operation-count seam proving that hierarchy-cut leaf ownership is
 * path-compressed rather than repeatedly walking a deep comb.
 */
export function watercolorFormCutAncestorTraversalsForTest(
  hierarchy: Readonly<RegionHierarchy>,
  formDetailInput: number,
): number {
  const metrics: AncestorResolutionMetrics = {
    ancestorTraversalCount: 0,
  }
  selectedAncestors(hierarchy, 1 - clampUnit(formDetailInput), metrics)
  return metrics.ancestorTraversalCount
}
