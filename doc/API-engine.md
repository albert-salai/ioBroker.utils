# API: IoStates, IoState, IoOperator, IoEngine

**Purpose:** API reference of the state registry, the typed state, the operator base class and the engine entry point.

**Audience:** developers and Claude sessions writing an adapter on `iobroker-utils`.

**Contains:** signatures and semantics per class (`src/io-state.ts`, `src/io-operator.ts`, `src/io-engine.ts`).

**Not here:** `IoAdapter`, `IoTimer`, helpers (`API-core.md`), history replay (`API-engine-history.md`), live mode
(`API-engine-live.md`), other items (`API-misc.md`).

## IoStates / IoState (`src/io-state.ts`)

`IoStates` is the singleton registry and factory (instance of the internal `IoStateStore`); `IoState<T>` is the typed
state wrapper. `type AnyState = IoState<ValType>`.

```ts
const IoStates: {
  create<T>(stateId: string, valObj: IoStateOpts<T>): Promise<IoState<T>>
    // writes the state object; writes valObj.common.def only when the stored val is null; then load()
    // throws if stateId is already registered or load() fails
  load<T>(stateId: string): Promise<IoState<T> | null>
    // returns the registered instance if present; else reads object and state from ioBroker
    // null (error logged) on empty stateId, missing object, missing state, val null, typeof val != common.type
  get(stateId: string): AnyState | undefined       // registered instance
  values(): AnyState[]                              // all registered states (registry order, unsorted)
  register(state: AnyState): void                   // called by the IoState constructor
  setWriteFn(fn: (state: AnyState, val: ValType) => Promise<void>): void
    // set by IoEngine (live) and IoHistoryEngine (replay); the default is a no-op
  write(state: AnyState, val: ValType): Promise<void>   // calls the active write function; used by IoState.write()
}

class IoState<T extends ValType> {
  readonly stateId:  string
  readonly name:     string
  readonly unit:     string
  readonly writable: boolean         // true = external writable input (written with ack=false by the engine)
  logType: 'none' | 'changed' | 'write'   // default 'none'; debug logging of onStateChange / write
  get val(): T
  get ts():  number                  // epoch ms; -1 = not yet initialized

  registerTrigger(op: IoOperator): void   // adds op to the operators triggered on change; called by IoOperator
  registerWriter(op: IoOperator): void    // adds op to the operators writing this state; called by IoOperator
  get writerCount(): number               // number of registered writers; IoHistoryEngine: 0 = src, > 0 = dst

  constructor({ stateId, name, unit, writable, val, ts })   // self-registers; use IoStates.create()/load() instead
  set(val: T, ts: number): void           // seeds val+ts; ts < 0: error logged, nothing changed
  onStateChange(val: T, ts: number): Promise<void>
    // ts < 0: error logged, nothing changed; else ts is set always; if val differs it is set and
    // each trigger operator's onTrigger(this) is awaited in registration order
  write(val: T): Promise<void>            // via IoStates.write(); non-finite number: error logged, not written
  getHistory(options: { start?, end?, ack?, limit? }): Promise<{ ts: number, val: T }[]>
    // sendTo(historyId, 'getHistory', aggregate 'none', ignoreNull true); [] when no historyId
  toJSON(): { stateId, name, unit, writable, ts, val, logType, triggerOperators, writtenByOperators }
    // ts/val as strings (dateStr/valStr); operators as `Operator<ClassName>`
}
```

`triggerOperators` and `writtenByOperators` are private.

## IoOperator (`src/io-operator.ts`)

Abstract base of reactive operators; subclasses implement `execute()` (and optionally `setup()`).

```ts
abstract class IoOperator {
  protected readonly inputStates:   readonly AnyState[]   // trigger execute() on change
  protected readonly outputStates:  readonly AnyState[]   // written in execute()
  protected readonly watchedStates: readonly AnyState[]   // read only, no trigger; ready before the first trigger
  protected readonly logf

  constructor(inputStates, outputStates, watchedStates)
    // calls registerTrigger(this) on each input and registerWriter(this) on each output

  protected setup(): Promise<boolean> | boolean     // default true; false = not ready, retried on the next trigger
  protected abstract execute(trigger: AnyState): Promise<void> | void   // precondition: all states ready (ts != -1)
  public async onTrigger(trigger: AnyState): Promise<void>
    // called by IoState.onStateChange(); runs setup() until it returns true, then execute(trigger)
}
```

## IoEngine (`src/io-engine.ts`)

```ts
class IoEngine {
  constructor()

  async start(historyDays: number): Promise<void>   // call from the adapter's onReady()
}
```

`start()` order:

1. Create folder objects for the path of every state under the adapter namespace (segments before the leaf, from the
   third on).
2. `historyDays > 0`: `IoHistoryEngine.run(historyDays, allStates)` (`API-engine-history.md`). When it returns false
   (SQL unavailable) or `historyDays = 0`: seed each state from its current ioBroker value; throws if any state is
   missing, has `val == null` or a `ts` in the future.
3. `IoTimer.configure()` (live timers), `IoStates.setWriteFn()` and ack-subscribe to every state; live behavior in
   `API-engine-live.md`.
