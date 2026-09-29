import { describe, expect, it } from 'vitest'
import { readProject } from './dbpr.ts'
import { buildModel, unsupportedReason } from './geometry.ts'
import { evaluate, optimise, type Problem } from './optimise.ts'
import { sectionSegments } from './section.ts'
import { splayRange } from './systems.ts'
import { EXAMPLES, haveExamples, openDb } from './testing.ts'

describe.runIf(haveExamples)('optimiser on a d&b example', () => {
  it('finds splays at least as even as d&b’s own on V-Series example 3', async () => {
    const db = await openDb(`${EXAMPLES}/V-Series/V-Series setup example 3.dbpr`)
    const proj = readProject(db)
    const g = proj.groups.find((g) => !unsupportedReason(g) && g.name === 'Main')!
    const model = buildModel(g)
    const segs = sectionSegments(model, proj.planes, 0.5)
    const points = segs.flatMap((s) => s.points)
    console.log(segs.map((s) => `${s.name}: ${s.points[0].u.toFixed(1)}–${s.points.at(-1)!.u.toFixed(1)} m`).join('; '))
    const r = splayRange(model.names)
    const p: Problem = {
      model, points, atmosphere: proj,
      goal: { flatBands: [1000, 2000, 4000, 8000], trackBands: [250], slopePerDoubling: 0, coherenceWeight: 0.5, worstWeight: 0.1 },
      limits: { splayMin: r.min, splayMax: r.max, splayStep: 1, frameMin: model.frameAngle - 10, frameMax: model.frameAngle + 10, frameStep: 0.1, monotonic: true },
    }
    const t0 = performance.now()
    const before = evaluate(p, { frameAngle: model.frameAngle, splays: model.splays })
    console.log('eval ms', (performance.now() - t0).toFixed(1), 'points', points.length)
    const gen = optimise(p, { maxEvaluations: 3000 })
    let res = gen.next()
    while (!res.done) res = gen.next()
    const after = res.value
    console.log('before', model.frameAngle, model.splays.join(' '), JSON.stringify(before.score))
    console.log('after ', after.best.frameAngle, after.best.splays.join(' '), JSON.stringify(after.score), after.evaluations, 'evals', ((performance.now() - t0) / 1000).toFixed(1), 's')
    expect(after.score.total).toBeLessThanOrEqual(before.score.total)
  })
})

describe.runIf(haveExamples)('short arrays', () => {
  it('finishes when the search space is smaller than the evaluation budget', async () => {
    const db = await openDb(`${EXAMPLES}/V-Series/V-Series setup example 3.dbpr`)
    const proj = readProject(db)
    const full = buildModel(proj.groups.find((g) => g.name === 'Main')!)
    // Three boxes, a 2° frame window: a few hundred layouts in all, far under the budget.
    const model = { ...full, heights: full.heights.slice(0, 3), links: full.links.slice(0, 2), lateral: full.lateral.slice(0, 3),
      names: full.names.slice(0, 3), levels: full.levels.slice(0, 3), mutes: full.mutes.slice(0, 3), splays: full.splays.slice(0, 3) }
    const points = sectionSegments(model, proj.planes, 1).flatMap((s) => s.points)
    const p: Problem = {
      model, points, atmosphere: proj,
      goal: { flatBands: [4000], trackBands: [], slopePerDoubling: 0, coherenceWeight: 0, worstWeight: 0 },
      limits: { splayMin: 0, splayMax: 3, splayStep: 1, frameMin: model.frameAngle - 1, frameMax: model.frameAngle + 1, frameStep: 0.1, monotonic: true },
    }
    const gen = optimise(p, { maxEvaluations: 1_000_000 })
    let r = gen.next(), steps = 0
    while (!r.done && steps++ < 100_000) r = gen.next()
    expect(r.done).toBe(true)
    expect(r.value.evaluations).toBeLessThan(1000)
  })
})
