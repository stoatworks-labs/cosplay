/// <reference lib="webworker" />
import { evaluate, optimise, type Problem, type Progress } from './lib/optimise.ts'

export interface Request { problem: Problem; maxEvaluations: number; runId: number }
export type Reply =
  | { runId: number; type: 'progress' | 'done'; progress: Progress; evaluation: ReturnType<typeof evaluate> }
  | { runId: number; type: 'error'; message: string }

self.onmessage = (e: MessageEvent<Request>) => {
  const { problem, maxEvaluations, runId } = e.data
  try {
    const gen = optimise(problem, { maxEvaluations })
    let last = 0
    for (;;) {
      const r = gen.next()
      const now = performance.now()
      if (r.done || now - last > 120) {
        last = now
        const reply: Reply = { runId, type: r.done ? 'done' : 'progress', progress: r.value, evaluation: evaluate(problem, r.value.best) }
        self.postMessage(reply)
      }
      if (r.done) break
    }
  } catch (err) {
    self.postMessage({ runId, type: 'error', message: String((err as Error)?.message ?? err) } satisfies Reply)
  }
}
