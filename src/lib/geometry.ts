import type { SourceGroup, Vec2, Vec3 } from './types.ts'

/**
 * A flown line array reduced to its vertical section plane.
 *
 * Every number that fixes the rigging geometry is measured from the project itself rather
 * than taken from a table: ArrayCalc stores each cabinet's FRONT-TOP hinge point and its
 * absolute angle, and the vector from one hinge to the next is constant in the upper box's
 * own frame (fitted over ~2,000 pairs in ArrayCalc's example projects: V 0.3105 m, J 0.3617,
 * KSL 0.3322, … with micrometre residuals). So a new set of splays can be laid out exactly.
 */
export interface ArrayModel {
  group: SourceGroup
  /** Frame origin in world space: the section plane's origin. */
  origin: Vec3
  /** Horizontal aim in radians, about z from world +x. */
  heading: number
  /** Top hinge relative to the frame origin, in the top box's frame. */
  frameOffset: Vec2
  /** frameAngle − top box angle, as stored (non-zero on SL-Series frames). */
  frameDelta: number
  /** Hinge i → hinge i+1, in box i's frame. Length n−1. */
  links: Vec2[]
  /** Front-face height of each box (its pitch), used as the acoustic aperture. */
  heights: number[]
  /** Sideways offset of each hinge from the section plane (≈0), kept so a write-back is faithful. */
  lateral: number[]
  names: string[]
  levels: number[]
  mutes: boolean[]
  /** As loaded: top box angle, and the splay below each box (splays[0] is 0). */
  frameAngle: number
  splays: number[]
}

export interface BoxPose {
  hinge: Vec2
  /** Degrees, nose-up positive. */
  angle: number
  /** Centre of the front face: the acoustic source point. */
  centre: Vec2
  height: number
}

const rad = (d: number) => (d * Math.PI) / 180
export const rot = (v: Vec2, deg: number): Vec2 => {
  const t = rad(deg), c = Math.cos(t), s = Math.sin(t)
  return { u: c * v.u - s * v.z, z: s * v.u + c * v.z }
}

export function toSection(m: Pick<ArrayModel, 'origin' | 'heading'>, p: Vec3): { u: number; z: number; w: number } {
  const dx = p.x - m.origin.x, dy = p.y - m.origin.y
  const c = Math.cos(m.heading), s = Math.sin(m.heading)
  return { u: dx * c + dy * s, w: -dx * s + dy * c, z: p.z - m.origin.z }
}

export function fromSection(m: Pick<ArrayModel, 'origin' | 'heading'>, p: Vec2, w = 0): Vec3 {
  const c = Math.cos(m.heading), s = Math.sin(m.heading)
  return { x: m.origin.x + p.u * c - w * s, y: m.origin.y + p.u * s + w * c, z: m.origin.z + p.z }
}

/** Why a group cannot be optimised, or null if it can. */
export function unsupportedReason(g: SourceGroup): string | null {
  if (g.type !== 1) return 'not a line array'
  if (g.mounting !== 0) return g.mounting === 1 ? 'stacked arrays are not supported yet' : 'only vertically flown arrays are supported'
  if (!g.frame) return 'no flying frame in the project'
  if (g.cabinets.length < 2) return 'needs at least two cabinets'
  const h = g.cabinets[0].horizontalAngle
  if (g.cabinets.some((c) => Math.abs(c.horizontalAngle - h) > 1e-6)) return 'cabinets do not share one horizontal aim'
  return null
}

export function buildModel(g: SourceGroup): ArrayModel {
  const why = unsupportedReason(g)
  if (why) throw new Error(`${g.name}: ${why}`)
  const frame = g.frame!
  const cabs = g.cabinets
  const m = { origin: frame.origin, heading: rad(cabs[0].horizontalAngle) }
  const sec = cabs.map((c) => toSection(m, c.origin))

  const links: Vec2[] = []
  for (let i = 0; i + 1 < cabs.length; i++) {
    const d = { u: sec[i + 1].u - sec[i].u, z: sec[i + 1].z - sec[i].z }
    links.push(rot(d, -cabs[i].verticalAngle))
  }
  const pitch = links.map((l) => Math.hypot(l.u, l.z))
  // The bottom box has no link below it: borrow the pitch of the nearest box of the same type.
  const heights = cabs.map((c, i) => {
    if (i < pitch.length) return pitch[i]
    for (let j = pitch.length - 1; j >= 0; j--) if (cabs[j].name === c.name) return pitch[j]
    return pitch[pitch.length - 1]
  })

  return {
    group: g,
    origin: frame.origin,
    heading: m.heading,
    frameOffset: rot({ u: sec[0].u, z: sec[0].z }, -cabs[0].verticalAngle),
    frameDelta: frame.frameAngle - cabs[0].verticalAngle,
    links,
    heights,
    lateral: sec.map((s) => s.w),
    names: cabs.map((c) => c.name),
    levels: cabs.map((c) => c.level),
    mutes: cabs.map((c) => c.mute),
    frameAngle: frame.frameAngle,
    splays: cabs.map((c, i) => (i === 0 ? 0 : c.splay)),
  }
}

/** Lay the array out for a frame angle and a set of nominal splays (splays[0] ignored). */
export function poses(m: ArrayModel, frameAngle: number, splays: ArrayLike<number>): BoxPose[] {
  const out: BoxPose[] = []
  let angle = frameAngle - m.frameDelta
  let hinge = rot(m.frameOffset, angle)
  for (let i = 0; i < m.heights.length; i++) {
    if (i > 0) {
      const l = rot(m.links[i - 1], out[i - 1].angle)
      hinge = { u: hinge.u + l.u, z: hinge.z + l.z }
      angle -= splays[i]
    }
    const h = m.heights[i]
    const f = rot({ u: 0, z: -h / 2 }, angle)
    out.push({ hinge, angle, centre: { u: hinge.u + f.u, z: hinge.z + f.z }, height: h })
  }
  return out
}
