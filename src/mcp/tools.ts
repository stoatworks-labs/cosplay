/**
 * Cosplay's operations as MCP tools: the page's controls, one tool per thing a person does.
 *
 * Each tool is a thin wrapper over `session.ts`, which asks `lib/` the questions the page
 * asks. The schemas are strict — unknown arguments are refused — and their ranges are the
 * page's own: a slider that stops at 6 dB per doubling stops there here too.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { EFFORT, HF_BANDS, LF_BANDS, type Settings } from '../lib/session.ts'
import { type JsonSchema, type ServerInfo, type Tool, ToolError } from './protocol.ts'
import {
  type GoalPatch,
  type Session,
  describeArray,
  levelTrace,
  openProject,
  pickArray,
  projectReport,
  runOptimise,
  setAngles,
  setCopies,
  setGoal,
  status,
  writeProject,
} from './session.ts'

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }

export const SERVER_INFO: ServerInfo = {
  name: 'cosplay',
  version,
  instructions: [
    'Cosplay searches the splay angles and frame angle of a d&b flown line array in an ArrayCalc project (.dbpr) for the most even direct sound level along the array’s main axis, with the octave bands running together, and writes the result into a COPY of the project. The original is never changed. It works on files on this machine; nothing is uploaded.',
    'The work, in order: open_project lists the arrays; describe_array shows one array’s goal, the listening planes its axis crosses, and its scores as loaded. set_goal changes what "even" means; optimise searches; level_trace shows the traces; set_angles adjusts by hand. A hang ArrayCalc links as another’s mirror is written with it automatically; set_copies adds an unlinked look-alike. write_project writes every array with a proposal into one copy.',
    'Arrays are named by ArrayCalc source-group id (#n) or name, and may be left out when there is only one. Splays are the hinge list from box 2 down. Scores are dB: flatness is the RMS deviation from the target level drop over the flat bands, bandSpread how far the bands run apart, worstSeat the largest single deviation; lower is better.',
    'The levels are Cosplay’s own line-source model, not d&b’s data. ArrayCalc has the final word: say so, and tell the user to open the copy there and check the rigging loads.',
  ].join('\n\n'),
}

/** `~/x` and relative paths, resolved the way a shell in the client's directory would. */
function resolvePath(p: string): string {
  const expanded = p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p
  return resolve(process.cwd(), expanded)
}

const ARRAY: JsonSchema = {
  oneOf: [{ type: 'integer' }, { type: 'string' }],
  description: 'The array: its ArrayCalc source-group id, or its name. May be left out when the project has one array.',
}

const GOAL: Record<string, JsonSchema> = {
  flatBands: {
    type: 'array',
    minItems: 1,
    items: { type: 'integer', enum: HF_BANDS },
    description: `Hz. The bands whose traces should follow the target level drop. Any of ${HF_BANDS.join(', ')}. Default 2000, 4000, 8000.`,
  },
  trackBand: {
    oneOf: [{ type: 'integer', enum: LF_BANDS }, { type: 'null' }],
    description: `Hz. One LF band that only has to run parallel to the flat ones (its level is set by array length), or null for none. Any of ${LF_BANDS.join(', ')}. Default 250.`,
  },
  slope: { type: 'number', minimum: 0, maximum: 6, description: 'Target level drop in dB per doubled distance. 0 is even level front to back. Default 0.' },
  coherenceWeight: { type: 'number', minimum: 0, maximum: 2, description: 'Weight of band spread against flatness. Default 0.5.' },
  fromM: { type: 'number', minimum: 0, description: 'Metres from the frame, horizontally, where the goal starts. Default 0.' },
  toM: { oneOf: [{ type: 'number', minimum: 0 }, { type: 'null' }], description: 'Metres where the goal ends, or null for the end of the last plane. Default null.' },
  splayMin: { type: 'integer', minimum: 0, maximum: 30, description: 'Smallest splay allowed, whole degrees. Defaults to the box family’s rigging range.' },
  splayMax: { type: 'integer', minimum: 0, maximum: 30, description: 'Largest splay allowed, whole degrees. Defaults to the box family’s rigging range.' },
  monotonic: { type: 'boolean', description: 'Splays may only stay equal or grow down the array: a J, never an S. Default true.' },
  frameSpan: { type: 'number', minimum: 0, maximum: 20, description: 'Degrees either side of the loaded frame angle the search may move it. Default 10.' },
  effort: { type: 'string', enum: Object.keys(EFFORT), description: `Layouts scored per search: ${Object.entries(EFFORT).map(([k, v]) => `${k} ${v}`).join(', ')}. Default normal.` },
  excludedPlanes: { type: 'array', items: { type: 'integer' }, description: 'Listening plane ids to leave out of the goal (describe_array.planesOnAxis). Replaces the list; [] includes every plane.' },
}

function need(state: { session: Session | null }): Session {
  if (!state.session) throw new ToolError('No project is open. Call open_project first.')
  return state.session
}

