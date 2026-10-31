/**
 * One open project and what has been decided about it, for the MCP tools.
 *
 * Holds what the page holds — the project as read, its arrays, and a `Plan` per array — and
 * asks the library the page's questions through `lib/session.ts`, so a proposal made here
 * scores and writes exactly as one made in the browser. Nothing in this file predicts a
 * level, lays out a hang or touches the database except through `lib/`.
 *
 * Splays are reported and taken as the hinge list, box 2 down: the degrees between each box
 * and the one above it. The library's own list leads with a 0 for the top box, which is
 * a fact about the data structure, and a model handed it would count one hinge too many.
 */

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { linkedChain, readProject } from '../lib/dbpr.ts'
import { unsupportedReason, buildModel, type ArrayModel } from '../lib/geometry.ts'
import { evaluate, feasible, optimise, type Candidate, type Problem, type Score } from '../lib/optimise.ts'
import { sectionSegments, type SectionSegment } from '../lib/section.ts'
import {
  EFFORT,
  SECTION_STEP,
  arraysOf,
  copyName,
  defaultSettings,
  drawingProblem,
  handEdit,
  plannedArrays,
  searchProblem,
  type Arrays,
  type Plan,
  type Settings,
} from '../lib/session.ts'
import { splayRange } from '../lib/systems.ts'
import type { Project } from '../lib/types.ts'
import { linkedTargets, planWrites, twins, writeCandidate } from '../lib/write.ts'
import { ToolError, type ToolContext } from './protocol.ts'

export interface Session {
  path: string
  fileName: string
  /** The file as opened. Every write starts again from these bytes, as the page's download does. */
  bytes: Uint8Array
  project: Project
  arrays: Arrays
  plans: Record<number, Plan>
  segments: Map<number, SectionSegment[]>
}

let sqlPromise: Promise<SqlJsStatic> | null = null
const sql = () => (sqlPromise ??= initSqlJs())

/** What the model is told every time it is shown a level: whose prediction it is. */
export const MODEL_CAVEAT =
  "Levels are Cosplay's own line-source model, not d&b's data, and relative: ArrayCalc has the final word. " +
  'Open the written copy there and check the Sources page and the rigging loads before anyone rigs from it.'

const COMPRESSION = /^(GSL|KSL|XSL|CCL)/

export async function openProject(path: string): Promise<Session> {
  if (!existsSync(path)) throw new ToolError(`No such file: ${path}`)
  const fileName = basename(path)
  const bytes = new Uint8Array(await readFile(path))
  const SQL = await sql()
  let project: Project
  const db = new SQL.Database(bytes)
  try {
    project = readProject(db, fileName)
  } catch (e) {
    throw new ToolError(`${fileName} could not be read as an ArrayCalc project (.dbpr): ${(e as Error).message}`)
  } finally {
    db.close()
  }
  let arrays: Arrays
  try {
    arrays = arraysOf(project)
  } catch (e) {
    const why = project.groups.filter((g) => g.type !== 5).map((g) => `${g.name} (#${g.sourceGroupId}): ${unsupportedReason(g) ?? 'readable'}`)
    throw new ToolError(`${(e as Error).message}${why.length ? `\n- ${why.join('\n- ')}` : ''}`)
  }
  return { path, fileName, bytes, project, arrays, plans: {}, segments: new Map() }
}

const ref = (m: ArrayModel) => ({ id: m.group.sourceGroupId, name: m.group.name })
/** An array in a list: id and name in one string, so a list of them reads on one line. */
const tag = (m: ArrayModel) => `#${m.group.sourceGroupId} ${m.group.name}`
const hinges = (splays: number[]) => splays.slice(1)
const asLoaded = (m: ArrayModel): Candidate => ({ frameAngle: m.frameAngle, splays: m.splays })
const angles = (c: Candidate) => ({ frameAngle: +c.frameAngle.toFixed(3), splays: hinges(c.splays) })

/**
 * The array a tool means: by ArrayCalc source-group id, or by name. Optional when the
 * project has only one array to work on. A linked follower is refused by name, with its
 * leader: in ArrayCalc it has no angles of its own.
 */
