// The model, stubbed: deterministic, slow on purpose, and cancellable. Swapping
// in a real client means rewriting this file and nothing above it — the agent
// takes a Model as an argument and never learns which one it got.

export interface ToolSpec {
  name: string
  describe: string
}

/** What the model decides to do next: reach for a tool, or answer. */
export type Plan = { tool: string; args: string } | { answer: string }

export interface Model {
  plan(transcript: readonly string[], tools: readonly ToolSpec[], opts: { signal: AbortSignal }): Promise<Plan>
  /** The final answer, a word at a time — the same shape a token stream has. */
  say(text: string, opts: { signal: AbortSignal }): AsyncIterable<string>
  /** One shot, no streaming: what a delegated writing agent needs. */
  compose(topic: string, notes: string, opts: { signal: AbortSignal }): Promise<string>
}

export const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    // the listener comes off when the timer wins: a process's signal outlives
    // thousands of these, and each one would otherwise stay attached
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('cancelled'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })

const used = (transcript: readonly string[], tool: string): boolean =>
  transcript.some((line) => line.startsWith(`${tool}(`))

const arithmetic = /^[\d\s+*/().-]+$/

/**
 * The rules are a stand-in for a model's judgement, chosen so the transcript is
 * legible: reach for the obvious tool once, ask permission before anything that
 * spends money, then answer from what came back.
 */
export function stubModel(opts: { latency?: number } = {}): Model {
  const latency = opts.latency ?? 260

  return {
    async plan(transcript, _tools, { signal }) {
      await delay(latency, signal)
      const question = transcript[0] ?? ''
      const sum = question.match(/[-\d][\d\s+*/().-]*[\d)]/)

      if (question.toLowerCase().includes('refund') && !used(transcript, 'refund'))
        return { tool: 'refund', args: question.replace(/[^\d.]/g, '') || '20' }
      if (sum !== null && arithmetic.test(sum[0]) && !used(transcript, 'calc'))
        return { tool: 'calc', args: sum[0].trim() }
      if (!used(transcript, 'search')) return { tool: 'search', args: question }

      // the transcript keeps `tool(args) → result` so the rules above can see
      // what has been tried; the answer only wants the results
      const findings = transcript.slice(1).map((line) => line.split(' → ')[1] ?? line)
      return { answer: findings.length === 0 ? `I have nothing on "${question}".` : findings.join('; ') }
    },

    async compose(topic, notes, { signal }) {
      await delay(latency, signal)
      return `On ${topic}: ${notes.replace(/^search says: /, '')}.`
    },

    async *say(text, { signal }) {
      for (const word of text.split(' ')) {
        await delay(latency / 6, signal)
        yield word
      }
    },
  }
}
