import type { Cabinet, FlyingFrame, ListeningPlane, Project, SourceGroup, Vec3 } from './types.ts'

/** The part of a sql.js `Database` this module uses, so tests and the browser share one reader. */
export interface SqlDb {
  exec(sql: string, params?: (string | number | null)[]): { columns: string[]; values: unknown[][] }[]
  run(sql: string, params?: (string | number | null)[]): unknown
}

type Row = Record<string, unknown>

export function rows(db: SqlDb, sql: string, params: (string | number | null)[] = []): Row[] {
  const res = db.exec(sql, params)
  if (!res.length) return []
  const { columns, values } = res[0]
  return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])))
}

function tableExists(db: SqlDb, name: string): boolean {
  return rows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]).length > 0
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown): string => (v == null ? '' : String(v))

export const PLANE_LISTENING = 1

export function readProject(db: SqlDb, fileName = 'project.dbpr'): Project {
  const warnings: string[] = []
  for (const t of ['SourceGroups', 'SourceGroupsAdditionalData', 'Cabinets', 'CabinetsAdditionalData', 'VenueObjects']) {
    if (!tableExists(db, t)) throw new Error(`Not an ArrayCalc project: table ${t} is missing.`)
  }

  const settings = new Map(rows(db, 'SELECT Name, Value FROM ProjectSettings').map((r) => [str(r.Name), r.Value]))
  const temperatureK = num(Number(settings.get('Temperature')), 293.15)
  const humidity = num(Number(settings.get('Humidity')), 50)

  const frames = new Map<number, FlyingFrame>()
  if (tableExists(db, 'FlyingFrames')) {
    for (const r of rows(db, 'SELECT * FROM FlyingFrames ORDER BY PositionIndex')) {
      const sg = num(r.SourceGroupId)
      // One frame per group on every flown array seen; a second (compression frame, SUB adapter) is kept out.
      if (frames.has(sg)) continue
      frames.set(sg, {
        flyingFrameId: num(r.FlyingFrameId),
        type: str(r.Name),
        frameAngle: num(r.FrameAngle),
        origin: { x: num(r.OriginX), y: num(r.OriginY), z: num(r.OriginZ) },
      })
    }
  }

  const cabinetsByGroup = new Map<number, Cabinet[]>()
  for (const r of rows(
    db,
    `SELECT c.CabinetId, c.SourceGroupId, c.PositionIndex, c.SpeakerId, c.HorizontalAngle, c.VerticalAngle,
            c.OriginX, c.OriginY, c.OriginZ, d.Name, d.SplayAngle, d.Level, d.Mute
       FROM Cabinets c LEFT JOIN CabinetsAdditionalData d USING (CabinetId)
      ORDER BY c.SourceGroupId, c.PositionIndex`,
  )) {
    const sg = num(r.SourceGroupId)
    const list = cabinetsByGroup.get(sg) ?? []
    list.push({
      cabinetId: num(r.CabinetId),
      positionIndex: num(r.PositionIndex),
      name: str(r.Name),
      speakerId: num(r.SpeakerId),
      verticalAngle: num(r.VerticalAngle),
      horizontalAngle: num(r.HorizontalAngle),
      splay: num(r.SplayAngle),
      origin: { x: num(r.OriginX), y: num(r.OriginY), z: num(r.OriginZ) },
      level: num(r.Level),
      mute: Boolean(num(r.Mute)),
    })
    cabinetsByGroup.set(sg, list)
  }

  const groups: SourceGroup[] = rows(
    db,
    `SELECT s.SourceGroupId, s.Name, s.Type, s.Mounting, s.ArrayProcessingEnable, a.System, a.OriginX, a.OriginY, a.OriginZ
       FROM SourceGroups s LEFT JOIN SourceGroupsAdditionalData a USING (SourceGroupId)
      ORDER BY s.OrderIndex, s.SourceGroupId`,
  ).map((r) => {
    const id = num(r.SourceGroupId)
    return {
      sourceGroupId: id,
      name: str(r.Name),
      type: num(r.Type),
      mounting: num(r.Mounting),
      system: str(r.System),
      origin: { x: num(r.OriginX), y: num(r.OriginY), z: num(r.OriginZ) },
      arrayProcessing: Boolean(num(r.ArrayProcessingEnable)),
      cabinets: cabinetsByGroup.get(id) ?? [],
      frame: frames.get(id) ?? null,
    }
  })

  const planes = readListeningPlanes(db, warnings)
  const info = tableExists(db, 'ProjectInformation')
    ? rows(db, 'SELECT ProjectName FROM ProjectInformation ORDER BY AuthorDateTime DESC LIMIT 1')[0]
    : undefined
  const name = str(info?.ProjectName) || fileName
  return { name, groups, planes, temperatureK, humidity, warnings }
}

// ---------------------------------------------------------------------------------------------
// Venue: listening planes, tessellated to triangles in world space.
// ---------------------------------------------------------------------------------------------

interface VenueRow {
  id: number
  name: string
  shape: number
  planeType: number
  enabled: boolean
  listenerHeight: number
  origin: Vec3
  rotZ: number
  rotX: number
  rotY: number
  scale: Vec3
  parent: number
}

/** Local → parent space: scale, then rotate about z, then translate. Inferred order; X/Y rotation is never used. */
function applyLocal(o: VenueRow, p: Vec3): Vec3 {
  const sx = p.x * o.scale.x, sy = p.y * o.scale.y, sz = p.z * o.scale.z
  const t = (o.rotZ * Math.PI) / 180
  const c = Math.cos(t), s = Math.sin(t)
  return { x: o.origin.x + c * sx - s * sy, y: o.origin.y + s * sx + c * sy, z: o.origin.z + sz }
}