export function pickArray(s: Session, which: unknown): ArrayModel {
  const { models, followers } = s.arrays
  const list = () => models.map((m) => `#${m.group.sourceGroupId} ${m.group.name}`).join(', ')
  if (which === undefined) {
    if (models.length === 1) return models[0]
    throw new ToolError(`This project has ${models.length} arrays; say which: ${list()}`)
  }
  const byId = typeof which === 'number'
  const hits = byId
    ? models.filter((m) => m.group.sourceGroupId === which)
    : models.filter((m) => m.group.name.toLowerCase() === String(which).trim().toLowerCase())
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) {
    throw new ToolError(`More than one array is called "${which}": ${hits.map((m) => `#${m.group.sourceGroupId}`).join(', ')}. Use the id.`)
  }
  const group = s.project.groups.find((g) => (byId ? g.sourceGroupId === which : g.name.toLowerCase() === String(which).trim().toLowerCase()))
  if (group && followers.has(group.sourceGroupId)) {
    const leader = models.find((m) => linkedChain(s.project.groups, m.group).some((g) => g.sourceGroupId === group.sourceGroupId))
    throw new ToolError(
      `${group.name} (#${group.sourceGroupId}) is linked in ArrayCalc` +
        (leader ? ` to ${leader.group.name} (#${leader.group.sourceGroupId}), and always takes its angles. Work on that one.` : ' and takes another array’s angles.'),
    )
  }
  if (group) throw new ToolError(`${group.name} (#${group.sourceGroupId}) cannot be optimised: ${unsupportedReason(group) ?? 'unused channels'}.`)
  throw new ToolError(`No array ${byId ? '#' : ''}${which}. Arrays: ${list()}`)
}

/** The array's plan, made with the page's defaults the first time it is asked for. */
function planOf(s: Session, m: ArrayModel): Plan {
  return (s.plans[m.group.sourceGroupId] ??= { settings: defaultSettings(m), proposal: null, copyTo: [] })
}

function segmentsOf(s: Session, m: ArrayModel): SectionSegment[] {
  const id = m.group.sourceGroupId
  let seg = s.segments.get(id)
  if (!seg) s.segments.set(id, (seg = sectionSegments(m, s.project.planes, SECTION_STEP)))
  return seg
}

/** The search's question for this array as its settings stand, or null with the reason. */
function problemOf(s: Session, m: ArrayModel): { problem: Problem | null; why?: string } {
  const plan = planOf(s, m)
  const problem = searchProblem(m, plan.settings, segmentsOf(s, m), s.project)
  if (problem) return { problem }
  const seg = segmentsOf(s, m)
  return {
    problem: null,
    why: seg.length
      ? 'Fewer than four listener points are left in range on the planes left in. Widen fromM/toM or include more planes (set_goal).'
      : 'No listening plane crosses this array’s horizontal aim, so there is no level trace to flatten.',
  }
}

function needProblem(s: Session, m: ArrayModel): Problem {
  const { problem, why } = problemOf(s, m)
  if (!problem) throw new ToolError(`${m.group.name} (#${m.group.sourceGroupId}): ${why}`)
  return problem
}

/** The page's three score cards, named as the page names them, and the total the search minimises. */
const scoreOf = (sc: Score) => ({
  total: sc.total,
  flatness: sc.flatness,
  bandSpread: sc.coherence,
  worstSeat: sc.worst,
})

function scores(s: Session, m: ArrayModel, problem: Problem | null) {
  if (!problem) return null
  const p = planOf(s, m).proposal
  return {
    asLoaded: scoreOf(evaluate(problem, asLoaded(m)).score),
    proposed: p ? scoreOf(evaluate(problem, p).score) : null,
  }
}

function warningsOf(s: Session, m: ArrayModel): string[] {
  const out: string[] = []
  if (m.group.arrayProcessing) out.push('ArrayProcessing is on for this array. New splays invalidate its AP slots; recalculate them in ArrayCalc.')
  const { problems } = linkedTargets(s.arrays.all, s.project.groups, m)
  if (problems.length) out.push(`Linked in ArrayCalc but not written, so ArrayCalc may disagree with the file: ${problems.join('; ')}.`)
  if (m.names.some((n) => COMPRESSION.test(n))) out.push(splayRange(m.names).note ?? 'compression rigging: ArrayCalc deflects each splay under load')
  return out
}

