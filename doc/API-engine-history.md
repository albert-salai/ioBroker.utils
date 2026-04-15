# IoHistoryEngine — History Mode

Entered via `IoEngine.start(historyDays > 0)` → `IoHistoryEngine.run()`.

## Purpose

Before going live, `IoHistoryEngine` replays SQL history to recompute derived (dst) state values from raw (src) state history. This ensures SQL contains consistent computed outputs from `fromTs` (= now − historyDays) up to wall time, even if the adapter was offline or restarted.

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
IoEngine.start()
  └─ IoHistoryEngine.run()
       ├─ sql_connect()               — returns false if SQL unavailable; caller falls back to live seeding
       ├─ sql.optimizeTablesAsync()   — optional, if adapter config 'sql-optimize' is set
       ├─ Timer.configure(offline)    — redirect Timer to simulated-clock implementation
       ├─ IoStates.writeFn = hist_write — redirect writes to buffered SQL path (not ioBroker)
       ├─ sql.delHistory(dstStateIds) — delete existing dst history from fromTs in chunks
       ├─ hist_init()        — seed all states: last SQL value before window,
       │                        else first value in window (timestamped at fromTs),
       │                        else current ioBroker state (throws if not found)
       ├─ hist_replay()      — read src rows from SQL in adaptive chunks; call
       │                        srcState.onStateChange() per row to drive operators
       ├─ hist_setNow(now)   — advance simulated clock to wall time, firing any
       │                        expired timers
       ├─ hist_convertTimers() — convert remaining offline timers to live JS timers
       ├─ hist_flush()       — flush remaining buffered SQL writes
       ├─ fix dstState divergence — delete + rewrite any dst SQL row whose value
       │                            diverged from in-memory state during replay
       ├─ sync srcStates     — re-read any src states that changed in ioBroker
       │                        while history processing ran
       └─ sql.onUnload()
  └─ Timer.configure()       — restore live JS timer implementations (always, after run())
```

## Clock

During history mode `IoHistoryEngine` uses a simulated clock (`histNow`) instead of wall time:

- `histNow` starts at `fromTs` and advances to each SQL row's `ts` via `hist_setNow()`.
- `Timer.now()` returns `histNow`, so operators see the simulated time.
- Timers are queued in `histTimers` (sorted by `expireTs`) and fire as the clock advances.
- SQL rows must arrive in strictly increasing `ts` order — a violation throws and aborts replay.

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

## State Classification

States are split into two groups at the start of `run()`:

- **srcStates** — have real SQL history; they drive operators by calling `onStateChange()` for each row.
  Condition: `writable === true` OR `writtenByOperators.length === 0`
- **dstStates** — computed outputs written by operators; their existing SQL history is deleted from `fromTs` before replay, then rewritten by `hist_write()`.
  Condition: `writtenByOperators.length > 0` AND `writable === false`

## Write Path

During history mode, `IoStates.writeFn` routes through `hist_write()` instead of the adapter:

1. Calls `ioState.onStateChange(val, histNow)` to propagate the value in-memory (may recursively trigger further operator executions).
2. Buffers `{ stateId, val, ts }` in `histWriteCache` — writable states are skipped because commands have no SQL history.
3. Flushes to SQL in batches of `flushSize` rows. `flushSize` is auto-tuned via exponential moving average to keep each flush at ~1 second.

## Operator Contract

Operators must inspect context (e.g. adapter config, time, external state) to skip side effects during replay. The `onTrigger()` / `execute()` call sequence is otherwise identical to live mode.

---
*Last updated: 2026-04-15*
