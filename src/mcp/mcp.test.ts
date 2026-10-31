/**
 * The MCP server, from the protocol up.
 *
 * Three layers. The protocol on its own, because a client that cannot negotiate never gets
 * as far as a tool. The tools, driven in process the way a model drives them, against
 * ArrayCalc's own example projects — and checked against the library asked directly, since
 * the one thing this server must not do is ask the optimiser a different question from the
 * page's. And the real server process over its own stdio, because Node's type stripping
 * and stdout carrying nothing but protocol are exactly what no in-process test can see.
 */

import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readProject } from '../lib/dbpr.ts'
import { buildModel } from '../lib/geometry.ts'
import { optimise } from '../lib/optimise.ts'
import { sectionSegments } from '../lib/section.ts'
import { SECTION_STEP, arraysOf, defaultSettings, plannedArrays, searchProblem } from '../lib/session.ts'
import { EXAMPLES, haveExamples, openDb } from '../lib/testing.ts'
import { planWrites, writeCandidate } from '../lib/write.ts'
import { PROTOCOL_VERSIONS, type Tool, createMcpServer } from './protocol.ts'
import { SERVER_INFO, cosplayTools } from './tools.ts'

const repo = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url))
const V3 = `${EXAMPLES}/V-Series/V-Series setup example 3.dbpr`
const J4 = `${EXAMPLES}/J-Series/J-Series setup example 4.dbpr`

/** The example, copied somewhere a default write can land beside it. */
function copyOf(example: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'cosplay-mcp-')), basename(example))
  copyFileSync(example, path)
  return path
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

/** An in-process client. `call` answers with the tool's text, parsed when it is JSON. */
function client(tools: Tool[] = cosplayTools()) {
  const sent: Json[] = []
  const server = createMcpServer(SERVER_INFO, tools, (m) => sent.push(m))
  let seq = 0
  const request = async (method: string, params?: object): Promise<Json> => {
    const id = ++seq
    await server.handle(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return sent.find((m) => m.id === id)
  }
  const call = async (name: string, args: object = {}): Promise<{ isError: boolean; text: string; json: Json }> => {
    const r = await request('tools/call', { name, arguments: args })
    const text: string = r.result.content[0].text
    let json: Json = null
    try {
      json = JSON.parse(text)
    } catch {
      // A refusal is prose.
    }
    return { isError: !!r.result.isError, text, json }
  }
  return { sent, server, request, call }
}

/** The angles the library's own search finds for this array with the page's default goal. */
async function libraryAnswer(file: string, id: number, maxEvaluations: number) {
  const db = await openDb(file)
  const project = readProject(db)
  db.close()
  const m = arraysOf(project).models.find((x) => x.group.sourceGroupId === id)!
  const problem = searchProblem(m, defaultSettings(m), sectionSegments(m, project.planes, SECTION_STEP), project)!
  const run = optimise(problem, { maxEvaluations })
  let r = run.next()
  while (!r.done) r = run.next()
  return { frameAngle: r.value.best.frameAngle, splays: r.value.best.splays.slice(1) }
}

describe('protocol', () => {
  it('echoes a protocol version it knows, and offers its newest for one it does not', async () => {
    const c = client()
    const known = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } })
    expect(known.result.protocolVersion).toBe('2025-06-18')
    expect(known.result.serverInfo.name).toBe('cosplay')
    expect(known.result.instructions).toMatch(/final word/)
    const future = await c.request('initialize', { protocolVersion: '2099-01-01' })
    expect(future.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0])
  })

  it('lists every tool with a strict object schema', async () => {
    const { result } = await client().request('tools/list')
    expect(result.tools.map((t: Json) => t.name)).toEqual([
      'open_project', 'status', 'describe_array', 'set_goal', 'optimise', 'set_angles', 'set_copies', 'level_trace', 'write_project',
    ])
    for (const t of result.tools) {
      expect(t.inputSchema.type).toBe('object')
      expect(t.inputSchema.additionalProperties).toBe(false)
      expect(t.description.length).toBeGreaterThan(40)
    }
  })

  it('answers protocol mistakes as protocol errors, and notifications not at all', async () => {
    const c = client()
    expect((await c.request('resources/list')).error.code).toBe(-32601)
    expect((await c.request('tools/call', { name: 'no_such_tool' })).error.code).toBe(-32602)
    await c.server.handle('{not json')
    expect(c.sent.at(-1)).toMatchObject({ id: null, error: { code: -32700 } })
    const before = c.sent.length
    await c.server.handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    expect(c.sent.length).toBe(before)
  })

  it('refuses an argument it does not know and a value off the page’s scale', async () => {
    const c = client()
    // A typo the model would otherwise be told succeeded.
    expect((await c.call('set_goal', { slpoe: 3 })).text).toMatch(/slpoe is not a known argument.*slope/)
    expect((await c.call('set_goal', { slope: 9 })).text).toMatch(/slope must be at most 6/)
    expect((await c.call('set_goal', { flatBands: [3000] })).text).toMatch(/flatBands\[0\] must be one of/)
    // An empty list would fall back to 4 kHz without saying so.
    expect((await c.call('set_goal', { flatBands: [] })).text).toMatch(/at least 1/)
    expect((await c.call('describe_array')).text).toMatch(/No project is open/)
    expect((await c.call('status')).json.open).toBeNull()
  })

  it('passes a cancellation through to a running call', async () => {
    let aborted = false
    const tool: Tool = {
      name: 'work',
      title: 'work',
      description: 'work',
      inputSchema: { type: 'object', properties: {} },
      run: async (_a, ctx) => {
        await new Promise((r) => setTimeout(r, 20))
        aborted = ctx.signal.aborted
        return 'done'
      },
    }
    const c = client([tool])
    const call = c.server.handle(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'work' } }))
    await new Promise((r) => setTimeout(r, 5))
    await c.server.handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }))
    await call
    expect(aborted).toBe(true)
  })
})