/** One line per array, for open_project and status. */
export function arraySummary(s: Session, m: ArrayModel) {
  const plan = s.plans[m.group.sourceGroupId]
  return {
    ...ref(m),
    boxes: m.names.length,
    types: [...new Set(m.names)],
    asLoaded: angles(asLoaded(m)),
    proposed: plan?.proposal ? angles(plan.proposal) : null,
    linkedTo: linkedTargets(s.arrays.all, s.project.groups, m).targets.map(tag),
    lookAlikes: twins(s.arrays.models, m, s.arrays.followers).map(tag),
  }
}

export function projectReport(s: Session) {
  return {
    file: s.path,
    project: s.project.name,
    temperatureC: +(s.project.temperatureK - 273.15).toFixed(1),
    humidityPercent: s.project.humidity,
    arrays: s.arrays.models.map((m) => arraySummary(s, m)),
    skipped: s.arrays.skipped,
    listeningPlanes: s.project.planes.length,
    warnings: s.project.warnings,
  }
}

export function describeArray(s: Session, m: ArrayModel) {
  const plan = planOf(s, m)
  const { problem, why } = problemOf(s, m)
  const range = splayRange(m.names)
  const proposal = plan.proposal
  return {
    ...arraySummary(s, m),
    cabinets: m.names,
    ...(m.levels.some((l) => l) ? { levelTrimDb: m.levels } : {}),
    ...(m.mutes.some((x) => x) ? { mutedBoxes: m.mutes.flatMap((x, i) => (x ? [i + 1] : [])) } : {}),
    splayRange: { min: range.min, max: range.max, ...(range.note ? { note: range.note } : {}) },
    // toM 1000 is the page's "to the end"; null says so without a magic number.
    goal: { ...plan.settings, toM: plan.settings.toM >= 1000 ? null : plan.settings.toM },
    planesOnAxis: segmentsOf(s, m).map((seg) => ({
      id: seg.planeId,
      name: seg.name,
      fromM: seg.points[0].u,
      toM: seg.points[seg.points.length - 1].u,
      included: !plan.settings.excludedPlanes.includes(seg.planeId),
    })),
    searchPoints: problem ? problem.points.length : 0,
    ...(why ? { cannotOptimise: why } : {}),
    scores: scores(s, m, problem),
    ...(proposal && problem && !feasible(problem.limits, proposal)
      ? { proposalBreaksLimits: 'The proposed angles break the “only grow” rule or the frame range of the current goal.' }
      : {}),
    copyTo: plan.copyTo,
    warnings: warningsOf(s, m),
  }
}

export type GoalPatch = Partial<Omit<Settings, 'toM'>> & { toM?: number | null; reset?: boolean }

/**
 * Change an array's goal, as the page's controls do. The proposal is kept and re-scored,
 * also as on the page: a goal change asks a different question of the same angles.
 */
