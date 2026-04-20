## IoAdapter — `/opt/iobroker/my_modules/ioBroker.utils/src/io-adapter.ts`

Extends `@iobroker/adapter-core` `Adapter`. Singleton; access via `IoAdapter.this` / `IoAdapter.logf`.

```ts
class IoAdapter extends Adapter {
  historyId: string                          // e.g. 'sql.0', set on ready from system.config
  logf: { silly/info/debug/warn/error(fmt: string, ...args) }  // sprintf-formatted logging

  static get this(): IoAdapter               // singleton instance
  static get logf()                          // shorthand for IoAdapter.this.logf

  // Override in subclass:
  protected onReady():  Promise<void>        // called after adapter ready
  protected onUnload(): Promise<void>        // called on unload

  save_config(): void                        // triggers config save + adapter restart

  // ioBroker object writers
  writeFolderObj(stateId, common): Promise<void>
  writeDeviceObj(stateId, common): Promise<void>
  writeChannelObj(stateId, common): Promise<void>
  writeStateObj(stateId, opts: IoStateOpts<ValType>): Promise<ioBroker.StateObject>
    // creates or updates state object; handles history config via historyId

  // ioBroker state r/w
  readStateObject(stateId): Promise<ioBroker.StateObject | null>
  writeState(stateId, state: ioBroker.SettableState): Promise<void>
  readState(stateId): Promise<ioBroker.State | null>

  // Subscriptions — callbacks serialized via mutex
  subscribe(spec: { stateId, cb, val?, ack? }): Promise<void>
  unsubscribe(spec): Promise<void>

  // Async timer helpers — callbacks run inside mutex
  setTimeoutAsync(cb: () => Promise<void>, ms): ioBroker.Timeout
  setIntervalAsync(cb: () => Promise<void>, ms): ioBroker.Interval
}
```

**Types:**
```ts
type ValType = number | boolean | string
interface StateChange { val: ValType, ack: boolean, ts: number }
interface IoStateOpts<T extends ValType> {
  common: Omit<Partial<ioBroker.StateCommon>, 'def' | 'type'> & { name: string, def: T }
  native?: ioBroker.SettableStateObject['native']
  history?: HistoryOpts   // set enabled:true to activate; all other fields optional
}
interface HistoryOpts { enabled?, changesOnly?, changesMinDelta?, retention?, ... }  // see source
```

```ts
dateStr(ts?: number): string   // → "DD.MM.YYYY HH:MM:SS" local time; defaults to now
valStr(val: ioBroker.StateValue): string  // number (rounded to 6 decimal places) | boolean → 'ON'/'OFF' | string
```

---

## Timer — `/opt/iobroker/my_modules/ioBroker.utils/src/io-timer.ts`

Unified timer abstraction; swappable for history vs. live execution.

```ts
class Timer {
  // Static (swappable) functions — replaced by IoEngine during history replay
  static setTimer(opts: TimerOpts): Timer | null
  static clearTimer(timer: Timer | null): null
  static now(): number                          // ms; returns Date.now() in live mode
  static configure(cfg?): void                  // reset to live (default) or inject custom fns

  // Instance
  readonly name:      string
  readonly cb:        () => void | Promise<void>
  expireTs:           number
  timeoutMs:          number | null
  intervalMs:         number | null
  timeoutId:          ioBroker.Timeout    // read by IoEngine.hist_convertTimers()
  intervalId:         ioBroker.Interval   // read by IoEngine.hist_convertTimers()
}

// either timeoutMs or intervalMs (or both) must be provided
type TimerOpts = { name: string, cb: TimerCb, timeoutMs?: number, intervalMs?: number }
               & ({ timeoutMs: number } | { intervalMs: number })

// Function-signature type aliases (useful when storing Timer.setTimer/clearTimer/now as callbacks)
export type SetTimer   = (opts: TimerOpts) => Timer | null
export type ClearTimer = (timer: Timer | null) => null
export type TimerNow   = () => number
```

**Usage:**
```ts
// Set a one-shot timer
let t = Timer.setTimer({ name: 'myTimer', timeoutMs: 5000, cb: async () => { ... } });
// Set recurring
let t = Timer.setTimer({ name: 'poll', intervalMs: 60000, cb: async () => { ... } });
// Clear
t = Timer.clearTimer(t);
```

---

## IoSql — `/opt/iobroker/my_modules/ioBroker.utils/src/io-sql.ts`

MariaDB/MySQL history backend. Caller must call `onUnload()` to close the connection.

```ts
class IoSql {
  async connect(opts: SqlConnOpts): Promise<boolean>
    // returns false on connection or datapoint-load failure

  async onUnload(): Promise<void>
    // cancels pending cache-wait timer and closes the SQL connection

  async readHistory(stateIds: string[], opts: SqlQueryOpts): Promise<SqlHistoryRow[]>
  async writeHistory(samples: IoWriteCacheVal[]): Promise<Record<string, number>>
    // inserts into ts_number / ts_string / ts_bool; skips unknown stateIds; returns affected rows by table
  async delHistory(stateIds: string[], opts: SqlQueryOpts): Promise<Record<string, number>>

  async optimizeTablesAsync(): Promise<void>
    // OPTIMIZE TABLE ts_number, ts_string, ts_bool WAIT 120

  async waitCache(maxLevel?: number): Promise<void>
    // polls until Aria dirty-cache ratio <= maxLevel (default 0); guards low-memory hardware

  stateIds(): string[]
    // returns all stateIds known to the datapoints table
}
```

**Types:**
```ts
interface IoWriteCacheVal { stateId: string, val: ValType, ts: number }

interface SqlQueryOpts {
  ack?, isNull?,
  at?, after?, from?, before?, until?   // epoch-ms; from/until inclusive, after/before exclusive
  desc?, limit?
}

interface SqlHistoryRow { id: string, ts: number, val: number | string | boolean, t: 'n' | 's' | 'b' }
```

---
*Last updated: 2026-04-20*
