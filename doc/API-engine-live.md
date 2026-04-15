# IoEngine — Live Mode

Entered after `IoHistoryEngine.run()` completes, or directly via `start(historyDays = 0)`.

## Purpose

Processes real-time ioBroker state changes and routes operator outputs back to ioBroker. This is the normal running state of the engine.

## Startup Sequence

```
// Always (IoEngine.start(), after IoHistoryEngine.run() or when historyDays = 0):
Timer.configure()                          — restore live JS timer implementations

// Only when skipping history mode (historyDays = 0, or IoHistoryEngine returned false):
await Promise.all(allStates.map(readState))  — seed initial values in parallel from ioBroker
  // throws if any state has val == null, missing state, or future ts (clock skew)

// Always:
IoStates.writeFn = adapter.writeState      — install live write handler
await Promise.all(allStates.map(subscribe)) — subscribe all states in parallel (ack=true)
```

## Clock

Wall clock — `Timer.now()` returns `Date.now()`. Timers use standard JS `setTimeout`/`setInterval`.

## Subscription Loop

Each state is subscribed with `ack = true`. On change:

1. `ioState.onStateChange(val, ts)` — updates val/ts, triggers `triggerOperators` if val changed.
2. Operator `onTrigger()` → `execute()` → `IoStates.writeFn()` → `adapter.writeState()` → subscription fires again.

This loop is recursive but bounded: it terminates once operator outputs stabilise (no value changes).

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

## Write Path

When an operator writes a value, `IoStates.writeFn` calls `adapter.writeState(stateId, { val, ack, ts })`:

- `ack = true` for read-only outputs (computed values).
- `ack = false` for writable states (signals a command to ioBroker).

The written state immediately triggers the subscribed ack change handler, which calls `ioState.onStateChange()` and re-executes dependent operators.

## Operator Contract

Operators may perform side effects and external calls in live mode.

`onTrigger()` calls `setup()` once on the first trigger; if `setup()` returns `false`, `execute()` is skipped and `setup()` is retried on the next trigger. Once `setup()` returns `true`, `execute()` is called on every trigger.

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

---
*Last updated: 2026-04-15*