export function setGoal(s: Session, m: ArrayModel, patch: GoalPatch) {
  const plan = planOf(s, m)
  const { reset, toM, ...rest } = patch
  const next: Settings = { ...(reset ? defaultSettings(m) : plan.settings), ...rest }
  if (toM !== undefined) next.toM = toM ?? 1000
  if (next.splayMin > next.splayMax) throw new ToolError(`splayMin ${next.splayMin} is above splayMax ${next.splayMax}.`)
  if (next.fromM >= next.toM) throw new ToolError(`fromM ${next.fromM} is not before toM ${next.toM}.`)
  const known = new Set(s.project.planes.map((p) => p.venueObjectId))
  const unknown = next.excludedPlanes.filter((id) => !known.has(id))
  if (unknown.length) throw new ToolError(`No listening plane ${unknown.map((id) => `#${id}`).join(', ')} in this project.`)
  next.flatBands = [...new Set(next.flatBands)].sort((a, b) => a - b)
  next.excludedPlanes = [...new Set(next.excludedPlanes)]
  plan.settings = next
  return describeArray(s, m)
}

/**
 * Run the search, as the page's Optimise button does, and keep the best layout found as
 * the proposal. The optimiser is a generator; between its steps this hands the event loop
 * back, so a ping is answered and a cancellation lands. Cancelled, it keeps the best so
 * far, which is what Stop does on the page.
 */
export async function runOptimise(
  s: Session,
  m: ArrayModel,
  opts: { effort?: Settings['effort']; seed?: number },
  ctx: ToolContext,
) {
  const problem = needProblem(s, m)
  const plan = planOf(s, m)
  const effort = opts.effort ?? plan.settings.effort
  const max = EFFORT[effort]
  const run = optimise(problem, { maxEvaluations: max, ...(opts.seed !== undefined ? { seed: opts.seed } : {}) })
  const started = performance.now()
  let last = 0
  let stopped = false
  let r = run.next()
  for (;;) {
    plan.proposal = r.value.best
    if (r.done) break
    if (ctx.signal.aborted) {
      stopped = true
      break
    }
    const now = performance.now()
    if (now - last > 200) {
      last = now
      ctx.progress(r.value.evaluations, max, `${r.value.phase} · ${r.value.evaluations} layouts`)
    }
    await new Promise((done) => setImmediate(done))
    r = run.next()
  }
  return {
    ...ref(m),
    ...(stopped ? { stopped: 'Cancelled; the best layout found so far is kept as the proposal.' } : {}),
    effort,
    layoutsScored: r.value.evaluations,
    seconds: +((performance.now() - started) / 1000).toFixed(1),
    asLoaded: angles(asLoaded(m)),
    proposed: angles(plan.proposal!),
    scores: scores(s, m, problem),
    writesTo: [tag(m), ...linkedTargets(s.arrays.all, s.project.groups, m).targets.map(tag)],
    note: MODEL_CAVEAT,
  }
}

/**
 * Set angles by hand, as the page's splay table does. Splays are snapped to whole degrees
 * and clamped to the range but NOT forced to grow down the array (`handEdit`); the frame
 * angle is taken as given. Either breaking the goal's limits is reported, not undone.
 */
export function setAngles(s: Session, m: ArrayModel, args: { frameAngle?: number; splays?: number[]; discard?: boolean }) {
  const plan = planOf(s, m)
  if (args.discard) {
    if (args.frameAngle !== undefined || args.splays) throw new ToolError('discard leaves the array as loaded; it takes no angles.')
    plan.proposal = null
    return describeArray(s, m)
  }
  if (args.frameAngle === undefined && !args.splays) throw new ToolError('Give frameAngle, splays, or both — or discard: true.')
  const problem = needProblem(s, m)
  const n = m.names.length
  if (args.splays && args.splays.length !== n - 1) {
    throw new ToolError(`${m.group.name} has ${n} boxes, so ${n - 1} splays (box 2 down), not ${args.splays.length}.`)
  }
  let c = plan.proposal ?? asLoaded(m)
  const notes: string[] = []
  if (args.splays) {
    c = handEdit(problem.limits, { ...c, splays: [0, ...args.splays] })
    args.splays.forEach((v, i) => {
      if (Math.abs(c.splays[i + 1] - v) > 1e-9) notes.push(`box ${i + 2}: ${v}° became ${c.splays[i + 1]}° (whole degrees, ${problem.limits.splayMin}–${problem.limits.splayMax}°)`)
    })
  }
  if (args.frameAngle !== undefined) c = { ...c, frameAngle: args.frameAngle }
  plan.proposal = c
  return { ...(notes.length ? { adjusted: notes } : {}), ...describeArray(s, m) }
}

/** The unlinked look-alikes this array's angles are also written to, by choice. */
export function setCopies(s: Session, m: ArrayModel, ids: number[]) {
  const can = twins(s.arrays.models, m, s.arrays.followers)
  const bad = ids.filter((id) => !can.some((t) => t.group.sourceGroupId === id))
  if (bad.length) {
    throw new ToolError(
      `Not a look-alike of ${m.group.name}: ${bad.map((id) => `#${id}`).join(', ')}. ` +
        (can.length ? `It can be copied to ${can.map((t) => `#${t.group.sourceGroupId} ${t.group.name}`).join(', ')}.` : 'No unlinked array has the same boxes.'),
    )
  }
  planOf(s, m).copyTo = [...new Set(ids)]
  return writesReport(s)
}

/** What write_project would write now, and anything it would refuse. */
export function writesReport(s: Session) {
  const { writes, problems } = planWrites(s.arrays.all, s.project.groups, plannedArrays(s.arrays, s.plans))
  return {
    writes: writes.map((w) => ({ array: tag(w.target), ...angles(w.candidate), ...(w.why === 'own' ? {} : { from: tag(w.from), why: w.why }) })),
    ...(problems.length ? { problems } : {}),
  }
}

export function status(s: Session | null) {
  if (!s) return { open: null, next: 'open_project with the path of an ArrayCalc .dbpr' }
  return { ...projectReport(s), pending: writesReport(s) }
}

/**
 * The level traces the page draws: every listener point on the planes left in, at full
 * resolution, thinned to one per `every` metres for reading. Relative dB, as loaded and
 * as proposed, with the goal's target shape.
 */
export function levelTrace(s: Session, m: ArrayModel, every: number) {
  const problem = needProblem(s, m)
  const plan = planOf(s, m)
  const draw = drawingProblem(problem, segmentsOf(s, m), plan.settings)
  const before = evaluate(draw, asLoaded(m))
  const after = plan.proposal ? evaluate(draw, plan.proposal) : null
  const keep: number[] = []
  draw.points.forEach((p, i) => {
    const prev = keep.length ? draw.points[keep[keep.length - 1]] : null
    if (!prev || prev.planeId !== p.planeId || p.u - prev.u >= every - 1e-9) keep.push(i)
  })
  const names = new Map(segmentsOf(s, m).map((seg) => [seg.planeId, seg.name]))
  const db = (v: number) => +v.toFixed(1)
  const bandsOf = (e: typeof before) =>
    // Labelled as the page labels them; a bare "250" key would sort ahead of the flat bands.
    Object.fromEntries(e.bands.map((b, k) => [b >= 1000 ? `${b / 1000} kHz` : `${b} Hz`, keep.map((i) => db(e.levels[k][i]))]))
  return {
    ...ref(m),
    distanceM: keep.map((i) => +draw.points[i].u.toFixed(2)),
    plane: keep.map((i) => names.get(draw.points[i].planeId) ?? `#${draw.points[i].planeId}`),
    asLoaded: bandsOf(before),
    ...(after ? { proposed: bandsOf(after) } : {}),
    target: keep.map((i) => db((after ?? before).target[i])),
    goalRangeM: [plan.settings.fromM, plan.settings.toM >= 1000 ? 'end' : plan.settings.toM],
    note: `Distance is horizontal, from the frame along the aim. The search scores every second point in the goal range; this shows one per ${every} m. ${MODEL_CAVEAT}`,
  }
}

/**
 * Write every proposal into a copy of the file as opened, each with its linked mirrors and
 * chosen copies, and read the copy back to check the angles landed before it is saved.
 */
export async function writeProject(s: Session, out: string | undefined, overwrite: boolean) {
  const { writes } = planWrites(s.arrays.all, s.project.groups, plannedArrays(s.arrays, s.plans))
  if (!writes.length) throw new ToolError('Nothing to write: no array has a proposal. Run optimise, or set_angles, first.')
  const path = resolve(out ?? join(dirname(s.path), copyName(s.fileName)))
  if (path === resolve(s.path)) throw new ToolError('That is the file that was opened. Cosplay writes a copy and never changes the original.')
  if (!/\.dbpr$/i.test(path)) throw new ToolError('ArrayCalc opens .dbpr files; give a path ending in .dbpr.')
  if (existsSync(path) && !overwrite) throw new ToolError(`${path} already exists. Pass overwrite: true to replace it, or give another path.`)

  const SQL = await sql()
  const db = new SQL.Database(s.bytes)
  let bytes: Uint8Array
  try {
    for (const w of writes) writeCandidate(db, w.target, w.candidate)
    bytes = db.export()
  } finally {
    db.close()
  }

  const check = new SQL.Database(bytes)
  try {
    const groups = readProject(check, basename(path)).groups
    for (const w of writes) {
      const back = buildModel(groups.find((g) => g.sourceGroupId === w.target.group.sourceGroupId)!)
      const same = Math.abs(back.frameAngle - w.candidate.frameAngle) < 1e-6 && back.splays.every((v, i) => Math.abs(v - w.candidate.splays[i]) < 1e-6)
      if (!same) throw new ToolError(`${w.target.group.name} (#${w.target.group.sourceGroupId}) read back with different angles; nothing was saved.`)
    }
  } finally {
    check.close()
  }

  await writeFile(path, bytes)
  const touched = new Set(writes.map((w) => w.target.group.sourceGroupId))
  return {
    wrote: path,
    bytes: bytes.length,
    ...writesReport(s),
    warnings: s.arrays.all.filter((m) => touched.has(m.group.sourceGroupId)).flatMap((m) => warningsOf(s, m).map((w) => `${m.group.name}: ${w}`)),
    note: `Only frame angles, splays, cabinet angles and positions and the lowest-edge height changed; everything else is as it was. ${MODEL_CAVEAT}`,
  }
}
