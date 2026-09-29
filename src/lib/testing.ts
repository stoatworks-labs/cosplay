import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import initSqlJs from 'sql.js'
import type { SqlDb } from './dbpr.ts'

/** ArrayCalc's bundled example projects: the ground truth for the format. Absent on CI. */
export const EXAMPLES = '/Applications/ArrayCalc V12.app/Contents/ExampleProjects'
export const haveExamples = existsSync(EXAMPLES)

export function exampleFiles(dir = EXAMPLES): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? exampleFiles(p) : n.endsWith('.dbpr') ? [p] : []
  })
}

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null
export async function openDb(path: string): Promise<SqlDb & { export(): Uint8Array; close(): void }> {
  SQL ??= await initSqlJs()
  return new SQL.Database(readFileSync(path)) as never
}
