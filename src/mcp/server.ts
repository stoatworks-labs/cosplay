#!/usr/bin/env node
/**
 * Cosplay's MCP server, for Claude Code or any other MCP client, over stdio:
 *
 *   claude mcp add cosplay -- node /path/to/cosplay/src/mcp/server.ts
 *
 * Runs on Node's own type stripping (Node 22.18 or later), straight from the source: the
 * library is erasable TypeScript, and sql.js finds its WebAssembly beside itself in
 * node_modules, so `npm install` is all it needs.
 */

import './stdout.ts'
import { serveStdio } from './protocol.ts'
import { SERVER_INFO, cosplayTools } from './tools.ts'

await serveStdio(SERVER_INFO, cosplayTools())
