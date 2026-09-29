import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import { linkedFollowers, readProject } from './lib/dbpr.ts'
import { buildModel, unsupportedReason, type ArrayModel } from './lib/geometry.ts'
import { evaluate, feasible, repair, type Candidate, type Evaluation, type Goal, type Limits, type Problem, type Progress } from './lib/optimise.ts'
import { sectionSegments } from './lib/section.ts'
import { splayRange } from './lib/systems.ts'
import type { Project } from './lib/types.ts'
import { linkedTargets, twins, writeCandidate } from './lib/write.ts'
import { LevelChart } from './components/LevelChart.tsx'
import { SectionView } from './components/SectionView.tsx'
import type { Reply, Request } from './worker.ts'

const HF_BANDS = [1000, 2000, 4000, 8000]
const LF_BANDS = [63, 125, 250, 500]
const EFFORT = { quick: 1500, normal: 5000, thorough: 15000 } as const

interface Loaded {
  fileName: string
  bytes: Uint8Array
  project: Project
  /** Every group that can be laid out, linked followers included (they are written, never listed). */
  all: ArrayModel[]
  /** What the array picker offers: ArrayCalc's source-list entries, so a linked L/R pair is one. */
  models: ArrayModel[]
  followers: Set<number>
  skipped: { name: string; why: string }[]
}

interface Settings {
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

let sqlPromise: Promise<SqlJsStatic> | null = null
const sql = () => (sqlPromise ??= initSqlJs({ locateFile: () => wasmUrl }))

export function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [groupId, setGroupId] = useState<number | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [proposal, setProposal] = useState<Candidate | null>(null)
  const [running, setRunning] = useState<Progress | null>(null)
  const [copyTo, setCopyTo] = useState<number[]>([])
  const [dragging, setDragging] = useState(false)
  const worker = useRef<Worker | null>(null)
  const runId = useRef(0)

  const open = useCallback(async (file: File) => {
    setError(null)
    try {
      const SQL = await sql()
      const bytes = new Uint8Array(await file.arrayBuffer())
      const db = new SQL.Database(bytes)
      const project = readProject(db, file.name)
      db.close()
      const followers = linkedFollowers(project.groups)
      const all: ArrayModel[] = []
      const skipped: Loaded['skipped'] = []
      for (const g of project.groups) {
        if (g.type === 5) continue
        const why = unsupportedReason(g)
        if (!why) all.push(buildModel(g))
        else if (!followers.has(g.sourceGroupId)) skipped.push({ name: g.name, why })
      }
      const models = all.filter((m) => !followers.has(m.group.sourceGroupId))
      if (!models.length) throw new Error('This project has no vertically flown line array Cosplay can work on.')
      setLoaded({ fileName: file.name, bytes, project, all, models, followers, skipped })
      selectGroup(models[0])
    } catch (e) {
      setError(String((e as Error).message ?? e))
    }
  }, [])

  const selectGroup = (m: ArrayModel) => {
    worker.current?.terminate()
    worker.current = null
    setRunning(null)
    setGroupId(m.group.sourceGroupId)
    const r = splayRange(m.names)
    setSettings({
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
    })
    setProposal(null)
    setCopyTo([])
  }

  const model = loaded?.models.find((m) => m.group.sourceGroupId === groupId) ?? null

  const segments = useMemo(() => (model && loaded ? sectionSegments(model, loaded.project.planes, 0.25) : []), [model, loaded])

  const problem = useMemo<Problem | null>(() => {
    if (!model || !settings || !loaded) return null
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
    return { model, points, atmosphere: loaded.project, goal, limits }
  }, [model, settings, segments, loaded])

  // Full-resolution problem for drawing (every 0.25 m point, all planes, distance range shown shaded).
  const drawProblem = useMemo<Problem | null>(() => {
    if (!problem) return null
    const points = segments.filter((s) => !settings!.excludedPlanes.includes(s.planeId)).flatMap((s) => s.points)
    return { ...problem, points }
  }, [problem, segments, settings])

