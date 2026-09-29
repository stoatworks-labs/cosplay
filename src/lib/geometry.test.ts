import { describe, expect, it } from 'vitest'
import { readProject } from './dbpr.ts'
import { buildModel, poses, toSection, unsupportedReason } from './geometry.ts'
import { exampleFiles, haveExamples, openDb } from './testing.ts'

// Compression-rigged systems store the deflected angle, not frame − Σ nominal splays (±0.3°).
const COMPRESSION = /^(GSL|KSL|XSL|CCL)/

describe.runIf(haveExamples)('geometry against ArrayCalc example projects', () => {
  it('re-lays every flown array from its own splays onto the stored hinge points', async () => {
    let arrays = 0, boxes = 0
    for (const f of exampleFiles()) {
      const db = await openDb(f)
      const p = readProject(db, f)
      for (const g of p.groups) {
        if (unsupportedReason(g)) continue
        const m = buildModel(g)
        const ps = poses(m, m.frameAngle, m.splays)
        const exact = !g.cabinets.some((c) => COMPRESSION.test(c.name))
        g.cabinets.forEach((c, i) => {
          const s = toSection(m, c.origin)
          if (exact || i === 0) {
            expect(Math.abs(ps[i].angle - c.verticalAngle), `${f} ${g.name} #${i + 1} angle`).toBeLessThan(1e-3)
            expect(Math.hypot(ps[i].hinge.u - s.u, ps[i].hinge.z - s.z), `${f} ${g.name} #${i + 1} hinge`).toBeLessThan(2e-4)
          } else {
            expect(Math.abs(ps[i].angle - c.verticalAngle)).toBeLessThan(0.5 * i)
          }
          boxes++
        })
        arrays++
      }
      db.close()
    }
    expect(arrays).toBeGreaterThan(40)
    console.log(`checked ${arrays} arrays, ${boxes} boxes`)
  })
})
