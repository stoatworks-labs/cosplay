/**
 * What the page decides about a loaded project before the optimiser sees it.
 *
 * Which groups are arrays to offer and which are skipped, the goal each array starts with,
 * which listener points the search runs on, and how a hand edit is clamped. These lived in
 * App.tsx; they are here so the MCP server (src/mcp/) asks the optimiser exactly the
 * question the page asks. Two front ends building their own `Problem` would score the same
 * splays differently, and neither would look wrong.
 */

import { linkedFollowers } from './dbpr.ts'
import { buildModel, unsupportedReason, type ArrayModel } from './geometry.ts'
import { repair, type Candidate, type Goal, type Limits, type Problem } from './optimise.ts'
import type { SectionSegment } from './section.ts'
import { splayRange } from './systems.ts'
import type { Project } from './types.ts'
import type { PlannedArray } from './write.ts'

/** The bands a trace can be kept flat in, and the ones that may only track them. */
export const HF_BANDS = [1000, 2000, 4000, 8000]
export const LF_BANDS = [63, 125, 250, 500]
/** Evaluations per search effort. */
export const EFFORT = { quick: 1500, normal: 5000, thorough: 15000 } as const
/** Metres between listener points along the section. The search takes every second one. */
export const SECTION_STEP = 0.25

export interface Settings {
  flatBands: number[]
  trackBand: number | null
  slope: number
  coherenceWeight: number
  fromM: number
  toM: number
  splayMin: number
  splayMax: number
  monotonic: boolean
  frameSpan: number
  effort: keyof typeof EFFORT
  excludedPlanes: number[]
}

/** Everything held for one array, kept while the others are worked on. */
export interface Plan {
  settings: Settings
  proposal: Candidate | null
  copyTo: number[]
}

export function defaultSettings(m: ArrayModel): Settings {
  const r = splayRange(m.names)
  return {
    flatBands: [2000, 4000, 8000],
    trackBand: 250,
    slope: 0,
    coherenceWeight: 0.5,
    fromM: 0,
    toM: 1000,
    splayMin: r.min,
    splayMax: r.max,
    monotonic: true,
    frameSpan: 10,
    effort: 'normal',
    excludedPlanes: [],
  }
}

export interface Arrays {
  /** Every group that can be laid out, linked followers included (they are written, never listed). */
  all: ArrayModel[]
  /** What the array picker offers: ArrayCalc's source-list entries, so a linked L/R pair is one. */
  models: ArrayModel[]
  followers: Set<number>
  skipped: { name: string; why: string }[]
}

/** The project's arrays, sorted into the ones Cosplay can work on and the ones it cannot. */
export function arraysOf(project: Project): Arrays {
  const followers = linkedFollowers(project.groups)
  const all: ArrayModel[] = []
  const skipped: Arrays['skipped'] = []
  for (const g of project.groups) {
    if (g.type === 5) continue
    const why = unsupportedReason(g)
    if (!why) all.push(buildModel(g))
    else if (!followers.has(g.sourceGroupId)) skipped.push({ name: g.name, why })
  }
  const models = all.filter((m) => !followers.has(m.group.sourceGroupId))
  if (!models.length) throw new Error('This project has no vertically flown line array Cosplay can work on.')
  return { all, models, followers, skipped }
}

/**
 * The search's question: the listener points in range on the planes left in, at every
 * second section step, and the goal and rigging limits from the settings. Null when fewer
 * than four points are left, which is too few to say anything about a level trace.
 */
export function searchProblem(model: ArrayModel, settings: Settings, segments: SectionSegment[], project: Project): Problem | null {
  const points = segments
    .filter((s) => !settings.excludedPlanes.includes(s.planeId))
    .flatMap((s) => s.points)
    .filter((p) => p.u >= settings.fromM && p.u <= settings.toM)
    .filter((_, i) => i % 2 === 0) // 0.5 m for the search; the chart draws every point
  if (points.length < 4) return null
  const goal: Goal = {
    flatBands: settings.flatBands.length ? settings.flatBands : [4000],
    trackBands: settings.trackBand ? [settings.trackBand] : [],
    slopePerDoubling: settings.slope,
    coherenceWeight: settings.coherenceWeight,
    worstWeight: 0.1,
  }
  const limits: Limits = {
    splayMin: settings.splayMin,
    splayMax: settings.splayMax,
    splayStep: 1,
    frameMin: +(model.frameAngle - settings.frameSpan).toFixed(1),
    frameMax: +(model.frameAngle + settings.frameSpan).toFixed(1),
    frameStep: 0.1,
    monotonic: settings.monotonic,
  }
  return { model, points, atmosphere: project, goal, limits }
}

/** The same question at full resolution, every plane left in, for drawing the traces. */
export function drawingProblem(problem: Problem, segments: SectionSegment[], settings: Settings): Problem {
  const points = segments.filter((s) => !settings.excludedPlanes.includes(s.planeId)).flatMap((s) => s.points)
  return { ...problem, points }
}

/**
 * A hand edit: snapped and clamped to the range, but NOT forced to grow down the array.
 * The person editing may mean the S; the page says when it breaks the rule rather than
 * quietly rewriting the boxes below.
 */
export function handEdit(limits: Limits, c: Candidate): Candidate {
  return repair({ ...limits, monotonic: false }, c)
}

/** Every array with a proposal, in the picker's order, with the look-alikes it is copied to: what one download writes. */
export function plannedArrays(arrays: Pick<Arrays, 'models'>, plans: Record<number, Plan>): PlannedArray[] {
  return arrays.models.flatMap((m) => {
    const p = plans[m.group.sourceGroupId]
    return p?.proposal ? [{ model: m, candidate: p.proposal, copyTo: arrays.models.filter((t) => p.copyTo.includes(t.group.sourceGroupId)) }] : []
  })
}

/** The name a changed copy is saved under: beside the original, never over it. */
export function copyName(fileName: string): string {
  return fileName.replace(/\.dbpr$/i, '') + ' (cosplay).dbpr'
}
