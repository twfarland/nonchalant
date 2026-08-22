// Type acceptance harness — compiled, never run. Verified on TS 7.0.2 --strict.
// The @ts-expect-error lines are load-bearing: if the compiler stops rejecting
// them, the type surface has regressed. This file is the contract the runtime
// implementation must satisfy.

import { spawn, derive, cell, define, registry } from '../src/index.ts'
import type { Call, Definition, Proc, Process, Registry, Self } from '../src/index.ts'

type Item = { id: number; title: string; done: boolean }
type CartState = { items: Item[]; total: number }

type CartMsg =
  | { type: 'add'; item: Item }
  | { type: 'remove'; id: number }
  | Call<{ type: 'checkout' }, { ok: boolean; orderId?: string }>

type MultiCallMsg =
  | Call<{ type: 'find'; id: number }, { name: string }>
  | Call<{ type: 'count' }, number>

declare const cartProc: Proc<CartState, CartMsg, { userId: string }>

// --- spawn: `initial` decides whether reads are total ---
const cart = spawn(cartProc, { userId: 'u1' }, { initial: { items: [], total: 0 } })
const total0: CartState = cart() // no undefined

const noInit = spawn(cartProc, { userId: 'u1' })
// @ts-expect-error — without initial, a read may be undefined
const total1: CartState = noInit()

// --- casts vs calls, separated by the compiler ---
cart.send({ type: 'add', item: { id: 1, title: 'x', done: false } })
// @ts-expect-error — checkout is a call, not a cast
cart.send({ type: 'checkout' })
// @ts-expect-error — unknown message shape
cart.send({ type: 'nope' })

async function checkout(): Promise<void> {
  const res = await cart.ask({ type: 'checkout' })
  const ok: boolean = res.ok
  void ok
}
void checkout

declare const multi: Process<null, MultiCallMsg>
const found: Promise<{ name: string }> = multi.ask({ type: 'find', id: 1 })
const counted: Promise<number> = multi.ask({ type: 'count' })
// @ts-expect-error — find requires its id
multi.ask({ type: 'find' })
// @ts-expect-error — count has no id
multi.ask({ type: 'count', id: 1 })

// --- derivations have no mailbox ---
const totals = derive(() => cart().total)
// @ts-expect-error — no send on a Process<T, never>
totals.send(1)

// --- cell: transient widget state ---
const open = cell(false)
open.send(true)
const b: boolean = open()
void b

// --- Self: the inside face ---
declare const self: Self<CartMsg>
self.signal satisfies AbortSignal
self.latest() satisfies AsyncIterable<CartMsg>

// --- registry schema: typed lookup, arity-checked ---
interface Shop {
  cart: Definition<CartState, CartMsg, { userId: string }>
  clock: Definition<number, never, void>
}
// @ts-expect-error — definitions are constructed by define(), not structural lookalikes
const fakeDefinition: Definition<number, never, void> = {}
declare const shop: Registry<Shop>
const rcart = shop.lookup('cart', { userId: 'u1' })
rcart.send({ type: 'remove', id: 1 })
shop.lookup('clock')
// @ts-expect-error — clock takes no args
shop.lookup('clock', {})
// @ts-expect-error — unknown name
shop.lookup('warehouse')

// --- local registry construction: define() infers the Definition, lookup stays typed ---
declare const clockProc: Proc<number, never, void>
const local = registry({
  cart: define(cartProc, { evict: 30_000 }),
  clock: define(clockProc),
})
const lc = local.lookup('cart', { userId: 'u1' })
lc.send({ type: 'remove', id: 2 })
local.lookup('clock')
// @ts-expect-error — clock takes no args
local.lookup('clock', {})
local.evict('cart', { userId: 'u1' })
local.evict('clock')
// @ts-expect-error — unknown name
local.evict('warehouse')

// --- middleware: processes compose as functions, types pass through ---
declare function withHistory<T, In, A>(
  proc: Proc<T, In, A>,
): Proc<T, In | { type: 'undo' } | { type: 'redo' }, A>
const hist = spawn(withHistory(cartProc), { userId: 'u1' })
hist.send({ type: 'undo' })
hist.send({ type: 'add', item: { id: 2, title: 'y', done: false } })

// silence unused locals
void total0; void total1; void rcart; void hist; void cart; void lc; void found; void counted; void fakeDefinition
export {}
