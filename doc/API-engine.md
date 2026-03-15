## IoState / IoStates — `/opt/iobroker/my_modules/ioBroker.utils/src/io-state.ts`

Typed wrapper around a single ioBroker state. Registered globally in `IoStates.allStates`.

```ts
class IoStates {
  static readonly allStates: Record<string, AnyState>   // all created/loaded states, keyed by stateId
  static write: (state, val) => Promise<void>           // set by IoEngine; triggers ioBroker writeState

  // Factory methods
  static create<T>(stateId, opts: IoStateOpts<T>): Promise<IoState<T>>
    // creates object + state in ioBroker; throws if already created
  static load<T>(stateId): Promise<IoState<T> | null>
    // returns existing instance if already loaded; otherwise loads object+state from ioBroker
    // returns null on missing stateId, missing object/state, or type mismatch
}

class IoState<T extends ValType> extends IoStates {
  readonly stateId:   string
  readonly name:      string
  readonly unit:      string
  readonly writable:  boolean     			// true = external writable input
  val:  T
  ts:   number                    			// ms timestamp; 0 = not yet initialized
  logType: 'none' | 'changed' | 'write'

  readonly inputFor:   IoOperator[]   		// operators triggered when this state changes
  readonly outputFrom: IoOperator[]			// operators that write this state

  init(val: T, ts: number): void            // set val+ts (ts must be > 0); no operator trigger
  update(val: T, ts: number): Promise<void> // always updates ts; triggers inputFor operators only if val changed
  write(val: ValType): Promise<void>        // write to ioBroker via IoStates.write; skips non-finite numbers
  getHistory(opts: { start?, end?, ack?, limit? }): Promise<{ts,val}[]>  // via historyId sendTo
}

type AnyState = IoState<ValType>
```

---

## IoOperator — `/opt/iobroker/my_modules/ioBroker.utils/src/io-operator.ts`

Abstract base for reactive operators. Subclass and implement `execute()`.

```ts
abstract class IoOperator {
  readonly           inputs:  readonly AnyState[]   // trigger execute() on change
  protected readonly outputs: readonly AnyState[]   // states this operator may write
  protected readonly others:  readonly AnyState[]   // states read but not triggering

  constructor(inputs, outputs, others)
    // registers this operator on each input.inputFor and each output.outputFrom

  protected init(): Promise<boolean> | boolean   	// optional pre-execute init; return true when done
  protected abstract execute(trigger: AnyState): Promise<void> | void

  async exec(trigger: AnyState): Promise<void>
    // called by IoState.update(); verifies all states have ts>0, calls init() once, then execute()

  static setOnline(v: boolean): void
  static isOnline(): boolean   						// false during history replay
}
```

---

## IoEngine — `/opt/iobroker/my_modules/ioBroker.utils/src/io-engine.ts`

Orchestrates startup, history replay, and live state subscriptions.

```ts
class IoEngine {
  constructor()

  // Main entry point — call from adapter's onReady()
  async start(historyDays: number): Promise<void>
    // historyDays > 0: connects SQL, replays history, then goes live
    // historyDays = 0: initializes states from current ioBroker values only

}
```

---
*Last updated: 2026-03-15*
