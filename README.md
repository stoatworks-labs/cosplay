# Cosplay — Compute Optimal Splay

> **AI-assisted project.** This codebase was created with [Claude](https://claude.com/claude-code)
> (Anthropic), directed and reviewed by a human author.
> Its splay results have been checked against ArrayCalc itself, and you should check yours
> there too before you rig from them.

Cosplay is a sidecar for d&b ArrayCalc. Open an ArrayCalc project (`.dbpr`), pick a flown
line array, and Cosplay searches the splay angles and the frame angle for the most even
direct sound level along the array's main axis (the "Direct sound level vs. distance"
traces on ArrayCalc's Sources page), with the octave bands running together. Then it
writes the result into a copy of the project for ArrayCalc to open.

The name's short for Compute Optimal Splay. No costumes are involved.

Everything runs in the browser, and the project is never uploaded.

## How it works

- **Reads the project directly.** A `.dbpr` is SQLite. Cosplay reads the source groups,
  cabinets, flying frame and listening planes (see [docs/FORMAT.md](docs/FORMAT.md)).
- **Rigging geometry is measured, not tabulated.** ArrayCalc stores each cabinet's
  front-top hinge point; the hinge-to-hinge vector is constant in the box's own frame, so
  the geometry for any new set of splays can be laid out precisely from the file itself.
- **Its own prediction.** d&b's balloon data isn't available, so each box is treated as a
  flat, coherent line source as tall as its pitch (sinc directivity), with a front/back weight,
  complex summation, 1/r spreading and ISO 9613-1 air absorption at the project's
  temperature and humidity. Octave bands are energy averages over 10 frequencies.
- **Goal.** For the chosen HF bands (default 2/4/8 kHz): RMS deviation from a target
  level drop (default 0 dB per doubled distance), plus a weighted *band spread* term
  (how far the bands, each with its own offset removed, run apart, including one tracked
  LF band), plus a small worst-seat term.
- **Search.** Discrete splays within the family's range (overridable), frame angle in
  0.1° steps, optional "splays only grow down the array". Seeds (as loaded, constant,
  progressive), best-improvement descent over single-hinge, hinge-pair and frame moves,
  then iterated kicks. Runs in a Web Worker; ~5,000 layouts in a few seconds.
- **Write-back.** Frame angle, `SplayAngle`, each cabinet's `VerticalAngle` and hinge
  origin, and `HeightLowestEdge` are updated together. A hang ArrayCalc links as another's
  mirror always gets the same angles, and an unlinked hang with the same box column can take
  them too if you tick it. One download writes every array you've made a proposal for.
  Nothing else in the file changes.

## Checked against ArrayCalc (12.8.3, 2026-09-29)

- Every flown array in ArrayCalc's 60-odd example projects re-lays from its own splays
  onto the stored hinge points to < 0.2 mm (non-compression systems); writing them back
  changes nothing.
- A file written by Cosplay (V-Series example 3, Main L/R) opens in ArrayCalc with the new
  frame angle and splays, rigging "Load OK", and the lowest-edge height Cosplay wrote.
- ArrayCalc's own unprocessed 2 kHz and 500 Hz traces for those splays agree with
  Cosplay's prediction to about 1 dB from 5 m to 40 m (read off the plot). Under the
  array (first 3 m) Cosplay is 2–4 dB more pessimistic.

## Limits

- Vertically flown line arrays only (no stacked, horizontal or SUB arrays yet).
- Compression-rigged families (GSL, KSL, XSL, CCL): the nominal splay is written;
  ArrayCalc deflects each by up to ±0.3° under load, which Cosplay does not model.
- Splay ranges per family are from memory plus the example projects, so check them.
- ArrayProcessing slots are invalidated by new splays; recalculate them in ArrayCalc.
- Pick-point loads are left for ArrayCalc to recompute. ArrayCalc has the final word.

## Drive it from Claude

Cosplay also runs as an MCP server, so Claude Code (or any other MCP client) can do the
search itself: open a project, set the goal, optimise each array, look at the traces and
write the copy. It's the same library the page runs, working on files on your own machine,
and nothing is uploaded. It needs Node 22.18 or later, which runs the TypeScript as it is.

```bash
npm install
```

```bash
claude mcp add cosplay -- node /path/to/cosplay/src/mcp/server.ts
```

Then ask for what you'd do in the page: *open ~/shows/arena.dbpr, optimise Main for a 3 dB
drop per doubled distance from 10 m back, and write the copy*. The tools are the page's
controls:

- `open_project` lists the arrays it can work on, each with its linked mirror, and the
  groups it skips and why. `describe_array` gives one array's boxes, goal, the listening
  planes its axis crosses and its scores.
- `set_goal` is the Goal and Rigging panel. `optimise` runs the search, reports progress,
  and keeps the best layout so far if it's cancelled.
- `set_angles` is the splay table: snapped to whole degrees and clamped to the range, but not
  forced to grow. `level_trace` gives the traces the chart draws, as numbers.
- `set_copies` ticks an unlinked look-alike. `write_project` writes every proposal into
  `<name> (cosplay).dbpr` beside the original and reads it back before saving. It never
  touches the original.

The levels are still Cosplay's own model, so the same rule applies: open the copy in
ArrayCalc and check it there.

## Development

```bash
npm install
npm run dev
npm test        # uses ArrayCalc's example projects if ArrayCalc V12 is installed
npm run build
```

See [CLAUDE.md](CLAUDE.md) for the rules the page and the MCP server share.

Not affiliated with d&b audiotechnik.

<!-- attributions:start -->
This project is built on other people's work — see [ATTRIBUTIONS.md](ATTRIBUTIONS.md).
<!-- attributions:end -->
