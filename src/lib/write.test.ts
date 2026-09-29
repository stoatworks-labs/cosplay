import { describe, expect, it } from 'vitest'
import { linkedFollowers, readProject } from './dbpr.ts'
import { buildModel, unsupportedReason } from './geometry.ts'
import { linkedTargets, writeCandidate } from './write.ts'
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