function readListeningPlanes(db: SqlDb, warnings: string[]): ListeningPlane[] {
  const objs = new Map<number, VenueRow>()
  for (const r of rows(db, 'SELECT * FROM VenueObjects')) {
    objs.set(num(r.VenueObjectId), {
      id: num(r.VenueObjectId),
      name: str(r.Name),
      shape: num(r.Shape),
      planeType: num(r.PlaneType),
      enabled: Boolean(num(r.Enabled, 1)),
      listenerHeight: num(r.ListenerHeight),
      origin: { x: num(r.OriginX), y: num(r.OriginY), z: num(r.OriginZ) },
      rotX: num(r.RotationX),
      rotY: num(r.RotationY),
      rotZ: num(r.RotationZ),
      scale: { x: num(r.ScaleX, 1), y: num(r.ScaleY, 1), z: num(r.ScaleZ, 1) },
      parent: num(r.ParentVenueObjectId),
    })
  }
  const points = new Map<number, Vec3[]>()
  for (const r of rows(db, 'SELECT * FROM VenueObjectPoints ORDER BY VenueObjectId, PointIndex')) {
    const id = num(r.VenueObjectId)
    const list = points.get(id) ?? []
    list.push({ x: num(r.X), y: num(r.Y), z: num(r.Z) })
    points.set(id, list)
  }
  const arcs = new Map<number, Row>()
  for (const t of ['VenueObjectsCircular', 'VenueObjectsEllipsoidal']) {
    if (tableExists(db, t)) for (const r of rows(db, `SELECT * FROM ${t}`)) arcs.set(num(r.VenueObjectId), r)
  }

  const toWorld = (o: VenueRow, p: Vec3): Vec3 => {
    let q = applyLocal(o, p)
    let parent = objs.get(o.parent)
    for (let guard = 0; parent && guard < 32; guard++) {
      q = applyLocal(parent, q)
      parent = objs.get(parent.parent)
    }
    return q
  }
  const enabledChain = (o: VenueRow): boolean => {
    let cur: VenueRow | undefined = o
    for (let guard = 0; cur && guard < 32; guard++) {
      if (!cur.enabled) return false
      cur = objs.get(cur.parent)
    }
    return true
  }

  const planes: ListeningPlane[] = []
  let tilted = 0
  for (const o of objs.values()) {
    if (o.planeType !== PLANE_LISTENING || o.shape === 5 || !enabledChain(o)) continue
    if (o.rotX || o.rotY) tilted++
    const lift = (p: Vec3): Vec3 => ({ ...p, z: p.z + o.listenerHeight })
    let local: [Vec3, Vec3, Vec3][] = []
    const pts = points.get(o.id) ?? []
    if (o.shape === 1 && pts.length >= 4) {
      local = [[pts[0], pts[1], pts[2]], [pts[0], pts[2], pts[3]]]
    } else if (o.shape === 6 && pts.length >= 3) {
      local = [[pts[0], pts[1], pts[2]]]
    } else if (o.shape === 4 && pts.length >= 8) {
      // A box: the audience stands on its top face, P5..P8.
      local = [[pts[4], pts[5], pts[6]], [pts[4], pts[6], pts[7]]]
    } else if ((o.shape === 2 || o.shape === 3) && arcs.has(o.id)) {
      local = tessellateArc(arcs.get(o.id)!)
    } else {
      warnings.push(`Listening plane "${o.name}" (shape ${o.shape}) could not be read and is ignored.`)
      continue
    }
    planes.push({
      venueObjectId: o.id,
      name: o.name,
      shape: o.shape,
      listenerHeight: o.listenerHeight,
      triangles: local.map((t) => t.map((p) => lift(toWorld(o, p))) as [Vec3, Vec3, Vec3]),
    })
  }
  if (tilted) warnings.push(`${tilted} listening plane(s) carry X/Y rotation, which Cosplay ignores.`)
  return planes
}

/**
 * Elliptical (optionally super-elliptical) annulus sector with a linear rake from the inner
 * edge (InnerZ) to the outer edge (OuterZ). Angles in degrees, counter-clockwise from local +x.
 * The superellipse exponent (Ellipsoidal's InnerN/OuterN) is an inference from the column names.
 */
function tessellateArc(r: Row): [Vec3, Vec3, Vec3][] {
  const start = (num(r.StartAngle) * Math.PI) / 180
  const span = (num(r.SpanAngle, 360) * Math.PI) / 180
  const nR = 8, nA = Math.max(8, Math.ceil(Math.abs(span) / (Math.PI / 48)))
  const at = (i: number, j: number): Vec3 => {
    const f = i / nR
    const a = num(r.InnerA) + f * (num(r.OuterA) - num(r.InnerA))
    const b = num(r.InnerB) + f * (num(r.OuterB) - num(r.InnerB))
    const n = r.InnerN == null ? 2 : num(r.InnerN, 2) + f * (num(r.OuterN, 2) - num(r.InnerN, 2))
    const phi = start + (j / nA) * span
    const c = Math.cos(phi), s = Math.sin(phi)
    const e = 2 / (n || 2)
    return {
      x: a * Math.sign(c) * Math.abs(c) ** e,
      y: b * Math.sign(s) * Math.abs(s) ** e,
      z: num(r.InnerZ) + f * (num(r.OuterZ) - num(r.InnerZ)),
    }
  }
  const tris: [Vec3, Vec3, Vec3][] = []
  for (let i = 0; i < nR; i++) {
    for (let j = 0; j < nA; j++) {
      const p00 = at(i, j), p10 = at(i + 1, j), p11 = at(i + 1, j + 1), p01 = at(i, j + 1)
      tris.push([p00, p10, p11], [p00, p11, p01])
    }
  }
  return tris
}