/** The tools, over one session. A fresh set per server, so the tests can run several. */
export function cosplayTools(state: { session: Session | null } = { session: null }): Tool[] {
  const array = (a: Record<string, unknown>) => {
    const s = need(state)
    return { s, m: pickArray(s, a.array) }
  }
  return [
    {
      name: 'open_project',
      title: 'Open an ArrayCalc project',
      description:
        'Read a .dbpr, replacing any project already open and every proposal made on it. Lists the flown line arrays Cosplay can work on (linked mirrors are listed under the array that drives them), the groups it skips and why, and the project’s warnings.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: { path: { type: 'string', description: 'The .dbpr. Relative paths resolve against the server’s working directory.' } },
      },
      async run(a) {
        state.session = await openProject(resolvePath(a.path as string))
        return projectReport(state.session)
      },
    },
    {
      name: 'status',
      title: 'Project status',
      description: 'The open project, every array with its loaded and proposed angles, and what write_project would write now, with any clash it would refuse.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: { readOnlyHint: true },
      run: () => status(state.session),
    },
    {
      name: 'describe_array',
      title: 'Describe an array',
      description:
        'One array: its boxes, loaded and proposed angles, the family’s splay range, its goal, the listening planes its main axis crosses (with their distances and ids), and the scores as loaded and as proposed. Also what it is linked to, what it could be copied to, and its warnings.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { array: ARRAY } },
      annotations: { readOnlyHint: true },
      run(a) {
        const { s, m } = array(a)
        return describeArray(s, m)
      },
    },
    {
      name: 'set_goal',
      title: 'Set the goal',
      description:
        'Change what the search aims for and the rigging limits it keeps to, as the page’s Goal and Rigging controls do. Only the settings given change; reset: true goes back to the defaults first. A proposal is kept and re-scored against the new goal.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { array: ARRAY, ...GOAL, reset: { type: 'boolean', description: 'Start from the defaults for this array.' } },
      },
      run(a) {
        const { s, m } = array(a)
        const { array: _, ...patch } = a
        return setGoal(s, m, patch as GoalPatch)
      },
    },
    {
      name: 'optimise',
      title: 'Optimise the splays',
      description:
        'Search the splays and frame angle for the array’s goal and keep the best layout as its proposal, replacing any earlier one. Reports progress; cancelling keeps the best found so far. Takes a second or several.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          array: ARRAY,
          effort: { ...GOAL.effort, description: `${GOAL.effort.description} Overrides the goal’s effort for this run only.` },
          seed: { type: 'integer', minimum: 0, description: 'The search’s random seed. A different seed can find a different layout of similar score.' },
        },
      },
      async run(a, ctx) {
        const { s, m } = array(a)
        return runOptimise(s, m, { effort: a.effort as Settings['effort'] | undefined, seed: a.seed as number | undefined }, ctx)
      },
    },
    {
      name: 'set_angles',
      title: 'Set angles by hand',
      description:
        'Edit the proposal, as the page’s splay table does, starting from the loaded angles when there is none. Splays are the hinge list from box 2 down, snapped to whole degrees and clamped to the goal’s range but not forced to grow; the frame angle is taken as given. Breaking the goal’s limits is reported, not undone. discard: true drops the proposal and leaves the array as loaded.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          array: ARRAY,
          frameAngle: { type: 'number', minimum: -90, maximum: 90, description: 'Degrees, nose up positive: the top box’s angle.' },
          splays: { type: 'array', items: { type: 'number' }, minItems: 1, description: 'Degrees between each box and the one above, box 2 down: one fewer than the boxes.' },
          discard: { type: 'boolean' },
        },
      },
      run(a) {
        const { s, m } = array(a)
        return setAngles(s, m, a as { frameAngle?: number; splays?: number[]; discard?: boolean })
      },
    },
    {
      name: 'set_copies',
      title: 'Copy to look-alikes',
      description:
        'Also write this array’s angles to unlinked arrays with the same boxes in the same order (describe_array.lookAlikes), such as a separately built L/R pair. Replaces the list; [] copies to none. A look-alike with a proposal of its own keeps it. Arrays ArrayCalc links are always written together and need no copy.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['copyTo'],
        properties: { array: ARRAY, copyTo: { type: 'array', items: { type: 'integer' }, description: 'Source-group ids.' } },
      },
      run(a) {
        const { s, m } = array(a)
        return setCopies(s, m, a.copyTo as number[])
      },
    },
    {
      name: 'level_trace',
      title: 'Level traces',
      description:
        'The direct sound level against distance along the array’s main axis, per band, as loaded and as proposed, with the target shape: the traces the page draws. Relative dB, one point per `every` metres on each listening plane left in.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { array: ARRAY, every: { type: 'number', minimum: 0.25, maximum: 20, description: 'Metres between the points shown. Default 1.' } },
      },
      annotations: { readOnlyHint: true },
      run(a) {
        const { s, m } = array(a)
        return levelTrace(s, m, (a.every as number | undefined) ?? 1)
      },
    },
    {
      name: 'write_project',
      title: 'Write the changed copy',
      description:
        'Write every array with a proposal, its linked mirrors and its chosen copies, into a copy of the project as it was opened, and read the copy back to check the angles before saving. Defaults to "<name> (cosplay).dbpr" beside the original. Never writes over the original, and refuses an existing file unless overwrite is true.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', description: 'Where to write, ending in .dbpr.' }, overwrite: { type: 'boolean' } },
      },
      annotations: { destructiveHint: false },
      run(a) {
        const s = need(state)
        return writeProject(s, a.path === undefined ? undefined : resolvePath(a.path as string), a.overwrite === true)
      },
    },
  ]
}
