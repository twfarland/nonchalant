// The Process type surface — draft 3, verified under tsc --strict (TS 7.0.2).
// One noun, two faces: Process (outside) and Self (inside the generator).

/** A message that expects an answer. Inside the generator it arrives with `reply`. */
export type Call<Req, Res> = Req & { readonly reply: (res: Res) => void }

export type Requests<In> = Extract<In, { reply: (res: never) => void }>
export type Plain<In> = Exclude<In, { reply: (res: never) => void }>
export type Res<M> = M extends { reply: (res: infer R) => void } ? R : never

export interface ProcessBase<T> {
  /** Synchronous read of the latest yield. Tracked inside derive/bindings/effects; a plain pull elsewhere. */
  (): T
  /** Working towards its next yield. */
  readonly pending: boolean
  /** Value survives a crash or a partition. */
  readonly stale: boolean
  /** Last failure, if any. */
  readonly error: unknown
  /** Lossy latest-value stream; each iterator is an independent multicast subscription. */
  [Symbol.asyncIterator](): AsyncIterator<T>
  /** Ends the process: mailbox closes, `finally` blocks run, owned children die, in order. */
  [Symbol.dispose](): void
}

export type Process<T, In = never> = ProcessBase<T> &
  ([Plain<In>] extends [never] ? {} : { send(msg: Plain<In>): void }) &
  ([Requests<In>] extends [never]
    ? {}
    : {
        ask<M extends Omit<Requests<In>, 'reply'>>(
          msg: M,
        ): Promise<Res<Extract<Requests<In>, M & object>>>
      })

/** The inside face: what the generator receives. FIFO mailbox, backpressured. */
export interface Self<In> extends AsyncIterable<In> {
  /** Aborts on dispose — thread it into every fetch. */
  readonly signal: AbortSignal
  /** Skip to the newest message, dropping the queue — flatMapLatest as an iteration mode. */
  latest(): AsyncIterable<In>
  /** Post to own inbox — the actor self-send, for tasks reporting back. */
  send(msg: In): void
}

export type Proc<T, In, Args> = (self: Self<In>, args: Args) => AsyncGenerator<T>

// ---------- registry ----------

declare const DEF: unique symbol
/** Phantom-typed schema entry: what a name resolves to. */
export interface Definition<T, In, Args> { readonly [DEF]?: [T, In, Args] }

export type Schema = { [name: string]: Definition<unknown, unknown, unknown> }

export type ProcessOf<D> = D extends Definition<infer T, infer In, infer _A> ? Process<T, In> : never
export type ArgsOf<D> = D extends Definition<infer _T, infer _In, infer A> ? A : never

/** lookup is get-or-spawn: DI, query caching, and remote addressing are one operation. */
export interface Registry<S extends { [K in keyof S]: Definition<unknown, unknown, unknown> }> {
  lookup<K extends keyof S & string>(
    name: K,
    ...args: [ArgsOf<S[K]>] extends [void] ? [] : [ArgsOf<S[K]>]
  ): ProcessOf<S[K]>
}

// ---------- sinks ----------

/** A render target; mount() delegates to it. @nonchalant/dom provides the DOM sink. */
export interface Sink<Out> {
  mount(view: ProcessBase<Out | undefined> | Out): Disposable
}

// ---------- view nodes (plain data; sinks interpret) ----------

export interface VNode {
  readonly tag: string
  readonly ns?: string
  readonly attrs: { readonly [name: string]: unknown }
  readonly children: readonly Slot[]
}

/** Everything a dynamic slot accepts; toProcess() lifts them all. */
export type Slot =
  | null
  | undefined
  | boolean
  | number
  | string
  | VNode
  | (() => unknown)
  | ProcessBase<unknown>
  | Promise<unknown>
  | AsyncIterable<unknown>
  | readonly Slot[]
