/**
 * The slice of an ArrayCalc project (.dbpr, a SQLite database) that Cosplay reads and writes.
 *
 * REVERSE-ENGINEERED from ArrayCalc 12.8.3's own example projects. There is no published
 * schema. What is asserted here was checked against those files (see docs/FORMAT.md);
 * anything inferred says so.
 */

/** A point or vector in the section plane of one array: `u` forward along the horizontal aim, `z` up. */
export interface Vec2 {
  u: number
  z: number
}

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Cabinet {
  cabinetId: number
  positionIndex: number
  /** Box type as ArrayCalc names it: "V8", "KSL12", "J-SUB"… */
  name: string
  speakerId: number
  /** Degrees. Positive tilts the nose up. Absolute, not relative to the box above. */
  verticalAngle: number
  /** Degrees about z. The array's horizontal aim; the same on every box of a flown array. */
  horizontalAngle: number
  /** Degrees between this box and the one above. 0 on the top box. */
  splay: number
  /** World position of the box's FRONT-TOP hinge point. */
  origin: Vec3
  /** Level trim in dB (CabinetsAdditionalData.Level). */
  level: number
  mute: boolean
}

export interface FlyingFrame {
  flyingFrameId: number
  type: string
  /** Degrees. For V/J/Y/KSL/… flown arrays this equals the top box's vertical angle. */
  frameAngle: number
  origin: Vec3
}

export interface SourceGroup {
  sourceGroupId: number
  name: string
  /** 1 = line array (flown or stacked), 2 = point source, 3 = SUB array, 5 = unused channels. */
  type: number
  /** 0 = flown, 1 = stacked. Other values observed (2 = horizontal A-Series, 5 = CCL top frame). */
  mounting: number
  system: string
  origin: Vec3
  arrayProcessing: boolean
  cabinets: Cabinet[]
  frame: FlyingFrame | null
}

/** A listening surface, already tessellated into world-space triangles at LISTENER height. */
export interface ListeningPlane {
  venueObjectId: number
  name: string
  shape: number
  listenerHeight: number
  triangles: [Vec3, Vec3, Vec3][]
}

export interface Project {
  name: string
  groups: SourceGroup[]
  planes: ListeningPlane[]
  /** Kelvin. ProjectSettings.Temperature. */
  temperatureK: number
  /** Percent. ProjectSettings.Humidity. */
  humidity: number
  warnings: string[]
}
