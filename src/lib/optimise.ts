import { predict, type Atmosphere } from './acoustics.ts'
import { poses, type ArrayModel } from './geometry.ts'
import type { SectionPoint } from './section.ts'

export interface Goal {
  /** Bands whose traces must be flat (ArrayCalc's curve 1 is picked from these). */
  flatBands: number[]
  /** Bands that must only run parallel to the flat ones (the LF curve, set by array length). */
  trackBands: number[]
  /** Target level drop in dB per doubling of distance. 0 = even level front to back. */
  slopePerDoubling: number
  /** Weight of trace coherence (bands running parallel) against flatness. */
  coherenceWeight: number
  /** Weight of the worst-seat deviation against the RMS one. */
  worstWeight: number
}

export interface Limits {
  /** Allowed nominal splay per hinge, whole degrees. */
  splayMin: number
  splayMax: number
  splayStep: number
  frameMin: number
  frameMax: number
  frameStep: number
  /** Splays may only stay equal or grow down the array (a J, never an S). */
  monotonic: boolean
}

export interface Candidate {
  frameAngle: number
  splays: number[]
}

export interface Score {
  total: number
  /** RMS deviation from the target shape, averaged over flatBands, dB. */
  flatness: number
  /** RMS spread between bands after each band's own offset is removed, dB. */
  coherence: number
  /** Largest single-seat deviation over flatBands, dB. */
  worst: number
}

export interface Evaluation {
  score: Score
  /** Horizontal distance from the frame along the aim, as ArrayCalc's plot's x axis; band levels in band order. */
  distance: number[]
  bands: number[]
  levels: number[][]
  /** Target shape at each point, offset to sit on the flat bands' mean. */
  target: number[]
}

export interface Problem {
  model: ArrayModel
  points: SectionPoint[]
  atmosphere: Atmosphere
  goal: Goal
  limits: Limits
}

export function evaluate(p: Problem, c: Candidate): Evaluation {
  const boxes = poses(p.model, c.frameAngle, c.splays)
  const bands = [...p.goal.flatBands, ...p.goal.trackBands]
  const L = predict(boxes, p.points, bands, {
    atmosphere: p.atmosphere,
    levels: p.model.levels,
    mutes: p.model.mutes,
  })
  const m = p.points.length
  // The level-drop target runs on true (slant) distance from the frame; the plot uses horizontal distance.
  const dist = p.points.map((q) => Math.hypot(q.u, q.z))
  const d0 = Math.max(1, Math.min(...dist))
  const shape = dist.map((d) => -p.goal.slopePerDoubling * Math.log2(Math.max(d, 1) / d0))

  const nFlat = p.goal.flatBands.length
  const resid: Float64Array[] = L.map((band) => {
    const e = new Float64Array(m)
    let mean = 0
    for (let j = 0; j < m; j++) mean += (e[j] = band[j] - shape[j])
    mean /= m
    for (let j = 0; j < m; j++) e[j] -= mean
    return e
  })

  let flat = 0, worst = 0
  for (let b = 0; b < nFlat; b++) {
    let s = 0
    for (let j = 0; j < m; j++) {
      s += resid[b][j] ** 2
      worst = Math.max(worst, Math.abs(resid[b][j]))
    }
    flat += Math.sqrt(s / m)
  }
  flat /= Math.max(1, nFlat)

  let coh = 0
  if (resid.length > 1) {
    for (let j = 0; j < m; j++) {
      let mu = 0
      for (const e of resid) mu += e[j]
      mu /= resid.length
      let v = 0
      for (const e of resid) v += (e[j] - mu) ** 2
      coh += v / resid.length
    }
    coh = Math.sqrt(coh / m)
  }

  const total = flat + p.goal.coherenceWeight * coh + p.goal.worstWeight * worst
  let flatMean = 0
  for (let b = 0; b < nFlat; b++) for (let j = 0; j < m; j++) flatMean += L[b][j] - shape[j]
  flatMean /= Math.max(1, nFlat * m)
  return {
    score: { total, flatness: flat, coherence: coh, worst },
    distance: p.points.map((q) => q.u),
    bands,
    levels: L.map((a) => Array.from(a)),
    target: shape.map((s) => s + flatMean),
  }
}

export function feasible(l: Limits, c: Candidate): boolean {
  if (c.frameAngle < l.frameMin - 1e-9 || c.frameAngle > l.frameMax + 1e-9) return false
  for (let i = 1; i < c.splays.length; i++) {
    const s = c.splays[i]
    if (s < l.splayMin - 1e-9 || s > l.splayMax + 1e-9) return false
    if (l.monotonic && i > 1 && s < c.splays[i - 1] - 1e-9) return false
  }
  return true
}

const snap = (v: number, step: number) => Math.round(v / step) * step
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Bring any candidate inside the limits (used on the as-loaded splays and on seeds). */
export function repair(l: Limits, c: Candidate): Candidate {
  const splays = c.splays.map((s, i) => (i === 0 ? 0 : clamp(snap(s, l.splayStep), l.splayMin, l.splayMax)))
  if (l.monotonic) for (let i = 2; i < splays.length; i++) splays[i] = Math.max(splays[i], splays[i - 1])
  return { frameAngle: clamp(snap(c.frameAngle, l.frameStep), l.frameMin, l.frameMax), splays }
}

