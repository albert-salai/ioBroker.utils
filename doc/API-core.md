# API core: IoAdapter, IoTimer, IoSql

**Purpose:** API reference of the adapter base class, the timer abstraction and the SQL history backend.

**Audience:** Claude Code sessions and developers using `iobroker-utils`.

**Contains:** signatures and semantics per class, in source order; imports only from `'iobroker-utils'` where exported.

**Not here:** `IoState`, `IoOperator`, `IoEngine`, `IoHistoryEngine` (`API-engine*.md`), math utilities and operators
(`API-misc.md`).

## IoAdapter (`src/io-adapter.ts`)

Extends `@iobroker/adapter-core` `Adapter`. Singleton: `IoAdapter.this` / `IoAdapter.logf`. Callbacks, timers and
messages run serialized through one mutex (20 s timeout). `logf` is a no-op until the `ready` handler has run.

```ts
class IoAdapter extends Adapter {
  constructor(options: AdapterOptions)
  historyId: string                    // e.g. 'sql.0'; system.config defaultHistory, '' if none
  logf: { silly|info|debug|warn|error: (fmt: string, ...args: unknown[]) => void }   // sprintf-formatted

  static get this(): IoAdapter
  static get logf()

  // Override in subclass
  protected onReady(): Promise<void>                       // after info.connection=false, logf and historyId are set
  protected onUnload(): Promise<void>
  protected onMessage(command: string, message: unknown): Promise<unknown>   // sendTo(); result is the reply;
                                                           // default { error } (needs common.messagebox: true)
  protected onNullWrite(stateId: string): Promise<void>    // ack:false null write to a subscribed state; noop

  save_config(): void       // marks config dirty; after onReady() `updateConfig(this.config)` restarts the adapter

  // Objects
  writeFolderObj(stateId, common): Promise<void>
  writeDeviceObj(stateId, common): Promise<void>
  writeChannelObj(stateId, common): Promise<void>
  writeStateObj(stateId, opts: IoStateOpts<ValType>): Promise<ioBroker.StateObject>
  readStateObject(stateId): Promise<ioBroker.StateObject | null>   // null if missing or not type 'state'

  // States
  writeState(stateId, state: ioBroker.SettableState): Promise<void>
  readState(stateId): Promise<ioBroker.State | null>

  // Subscriptions: reference-counted per stateId, dispatched through the mutex
  subscribe(spec: { stateId: string, cb: (c: StateChange) => void | Promise<void>,
             val?: ValType, ack?: boolean }): Promise<void>
  unsubscribe(spec): Promise<void>        // same spec object; unsubscribes from ioBroker with the last spec

  // Timers: callbacks run inside the mutex
  setTimeoutAsync(cb: () => Promise<void>, ms: number): ioBroker.Timeout
  setIntervalAsync(cb: () => Promise<void>, ms: number): ioBroker.Interval
}
```

- `writeStateObj`: `type` is derived from `common.def`; defaults `read: true`, `write: false`, `role: ''`. History
  config for `historyId` (only when `historyId` is set) merges built-in defaults < existing values < `opts.history`;
  `history.enabled` falsy removes an existing entry. Throws if the existing object is not type `'state'`. Logs each
  `common` diff. Returns the stored object.
- `subscribe`: a spec with `val` / `ack` fires only on that value / ack. `val: null` writes never reach a spec.

```ts
type ValType = number | boolean | string
interface StateChange { val: ValType, ack: boolean, ts: number }
interface IoStateOpts<T extends ValType> {
  common: Omit<Partial<ioBroker.StateCommon>, 'def' | 'type'> & { name: string, def: T }
  native?: ioBroker.SettableStateObject['native']
  history?: HistoryOpts
}
interface HistoryOpts {   // all optional; mirrors the sql adapter's custom config (defaults in src/io-adapter.ts)
  enabled, storageType, counter, aliasId, debounceTime, blockTime, changesOnly, changesRelogInterval,
  changesMinDelta, ignoreBelowNumber, disableSkippedValueLogging, retention, customRetentionDuration, maxLength,
  enableDebugLogs, debounce
}

dateStr(ts?: number): string              // 'DD.MM.YYYY HH:MM:SS' local time; default IoTimer.now()
valStr(val: ioBroker.StateValue): string  // number rounded to 6 decimals | boolean 'ON'/'OFF' | string | JSON
```

