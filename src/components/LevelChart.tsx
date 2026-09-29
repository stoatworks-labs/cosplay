import { useMemo, useState } from 'react'
import type { Evaluation } from '../lib/optimise.ts'
import { ticks, useWidth } from './useWidth.ts'

/** Colour follows the band, never its position in the list. */
export const BAND_SERIES: Record<number, number> = { 1000: 1, 2000: 2, 4000: 3, 8000: 4, 63: 5, 125: 5, 250: 5, 500: 5 }
const fmtHz = (f: number) => (f >= 1000 ? `${f / 1000}k` : `${f}`)

interface Props {
  before: Evaluation
  after: Evaluation | null
  fromM: number
  toM: number
  /** Indices where a new plane (or a gap) starts: the line breaks there. */
  segments: number[]
}

const H = 320
const PAD = { l: 44, r: 16, t: 12, b: 34 }

export function LevelChart({ before, after, fromM, toM, segments }: Props) {
  const [ref, W] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const nFlat = before.bands.length - (before.bands.some((b) => b < 1000) ? 1 : 0)

  // One offset for both states, taken from the as-loaded flat bands, so real level changes stay visible.
  const offset = useMemo(() => {
    let s = 0, n = 0
    for (let b = 0; b < nFlat; b++) for (const v of before.levels[b]) (s += v), n++
    return n ? s / n : 0
  }, [before, nFlat])

  const all = [before, ...(after ? [after] : [])]
  const dMin = Math.min(...before.distance), dMax = Math.max(...before.distance)
  const vals = all.flatMap((e) => e.levels.flat()).map((v) => v - offset)
  const yLo = Math.floor(Math.max(Math.min(...vals), -30) / 3) * 3 - 3
  const yHi = Math.ceil(Math.min(Math.max(...vals), 20) / 3) * 3 + 3
  const x = (d: number) => PAD.l + ((d - dMin) / (dMax - dMin || 1)) * (W - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + ((yHi - v) / (yHi - yLo)) * (H - PAD.t - PAD.b)

  const path = (e: Evaluation, b: number) => {
    let d = ''
    const breaks = new Set(segments)
    e.levels[b].forEach((v, i) => {
      d += `${i === 0 || breaks.has(i) ? 'M' : 'L'}${x(e.distance[i]).toFixed(1)},${y(v - offset).toFixed(1)}`
    })
    return d
  }
  const targetPath = (e: Evaluation) => {
    const breaks = new Set(segments)
    return e.target.map((v, i) => `${i === 0 || breaks.has(i) ? 'M' : 'L'}${x(e.distance[i]).toFixed(1)},${y(v - offset).toFixed(1)}`).join('')
  }

  const onMove = (ev: React.MouseEvent<SVGSVGElement>) => {
    const r = ev.currentTarget.getBoundingClientRect()
    const px = ev.clientX - r.left
    let best = 0, bd = Infinity
    before.distance.forEach((d, i) => {
      const dd = Math.abs(x(d) - px)
      if (dd < bd) (bd = dd), (best = i)
    })
    setHover(best)
  }

  const shown = after ?? before
  return (
    <div className="chart" ref={ref}>
      <div className="legend">
        {before.bands.map((b) => (
          <span key={b} className="key">
            <i style={{ background: `var(--series-${BAND_SERIES[b]})` }} />
            {fmtHz(b)}Hz{b < 1000 ? ' (tracked)' : ''}
          </span>
        ))}
        <span className="key">
          <i className="dash" />
          target
        </span>
      </div>
      <svg width={W} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Direct sound level against distance, per octave band">
        {ticks(yLo, yHi, 6).map((t) => (
          <g key={`y${t}`}>
            <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
            <text className="axis" x={PAD.l - 6} y={y(t) + 4} textAnchor="end">
              {t > 0 ? `+${t}` : t}
            </text>
          </g>
        ))}
        {ticks(dMin, dMax, Math.max(3, Math.floor(W / 90))).map((t) => (
          <text key={`x${t}`} className="axis" x={x(t)} y={H - PAD.b + 16} textAnchor="middle">
            {t}
          </text>
        ))}
        <text className="axis" x={W - PAD.r} y={H - 4} textAnchor="end">
          horizontal distance from array (m)
        </text>
        {fromM > dMin && <rect className="excluded" x={PAD.l} y={PAD.t} width={Math.max(0, x(Math.min(fromM, dMax)) - PAD.l)} height={H - PAD.t - PAD.b} />}
        {toM < dMax && <rect className="excluded" x={x(Math.max(toM, dMin))} y={PAD.t} width={Math.max(0, W - PAD.r - x(Math.max(toM, dMin)))} height={H - PAD.t - PAD.b} />}
        <path className="target" d={targetPath(shown)} />
        {before.bands.map((b, i) => (
          <path key={`b${b}`} className={after ? 'trace before' : 'trace'} style={{ stroke: `var(--series-${BAND_SERIES[b]})` }} d={path(before, i)} />
        ))}
        {after?.bands.map((b, i) => (
          <path key={`a${b}`} className="trace" style={{ stroke: `var(--series-${BAND_SERIES[b]})` }} d={path(after, i)} />
        ))}
        {hover !== null && (
          <g>
            <line className="cross" x1={x(before.distance[hover])} x2={x(before.distance[hover])} y1={PAD.t} y2={H - PAD.b} />
            {shown.bands.map((b, i) => (
              <circle key={b} cx={x(shown.distance[hover])} cy={y(shown.levels[i][hover] - offset)} r={4} className="dot" style={{ fill: `var(--series-${BAND_SERIES[b]})` }} />
            ))}
          </g>
        )}
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{ left: Math.min(x(before.distance[hover]) + 12, W - 170) }}>
          <b>{before.distance[hover].toFixed(1)} m</b>
          {shown.bands.map((b, i) => (
            <div key={b}>
              <i style={{ background: `var(--series-${BAND_SERIES[b]})` }} />
              {fmtHz(b)}Hz {(shown.levels[i][hover] - offset).toFixed(1)}
              {after && <span className="muted"> (was {(before.levels[i][hover] - offset).toFixed(1)})</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
