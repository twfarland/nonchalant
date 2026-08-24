// 7GUIs 7/7 — Cells (deliberately last: it stresses derivations).
//
// One source process holds the formulas ({ A1: '=B1*2', ... }); every cell's
// VALUE is a lazily-created derive that parses its formula and resolves
// references by reading other cells' derives. Dependency tracking is
// therefore automatic and exact:
//   - editing A1 wakes only the formulas that (transitively) read A1 —
//     path precision on the formula source means unrelated cells don't even
//     re-parse;
//   - a dependent whose computed value is unchanged cuts propagation there
//     (equality cut);
//   - cycles resolve to '#CYCLE' via an evaluation stack, without hanging.
//
// Formula grammar: text, number, or =EXPR with numbers, cell refs (A1..Z99),
// + - * /, and parentheses.

import { derive, spawn } from '@nonchalant/core'
import type { Cast, Proc, Process } from '@nonchalant/core'

export type CellValue = number | string
export type Formulas = Record<string, string>
export type SheetMsg = Cast<{ type: 'set'; key: string; formula: string }>

const sheetProc: Proc<Formulas, SheetMsg, void> = async function* (self) {
  let formulas: Formulas = {}
  yield formulas
  for await (const msg of self) {
    formulas = { ...formulas, [msg.key]: msg.formula }
    yield formulas
  }
}

// ---------- a tiny formula parser ----------

type Tok = { kind: 'num'; n: number } | { kind: 'ref'; key: string } | { kind: 'op'; op: string }

const tokenize = (src: string): Tok[] => {
  const out: Tok[] = []
  const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Z][0-9]{1,2})|([+\-*/()]))/gy
  let m: RegExpExecArray | null
  let last = 0
  while ((m = re.exec(src)) !== null) {
    last = re.lastIndex
    if (m[1] !== undefined) out.push({ kind: 'num', n: Number(m[1]) })
    else if (m[2] !== undefined) out.push({ kind: 'ref', key: m[2] })
    else out.push({ kind: 'op', op: m[3] as string })
  }
  if (last !== src.length && src.slice(last).trim() !== '') throw new Error('parse')
  return out
}

type Resolve = (key: string) => number

const parseExpr = (toks: Tok[], resolve: Resolve): number => {
  let i = 0
  const peek = (): Tok | undefined => toks[i]
  const eat = (): Tok => toks[i++] as Tok
  const primary = (): number => {
    const t = eat()
    if (t === undefined) throw new Error('parse')
    if (t.kind === 'num') return t.n
    if (t.kind === 'ref') return resolve(t.key)
    if (t.op === '(') {
      const v = addsub()
      const close = eat()
      if (close?.kind !== 'op' || close.op !== ')') throw new Error('parse')
      return v
    }
    if (t.op === '-') return -primary()
    throw new Error('parse')
  }
  const muldiv = (): number => {
    let v = primary()
    while (peek()?.kind === 'op' && ((peek() as Tok & { op: string }).op === '*' || (peek() as Tok & { op: string }).op === '/')) {
      const { op } = eat() as Tok & { op: string }
      const rhs = primary()
      v = op === '*' ? v * rhs : v / rhs
    }
    return v
  }
  const addsub = (): number => {
    let v = muldiv()
    while (peek()?.kind === 'op' && ((peek() as Tok & { op: string }).op === '+' || (peek() as Tok & { op: string }).op === '-')) {
      const { op } = eat() as Tok & { op: string }
      const rhs = muldiv()
      v = op === '+' ? v + rhs : v - rhs
    }
    return v
  }
  const v = addsub()
  if (i !== toks.length) throw new Error('parse')
  return v
}

// ---------- the sheet ----------

export interface Sheet {
  set(key: string, formula: string): void
  /** Tracked read of a cell's computed value — usable directly in bindings. */
  value(key: string): CellValue
  formulas: Process<Formulas, SheetMsg>
  /** Instrumentation: how many times each cell's formula was evaluated. */
  evals: Map<string, number>
  dispose(): void
}

export function createSheet(): Sheet {
  const formulas = spawn(sheetProc, undefined, { initial: {} as Formulas })
  const values = new Map<string, Process<CellValue>>()
  const evals = new Map<string, number>()
  const evaluating = new Set<string>() // cycle guard: derive getters nest synchronously

  const valueOf = (key: string): Process<CellValue> => {
    let d = values.get(key)
    if (d === undefined) {
      d = derive((): CellValue => {
        evals.set(key, (evals.get(key) ?? 0) + 1)
        const src = formulas()[key] ?? '' // tracked read: exactly the path /<key>
        if (!src.startsWith('=')) {
          const n = Number(src)
          return src.trim() !== '' && Number.isFinite(n) ? n : src
        }
        evaluating.add(key)
        try {
          return parseExpr(tokenize(src.slice(1).toUpperCase()), (ref) => {
            // a ref that is mid-evaluation would hand back a stale value —
            // that is a cycle, however long the loop
            if (evaluating.has(ref)) throw new Error('cycle')
            const v = valueOf(ref)() as CellValue | undefined
            if (v === '#CYCLE' || v === undefined) throw new Error('cycle')
            return typeof v === 'number' ? v : 0
          })
        } catch (e) {
          return e instanceof Error && e.message === 'cycle' ? '#CYCLE' : '#ERR'
        } finally {
          evaluating.delete(key)
        }
      })
      values.set(key, d)
    }
    return d
  }

  return {
    set: (key, formula) => formulas.cast({ type: 'set', key: key.toUpperCase(), formula }),
    value: (key) => valueOf(key.toUpperCase())(),
    formulas,
    evals,
    dispose: () => {
      for (const d of values.values()) d[Symbol.dispose]()
      formulas[Symbol.dispose]()
    },
  }
}
