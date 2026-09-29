# What Cosplay relies on in a .dbpr

Reverse-engineered from ArrayCalc 12.8.3's example projects. No published schema exists.

- `.dbpr` is a SQLite 3 database (rollback journal). ArrayCalc holds a `<file>.dblock`
  beside it while open.
- `SourceGroups`: `Type` 1 = line array, 2 = point source, 3 = SUB array, 5 = unused
  channels. `Mounting` 0 = flown, 1 = stacked (2 = horizontal A-Series, 5 = CCL top frame).
- `FlyingFrames`: one per flown group (SL-Series add a compression frame; the first
  by `PositionIndex` is the flying frame). `FrameAngle` = top cabinet's `VerticalAngle`
  (SL frames: +0.3–0.5°).
- `Cabinets`: `VerticalAngle` absolute, nose-up positive; `HorizontalAngle` the aim;
  `Origin*` is the **front-top hinge point** in world space.
- `CabinetsAdditionalData.SplayAngle`: angle to the box above; 0 on the top box.
  Non-compression systems: `VerticalAngle[i] = VerticalAngle[i-1] − SplayAngle[i]` exactly.
  GSL/KSL/XSL/CCL store the deflected angle (nominal ±0.1–0.3°).
- Hinge-to-hinge vector in the upper box's frame is `(≈0, −pitch)`: V 0.3105, J 0.3617,
  Y 0.257, KSL 0.3322, GSL 0.394, XSL 0.2851, CCL 0.2102, Q 0.308, T 0.197 m.
- `VenueObjects` with `PlaneType` 1 are listening planes; `ListenerHeight` is added to z.
  Shape 1 quad / 6 triangle / 4 box use `VenueObjectPoints` (local, then `RotationZ`,
  then `Origin`, then the parent chain). Shapes 2/3 are annulus sectors in
  `VenueObjectsCircular` / `VenueObjectsEllipsoidal` (StartAngle/SpanAngle degrees,
  Inner/Outer A/B radii, InnerZ→OuterZ rake).
- `ProjectSettings` `Temperature` (K) and `Humidity` (%).
