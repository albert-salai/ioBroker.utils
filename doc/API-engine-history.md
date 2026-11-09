# IoHistoryEngine — History Mode

**Purpose:** behaviour of the SQL history replay that runs before live mode (`src/io-history-engine.ts`).

**Audience:** Claude sessions and developers writing operators or changing the replay.

**Contains:** pipeline, simulated clock, src/dst classification, write path, flush and delete behaviour, operator
contract during replay.

**Not here:** `IoEngine.start()` signature (`API-engine.md`), live mode (`API-engine-live.md`), `IoSql` API and
`IoTimer` fields (`API-core.md`).

Entered via `IoEngine.start(historyDays > 0)` → `new IoHistoryEngine().run(historyDays, allStates)`. The instance is
single-use. `run()` returns `false` when SQL is unavailable (no history instance, or `dbtype` is not `mysql`); the
caller then seeds from ioBroker (see `API-engine-live.md`).

The same file exports `optimizeSql(): Promise<boolean>` (re-exported by `src/index.ts`): connects, runs
`optimizeTablesAsync()`, disconnects; `false` if SQL is unavailable. `run()` does not call it.

## Purpose

`run()` recomputes derived (dst) state values from raw (src) state history for `fromTs` (= now − `historyDays`) up to
wall time, so SQL is consistent even if the adapter was offline.

```
  SQL                    Engine                               SQL
  ┌─────────────────┐    ┌──────────────────────────────┐    ┌─────────────────┐
  │  src history    │    │  srcState        Operator    │    │  dst history    │
  │  (fromTs→now)   │──> │  .onStateChange() ─execute() │──> │  (fromTs→now)   │
  └─────────────────┘    │          │                   │    └─────────────────┘
                         │       dstState               │
                         │       hist_write             │
                         │       (buffered flush)       │
                         └──────────────────────────────┘
```

## Startup Sequence

```
IoHistoryEngine.run(historyDays, allStates)
  ├─ sql_connect()               — false if SQL unavailable
  ├─ IoTimer.configure({...})    — simulated-clock setTimer / clearTimer / now
  ├─ IoStates.setWriteFn(hist_write) — buffered SQL path instead of ioBroker
  ├─ classify states             — srcStates / dstStates; warn for dst without SQL datapoint
  ├─ sql.delHistory(dstStateIds) — delete dst history from fromTs, in 21-day chunks (ReadDaysLimit/2)
  ├─ hist_init()                 — seed all states (see below)
  ├─ hist_replay()               — read src rows in adaptive chunks; drive srcState.onStateChange() per row
  ├─ hist_setNow(Date.now())     — advance simulated clock to wall time, firing expired timers
  ├─ hist_convertTimers()        — IoTimer.configure() (live), then convert remaining timers to live timers
  ├─ hist_flush()                — flush remaining buffered writes
  ├─ fix dstState divergence     — if the ioBroker value differs from the in-memory dst value: delete the
  │                                SQL row at dstState.ts, then adapter.writeState(dst val, ack=true, ts)
  ├─ sync srcStates              — srcState.onStateChange() for src states whose ioBroker value changed meanwhile
  └─ sql.onUnload()
```

`hist_init()` seeds each state (`ack=true`, non-null rows only), first match wins:

1. last SQL value before `fromTs` (own `ts`);
2. first SQL value from `fromTs` (`ts = fromTs`);
3. current ioBroker state; written back to ioBroker only for srcStates. Throws if the state is missing or null.

A seed `ts <= 0` is logged and replaced by `fromTs`.

`IoEngine.start()` restores live timers (`IoTimer.configure()`) and installs the live `writeFn` afterwards; see
`API-engine-live.md`.

## Clock

`IoHistoryEngine` replaces the `IoTimer` statics with simulated implementations:

- `histNow` starts at `fromTs` and advances to each SQL row's `ts` via `hist_setNow()`.
- `IoTimer.now()` returns `histNow`, so operators see simulated time.
- Timers are queued in `histTimers` (sorted by `expireTs`). `hist_setNow(next)` fires every timer with
  `expireTs <= next` in order, setting `histNow = expireTs` before each callback; interval timers are re-queued
  (`expireTs += intervalMs`), one-shots removed. `hist_clearTimer()` removes a timer and logs an error if unknown.
- A row with `ts < histNow` logs an error and throws, which aborts the replay.

```
  time
  ──────────────────────────────────────────────────────────────>

  fromTs          row.ts advances...               now (wall time)
  |               |        |        |        |        |
  v               v        v        v        v        v
  hist_init    setNow   setNow   setNow   setNow   setNow(now)
  seed states  timers   timers   timers   timers   timers
               update   update   update   update   hist_convertTimers
               write    write    write    write
```

`hist_convertTimers()`: per remaining timer, `timeoutMs = expireTs - now`; one-shot: fire at once if `<= 0`, else
live `setTimer`; interval: if `<= 0` fire once and start a live interval, else live timeout + interval.

## State Classification

At the start of `run()` every state goes into one group:

- **dstStates** — computed outputs: `writerCount > 0` AND `writable === false`. Their SQL history from `fromTs` is
  deleted before replay and rewritten by `hist_write()`.
- **srcStates** — all others: they drive operators by calling `onStateChange()` per SQL row.

## Replay

`hist_replay()` reads `ack=true`, non-null rows of the srcStates with `IoSql.readHistory({ from, before, limit })`:

- window = `min(42 days, 150000 / rowsPerDay)`, `rowsPerDay` starts at 25000 and is re-estimated per chunk;
- when a chunk reaches the limit (225000 rows) it is re-read with a narrower window; an empty chunk before wall time
  lowers the density estimate and advances the window;
- chunk N is replayed (`hist_replayRows()`) while chunk N+1 is read;
- a repeated value is in the history only when its state is logged with `changesOnly: false`, so an operator with
  `triggerOnUnchanged` sees fewer samples in replay than live.

## Write Path

`IoStates.writeFn` is `hist_write(ioState, val)`:

1. `ioState.onStateChange(val, histNow)` propagates in memory (recursively triggers further operators).
2. Non-writable states are buffered as `{ stateId, val, ts: histNow }` in `histWriteCache`; writable states are
   skipped (commands have no SQL history).
3. At `flushSize` buffered rows, `hist_flush()` runs asynchronously (`IoSql.writeHistory`); at most one flush is in
   flight. `flushSize` starts at 35000 and is tuned per flush toward ~1 s: clamped to 10000–50000, smoothed
   `(new + 3·old) / 4`.

## Operator Contract

Operators skip side effects during replay by inspecting context (adapter config, time, external state). The
`onTrigger()` / `execute()` sequence is otherwise identical to live mode (`API-engine-live.md`, Operator Contract).
