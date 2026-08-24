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

const arithmetic = /^[\d\s+*/().-]+$/

/** "what is 2 + 3 * 4?" is arithmetic; "refund 20" is not, whatever digits it contains. */
const sumIn = (question: string): string => question.replace(/^\s*(what\s+is\s+)?/i, '').replace(/[?\s]+$/, '')

/**
 * A stand-in for a model's judgement, and the judgement is: pick the one tool
 * this question needs, then answer from what it said. A model that reached for
 * every tool it had would be a bad model, and a demo of one would be a bad
 * demo — the loop below can run several turns, but nothing here needs two.
 */
export function stubModel(opts: { latency?: number } = {}): Model {
  const latency = opts.latency ?? 260

  return {
    async plan(transcript, _tools, { signal }) {
      await delay(latency, signal)
      const question = transcript[0] ?? ''
      const answers = transcript.slice(1)

      if (answers.length === 0) {
        if (/refund/i.test(question))
          return { tool: 'refund', args: question.replace(/[^\d.]/g, '') || '20' }
        const sum = sumIn(question)
        if (sum !== '' && arithmetic.test(sum)) return { tool: 'calc', args: sum }
        return { tool: 'search', args: question }
      }

      // the transcript keeps `tool(args) → result` so a rule can see what was
      // tried; the answer only wants what came back, without the tool's voice
      const findings = answers.map((line) => (line.split(' → ')[1] ?? line).replace(/^\w+ says: /, ''))
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
