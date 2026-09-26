// Type acceptance harness — compiled, never run. Verified on TS 7.0.2 --strict.
// The @ts-expect-error lines are load-bearing: if the compiler stops rejecting
// them, the type surface has regressed. This file is the contract the runtime
// implementation must satisfy.

import { spawn, derive, cell, define, registry, reducer } from '../src/index.ts'
import type { Call, Cast, Definition, Proc, Process, Registry, Self } from '../src/index.ts'

type Item = { id: number; title: string; done: boolean }
type CartState = { items: Item[]; total: number }

type CartMsg =
  | Cast<{ type: 'add'; item: Item }>
  | Cast<{ type: 'remove'; id: number }>
  | Call<{ type: 'checkout' }, { ok: boolean; orderId?: string }>

type MultiCallMsg =
  | Call<{ type: 'find'; id: number }, { name: string }>
  | Call<{ type: 'count' }, number>

declare const cartProc: Proc<CartState, CartMsg, { userId: string }>

// --- spawn: `initial` decides whether reads are total ---
const cart = spawn(cartProc, { userId: 'u1' }, { initial: { items: [], total: 0 } })
const total0: CartState = cart() // no undefined
const cartDisposed: Promise<void> = cart[Symbol.asyncDispose]()

const noInit = spawn(cartProc, { userId: 'u1' })
// @ts-expect-error — without initial, a read may be undefined
const total1: CartState = noInit()

// --- casts vs calls, separated by the compiler ---
cart.cast({ type: 'add', item: { id: 1, title: 'x', done: false } })
// @ts-expect-error — checkout is a call, not a cast
cart.cast({ type: 'checkout' })
// @ts-expect-error — unknown message shape
cart.cast({ type: 'nope' })
// @ts-expect-error — a cast carries no reply; that marker is what keeps it out of Calls
cart.cast({ type: 'add', item: { id: 1, title: 'x', done: false }, reply: () => {} })

async function checkout(): Promise<void> {
  const res = await cart.call({ type: 'checkout' })
  const ok: boolean = res.ok
  void ok
}
void checkout

declare const multi: Process<null, MultiCallMsg>
const found: Promise<{ name: string }> = multi.call({ type: 'find', id: 1 })
const counted: Promise<number> = multi.call({ type: 'count' })
// @ts-expect-error — find requires its id
multi.call({ type: 'find' })
// @ts-expect-error — count has no id
multi.call({ type: 'count', id: 1 })

// --- derivations have no mailbox ---
const totals = derive(() => cart().total)
// @ts-expect-error — no cast on a Process<T, never>
totals.cast(1)

// --- cell: transient widget state ---
const open = cell(false)
open.cast(true)
const b: boolean = open()
void b

// --- Self: the inside face ---
declare const clockProcEarly: Proc<number, never, void>
declare const self: Self<CartMsg>
self.signal satisfies AbortSignal
self.latest() satisfies AsyncIterable<CartMsg>
self.busy() satisfies Disposable
self.cast({ type: 'remove', id: 1 })
const ownedClock: Process<number | undefined, never> = self.spawn(clockProcEarly, undefined)
const seededClock: Process<number, never> = self.spawn(clockProcEarly, undefined, { initial: 0 })
const ownedCart = self.spawn(cartProc, { userId: 'u1' })
ownedCart.cast({ type: 'remove', id: 1 })
// @ts-expect-error — without initial, an owned child reads T | undefined like spawn
const ownedNow: number = self.spawn(clockProcEarly, undefined)()
// @ts-expect-error — args are checked against the proc
self.spawn(cartProc, { user: 'u1' })
void ownedClock, seededClock, ownedNow

// --- registry schema: typed lookup, arity-checked ---
interface Shop {
  cart: Definition<CartState, CartMsg, { userId: string }>
  clock: Definition<number, never, void>
}
// @ts-expect-error — definitions are constructed by define(), not structural lookalikes
const fakeDefinition: Definition<number, never, void> = {}
declare const shop: Registry<Shop>
const rcart = shop.lookup('cart', { userId: 'u1' })
rcart.cast({ type: 'remove', id: 1 })
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
lc.cast({ type: 'remove', id: 2 })
local.lookup('clock')
// @ts-expect-error — clock takes no args
local.lookup('clock', {})
local.evict('cart', { userId: 'u1' })
local.evict('clock')
// @ts-expect-error — unknown name
local.evict('warehouse')

// --- lookups read `T | undefined` until the first yield, unless the definition supplies `initial` ---
// @ts-expect-error — a hand-written Definition has no initial: a read may be undefined
const rcartState: CartState = shop.lookup('cart', { userId: 'u1' })()
// @ts-expect-error — define() without initial: a read may be undefined
const clockNow: number = local.lookup('clock')()
const seeded = registry({ clock: define(clockProc, { initial: 0 }) })
const seededNow: number = seeded.lookup('clock')() // initial supplied: total
const maybeNow: number | undefined = local.lookup('clock')()

// --- a Proc's generator is not `any`-typed on its return or next channels ---
async function drive(): Promise<void> {
  const it = clockProc(undefined as unknown as Self<never>, undefined)
  const r = await it.next()
  // @ts-expect-error — the result is `number | unknown`, not `any`
  const s: string = r.value
  void s
}
void drive

// --- middleware: processes compose as functions, types pass through ---
declare function withHistory<T, In, A>(
  proc: Proc<T, In, A>,
): Proc<T, In | { type: 'undo' } | { type: 'redo' }, A>
const hist = spawn(withHistory(cartProc), { userId: 'u1' })
hist.cast({ type: 'undo' })
hist.cast({ type: 'add', item: { id: 2, title: 'y', done: false } })

// --- reducer sugar: an ordinary Proc, with per-case reply types ---
const cartReducer = reducer((_: { userId: string }): CartState => ({ items: [], total: 0 }), function cartR(s, msg: CartMsg) {
  switch (msg.type) {
    case 'add':
      return { ...s, items: [...s.items, msg.item] }
    case 'remove':
      return { ...s, items: s.items.filter((i) => i.id !== msg.id) }
    case 'checkout':
      // @ts-expect-error — the reply is narrowed to this case's response type
      msg.reply(true)
      return s
  }
})
const asProc: Proc<CartState, CartMsg, { userId: string }> = cartReducer
const rcartSpawned = spawn(cartReducer, { userId: 'u1' }, { initial: { items: [], total: 0 } })
const rcartOk: Promise<{ ok: boolean; orderId?: string }> = rcartSpawned.call({ type: 'checkout' })
// @ts-expect-error — a reducer returns the next state, not a partial of it
reducer((): CartState => ({ items: [], total: 0 }), (s: CartState, _msg: CartMsg) => ({ total: s.total }))
// @ts-expect-error — init's args are the spawn args
spawn(cartReducer, { user: 'u1' })

// silence unused locals
void total0; void total1; void rcart; void hist; void cart; void cartDisposed; void lc; void found; void counted; void fakeDefinition
void rcartState; void asProc; void rcartOk; void clockNow; void seededNow; void maybeNow
export {}
