## IoState / IoStates — `/opt/iobroker/my_modules/ioBroker.utils/src/io-state.ts`

Registry, factory, and typed state wrapper. `IoStates` is the public entry point; `IoState<T>` extends it.

```ts
class IoStates {
  static readonly registry: Record<string, AnyState>    // all created/loaded states, keyed by stateId
  static writeFn: (state, val) => Promise<void>         // injected by IoEngine; routes writes through adapter

  // Factory methods — public entry points for consumers
  static create<T>(stateId, opts: IoStateOpts<T>): Promise<IoState<T>>
    // creates object + state in ioBroker; calls load() internally; throws if stateId already created or load() fails
  static load<T>(stateId): Promise<IoState<T> | null>
    // returns existing instance if already registered; otherwise loads object+state from ioBroker
    // returns null on missing stateId, missing/unwritten state, or type mismatch
}

class IoState<T extends ValType> extends IoStates {
  readonly stateId:   string
  readonly name:      string
  readonly unit:      string
  readonly writable:  boolean     			// true = external writable input
  val:  T
  ts:   number                    			// ms timestamp; -1 = not yet initialized
  logType: 'none' | 'changed' | 'write'

  readonly triggerOperators:    IoOperator[]   // operators triggered when this state changes
  readonly writtenByOperators:  IoOperator[]   // operators that write this state

  set(val: T, ts: number): void                   // set val+ts (ts must be >= 0); logs error and leaves val unchanged if ts < 0
  onStateChange(val: T, ts: number): Promise<void> // always updates ts; triggers triggerOperators only if val changed
  write(val: ValType): Promise<void>               // write to ioBroker via IoStates.writeFn; skips non-finite numbers
  getHistory(opts: { start?, end?, ack?, limit? }): Promise<{ts,val}[]>  // via historyId sendTo
  toJSON(): { stateId, name, unit, writable, ts, val, triggerOperators, writtenByOperators, logType }
}

type AnyState = IoState<ValType>
```

---

## IoOperator — `/opt/iobroker/my_modules/ioBroker.utils/src/io-operator.ts`

Abstract base for reactive operators. Subclass and implement `execute()`.

```ts
abstract class IoOperator {
  readonly           inputStates:   readonly AnyState[]   // trigger execute() on change
  protected readonly outputStates:  readonly AnyState[]   // states this operator may write
  protected readonly watchedStates: readonly AnyState[]   // states read but not triggering

  constructor(inputStates, outputStates, watchedStates)
    // registers this operator on each input.triggerOperators and each output.writtenByOperators

  protected setup(): Promise<boolean> | boolean   	// optional pre-execute setup; return true when done
  protected abstract execute(trigger: AnyState): Promise<void> | void

  async onTrigger(trigger: AnyState): Promise<void>
    // called by IoState.onStateChange(); calls setup() once then execute()
}
```

---

## IoEngine — `/opt/iobroker/my_modules/ioBroker.utils/src/io-engine.ts`

Orchestrates startup: delegates history replay to `IoHistoryEngine`, then seeds live state and activates subscriptions.

```ts
class IoEngine {
  constructor()

  // Main entry point — call from adapter's onReady()
  async start(historyDays: number): Promise<void>
    // historyDays > 0: runs IoHistoryEngine.run(), then activates live mode
    // historyDays = 0: seeds states from current ioBroker values, then activates live mode
    // throws if any state has val == null, a future ts (clock skew), or is missing
}
```

---

## IoHistoryEngine — `/opt/iobroker/my_modules/ioBroker.utils/src/io-history-engine.ts`

Runs the full history-replay pipeline. Single-use — construct and call `run()` once.

```ts
class IoHistoryEngine {
  constructor(adapter: IoAdapter, logf: typeof IoAdapter.logf)

  async run(historyDays: number, allStates: AnyState[]): Promise<boolean>
    // Returns false if SQL is unavailable (no-op, caller falls back to live seeding)
    // Returns true after full replay: seeds states, replays SQL rows, flushes writes,
    // converts offline timers, syncs any src states that changed during replay
    // Caller must call Timer.configure() after run() to restore live timer implementations
}
```

---
*Last updated: 2026-04-20*
