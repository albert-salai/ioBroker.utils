# IoEngine — Live Mode

**Purpose:** behaviour of the live part of `IoEngine.start()` (`src/io-engine.ts`).

**Audience:** Claude sessions and developers writing operators or changing the engine.

**Contains:** seeding without history, `writeFn`, subscription loop, operator contract in live mode.

**Not here:** `start()` signature (`API-engine.md`), history replay (`API-engine-history.md`), `IoState` and
`IoTimer` API (`API-engine.md`, `API-core.md`).

Entered after `IoHistoryEngine.run()` returned `true`, or directly when `historyDays = 0` or `run()` returned `false`.

## Startup Sequence

```
// Only when no history replay happened:
await Promise.all(allStates.map(readState))  — seed val/ts in parallel from ioBroker via ioState.set()
  // after reading all: throws if any state is missing, has val == null, or has a future ts (clock skew)

// Always:
IoTimer.configure()                           — restore live JS timer implementations
IoStates.setWriteFn(live writeFn)             — install live write handler
await Promise.all(allStates.map(subscribe))   — subscribe all states in parallel (ack=true)
```

Before this, `start()` creates folder objects (`add_folders()`) for the path segments of states under the adapter
namespace.

## Clock

Wall clock: `IoTimer.now()` is `Date.now()`; timers use the adapter's `setTimeoutAsync` / `setIntervalAsync`.

## Write Path

The live `writeFn` calls `adapter.writeState(stateId, { val, ack, ts: Date.now() })`:

- `ack = true` for read-only states (computed values);
- `ack = false` for writable states (a command to ioBroker).

## Subscription Loop

Each state is subscribed with `ack = true`. On every ack'd event (value may be unchanged):

1. `ioState.onStateChange(val, ts)` updates val/ts and triggers `triggerOperators` if val changed; on an unchanged val
   only those with `triggerOnUnchanged`.
2. Operator `onTrigger()` → `execute()` → `ioState.write()` → `writeFn` → `adapter.writeState()` → the subscription
   fires again for the written state.

The loop terminates once operator outputs stabilise (no value changes). A writable state is written with `ack=false`,
so it does not re-enter the loop until the owning adapter acknowledges it.

```
  ioBroker          Engine               Operator
     |                 |                    |
     |  state change   |                    |
     | --------------> |                    |
     |                 | ioState.onStateChange() |
     |                 |------+             |
     |                 |<-----+             |
     |                 |                    |
     |                 |    onTrigger()     |
     |                 | -----------------> |
     |                 |                    | execute()
     |                 |                    |-----+
     |                 |                    |<----+
     |                 | IoStates.writeFn() |
     |                 | <----------------- |
     |  writeState()   |                    |
     | <-------------- |                    |
     |                 |                    |
     |  state change   |                    |
     | - - - - - - - > |  (loops until      |
     |                 |   values stable)   |
```

## Operator Contract

Operators may perform side effects and external calls in live mode.

`IoOperator.onTrigger()` calls `setup()` while the operator is not ready; if `setup()` returns `false`, `execute()` is
skipped and `setup()` is retried on the next trigger. Once `setup()` returns `true`, `execute()` runs on every trigger.

```
  trigger: state change
          |
          v
  setup already run? --no--> setup() --returns false--> skip, retry on next trigger
          |
         yes
          |
          v
      execute()
          |
          v
     IoStates.writeFn
```
