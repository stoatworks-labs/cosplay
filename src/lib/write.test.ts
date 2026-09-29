import { describe, expect, it } from 'vitest'
import { linkedFollowers, readProject } from './dbpr.ts'
import { buildModel, unsupportedReason } from './geometry.ts'
import { linkedTargets, planWrites, writeCandidate } from './write.ts'
import { EXAMPLES, exampleFiles, haveExamples, openDb } from './testing.ts'

describe.runIf(haveExamples)('write-back', () => {
  it('writing an array’s own splays changes nothing (non-compression systems)', async () => {
    let n = 0
    for (const f of exampleFiles()) {
      const db = await openDb(f)
      const p = readProject(db)
      for (const g of p.groups) {
        if (unsupportedReason(g) || g.cabinets.some((c) => /^(GSL|KSL|XSL|CCL)/.test(c.name))) continue
        const m = buildModel(g)
        writeCandidate(db, m, { frameAngle: m.frameAngle, splays: m.splays })
        const g2 = readProject(db).groups.find((x) => x.sourceGroupId === g.sourceGroupId)!
        g2.cabinets.forEach((c, i) => {
          const o = g.cabinets[i]
          expect(Math.abs(c.verticalAngle - o.verticalAngle)).toBeLessThan(1e-3)
          expect(Math.hypot(c.origin.x - o.origin.x, c.origin.y - o.origin.y, c.origin.z - o.origin.z)).toBeLessThan(2e-4)
        })
        n++
      }
      db.close()
    }
    expect(n).toBeGreaterThan(30)
  })

  it('new splays round-trip through the file, mirrored twin included', async () => {
    const db = await openDb(`${EXAMPLES}/V-Series/V-Series setup example 3.dbpr`)
    const p = readProject(db)
    const [a, b] = p.groups.filter((g) => g.name === 'Main').map(buildModel)
    const cand = { frameAngle: 4.9, splays: [0, 3, 3, 4, 4, 6, 14, 14] }
    writeCandidate(db, a, cand)
    writeCandidate(db, b, cand)
    for (const id of [a.group.sourceGroupId, b.group.sourceGroupId]) {
      const m2 = buildModel(readProject(db).groups.find((g) => g.sourceGroupId === id)!)
      expect(m2.frameAngle).toBeCloseTo(4.9, 6)
      expect(m2.splays).toEqual(cand.splays)
      // Rigging measured back from the rewritten file is the rigging we laid it out with.
      m2.links.forEach((l, i) => expect(Math.hypot(l.u - a.links[i].u, l.z - a.links[i].z)).toBeLessThan(1e-6))
    }
  })
})

describe.runIf(haveExamples)('linked arrays', () => {
  it('lists each linked chain once and writes the leader’s angles to every member, mirrored', async () => {
    let pairs = 0
    for (const f of exampleFiles()) {
      const db = await openDb(f)
      const p = readProject(db)
      const all = p.groups.filter((g) => !unsupportedReason(g)).map(buildModel)
      const followers = linkedFollowers(p.groups)
      for (const m of all.filter((m) => !followers.has(m.group.sourceGroupId))) {
        const { targets } = linkedTargets(all, p.groups, m)
        if (!targets.length) continue
        // A leader is never itself a follower, and every follower is hidden in ArrayCalc's list.
        targets.forEach((t) => expect(t.group.hasPrevious, `${f} ${t.group.name}`).toBe(true))
        const cand = { frameAngle: m.frameAngle + 1, splays: m.splays.map((s, i) => (i ? Math.min(s + 1, 7) : 0)) }
        writeCandidate(db, m, cand)
        for (const t of targets) writeCandidate(db, t, cand)
        const again = readProject(db)
        const lead = buildModel(again.groups.find((g) => g.sourceGroupId === m.group.sourceGroupId)!)
        for (const t of targets) {
          const tm = buildModel(again.groups.find((g) => g.sourceGroupId === t.group.sourceGroupId)!)
          expect(tm.splays).toEqual(lead.splays)
          expect(tm.frameAngle).toBeCloseTo(lead.frameAngle, 9)
          // Mirrored across the room's centre line: same height, same distance forward.
          const a = lead.group.cabinets.at(-1)!, b = tm.group.cabinets.at(-1)!
          expect(Math.abs(a.origin.z - b.origin.z)).toBeLessThan(1e-3)
        }
        pairs++
      }
      db.close()
    }
    expect(pairs).toBeGreaterThan(50)
  })
})

