# CLAUDE.md — Cosplay

Splay optimiser for d&b ArrayCalc projects. A static page (`src/App.tsx`) and an MCP server
(`src/mcp/`) over one library (`src/lib/`). The `.dbpr` format is reverse-engineered; what
is known and how it was checked is in [docs/FORMAT.md](docs/FORMAT.md).

## Commands

```bash
npm install
npm run dev
npm test               # vitest. The format and tool tests need ArrayCalc V12's example projects
npm run build          # tsc -b && vite build -> dist/
npx tsc -b             # typecheck only
node src/mcp/server.ts # the MCP server over stdio (Node 22.18+)
```

Add it to Claude Code with `claude mcp add cosplay -- node "$PWD/src/mcp/server.ts"`.

Every push to `main` that touches more than prose deploys, through
`.github/workflows/deploy.yml`. CI has no ArrayCalc, so the tests gated on `haveExamples`
skip there, and only the protocol and server-process tests run.

## Ground rules

- **The page and the server ask the optimiser the same question.** What the page decides
  before a search runs is `src/lib/session.ts`, for `App.tsx` and `src/mcp/` both: which
  arrays are offered, the default goal, which listener points the search scores, how a hand
  edit is clamped, and what one download writes. Never build a `Problem` anywhere else. Two
  front ends that score the same splays differently both look right.
- **`src/mcp/` predicts nothing and writes nothing itself.** It calls `lib/`. Its tests check
  that by asking the library directly and comparing: the same proposal from `optimise`, and
  the same bytes from `write_project` as the page's download.
- **`src/lib/` and `src/mcp/` run under Node's type stripping**, straight from source.
  `erasableSyntaxOnly` and `verbatimModuleSyntax` in `tsconfig.json` hold that line. No
  enums, namespaces or parameter properties, type-only imports say `type`, and imports
  carry `.ts`.
- **stdout belongs to the protocol.** `src/mcp/stdout.ts` sends console output to stderr and
  has to be `server.ts`'s FIRST import, because imports run in order. The spawn test in
  `mcp.test.ts` is the only test that would see a stray line.
- **At the MCP boundary, splays are the hinge list, box 2 down.** The library's list leads
  with a 0 for the top box, and a model handed it counts one hinge too many.
- **The original file is never written.** `write_project` refuses the source path, and an
  existing file unless told to overwrite. It also reads the copy back before saving.
- **Levels are Cosplay's line-source model, not d&b's data.** Every answer that carries a
  level says so, and the page does too. Keep both.
- **`src/mcp/protocol.ts` is VENDORED** from `stoatworks-backend/mcp/protocol.ts`, the same
  file in every tool's server. Never edit it here: change the master and run
  `stoatworks-backend/scripts/sync-mcp.py --apply`, or the next sync reverts the fix. It is
  hand-rolled rather than `@modelcontextprotocol/sdk`, which brings an HTTP server, a
  schema library and a dozen transitive packages to frame newline-delimited JSON.
- Tests that need the example projects use `describe.runIf(haveExamples)` from
  `src/lib/testing.ts`.