  const asLoaded: Candidate | null = model ? { frameAngle: model.frameAngle, splays: model.splays } : null
  const before = useMemo(() => (drawProblem && asLoaded ? evaluate(drawProblem, asLoaded) : null), [drawProblem, model])
  const after = useMemo(() => (drawProblem && proposal ? evaluate(drawProblem, proposal) : null), [drawProblem, proposal])
  const beforeScore = useMemo(() => (problem && asLoaded ? evaluate(problem, asLoaded).score : null), [problem, model])
  const afterScore = useMemo(() => (problem && proposal ? evaluate(problem, proposal).score : null), [problem, proposal])

  const run = () => {
    if (!problem) return
    worker.current?.terminate()
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.current = w
    const id = ++runId.current
    w.onmessage = (e: MessageEvent<Reply>) => {
      const r = e.data
      if (r.runId !== runId.current) return
      if (r.type === 'error') {
        setError(r.message)
        setRunning(null)
        return
      }
      setProposal(r.progress.best)
      setRunning(r.type === 'done' ? null : r.progress)
      if (r.type === 'done') {
        w.terminate()
        worker.current = null
      }
    }
    setRunning({ best: asLoaded!, score: beforeScore!, evaluations: 0, phase: 'starting' })
    w.postMessage({ problem, maxEvaluations: EFFORT[settings!.effort], runId: id } satisfies Request)
  }

  const stop = () => {
    worker.current?.terminate()
    worker.current = null
    runId.current++
    setRunning(null)
  }

  useEffect(() => () => worker.current?.terminate(), [])

