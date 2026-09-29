import type { BoxPose } from './geometry.ts'

/**
 * Cosplay's own direct-sound prediction. NOT ArrayCalc's: d&b's measured balloons are not
 * available to us, so each cabinet is modelled from its geometry alone —
 *
 *  - a flat, coherent vertical line source as tall as the box pitch (the isophasic wavefront
 *    a line-array waveguide is built to make), giving sinc(k·h/2·sin θ). Large splays
 *    therefore open real HF gaps, as they do in practice. A flat-topped beam as wide as the
 *    family's largest splay was tried and dropped: overlapping flat tops from point sources
 *    interfere into a ~15 dB comb at 8 kHz that no real array shows;
 *  - a front/back weighting that turns from omni at LF to a cardioid by ~1 kHz;
 *  - complex (phase-true) summation of all boxes, 1/r spreading, and ISO 9613-1 air
 *    absorption at the project's temperature and humidity.
 *
 * That captures what the splays actually control — where each box points and how the boxes
 * couple — and leaves out what they do not (the absolute level and the exact per-model
 * response). Results are in dB relative to one box on axis at 1 m, flat input.
 */

export const OCTAVES = [63, 125, 250, 500, 1000, 2000, 4000, 8000] as const
export type Octave = (typeof OCTAVES)[number]

export interface Atmosphere {
  temperatureK: number
  humidity: number
}

export function speedOfSound(tK: number): number {
  return 331.3 * Math.sqrt(tK / 273.15)
}

/** ISO 9613-1 pure-tone air absorption, dB per metre, at 101.325 kPa. */
export function airAbsorption(f: number, { temperatureK: T, humidity: hr }: Atmosphere): number {
  const T0 = 293.15, T01 = 273.16
  const psat = 10 ** (-6.8346 * (T01 / T) ** 1.261 + 4.6151)
  const h = hr * psat
  const frO = 24 + (4.04e4 * h * (0.02 + h)) / (0.391 + h)
  const frN = (T / T0) ** -0.5 * (9 + 280 * h * Math.exp(-4.17 * ((T / T0) ** (-1 / 3) - 1)))
  const a =
    8.686 *
    f * f *
    (1.84e-11 * (T / T0) ** 0.5 +
      (T / T0) ** -2.5 *
        ((0.01275 * Math.exp(-2239.1 / T)) / (frO + (f * f) / frO) +
          (0.1068 * Math.exp(-3352 / T)) / (frN + (f * f) / frN)))
  return a
}

/** Frequencies sampled inside one octave band (linear spacing, as predict() uses). 10 per octave
 * keeps the comb ripple of discrete boxes from aliasing into the trace. */
export function bandFrequencies(fc: number, perOctave = 10): number[] {
  const lo = fc / Math.SQRT2, df = (fc * Math.SQRT2 - lo) / perOctave
  return Array.from({ length: perOctave }, (_, i) => lo + (i + 0.5) * df)
}

export interface Listener {
  u: number
  z: number
}

export interface PredictOptions {
  atmosphere: Atmosphere
  /** Per-box trim in dB (CabinetsAdditionalData.Level). */
  levels?: ArrayLike<number>
  mutes?: ArrayLike<boolean>
  perOctave?: number
}

/**
 * Band levels in dB at each listener: result[band][listener].
 * The inner loop is the optimiser's whole cost, so it avoids allocation.
 */
export function predict(
  boxes: BoxPose[],
  listeners: Listener[],
  bands: readonly number[],
  opts: PredictOptions,
): Float64Array[] {
  const c = speedOfSound(opts.atmosphere.temperatureK)
  const n = boxes.length, m = listeners.length
  const gain = new Float64Array(n)
  for (let i = 0; i < n; i++) gain[i] = opts.mutes?.[i] ? 0 : 10 ** ((opts.levels?.[i] ?? 0) / 20)

  // Geometry once per call: distance, and sin/cos of the angle off each box's axis.
  const r = new Float64Array(n * m), sinT = new Float64Array(n * m), cosT = new Float64Array(n * m)
  for (let i = 0; i < n; i++) {
    const b = boxes[i]
    const a = (b.angle * Math.PI) / 180
    const ax = Math.cos(a), az = Math.sin(a)
    for (let j = 0; j < m; j++) {
      const du = listeners[j].u - b.centre.u, dz = listeners[j].z - b.centre.z
      const d = Math.max(Math.hypot(du, dz), 0.1)
      const k = i * m + j
      r[k] = d
      cosT[k] = (du * ax + dz * az) / d
      sinT[k] = (dz * ax - du * az) / d
    }
  }

  // Per band: frequencies spaced LINEARLY across the octave (a flat input spectrum), so that
  // k, the propagation phase k·r and the sinc argument all step by a constant per frequency.
  // Each then advances by one complex rotation instead of a sin/cos pair: the optimiser
  // spends nearly all its time here. Air absorption and the front/back weight are taken at
  // the band centre.
  const out: Float64Array[] = []
  const F = opts.perOctave ?? 10
  const re = new Float64Array(F * m), im = new Float64Array(F * m)
  for (const fc of bands) {
    re.fill(0)
    im.fill(0)
    const fLo = fc / Math.SQRT2, df = (fc * Math.SQRT2 - fLo) / F
    const k0 = (2 * Math.PI * (fLo + df / 2)) / c, dk = (2 * Math.PI * df) / c
    const alpha = airAbsorption(fc, opts.atmosphere) / 8.686 // nepers per metre
    // Front/back: omni well below 250 Hz, cardioid-ish above 1 kHz.
    const back = Math.min(1, Math.max(0, Math.log2(fc / 150) / Math.log2(1000 / 150)))
    for (let i = 0; i < n; i++) {
      if (!gain[i]) continue
      const hh = boxes[i].height / 2
      for (let j = 0; j < m; j++) {
        const q = i * m + j
        const rq = r[q]
        const amp = (gain[i] * (1 - back + back * 0.5 * (1 + cosT[q])) * Math.exp(-alpha * rq)) / rq
        // Propagation phasor e^{-jkr} and its step.
        let pr = Math.cos(k0 * rq), pi = -Math.sin(k0 * rq)
        const sr = Math.cos(dk * rq), si = -Math.sin(dk * rq)
        // sinc argument x = k·h/2·sinθ, carried as (sin x, cos x).
        let x = k0 * hh * sinT[q]
        const dx = dk * hh * sinT[q]
        let sx = Math.sin(x), cx = Math.cos(x)
        const sd = Math.sin(dx), cd = Math.cos(dx)
        for (let f = 0; f < F; f++) {
          const a = amp * (Math.abs(x) < 1e-6 ? 1 : sx / x)
          const o = f * m + j
          re[o] += a * pr
          im[o] += a * pi
          const npr = pr * sr - pi * si
          pi = pr * si + pi * sr
          pr = npr
          const nsx = sx * cd + cx * sd
          cx = cx * cd - sx * sd
          sx = nsx
          x += dx
        }
      }
    }
    const L = new Float64Array(m)
    for (let j = 0; j < m; j++) {
      let e = 0
      for (let f = 0; f < F; f++) e += re[f * m + j] ** 2 + im[f * m + j] ** 2
      L[j] = 10 * Math.log10(e / F + 1e-30)
    }
    out.push(L)
  }
  return out
}