describe.runIf(haveExamples)('a project, through the tools', () => {
  it('lists the arrays the page offers, with their linked mirrors and the groups skipped', async () => {
    const { json } = await client().call('open_project', { path: V3 })
    expect(json.project).toBe('V-Series example 3AP')
    expect(json.arrays.map((a: Json) => [a.id, a.name, a.linkedTo])).toEqual([
      [1, 'Main', ['#2 Main']],
      [4, 'Out', ['#5 Out']],
    ])
    expect(json.arrays[0].asLoaded).toEqual({ frameAngle: 2, splays: [4, 3, 4, 5, 8, 11, 14] })
    expect(json.skipped.map((s: Json) => s.name)).toEqual(['Center V7P', 'SUB array'])
  })

  it('names an array by id or name, and sends a linked mirror back to the array that drives it', async () => {
    const c = client()
    await c.call('open_project', { path: V3 })
    expect((await c.call('describe_array')).text).toMatch(/2 arrays; say which: #1 Main, #4 Out/)
    expect((await c.call('describe_array', { array: 'out' })).json.id).toBe(4)
    expect((await c.call('describe_array', { array: 2 })).text).toMatch(/linked in ArrayCalc to Main \(#1\)/)
    expect((await c.call('describe_array', { array: 'Center V7P' })).text).toMatch(/not a line array/)
    expect((await c.call('describe_array', { array: 99 })).text).toMatch(/No array #99/)

    const d = (await c.call('describe_array', { array: 1 })).json
    expect(d.cabinets).toEqual(['V8', 'V8', 'V8', 'V8', 'V8', 'V8', 'V12', 'V12'])
    expect(d.planesOnAxis.map((p: Json) => p.name)).toEqual(['100', '200 Cnt', '300 Cnt'])
    expect(d.searchPoints).toBe(144)
    expect(d.scores.proposed).toBeNull()
    expect(d.warnings[0]).toMatch(/ArrayProcessing is on/)
  })

  it('asks the optimiser exactly the page’s question', async () => {
    const c = client()
    await c.call('open_project', { path: V3 })
    const r = (await c.call('optimise', { array: 1, effort: 'quick' })).json
    expect(r.proposed).toEqual(await libraryAnswer(V3, 1, 1500))
    expect(r.layoutsScored).toBe(1500)
    expect(r.scores.proposed.total).toBeLessThan(r.scores.asLoaded.total)
    expect(r.writesTo).toEqual(['#1 Main', '#2 Main'])
    expect(r.note).toMatch(/ArrayCalc has the final word/)
  })

  it('changes the goal, keeps the proposal and scores it again', async () => {
    const c = client()
    await c.call('open_project', { path: V3 })
    const first = (await c.call('optimise', { array: 1, effort: 'quick' })).json
    const sloped = (await c.call('set_goal', { array: 1, slope: 3, toM: 40 })).json
    expect(sloped.goal).toMatchObject({ slope: 3, toM: 40, flatBands: [2000, 4000, 8000] })
    expect(sloped.proposed).toEqual(first.proposed)
    expect(sloped.scores.proposed.total).not.toBeCloseTo(first.scores.proposed.total, 3)
    expect(sloped.searchPoints).toBeLessThan(144)
    expect((await c.call('set_goal', { array: 1, reset: true })).json.goal).toMatchObject({ slope: 0, toM: null })

    expect((await c.call('set_goal', { array: 1, excludedPlanes: [999] })).text).toMatch(/No listening plane #999/)
    expect((await c.call('set_goal', { array: 1, fromM: 50, toM: 40 })).text).toMatch(/not before/)
    const none = (await c.call('set_goal', { array: 1, excludedPlanes: [1, 11, 4] })).json
    expect(none.cannotOptimise).toMatch(/Fewer than four/)
    expect((await c.call('optimise', { array: 1 })).text).toMatch(/Fewer than four/)
  })

  it('takes hand edits as the splay table does: snapped and clamped, not forced to grow', async () => {
    const c = client()
    await c.call('open_project', { path: V3 })
    expect((await c.call('set_angles', { array: 1, splays: [1, 2, 3] })).text).toMatch(/8 boxes, so 7 splays/)
    const edited = (await c.call('set_angles', { array: 1, splays: [4, 3, 4, 5, 8, 11, 15.4] })).json
    expect(edited.adjusted).toEqual(['box 8: 15.4° became 14° (whole degrees, 0–14°)'])
    // 4 then 3 is an S, which a hand edit may mean: reported, not rewritten.
    expect(edited.proposed.splays).toEqual([4, 3, 4, 5, 8, 11, 14])
    expect(edited.proposalBreaksLimits).toBeDefined()
    expect((await c.call('set_angles', { array: 1, frameAngle: 25 })).json.proposed).toEqual({ frameAngle: 25, splays: [4, 3, 4, 5, 8, 11, 14] })
    expect((await c.call('set_angles', { array: 1, discard: true, frameAngle: 3 })).isError).toBe(true)
    expect((await c.call('set_angles', { array: 1, discard: true })).json.proposed).toBeNull()
  })

  it('shows the level traces as loaded and as proposed', async () => {
    const c = client()
    await c.call('open_project', { path: V3 })
    const loaded = (await c.call('level_trace', { array: 1 })).json
    expect(Object.keys(loaded.asLoaded)).toEqual(['2 kHz', '4 kHz', '8 kHz', '250 Hz'])
    expect(loaded.proposed).toBeUndefined()
    expect(loaded.plane.length).toBe(loaded.distanceM.length)
    expect(loaded.asLoaded['4 kHz'].length).toBe(loaded.distanceM.length)
    await c.call('optimise', { array: 1, effort: 'quick' })
    const after = (await c.call('level_trace', { array: 1, every: 5 })).json
    expect(after.proposed['2 kHz'].length).toBe(after.distanceM.length)
    expect(after.distanceM.length).toBeLessThan(loaded.distanceM.length / 3)
  })

  it('writes the page’s file: every proposal and its linked mirror, into a copy beside the original', async () => {
    const path = copyOf(V3)
    const original = readFileSync(path)
    const c = client()
    await c.call('open_project', { path })
    expect((await c.call('write_project')).text).toMatch(/Nothing to write/)
    const main = (await c.call('optimise', { array: 'Main', effort: 'quick' })).json.proposed
    await c.call('set_angles', { array: 'Out', splays: [5, 8, 12, 13, 14] })

    const w = await c.call('write_project')
    expect(w.isError).toBe(false)
    expect(w.json.wrote).toBe(join(path, '..', 'V-Series setup example 3 (cosplay).dbpr'))
    expect(w.json.writes.map((x: Json) => x.array)).toEqual(['#1 Main', '#2 Main', '#4 Out', '#5 Out'])
    expect(w.json.warnings.some((x: string) => /ArrayProcessing/.test(x))).toBe(true)

    // Read back by the library: each group and its mirror have the angles proposed.
    const back = await openDb(w.json.wrote)
    const groups = readProject(back).groups
    back.close()
    const angles = (id: number) => {
      const m = buildModel(groups.find((g) => g.sourceGroupId === id)!)
      return { frameAngle: +m.frameAngle.toFixed(3), splays: m.splays.slice(1) }
    }
    expect(angles(1)).toEqual(main)
    expect(angles(2)).toEqual(main)
    expect(angles(5).splays).toEqual([5, 8, 12, 13, 14])

    // The same bytes the page's download writes from the same proposals.
    const db = await openDb(path)
    const project = readProject(db)
    const arrays = arraysOf(project)
    const plans = Object.fromEntries(
      [[1, { frameAngle: main.frameAngle, splays: [0, ...main.splays] }], [4, { frameAngle: 5.4, splays: [0, 5, 8, 12, 13, 14] }]].map(([id, c]) => [
        id,
        { settings: defaultSettings(arrays.models[0]), proposal: c as never, copyTo: [] },
      ]),
    )
    for (const x of planWrites(arrays.all, project.groups, plannedArrays(arrays, plans)).writes) writeCandidate(db, x.target, x.candidate)
    expect(Buffer.compare(Buffer.from(db.export()), readFileSync(w.json.wrote))).toBe(0)
    db.close()

    expect(Buffer.compare(readFileSync(path), original)).toBe(0)
    expect((await c.call('write_project')).text).toMatch(/already exists/)
    expect((await c.call('write_project', { overwrite: true })).isError).toBe(false)
    expect((await c.call('write_project', { path, overwrite: true })).text).toMatch(/never changes the original/)
    expect((await c.call('write_project', { path: join(path, '..', 'out.txt') })).text).toMatch(/\.dbpr/)
  })

  it('copies to an unlinked look-alike only when asked, and never over its own proposal', async () => {
    const c = client()
    await c.call('open_project', { path: J4 })
    const d = (await c.call('describe_array', { array: 5 })).json
    expect(d.lookAlikes).toEqual(['#6 Outfill R'])
    expect((await c.call('set_copies', { array: 5, copyTo: [1] })).text).toMatch(/Not a look-alike of Outfill L: #1/)

    await c.call('optimise', { array: 5, effort: 'quick' })
    expect((await c.call('status')).json.pending.writes.map((w: Json) => w.array)).toEqual(['#5 Outfill L'])
    const copied = (await c.call('set_copies', { array: 5, copyTo: [6] })).json
    expect(copied.writes[1]).toMatchObject({ array: '#6 Outfill R', from: '#5 Outfill L', why: 'copy' })

    await c.call('optimise', { array: 6, effort: 'quick' })
    const both = (await c.call('status')).json.pending
    expect(both.writes.filter((w: Json) => w.array === '#6 Outfill R')).toHaveLength(1)
    expect(both.problems[0]).toMatch(/has its own angles/)
  })

  it('reports progress, answers a ping mid-search, and keeps the best so far when cancelled', async () => {
    const c = client()
    await c.call('open_project', { path: V3 })
    const id = 900
    const run = c.server.handle(
      JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'optimise', arguments: { array: 1, effort: 'thorough' }, _meta: { progressToken: 't' } } }),
    )
    while (!c.sent.some((m) => m.method === 'notifications/progress')) await new Promise((r) => setTimeout(r, 5))
    // Not queued behind the search: the event loop is handed back between its steps.
    expect((await c.request('ping')).result).toEqual({})
    await c.server.handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }))
    await run
    const r = JSON.parse(c.sent.find((m) => m.id === id).result.content[0].text)
    expect(r.stopped).toMatch(/best layout found so far/)
    expect(r.layoutsScored).toBeLessThan(15000)
    expect((await c.call('status')).json.arrays[0].proposed).toEqual(r.proposed)
  }, 60_000)
})

const typeStripping = !!(process.features as { typescript?: unknown }).typescript

describe.runIf(typeStripping)('the server process', () => {
  it('runs from source under Node and writes nothing but protocol to stdout', async () => {
    const child = spawn(process.execPath, [repo('src/mcp/server.ts')], { cwd: repo('.'), stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', (d) => (stdout += d))
    const path = haveExamples ? V3 : repo('no-such-project.dbpr')
    const lines = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'open_project', arguments: { path } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'optimise', arguments: { array: 1, effort: 'quick' } } },
    ]
    child.stdin.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const code = await new Promise((r) => child.on('close', r))
    expect(code).toBe(0)

    // Every line parses: one stray console.log from a library would fail here.
    const replies = stdout.trim().split('\n').map((l) => JSON.parse(l))
    expect(replies.map((r) => r.id)).toEqual([1, 2, 3, 4])
    expect(replies[1].result.tools).toHaveLength(9)
    if (haveExamples) {
      expect(JSON.parse(replies[3].result.content[0].text).proposed).toEqual(await libraryAnswer(V3, 1, 1500))
    } else {
      expect(replies[2].result.content[0].text).toMatch(/No such file/)
    }
  }, 60_000)
})