## IoTimer (`src/io-timer.ts`)

Timer abstraction; `IoHistoryEngine` swaps the static functions for history replay (`configure()`). Caller must call
`clearTimer()` before dropping a timer.

```ts
class IoTimer {
  static setTimer(opts: TimerOpts): IoTimer | null
  static clearTimer(timer: IoTimer | null): null        // cancels timeout and interval, returns null
  static now(): number                                  // epoch-ms; live: Date.now()
  static configure(cfg?: { setTimer, clearTimer, now }): void   // no arg: back to live; call before first use

  readonly name: string
  readonly cb: () => void | Promise<void>
  expireTs: number                      // epoch-ms of the next expected fire; 0 if neither delay is valid
  timeoutMs: number | null              // one-shot delay
  intervalMs: number | null             // recurring period
  timeoutId: ioBroker.Timeout           // read by IoHistoryEngine.hist_convertTimers()
  intervalId: ioBroker.Interval         // read by IoHistoryEngine.hist_convertTimers()
}

type TimerOpts = { name: string, cb: () => void | Promise<void>, timeoutMs?: number, intervalMs?: number }
               & ({ timeoutMs: number } | { intervalMs: number })   // at least one
```

- Constructor: negative `timeoutMs` / `intervalMs` is dropped (error / warn logged), values above `0x7FFFFFFF` are
  clamped.
- Both set (live): the interval starts after the timeout callback resolves.
- Not exported from `src/index.ts`: the aliases `SetTimer`, `ClearTimer`, `TimerNow`.

```ts
let t = IoTimer.setTimer({ name: 'poll', timeoutMs: 5000, intervalMs: 60000, cb: async () => { /* ... */ } });
t = IoTimer.clearTimer(t);
```

## IoSql (`src/io-sql.ts`)

MariaDB/MySQL history backend over `mysql2`. Not exported from `src/index.ts` (only `optimizeSql`). Caller must call
`onUnload()` to close the connection. Every read / write / delete first runs `waitCache()`.

```ts
class IoSql {
  connect(opts: mysql.ConnectionOptions): Promise<boolean>   // loads iobroker.datapoints; false on failure
  onUnload(): Promise<void>                                  // cancels the cache-wait timer, closes the connection

  readHistory(stateIds: string[], opts: SqlQueryOpts): Promise<SqlHistoryRow[]>   // bool vals coerced from 0/1
  writeHistory(samples: IoWriteCacheVal[]): Promise<Record<string, number>>
    // INSERT ... ON DUPLICATE KEY no-op into ts_number / ts_string / ts_bool (ack TRUE); skips unknown stateIds;
    // returns affected rows per table
  delHistory(stateIds: string[], opts: SqlQueryOpts): Promise<Record<string, number>>   // affected rows per table

  optimizeTablesAsync(): Promise<void>        // OPTIMIZE TABLE ts_number, ts_string, ts_bool WAIT 120
  waitCache(maxLevel = 0): Promise<void>      // polls every 250 ms until Aria dirty-cache ratio <= maxLevel
  stateIds(): string[]                        // all stateIds in the datapoints table
  cleanUpHistory(): Promise<void>             // stub: logs the changesOnly states, deletes nothing
}

optimizeSql(): Promise<boolean>   // exported from io-history-engine.ts: connects via the history instance's native
                                  // config (mysql only), optimizes, disconnects; false if unavailable
```

```ts
interface IoWriteCacheVal { stateId: string, val: ValType, ts: number }

interface SqlQueryOpts {
  ack?: boolean, isNull?: boolean,
  at?, after?, from?, before?, until?: number,   // epoch-ms; from/until inclusive, after/before exclusive
  desc?: boolean, limit?: number                 // limit per table before UNION ALL, then on the merged result
}

interface SqlHistoryRow { id: string, ts: number, val: number | string | boolean, t: 'n' | 's' | 'b' }
  // t: source table ts_number | ts_string | ts_bool
```
