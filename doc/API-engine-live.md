# IoEngine — Live Mode

Active when `IoOperator.isOnline() === true`. Entered after history mode completes, or directly via `start(historyDays = 0)`.

## Purpose

Processes real-time ioBroker state changes and routes operator outputs back to ioBroker. This is the normal running state of the engine.

## Startup Sequence

```
// Only when skipping history mode (historyDays = 0):
Timer.configure()
for each ioState: ioState.init(currentVal, currentTs)   — seed initial values from ioBroker

// Always (whether coming from history mode or starting directly):
IoStates.write = adapter.writeState                     — install live write handler
for each ioState: adapter.subscribe(stateId, ack=true)  — start listening for state changes
```

## Clock

Wall clock — `Timer.now()` returns `Date.now()`. Timers use standard JS `setTimeout`/`setInterval`.

## Subscription Loop

Each state is subscribed with `ack = true`. On change:

1. `ioState.update(val, ts)` — updates val/ts, triggers `inputFor` operators if val changed.
2. Operator `exec()` → `execute()` → `IoStates.write()` → `adapter.writeState()` → subscription fires again.

This loop is recursive but bounded: it terminates once operator outputs stabilise (no value changes).

```
  ioBroker          Engine               Operator
     |                 |                    |
     |  state change   |                    |
     | --------------> |                    |
     |                 | ioState.update()   |
     |                 |------+             |
     |                 |<-----+             |
     |                 |                    |
     |                 |      exec()        |
     |                 | -----------------> |
     |                 |                    | execute()
     |                 |                    |-----+
     |                 |                    |<----+
     |                 |  IoStates.write()  |
     |                 | <----------------- |
     |  writeState()   |                    |
     | <-------------- |                    |
     |                 |                    |
     |  state change   |                    |
     | - - - - - - - > |  (loops until      |
     |                 |   values stable)   |
```

## Write Path

When an operator writes a value, `IoStates.write` calls `adapter.writeState(stateId, { val, ack, ts })`:

- `ack = true` for read-only outputs (computed values).
- `ack = false` for writable states (signals a command to ioBroker).

The written state immediately triggers the subscribed ack change handler, which calls `ioState.update()` and re-executes dependent operators.

## Operator Contract

`IoOperator.isOnline()` returns `true` — operators may perform side effects and external calls.

`exec()` verifies `ts > 0` for all states (`inputs + outputs + others`) before proceeding. If any state has not yet received a value (`ts === 0`), `init()` is skipped and retried on the next trigger. Once all states are ready, `init()` runs once; if it returns `false`, `execute()` is skipped and `init()` is retried. Otherwise `execute()` is called on every trigger.

```
  trigger: state change
          |
          v
  all states ts > 0? --no--> skip, retry on next trigger
          |                          ^
         yes                         |
          |                          |
          v                          |
   init already run? --no--> init() --returns false--+
          |
         yes
          |
          v
      execute()
          |
          v
     IoStates.write
```

---
*Last updated: 2026-03-15*
