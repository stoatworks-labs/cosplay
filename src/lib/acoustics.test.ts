import { describe, expect, it } from 'vitest'
import { airAbsorption, bandFrequencies, predict, speedOfSound } from './acoustics.ts'
import type { BoxPose } from './geometry.ts'

const atm = { temperatureK: 293.15, humidity: 50 }
const box = (z: number, angle: number, h = 0.31): BoxPose => ({ hinge: { u: 0, z }, angle, centre: { u: 0, z: z - h / 2 }, height: h })

/** Straightforward version of predict(): one sin/cos per term, no recurrences. */
function reference(boxes: BoxPose[], pts: { u: number; z: number }[], fc: number): number[] {
  const c = speedOfSound(atm.temperatureK)
  const alpha = airAbsorption(fc, atm) / 8.686
  const back = Math.min(1, Math.max(0, Math.log2(fc / 150) / Math.log2(1000 / 150)))
  return pts.map((p) => {
    let e = 0
    for (const f of bandFrequencies(fc, 10)) {
      const k = (2 * Math.PI * f) / c
      let re = 0, im = 0
      for (const b of boxes) {
        const a = (b.angle * Math.PI) / 180
        const du = p.u - b.centre.u, dz = p.z - b.centre.z
        const r = Math.max(Math.hypot(du, dz), 0.1)
        const cos = (du * Math.cos(a) + dz * Math.sin(a)) / r
        const sin = (dz * Math.cos(a) - du * Math.sin(a)) / r
        const x = (k * b.height * sin) / 2
        const amp = ((x === 0 ? 1 : Math.sin(x) / x) * (1 - back + back * 0.5 * (1 + cos)) * Math.exp(-alpha * r)) / r
        re += amp * Math.cos(-k * r)
        im += amp * Math.sin(-k * r)
      }
      e += re * re + im * im
    }
    return 10 * Math.log10(e / 10)
  })
}

describe('prediction', () => {
  it('matches the straightforward sum to 0.01 dB', () => {
    const boxes = Array.from({ length: 10 }, (_, i) => box(-0.31 * i, -2 - i * i * 0.4))
    const pts = Array.from({ length: 80 }, (_, i) => ({ u: 3 + i * 0.6, z: -9 + i * 0.05 }))
    const got = predict(boxes, pts, [125, 1000, 8000], { atmosphere: atm })
    ;[125, 1000, 8000].forEach((fc, b) => {
      const want = reference(boxes, pts, fc)
      want.forEach((w, j) => expect(Math.abs(got[b][j] - w)).toBeLessThan(0.01))
    })
  })

  it('one box on axis falls 6 dB per doubled distance at LF', () => {
    const pts = [10, 20, 40].map((u) => ({ u, z: -0.155 }))
    const [L] = predict([box(0, 0)], pts, [125], { atmosphere: atm })
    expect(L[0] - L[1]).toBeCloseTo(6.02, 1)
    expect(L[1] - L[2]).toBeCloseTo(6.02, 1)
  })

  it('air absorption matches ISO 9613-2 Table 2 (20 °C, 70 %) to 5 %', () => {
    const table: [number, number][] = [[250, 1.1], [500, 2.8], [1000, 5.0], [2000, 9.0], [4000, 22.9], [8000, 76.6]]
    for (const [f, dbPerKm] of table) {
      const got = airAbsorption(f, { temperatureK: 293.15, humidity: 70 }) * 1000
      expect(Math.abs(got / dbPerKm - 1), `${f} Hz: ${got.toFixed(1)} dB/km`).toBeLessThan(0.05)
    }
  })

  it('a straight 12-box column beams: on-axis beats 10° off at 4 kHz by > 10 dB', () => {
    const boxes = Array.from({ length: 12 }, (_, i) => box(-0.31 * i, 0))
    const d = 30, zc = -0.31 * 6
    const t = (10 * Math.PI) / 180
    const [L] = predict(boxes, [{ u: d, z: zc }, { u: d * Math.cos(t), z: zc - d * Math.sin(t) }], [4000], { atmosphere: atm })
    expect(L[0] - L[1]).toBeGreaterThan(10)
  })
})
