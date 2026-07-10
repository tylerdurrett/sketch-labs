import { lerp } from '../../math'

/** A scalar potential whose rotated gradient supplies a two-dimensional curl field. */
export type PotentialField = (x: number, y: number) => number

export interface VortexSphereRequest {
  /** Requested sphere radius in the potential field's coordinate space. */
  radius: number
  /** Seeded [0, 1] anchor used only to break otherwise equal candidate scores. */
  tieBreaker: readonly [number, number]
}

export interface VortexSphere {
  cx: number
  cy: number
  r: number
}

interface Candidate {
  cx: number
  cy: number
  score: number
  tieDistance: number
}

const GRID_STEPS = 20
const RING_SAMPLES = 16
const REFINEMENT_STEPS = 5
const SEPARATION_FACTORS = [0.6, 0.4, 0.2, Number.EPSILON] as const

function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5
}

/**
 * Score how closely the potential around a proposed sphere resembles a round,
 * vortex-like region. Curl follows the potential's contour lines, so a center
 * value consistently above/below a low-variance ring means the visible flow is
 * coherently tangent to that circle. True hills and basins score especially
 * well, while exact-count fallback still permits the best available candidate.
 */
function vortexScore(
  potentialAt: PotentialField,
  cx: number,
  cy: number,
  radius: number,
): number {
  const center = potentialAt(cx, cy)
  if (!Number.isFinite(center)) return Number.NEGATIVE_INFINITY

  let sum = 0
  let sumSquares = 0
  let above = 0
  let below = 0

  for (let i = 0; i < RING_SAMPLES; i++) {
    const angle = (i / RING_SAMPLES) * Math.PI * 2
    const value = potentialAt(
      cx + Math.cos(angle) * radius,
      cy + Math.sin(angle) * radius,
    )
    if (!Number.isFinite(value)) return Number.NEGATIVE_INFINITY
    sum += value
    sumSquares += value * value
    if (value >= center) above++
    if (value <= center) below++
  }

  const mean = sum / RING_SAMPLES
  const variance = Math.max(0, sumSquares / RING_SAMPLES - mean * mean)
  const contrast = Math.abs(center - mean)
  const oneSidedness = Math.max(above, below) / RING_SAMPLES

  // Contrast rejects straight/sloping flow; ring variance rejects stretched or
  // turbulent contours; one-sidedness rejects saddles crossing the center value.
  return (contrast * contrast * oneSidedness ** 4) / (Math.sqrt(variance) + 1e-3)
}

function isSeparated(
  candidate: Pick<Candidate, 'cx' | 'cy'>,
  radius: number,
  placed: readonly VortexSphere[],
  factor: number,
): boolean {
  return placed.every(
    (sphere) =>
      Math.hypot(candidate.cx - sphere.cx, candidate.cy - sphere.cy) >=
      (radius + sphere.r) * factor,
  )
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    b.score - a.score ||
    a.tieDistance - b.tieDistance ||
    a.cy - b.cy ||
    a.cx - b.cx
  )
}

function candidatesFor(
  potentialAt: PotentialField,
  width: number,
  height: number,
  request: VortexSphereRequest,
): { candidates: Candidate[]; radius: number; stepX: number; stepY: number } {
  const radius = Math.min(Math.max(0, request.radius), width / 2, height / 2)
  const minX = radius
  const maxX = width - radius
  const minY = radius
  const maxY = height - radius
  const stepX = (maxX - minX) / GRID_STEPS
  const stepY = (maxY - minY) / GRID_STEPS
  const anchorX = lerp(minX, maxX, clampUnit(request.tieBreaker[0]))
  const anchorY = lerp(minY, maxY, clampUnit(request.tieBreaker[1]))
  const normalizerX = Math.max(1, maxX - minX)
  const normalizerY = Math.max(1, maxY - minY)
  const candidates: Candidate[] = []

  for (let row = 0; row <= GRID_STEPS; row++) {
    const cy = lerp(minY, maxY, row / GRID_STEPS)
    for (let col = 0; col <= GRID_STEPS; col++) {
      const cx = lerp(minX, maxX, col / GRID_STEPS)
      candidates.push({
        cx,
        cy,
        score: vortexScore(potentialAt, cx, cy, radius),
        tieDistance: Math.hypot((cx - anchorX) / normalizerX, (cy - anchorY) / normalizerY),
      })
    }
  }

  candidates.sort(compareCandidates)
  return { candidates, radius, stepX, stepY }
}

function refineCandidate(
  potentialAt: PotentialField,
  initial: Candidate,
  radius: number,
  width: number,
  height: number,
  initialStepX: number,
  initialStepY: number,
  placed: readonly VortexSphere[],
  separationFactor: number,
  tieBreaker: readonly [number, number],
): Candidate {
  let best = initial
  let stepX = initialStepX / 2
  let stepY = initialStepY / 2
  const minX = radius
  const maxX = width - radius
  const minY = radius
  const maxY = height - radius
  const anchorX = lerp(minX, maxX, clampUnit(tieBreaker[0]))
  const anchorY = lerp(minY, maxY, clampUnit(tieBreaker[1]))
  const normalizerX = Math.max(1, maxX - minX)
  const normalizerY = Math.max(1, maxY - minY)

  for (let iteration = 0; iteration < REFINEMENT_STEPS; iteration++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = Math.min(width - radius, Math.max(radius, best.cx + dx * stepX))
        const cy = Math.min(height - radius, Math.max(radius, best.cy + dy * stepY))
        const candidate: Candidate = {
          cx,
          cy,
          score: vortexScore(potentialAt, cx, cy, radius),
          tieDistance: Math.hypot(
            (cx - anchorX) / normalizerX,
            (cy - anchorY) / normalizerY,
          ),
        }
        if (
          isSeparated(candidate, radius, placed, separationFactor) &&
          compareCandidates(candidate, best) < 0
        ) {
          best = candidate
        }
      }
    }
    stepX /= 2
    stepY /= 2
  }

  return best
}

/**
 * Place an exact requested set of spheres at the strongest circular-coherence
 * candidates in a scalar potential. Request order is preserved so increasing
 * sphereCount keeps the existing prefix stable. Successively relaxed separation
 * keeps distinct candidates preferred without making an exact count impossible
 * in a small feasible center region.
 */
export function placeSpheresAtVortices(
  potentialAt: PotentialField,
  width: number,
  height: number,
  requests: readonly VortexSphereRequest[],
): VortexSphere[] {
  if (!(width > 0) || !(height > 0) || requests.length === 0) return []

  const placed: VortexSphere[] = []
  const byRequest = new Array<VortexSphere>(requests.length)
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index]!
    const { candidates, radius, stepX, stepY } = candidatesFor(
      potentialAt,
      width,
      height,
      request,
    )
    let chosen = candidates[0]!
    let separationFactor = 0

    for (const factor of SEPARATION_FACTORS) {
      const separated = candidates.find((candidate) =>
        isSeparated(candidate, radius, placed, factor),
      )
      if (separated !== undefined) {
        chosen = separated
        separationFactor = factor
        break
      }
    }

    chosen = refineCandidate(
      potentialAt,
      chosen,
      radius,
      width,
      height,
      stepX,
      stepY,
      placed,
      separationFactor,
      request.tieBreaker,
    )
    const sphere = { cx: chosen.cx, cy: chosen.cy, r: radius }
    placed.push(sphere)
    byRequest[index] = sphere
  }

  return byRequest
}
