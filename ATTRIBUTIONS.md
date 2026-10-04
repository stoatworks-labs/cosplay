# Attributions

Cosplay is built on other people's work. This file lists what that work is, who did
it, and what it is doing here.

It is generated — the master lists live in the `stoatworks-backend` repo and are
pushed out by `scripts/sync-attributions.py`. Edit it there, not here.

## Third-party code this project uses

Libraries, SDKs and frameworks the project is built on or bundles.

### React

<https://react.dev>  
Licence: MIT  
Copyright: Meta Platforms, Inc. and affiliates

An npm dependency.

The UI layer for the browser tools and the Electron and Tauri front ends.

### The npm ecosystem

<https://www.npmjs.com>  
Licence: predominantly MIT  
Copyright: the individual package authors

npm dependencies, resolved and pinned in the lockfile.

Build tooling, test runners and the libraries the front ends are assembled from. The exact set and versions for any build are in that repo's lockfile, which is the authoritative list.

The full transitive dependency set for any build is pinned in this repo's lockfile,
which is the authoritative list. What is named above is the layers a reader would
want to know about, not every package that has ever been resolved.

## Work we checked ourselves against

No code was taken from these — but they were how we knew we had it right, and that is worth saying out loud.

### d&b ArrayCalc 12.8.3 and its example projects — d&b audiotechnik

The .dbpr format Cosplay reads and writes is SQLite with no published schema, reverse-engineered from ArrayCalc 12.8.3's own example projects, which the tests use as ground truth; the hinge-to-hinge vectors were fitted over about 2,000 pairs in them. Every flown array in the 60-odd examples re-lays onto its stored hinge points to under 0.2 mm, a file Cosplay wrote opens in ArrayCalc with rigging Load OK, and ArrayCalc's own 2 kHz and 500 Hz traces agree with Cosplay's prediction to about 1 dB from 5 m to 40 m. The splay range per cabinet family is from d&b's rigging manuals as best remembered, cross-checked against the examples. Not affiliated with d&b audiotechnik.

## Standards and published specifications

What the implementation is measured against.

- **ISO 9613-1** — Pure-tone air absorption at 101.325 kPa, applied at the project's temperature and humidity in Cosplay's own direct-sound prediction.

## Getting this wrong

If your work is here and the description is inaccurate, the licence is wrong, or you would rather not be listed — open an issue and it will be fixed.
