import { fromSection, poses, rot, type ArrayModel } from './geometry.ts'
import type { SqlDb } from './dbpr.ts'
import type { Candidate } from './optimise.ts'

/**
 * Write a frame angle and splays into the project, keeping every stored field that depends
 * on them consistent: FlyingFrames.FrameAngle, each cabinet's VerticalAngle and hinge origin,
 * CabinetsAdditionalData.SplayAngle, and the group's HeightLowestEdge (shifted by as much as
 * the bottom box's lower front corner moved). Pick-point loads are left for ArrayCalc to redo.
 *
 * `target` may be another group with the same cabinet column (the mirrored hang): the new
 * angles are laid out from that group's own frame, heading and measured rigging.
 */
export function writeCandidate(db: SqlDb, target: ArrayModel, c: Candidate): void {
  const g = target.group
  if (g.cabinets.length !== c.splays.length) throw new Error(`${g.name}: ${g.cabinets.length} boxes, ${c.splays.length} splays`)
  const next = poses(target, c.frameAngle, c.splays)
  const prev = poses(target, target.frameAngle, target.splays)
  const bottomFront = (ps: ReturnType<typeof poses>) => {
    const last = ps[ps.length - 1]
    return last.hinge.z + rot({ u: 0, z: -last.height }, last.angle).z
  }
  const drop = bottomFront(next) - bottomFront(prev)

  db.run('BEGIN')
  try {
    db.run('UPDATE FlyingFrames SET FrameAngle = ? WHERE FlyingFrameId = ?', [c.frameAngle, g.frame!.flyingFrameId])
    g.cabinets.forEach((cab, i) => {
      const o = fromSection(target, next[i].hinge, target.lateral[i])
      db.run('UPDATE Cabinets SET VerticalAngle = ?, OriginX = ?, OriginY = ?, OriginZ = ? WHERE CabinetId = ?', [
        next[i].angle, o.x, o.y, o.z, cab.cabinetId,
      ])
      db.run('UPDATE CabinetsAdditionalData SET SplayAngle = ? WHERE CabinetId = ?', [i === 0 ? 0 : c.splays[i], cab.cabinetId])
    })
    db.run(
      'UPDATE SourceGroupsAdditionalData SET HeightLowestEdge = HeightLowestEdge + ? WHERE SourceGroupId = ? AND HeightLowestEdge IS NOT NULL',
      [drop, g.sourceGroupId],
    )
    db.run('COMMIT')
  } catch (e) {
    db.run('ROLLBACK')
    throw e
  }
}

/** Other groups this result can be copied to: same boxes in the same order (a mirrored L/R hang). */
export function twins(models: ArrayModel[], m: ArrayModel): ArrayModel[] {
  const sig = m.names.join('|')
  return models.filter((o) => o !== m && o.names.join('|') === sig)
}