describe.runIf(haveExamples)('several arrays in one download', () => {
  const V3 = `${EXAMPLES}/V-Series/V-Series setup example 3.dbpr`
  const load = async (unlinkMains = false) => {
    const db = await openDb(V3)
    // Unlinked, the two Main hangs are a separately built L/R pair: look-alikes, not a link.
    if (unlinkMains) db.run('UPDATE SourceGroups SET NextSourceGroupId = 0 WHERE SourceGroupId = 1')
    const p = readProject(db)
    const all = p.groups.filter((g) => !unsupportedReason(g)).map(buildModel)
    const byId = (id: number) => all.find((m) => m.group.sourceGroupId === id)!
    return { db, p, all, byId }
  }

  it('writes every planned array and each one’s linked mirror, and nothing else', async () => {
    const { db, p, all, byId } = await load()
    const main = { frameAngle: 4, splays: [0, 1, 2, 3, 4, 6, 9, 12] }
    const out = { frameAngle: 6, splays: [0, 2, 4, 6, 8, 10] }
    const { writes, problems } = planWrites(all, p.groups, [
      { model: byId(1), candidate: main, copyTo: [] },
      { model: byId(4), candidate: out, copyTo: [] },
    ])
    expect(problems).toEqual([])
    expect(writes.map((w) => [w.target.group.sourceGroupId, w.why]).sort()).toEqual([[1, 'own'], [2, 'linked'], [4, 'own'], [5, 'linked']])
    for (const w of writes) writeCandidate(db, w.target, w.candidate)
    const again = readProject(db)
    const m = (id: number) => buildModel(again.groups.find((g) => g.sourceGroupId === id)!)
    for (const id of [1, 2]) expect(m(id).splays).toEqual(main.splays)
    for (const id of [4, 5]) expect(m(id).splays).toEqual(out.splays)
    // Untouched groups are exactly as loaded.
    const cabs = (pr: typeof p, id: number) => pr.groups.find((g) => g.sourceGroupId === id)!.cabinets
    expect(cabs(again, 6)).toEqual(cabs(p, 6))
  })

  it('never lets a copy overwrite a look-alike’s own proposal', async () => {
    const { p, all, byId } = await load(true)
    const a = { frameAngle: 3, splays: [0, 1, 1, 2, 3, 5, 8, 12] }
    const b = { frameAngle: 5, splays: [0, 2, 2, 3, 4, 6, 9, 14] }
    const { writes, problems } = planWrites(all, p.groups, [
      { model: byId(1), candidate: a, copyTo: [byId(2)] },
      { model: byId(2), candidate: b, copyTo: [] },
    ])
    expect(writes.filter((w) => w.target.group.sourceGroupId === 2)).toEqual([expect.objectContaining({ why: 'own', candidate: b })])
    expect(problems.join()).toMatch(/has its own angles/)
  })

  it('copies to an unlinked look-alike when asked', async () => {
    const { p, all, byId } = await load(true)
    const a = { frameAngle: 3, splays: [0, 1, 1, 2, 3, 5, 8, 12] }
    const { writes } = planWrites(all, p.groups, [{ model: byId(1), candidate: a, copyTo: [byId(2)] }])
    expect(writes.map((w) => [w.target.group.sourceGroupId, w.why])).toEqual([[1, 'own'], [2, 'copy']])
  })
})