  const download = async () => {
    if (!loaded || !model || !proposal) return
    const SQL = await sql()
    const db: Database = new SQL.Database(loaded.bytes)
    try {
      writeCandidate(db, model, proposal)
      for (const t of linked.targets) writeCandidate(db, t, proposal)
      for (const t of loaded.models) if (copyTo.includes(t.group.sourceGroupId)) writeCandidate(db, t, proposal)
      const out = db.export()
      const blob = new Blob([out.slice().buffer], { type: 'application/octet-stream' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = loaded.fileName.replace(/\.dbpr$/i, '') + ' (cosplay).dbpr'
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    } finally {
      db.close()
    }
  }

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings((s) => (s ? { ...s, [k]: v } : s))
  const editSplay = (i: number, v: number) => {
    if (!proposal || !problem) return
    const splays = proposal.splays.slice()
    splays[i] = v
    setProposal(repair({ ...problem.limits, monotonic: false }, { ...proposal, splays }))
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) open(f)
  }

  const linked = model && loaded ? linkedTargets(loaded.all, loaded.project.groups, model) : { targets: [], problems: [] }
  const twinsOf = model && loaded ? twins(loaded.models, model, loaded.followers) : []
  const linkLabel = (m: ArrayModel) => {
    const n = loaded ? linkedTargets(loaded.all, loaded.project.groups, m).targets.length : 0
    return n === 0 ? '' : n === 1 ? ' · linked L/R' : ` · ${n + 1} linked`
  }
  const range = model ? splayRange(model.names) : null
  const feasibleNow = proposal && problem ? feasible(problem.limits, proposal) : true

  return (
    <div
      className={`app${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <header className="top">
        <div className="brand">
          <h1>Cosplay</h1>
          <span className="tag">Compute Optimal Splay · for d&amp;b ArrayCalc projects</span>
          <span className="preview">preview</span>
        </div>
        <div className="top-actions">
        <button type="button" className="btn ghost" data-stoatworks-about>
          About
        </button>
        <label className="btn">
          {loaded ? 'Open another .dbpr' : 'Open .dbpr'}
          <input type="file" accept=".dbpr" hidden onChange={(e) => e.target.files?.[0] && open(e.target.files[0])} />
        </label>
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}

      {!loaded && (
        <section className="empty">
          <h2>Drop an ArrayCalc project here</h2>
          <p>
            Cosplay reads the flown line arrays and listening planes from a <code>.dbpr</code>, searches the splay
            angles and frame angle for the most even direct sound level along each array&rsquo;s main axis, with the
            frequency bands running together, and writes the result back into a copy of the project for ArrayCalc
            to open.
          </p>
          <p className="muted">The file is read in your browser and never uploaded.</p>
        </section>
      )}

      {loaded && model && settings && (
        <main className="layout">
          <aside className="panel">
            <div className="field">
              <span className="label">Project</span>
              <span className="value">{loaded.project.name}</span>
            </div>
            <label className="field">
              <span className="label">Array</span>
              <select value={groupId ?? ''} onChange={(e) => selectGroup(loaded.models.find((m) => m.group.sourceGroupId === +e.target.value)!)}>
                {loaded.models.map((m) => (
                  <option key={m.group.sourceGroupId} value={m.group.sourceGroupId}>
                    {m.group.name} — {m.names.length}× {[...new Set(m.names)].join('/')}{linkLabel(m)} (#{m.group.sourceGroupId})
                  </option>
                ))}
              </select>
            </label>
            {loaded.skipped.length > 0 && (
              <details className="muted small">
                <summary>{loaded.skipped.length} group(s) skipped</summary>
                <ul>
                  {loaded.skipped.map((s, i) => (
                    <li key={i}>
                      {s.name}: {s.why}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {model.group.arrayProcessing && (
              <div className="banner warn small">ArrayProcessing is on for this array. New splays invalidate its AP slots; recalculate them in ArrayCalc.</div>
            )}

            <h3>Goal</h3>
            <div className="field">
              <span className="label">Keep flat</span>
              <div className="chips">
                {HF_BANDS.map((b) => (
                  <label key={b} className={`chip${settings.flatBands.includes(b) ? ' on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={settings.flatBands.includes(b)}
                      onChange={(e) => set('flatBands', e.target.checked ? [...settings.flatBands, b].sort((x, y) => x - y) : settings.flatBands.filter((x) => x !== b))}
                    />
                    {fmtHz(b)}
                  </label>
                ))}
              </div>
            </div>
            <label className="field">
              <span className="label">Track LF band</span>
              <select value={settings.trackBand ?? ''} onChange={(e) => set('trackBand', e.target.value ? +e.target.value : null)}>
                <option value="">none</option>
                {LF_BANDS.map((b) => (
                  <option key={b} value={b}>
                    {fmtHz(b)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="label">
                Level drop <b>{settings.slope.toFixed(1)} dB</b> per doubled distance
              </span>
              <input type="range" min={0} max={6} step={0.5} value={settings.slope} onChange={(e) => set('slope', +e.target.value)} />
            </label>
            <label className="field">
              <span className="label">
                Trace coherence weight <b>{settings.coherenceWeight.toFixed(2)}</b>
              </span>
              <input type="range" min={0} max={2} step={0.05} value={settings.coherenceWeight} onChange={(e) => set('coherenceWeight', +e.target.value)} />
            </label>
            <div className="field row">
              <label>
                <span className="label">From (m)</span>
                <input type="number" min={0} step={1} value={settings.fromM} onChange={(e) => set('fromM', +e.target.value)} />
              </label>
              <label>
                <span className="label">To (m)</span>
                <input type="number" min={0} step={1} value={settings.toM >= 1000 ? '' : settings.toM} placeholder="end" onChange={(e) => set('toM', e.target.value === '' ? 1000 : +e.target.value)} />
              </label>
            </div>
            <div className="field">
              <span className="label">Listening planes on the axis</span>
              {segments.length === 0 && <span className="muted small">None — no listening plane crosses this array&rsquo;s aim.</span>}
              {segments.map((s) => (
                <label key={s.planeId} className="check small">
                  <input
                    type="checkbox"
                    checked={!settings.excludedPlanes.includes(s.planeId)}
                    onChange={(e) => set('excludedPlanes', e.target.checked ? settings.excludedPlanes.filter((x) => x !== s.planeId) : [...settings.excludedPlanes, s.planeId])}
                  />
                  {s.name} <span className="muted">{s.points[0].u.toFixed(1)}–{s.points[s.points.length - 1].u.toFixed(1)} m</span>
                </label>
              ))}
            </div>

            <h3>Rigging</h3>
            <div className="field row">
              <label>
                <span className="label">Splay min°</span>
                <input type="number" step={1} value={settings.splayMin} onChange={(e) => set('splayMin', +e.target.value)} />
              </label>
              <label>
                <span className="label">Splay max°</span>
                <input type="number" step={1} value={settings.splayMax} onChange={(e) => set('splayMax', +e.target.value)} />
              </label>
            </div>
            {range?.note && <p className="muted small">{range.note}</p>}
            <label className="field">
              <span className="label">
                Frame angle within ±<b>{settings.frameSpan}°</b> of {model.frameAngle.toFixed(1)}°
              </span>
              <input type="range" min={0} max={20} step={0.5} value={settings.frameSpan} onChange={(e) => set('frameSpan', +e.target.value)} />
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.monotonic} onChange={(e) => set('monotonic', e.target.checked)} />
              Splays only grow down the array
            </label>
            <label className="field">
              <span className="label">Search effort</span>
              <select value={settings.effort} onChange={(e) => set('effort', e.target.value as Settings['effort'])}>
                <option value="quick">Quick</option>
                <option value="normal">Normal</option>
                <option value="thorough">Thorough</option>
              </select>
            </label>

            <div className="actions">
              {running ? (
                <button className="btn" onClick={stop}>
                  Stop
                </button>
              ) : (
                <button className="btn primary" disabled={!problem} onClick={run}>
                  Optimise
                </button>
              )}
              {running && (
                <span className="muted small">
                  {running.phase} · {running.evaluations.toLocaleString()} layouts
                </span>
              )}
            </div>
          </aside>

          <section className="results">
            <div className="scores">
              <ScoreCard label="Flatness (RMS)" before={beforeScore?.flatness} after={afterScore?.flatness} />
              <ScoreCard label="Band spread" before={beforeScore?.coherence} after={afterScore?.coherence} />
              <ScoreCard label="Worst seat" before={beforeScore?.worst} after={afterScore?.worst} />
            </div>

            <div className="card">
              <div className="card-head">
                <h3>Direct sound level vs. distance</h3>
                <span className="muted small">dB, relative · dashed = as loaded, solid = proposed</span>
              </div>
              {before && <LevelChart before={before} after={after} fromM={settings.fromM} toM={settings.toM} segments={segmentBreaks(drawProblem!)} />}
            </div>

            <div className="grid2">
              <div className="card">
                <div className="card-head">
                  <h3>Section</h3>
                  <span className="muted small">along the array&rsquo;s horizontal aim</span>
                </div>
                <SectionView model={model} segments={segments} before={asLoaded!} after={proposal} />
              </div>

              <div className="card">
                <div className="card-head">
                  <h3>Splays</h3>
                  <span className="muted small">proposed column is editable</span>
                </div>
                <SplayTable model={model} proposal={proposal} onEdit={editSplay} min={settings.splayMin} max={settings.splayMax} onFrame={(v) => proposal && setProposal({ ...proposal, frameAngle: v })} />
                {!feasibleNow && <div className="banner warn small">The edited splays break the “only grow” rule or the frame range.</div>}
              </div>
            </div>

            <div className="card export">
              {linked.targets.length > 0 && (
                <p className="small">
                  Linked in ArrayCalc: the same angles are written to {linked.targets.map((t) => `${t.group.name} (#${t.group.sourceGroupId})`).join(', ')}.
                </p>
              )}
              {linked.problems.length > 0 && (
                <div className="banner warn small">
                  Linked in ArrayCalc but not written, so ArrayCalc may disagree with this file: {linked.problems.join('; ')}.
                </div>
              )}
              {twinsOf.length > 0 && (
                <div className="field">
                  <span className="label">Also apply to</span>
                  {twinsOf.map((t) => (
                    <label key={t.group.sourceGroupId} className="check small">
                      <input
                        type="checkbox"
                        checked={copyTo.includes(t.group.sourceGroupId)}
                        onChange={(e) => setCopyTo((c) => (e.target.checked ? [...c, t.group.sourceGroupId] : c.filter((x) => x !== t.group.sourceGroupId)))}
                      />
                      {t.group.name} (#{t.group.sourceGroupId}, same {t.names.length} boxes, not linked in ArrayCalc)
                    </label>
                  ))}
                </div>
              )}
              <button className="btn primary" disabled={!proposal || !!running} onClick={download}>
                Download project with new splays
              </button>
              <p className="muted small">
                Writes a copy with the frame angle, splays, cabinet angles and positions updated. Open it in ArrayCalc and
                check the Sources page and the rigging loads. The levels here come from Cosplay&rsquo;s own line-source model, not
                d&amp;b&rsquo;s data, so ArrayCalc has the final word.
              </p>
            </div>
            {loaded.project.warnings.length > 0 && (
              <ul className="muted small">
                {loaded.project.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </section>
        </main>
      )}
      <footer className="foot muted small">Cosplay {__APP_VERSION__} · not affiliated with d&amp;b audiotechnik</footer>
    </div>
  )
}

function segmentBreaks(p: Problem): number[] {
  const breaks: number[] = []
  for (let i = 1; i < p.points.length; i++) {
    const a = p.points[i - 1], b = p.points[i]
    if (a.planeId !== b.planeId || Math.abs(b.u - a.u) > 0.6) breaks.push(i)
  }
  return breaks
}

export const fmtHz = (f: number) => (f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`)

function ScoreCard({ label, before, after }: { label: string; before?: number; after?: number }) {
  const delta = before !== undefined && after !== undefined ? after - before : undefined
  return (
    <div className="score">
      <span className="label">{label}</span>
      <span className="big">{(after ?? before)?.toFixed(1) ?? '—'} dB</span>
      <span className="muted small">
        {delta === undefined ? 'as loaded' : `was ${before!.toFixed(1)} · ${delta <= 0 ? '−' : '+'}${Math.abs(delta).toFixed(1)}`}
      </span>
    </div>
  )
}

function SplayTable({
  model,
  proposal,
  onEdit,
  onFrame,
  min,
  max,
}: {
  model: ArrayModel
  proposal: Candidate | null
  onEdit: (i: number, v: number) => void
  onFrame: (v: number) => void
  min: number
  max: number
}) {
  const opts = Array.from({ length: max - min + 1 }, (_, i) => min + i)
  return (
    <table className="splays">
      <thead>
        <tr>
          <th>#</th>
          <th>Box</th>
          <th>As loaded</th>
          <th>Proposed</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td></td>
          <td className="muted">Frame</td>
          <td>{model.frameAngle.toFixed(1)}°</td>
          <td>
            {proposal ? (
              <input type="number" step={0.1} value={+proposal.frameAngle.toFixed(1)} onChange={(e) => onFrame(+e.target.value)} className={diff(proposal.frameAngle, model.frameAngle)} />
            ) : (
              '—'
            )}
          </td>
        </tr>
        {model.names.map((n, i) => (
          <tr key={i}>
            <td className="muted">{i + 1}</td>
            <td>{n}</td>
            <td>{i === 0 ? '—' : `${model.splays[i]}°`}</td>
            <td>
              {i === 0 || !proposal ? (
                '—'
              ) : (
                <select value={proposal.splays[i]} onChange={(e) => onEdit(i, +e.target.value)} className={diff(proposal.splays[i], model.splays[i])}>
                  {opts.map((o) => (
                    <option key={o} value={o}>
                      {o}°
                    </option>
                  ))}
                </select>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const diff = (a: number, b: number) => (Math.abs(a - b) > 1e-6 ? 'changed' : '')

export type { Evaluation }
