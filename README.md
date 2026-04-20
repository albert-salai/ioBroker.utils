# ioBroker.utils

Shared utilities for ioBroker adapter development — a reactive state-processing framework with SQL history replay.

> **Status**: Superseded by [`iobroker-io-lib`](../ioBroker.io-lib/). This package is archived.

## Overview

`ioBroker.utils` provides a layered framework on top of `@iobroker/adapter-core`:

| Layer | Class | Purpose |
|---|---|---|
| Core | `IoAdapter` | Singleton adapter base — logging, state I/O, subscriptions |
| Core | `IoSql` | MySQL history backend (read/write) |
| Core | `IoTimer` | Dual-mode timer (live JS timers / simulated clock) |
| Engine | `IoState` / `IoStates` | Typed state registry with reactive subscriptions |
| Engine | `IoOperator` | Reactive computation base class |
| Engine | `IoEngine` | Lifecycle orchestration — history replay → live mode |

## Architecture

```
IoAdapter (singleton)
  └── IoEngine.start()
        ├── [history mode] IoSql → replay SQL rows via simulated clock
        │     └── IoOperator.execute() on each simulated tick
        └── [live mode] real subscriptions via ioBroker
              └── IoOperator.execute() on state change
```

**Key design properties:**

- All state mutations are serialized through a single `async-mutex` (20 s timeout), preventing concurrent writes.
- `IoStates` uses reference-counted subscriptions — the adapter only subscribes to a state when at least one operator depends on it.
- Operators form a DAG: an input state change triggers `execute()`, which may write output states, which may trigger further operators. Execution is bounded — it terminates when values stabilize.
- History replay rewinds the clock to `now - historyDays`, drives operators through SQL rows, then deletes and rewrites derived state history for consistency before switching to live mode.

## Installation

```bash
npm install iobroker-utils
```

Requires Node.js ≥ 18 and a running ioBroker instance.

## Quick Start

```typescript
import { IoAdapter, IoEngine, IoStates, IoOperator, IoState } from 'iobroker-utils';

// 1. Extend IoAdapter
class MyAdapter extends IoAdapter {
    async onReady() {
        // Define states
        const temp = await IoStates.create<number>('sensor.temperature', { unit: '°C' });
        const alarm = await IoStates.create<boolean>('alarm.high-temp', { role: 'indicator' });

        // Define a reactive operator
        new class extends IoOperator {
            constructor() { super([temp], [alarm], []); }
            async execute(trigger: IoState) {
                await alarm.write(temp.val > 30);
            }
        }();

        // Start engine (history replay for 7 days, then go live)
        await IoEngine.start(7);
    }
}

new MyAdapter();
```

## Core API

### IoAdapter

Singleton extending `@iobroker/adapter-core`. Access via `IoAdapter.this` or `IoAdapter.logf` (static).

```typescript
// Formatted logging (sprintf-style)
IoAdapter.logf.info('Temperature: %.1f °C', 23.456);

// State I/O
const { val, ts } = await adapter.readState('sensor.temperature');
await adapter.writeState('alarm.high-temp', true, /*ack*/ true);

// Subscriptions with filtering
adapter.subscribe(stateId, { ack: true }, callback);

// Async timers (run inside the mutex)
adapter.setTimeoutAsync(fn, 5000);
adapter.setIntervalAsync(fn, 60_000);
```

### IoStates / IoState

```typescript
// Create (registers state object in ioBroker)
const s = await IoStates.create<number>('my.state', { unit: 'W', role: 'value.power' });

// Load (reads an existing state)
const s = await IoStates.load<number>('my.state');

// Use
s.val        // current value
s.ts         // last-change timestamp (epoch ms)
await s.write(42);
const history = await s.getHistory({ start, end, limit });
```

### IoOperator

```typescript
class MyOp extends IoOperator {
    constructor() {
        super(
            [inputStateA, inputStateB],  // triggers execute() on change
            [outputState],               // states this operator writes
            [watchedState]               // read-only dependencies
        );
    }

    async setup(): Promise<boolean> {
        // async init; return false to defer until next trigger
        return true;
    }

    async execute(trigger: IoState): Promise<void> {
        outputState.set(inputStateA.val + inputStateB.val);
        await outputState.write();
    }
}
```

### IoEngine

```typescript
// Start with 7 days of history replay
await IoEngine.start(7);

// Start without history (live-only)
await IoEngine.start(0);
```

### IoSql

```typescript
const sql = new IoSql();
await sql.connect({ host: 'localhost', user: 'iobroker', password: '…', database: 'iobroker' });

const rows = await sql.getHistory(stateId, { start, end, limit, ack: true });
await sql.writeHistory(stateId, [{ ts, val, ack: true }]);
```

## Built-in Operators

| Operator | Description |
|---|---|
| `OpAutoOnOff` | Auto-switch boolean after timeout |
| `OpBiQuadFilter` | Second-order IIR (biquad) filter |
| `OpDewpoint` | Magnus-formula dew point |
| `OpDiff` | Difference between consecutive values |
| `OpFollowSwitch` | Output mirrors a boolean input |
| `OpIfThenElse` | Conditional write |
| `OpLowerBound` | Enforce minimum value |
| `OpMean` | Arithmetic mean of N inputs |
| `OpMovingAvg` | Exponential moving average |
| `OpOnOffDelay` | Delayed boolean transitions |
| `OpPartPress` | Partial pressure from temperature + humidity |
| `OpSchmittTrig` | Hysteretic comparator |
| `OpSumN` | Sum of N inputs |

## Utilities

```typescript
import { dateStr, valStr, sortBy, Magnus, IIR, newtonRaphson, RLS, parabola } from 'iobroker-utils';

dateStr(Date.now())       // '20.04.2026 14:30:00'
valStr(3.141592653)       // '3.141593'
sortBy<Item>('name')      // Array.sort() comparator

Magnus.satPress(20)       // saturation vapor pressure at 20 °C
Magnus.dewpoint(20, 60)   // dew point at 20 °C, 60 % RH

const filter = new IIR(b, a);
filter.step(x);           // one sample

newtonRaphson(f, df, x0, opts);

const rls = new RLS(order, forgettingFactor);
rls.update(x, y);
```

## Build

```bash
# Compile TypeScript
sudo -u iobroker npm run build

# Type-check without emit
sudo -u iobroker npm run check

# Lint
sudo -u iobroker npm run lint
```

## API Documentation

Detailed API docs live in [`doc/`](doc/):

- [API-core.md](doc/API-core.md) — IoAdapter, IoSql, IoTimer
- [API-engine.md](doc/API-engine.md) — IoState, IoOperator, IoEngine
- [API-engine-history.md](doc/API-engine-history.md) — history replay mode
- [API-engine-live.md](doc/API-engine-live.md) — live mode
- [API-misc.md](doc/API-misc.md) — utility functions

## License

MIT © Albert Salai
