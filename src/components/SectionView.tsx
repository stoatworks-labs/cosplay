import { poses, rot, type ArrayModel, type BoxPose } from '../lib/geometry.ts'
import type { Candidate } from '../lib/optimise.ts'
import type { SectionSegment } from '../lib/section.ts'
import { ticks, useWidth } from './useWidth.ts'

interface Props {
  model: ArrayModel
  segments: SectionSegment[]
  before: Candidate
  after: Candidate | null
}

const PAD = 28

/** Side view, true to scale: listening planes on the axis, the boxes, and each box's aim line. */
export function SectionView({ model, segments, before, after }: Props) {
  const [ref, full] = useWidth<HTMLDivElement>(420)
  // The magnified hang sits beside the section when there is room, above it when not.
  const side = full >= 520
  const W = side ? full - 166 : full
  const pb = poses(model, before.frameAngle, before.splays)
  const pa = after ? poses(model, after.frameAngle, after.splays) : null
  const pts = segments.flatMap((s) => s.points)
  const uMax = Math.max(10, ...pts.map((p) => p.u)) + 2
  const zs = [...pts.map((p) => p.z), ...pb.map((b) => b.hinge.z), 0, -1]
  const zMin = Math.min(...zs) - 2, zMax = Math.max(...zs, 1) + 2
  const uMin = -3
  const s = (W - 2 * PAD) / (uMax - uMin)
  const H = Math.min(420, Math.max(200, (zMax - zMin) * s + 2 * PAD))
  const sc = Math.min(s, (H - 2 * PAD) / (zMax - zMin))
  const X = (u: number) => PAD + (u - uMin) * sc
  const Y = (z: number) => H - PAD - (z - zMin) * sc

  // Where each box's axis first meets the audience, for the aim lines.
  const aimEnd = (b: BoxPose) => {
    const a = (b.angle * Math.PI) / 180
    const dir = { u: Math.cos(a), z: Math.sin(a) }
    let best = uMax * 1.5
    for (const seg of segments) {
      for (let i = 1; i < seg.points.length; i++) {
        const p = seg.points[i - 1], q = seg.points[i]
        // Solve centre + t·dir = p + s·(q − p)
        const ex = q.u - p.u, ez = q.z - p.z
        const den = dir.u * ez - dir.z * ex
        if (Math.abs(den) < 1e-9) continue
        const wx = p.u - b.centre.u, wz = p.z - b.centre.z
        const t = (wx * ez - wz * ex) / den
        const k = (wx * dir.z - wz * dir.u) / den
        if (t > 0 && k >= 0 && k <= 1) best = Math.min(best, t)
      }
    }
    return { u: b.centre.u + dir.u * best, z: b.centre.z + dir.z * best }
  }

  const box = (b: BoxPose, cls: string, i: number) => {
    const depth = 0.45
    const c = [
      b.hinge,
      { u: b.hinge.u + rot({ u: 0, z: -b.height }, b.angle).u, z: b.hinge.z + rot({ u: 0, z: -b.height }, b.angle).z },
      { u: b.hinge.u + rot({ u: -depth, z: -b.height }, b.angle).u, z: b.hinge.z + rot({ u: -depth, z: -b.height }, b.angle).z },
      { u: b.hinge.u + rot({ u: -depth, z: 0 }, b.angle).u, z: b.hinge.z + rot({ u: -depth, z: 0 }, b.angle).z },
    ]
    return <polygon key={`${cls}${i}`} className={cls} points={c.map((p) => `${X(p.u)},${Y(p.z)}`).join(' ')} />
  }

  const shown = pa ?? pb
  return (
    <div className={`section${side ? ' side' : ''}`} ref={ref}>
      <Inset before={pb} after={pa} />
      <svg width={W} height={H} role="img" aria-label="Side section of the array and listening planes">
        {ticks(0, uMax, Math.max(3, Math.floor(W / 80))).map((t) => (
          <g key={t}>
            <line className="grid" x1={X(t)} x2={X(t)} y1={PAD / 2} y2={H - PAD} />
            <text className="axis" x={X(t)} y={H - 8} textAnchor="middle">
              {t} m
            </text>
          </g>
        ))}
        {segments.map((seg) => (
          <polyline key={seg.planeId} className="plane" points={seg.points.map((p) => `${X(p.u)},${Y(p.z)}`).join(' ')} />
        ))}
        {shown.map((b, i) => {
          const e = aimEnd(b)
          return <line key={`aim${i}`} className="aim" x1={X(b.centre.u)} y1={Y(b.centre.z)} x2={X(e.u)} y2={Y(e.z)} />
        })}
        {pa && pb.map((b, i) => box(b, 'box ghost', i))}
        {shown.map((b, i) => box(b, 'box', i))}
      </svg>
    </div>
  )
}

/** The hang itself, magnified: as loaded dashed, proposed solid. */
function Inset({ before, after }: { before: BoxPose[]; after: BoxPose[] | null }) {
  const x = 0, y = 0
  const all = [...before, ...(after ?? [])]
  const depth = 0.45
  const corners = (b: BoxPose) =>
    [{ u: 0, z: 0 }, { u: 0, z: -b.height }, { u: -depth, z: -b.height }, { u: -depth, z: 0 }].map((c) => {
      const r = rot(c, b.angle)
      return { u: b.hinge.u + r.u, z: b.hinge.z + r.z }
    })
  const pts = all.flatMap(corners)
  const u0 = Math.min(...pts.map((p) => p.u)), u1 = Math.max(...pts.map((p) => p.u))
  const z0 = Math.min(...pts.map((p) => p.z)), z1 = Math.max(...pts.map((p) => p.z))
  const size = 150
  const k = (size - 16) / Math.max(u1 - u0, z1 - z0, 0.5)
  const X = (u: number) => x + 8 + (u - u0) * k
  const Y = (z: number) => y + 8 + (z1 - z) * k
  const poly = (b: BoxPose, cls: string, i: number) => (
    <polygon key={cls + i} className={cls} points={corners(b).map((p) => `${X(p.u)},${Y(p.z)}`).join(' ')} />
  )
  const h = (z1 - z0) * k + 16
  return (
    <svg className="inset" width={size} height={h} role="img" aria-label="The array, magnified: as loaded dashed, proposed solid">
      {after && before.map((b, i) => poly(b, 'box ghost', i))}
      {(after ?? before).map((b, i) => poly(b, 'box', i))}
    </svg>
  )
}