/** Seeds: as loaded, constant, and progressive curves of several total angles. */
export function seeds(p: Problem): Candidate[] {
  const n = p.model.heights.length
  const l = p.limits
  const out: Candidate[] = [repair(l, { frameAngle: p.model.frameAngle, splays: p.model.splays })]
  // Aim the top box at the farthest seat, as ArrayCalc's auto splay does.
  const far = p.points.reduce((a, b) => (Math.hypot(b.u, b.z) > Math.hypot(a.u, a.z) ? b : a), p.points[0])
  const aimFar = (Math.atan2(far.z, far.u) * 180) / Math.PI
  const near = p.points.reduce((a, b) => (Math.hypot(b.u, b.z) < Math.hypot(a.u, a.z) ? b : a), p.points[0])
  const aimNear = (Math.atan2(near.z, near.u) * 180) / Math.PI
  const needed = Math.max(0, aimFar - aimNear)
  for (const total of [needed * 0.6, needed * 0.8, needed, needed * 1.2]) {
    for (const power of [0, 1, 2]) {
      const w = Array.from({ length: n }, (_, i) => (i === 0 ? 0 : i ** power))
      const sum = w.reduce((a, b) => a + b, 0) || 1
      out.push(repair(l, { frameAngle: aimFar, splays: w.map((x) => (x / sum) * total) }))
    }
  }
  return out
}

export interface Progress {
  best: Candidate
  score: Score
  evaluations: number
  phase: string
}

function key(c: Candidate) {
  return `${c.frameAngle.toFixed(3)}|${c.splays.join(',')}`
}

/**
 * Iterated local search over the discrete splay grid and the frame angle.
 * Moves: one hinge ±1–2 steps; one step moved between two nearby hinges (keeps the total);
 * the frame angle by several step sizes. Kicks of 2–4 random moves escape local minima.
 */
export function* optimise(p: Problem, opts: { maxEvaluations?: number; seed?: number } = {}): Generator<Progress, Progress> {
  const maxEval = opts.maxEvaluations ?? 6000
  let rng = opts.seed ?? 12345
  const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const cache = new Map<string, number>()
  let evals = 0
  const cost = (c: Candidate): number => {
    const k = key(c)
    const hit = cache.get(k)
    if (hit !== undefined) return hit
    evals++
    const v = feasible(p.limits, c) ? evaluate(p, c).score.total : Infinity
    cache.set(k, v)
    return v
  }
  const l = p.limits
  const n = p.model.heights.length

  let best: Candidate = seeds(p).reduce((a, b) => (cost(b) < cost(a) ? b : a))
  let bestCost = cost(best)
  const report = (phase: string): Progress => ({ best, score: evaluate(p, best).score, evaluations: evals, phase })
  yield report('seeded')

  const neighbours = function* (c: Candidate): Generator<Candidate> {
    for (const d of [l.frameStep, 5 * l.frameStep, 10 * l.frameStep, 20 * l.frameStep]) {
      for (const s of [-1, 1]) yield { frameAngle: +(c.frameAngle + s * d).toFixed(6), splays: c.splays }
    }
    for (let i = 1; i < n; i++) {
      for (const d of [-2, -1, 1, 2]) {
        const splays = c.splays.slice()
        splays[i] += d * l.splayStep
        yield { frameAngle: c.frameAngle, splays }
      }
      for (let j = Math.max(1, i - 3); j <= Math.min(n - 1, i + 3); j++) {
        if (j === i) continue
        const splays = c.splays.slice()
        splays[i] += l.splayStep
        splays[j] -= l.splayStep
        yield { frameAngle: c.frameAngle, splays }
      }
    }
  }

  // Best-improvement descent. Yields after every step so the UI sees progress mid-descent.
  const descend = function* (start: Candidate, startCost: number, phase: string): Generator<Progress, [Candidate, number]> {
    let cur = start, curCost = startCost
    for (let improved = true; improved && evals < maxEval; ) {
      improved = false
      let nb = cur, nbCost = curCost
      for (const c of neighbours(cur)) {
        const v = cost(c)
        if (v < nbCost - 1e-9) { nb = c; nbCost = v }
        if (evals >= maxEval) break
      }
      if (nbCost < curCost - 1e-9) {
        cur = nb
        curCost = nbCost
        improved = true
        if (curCost < bestCost - 1e-9) {
          best = cur
          bestCost = curCost
        }
      }
      yield report(phase)
    }
    return [cur, curCost]
  }

  yield* descend(best, bestCost, 'descent')

  while (evals < maxEval) {
    // Kick: a few random single-hinge moves plus a frame nudge, then descend again.
    let c: Candidate = { frameAngle: best.frameAngle, splays: best.splays.slice() }
    const kicks = 2 + Math.floor(rand() * 3)
    for (let k = 0; k < kicks; k++) {
      const i = 1 + Math.floor(rand() * (n - 1))
      c.splays[i] += (rand() < 0.5 ? -1 : 1) * l.splayStep * (1 + Math.floor(rand() * 2))
    }
    c.frameAngle += (rand() - 0.5) * 20 * l.frameStep
    c = repair(l, c)
    yield* descend(c, cost(c), 'search')
  }
  return report('done')
}
