import { toSection, type ArrayModel } from './geometry.ts'
import type { ListeningPlane } from './types.ts'

/** A listener position on the array's main axis. */
export interface SectionPoint {
  /** Horizontal distance from the frame along the aim, metres. */
  u: number
  /** Ear height relative to the frame origin, metres (negative: below the array). */
  z: number
  planeId: number
}

export interface SectionSegment {
  planeId: number
  name: string
  points: SectionPoint[]
}

/**
 * Where the listening planes cross the vertical half-plane through the array's horizontal aim:
 * the same line ArrayCalc's "Direct sound level vs. distance" plot is drawn along.
 * Stacked tiers (stalls under a balcony) each give their own segment.
 */
export function sectionSegments(m: ArrayModel, planes: ListeningPlane[], step = 0.25): SectionSegment[] {
  const segs: SectionSegment[] = []
  for (const pl of planes) {
    // Intersect each triangle with the plane w = 0, keep u >= 0.
    const spans: { u0: number; z0: number; u1: number; z1: number }[] = []
    for (const tri of pl.triangles) {
      const s = tri.map((p) => toSection(m, p))
      const cut: { u: number; z: number }[] = []
      for (let i = 0; i < 3; i++) {
        const a = s[i], b = s[(i + 1) % 3]
        if (a.w <= 0 === b.w <= 0) continue
        const t = a.w / (a.w - b.w)
        cut.push({ u: a.u + t * (b.u - a.u), z: a.z + t * (b.z - a.z) })
      }
      if (cut.length < 2) continue
      cut.sort((p, q) => p.u - q.u)
      const lo = cut[0], hi = cut[cut.length - 1]
      if (hi.u <= 0 || hi.u - lo.u < 1e-6) continue
      spans.push({ u0: lo.u, z0: lo.z, u1: hi.u, z1: hi.z })
    }
    if (!spans.length) continue
    const u0 = Math.max(0, Math.min(...spans.map((s) => s.u0)))
    const u1 = Math.max(...spans.map((s) => s.u1))
    const points: SectionPoint[] = []
    for (let u = Math.ceil(u0 / step) * step; u <= u1 + 1e-9; u += step) {
      // Highest surface of this plane at u (a plane is single-valued in practice).
      let z = -Infinity
      for (const s of spans) {
        if (u < s.u0 - 1e-9 || u > s.u1 + 1e-9) continue
        const t = s.u1 === s.u0 ? 0 : (u - s.u0) / (s.u1 - s.u0)
        z = Math.max(z, s.z0 + t * (s.z1 - s.z0))
      }
      if (z > -Infinity) points.push({ u, z, planeId: pl.venueObjectId })
    }
    if (points.length) segs.push({ planeId: pl.venueObjectId, name: pl.name, points })
  }
  return segs.sort((a, b) => a.points[0].u - b.points[0].u)
}
