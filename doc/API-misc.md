# API misc: math utilities and operators

**Purpose:** API reference of the math / signal utilities and the generic reactive operators.

**Audience:** Claude Code sessions and developers using `iobroker-utils`.

**Contains:** signatures and one-line semantics; utilities in `src/io-util.ts`, operators in `src/operators/`.

**Not here:** `IoOperator` base class and `IoState` (`API-engine.md`), `IoAdapter`, `IoTimer`, `IoSql`
(`API-core.md`), operator internals (the source comments).

## Utilities (`src/io-util.ts`)

All exported from `src/index.ts`.

```ts
sortBy<T>(key: keyof T): (a: T, b: T) => number          // ascending comparator for Array.sort()
parabola(x: [n,n,n], y: [n,n,n]): { a, b, c }             // y = ax² + bx + c through 3 points

// Magnus formulas, WMO-No.8, water, -45..60 °C
class Magnus {
  sdd(T): number      // saturation vapour pressure [hPa]
  dd(T, rh): number   // actual vapour pressure [hPa]; rh in %
  td(T, rh): number   // dew point [°C]
}

// IIR filter, direct form II transposed
class IIR {
  b: number[]; a: number[]                         // normalized by a[0]
  constructor(opts: { b: number[], a: number[] })  // throws if empty, unequal length or a[0] undefined
  next(x: number): number                          // first call sets the state to steady state for x
}

// Newton-Raphson; fp omitted: 5-point finite difference. Returns false if derivative ~0 or maxIter reached
newtonRaphson(f, x0, opts: { fp?, h?=1e-4, tolerance?=1e-9, epsilon?=1e-16, maxIter?=20, xMin?, xMax?,
                             verbose? }): number | false

// Recursive least squares; call init() before update()
class RLS {
  init(w: number[], lambda: number, P: number | number[][]): void
    // w: initial weights, lambda: forgetting factor, P: initial covariance (scalar s -> s*I)
  update(x_vals: number[], y_val: number): number[]    // returns the updated weight vector
}
```

## Operators (`src/operators/`)

Subclasses of `IoOperator`, all exported from `src/index.ts`. `Input*` states trigger; `Output*` states are written;
`Temp` is read only. Constructor options marked `?` are optional.

| Operator | Constructor | Semantics |
|---|---|---|
| `OpSumN` | `(inputs: IoState<number>[], output, scale?: number[])` | `output = Σ scale[i]*inputs[i]`; scale default all 1, length must match |
| `OpDiff` | `(input1, input2, output)` | `OpSumN` with scale `[1, -1]` |
| `OpIfThenElse` | `(opts: IfThenElseOpts)` | IF / CONDS chain (`AND`/`OR`, ops `=`,`<`,`>`) selects a THEN or optional ELSE write |
| `OpSchmittTrig` | `({ CurrInput, TargetInput, Output: boolean, lowerBound?=0, upperBound?=0 })` | ON at `Curr <= Target - lowerBound`, OFF at `Curr > Target + upperBound` |
| `OpAutoOnOff` | `(State: boolean, { autoOnMs?, autoOffMs? })` | switches OFF / ON after the delay; applies an elapsed delay at start |
| `OpOnOffDelay` | `(Input, Output, { onDelayMs, offDelayMs })` | mirrors a boolean with separate on / off delays |
| `OpFollowSwitch` | `(Input, Output, { dutyCycleOnMin?=0, dutyCycleOffMax?=1 })` | mirrors a boolean, delayed by the observed duty cycle |
| `OpLowerBound` | `(Input, Output, { debounceSecs })` | writes the last value before a rise; `debounceSecs > 0` clamps Output down to Input |
| `OpDewpoint` | `({ Relhum, Temp, Dewpoint })` | `Magnus.td`, writes °C; seeds at start |
| `OpPartPress` | `({ Relhum, Temp, Partpres })` | `Magnus.dd`, writes hPa; values above 50 hPa are dropped; seeds at start |
| `OpBiQuadFilter` | `({ Input, Output, clockSecs, tauGr, minDelta?=0 })` | clocked 2nd-order low pass, `tauGr` > 1 group-delay ratio |
| `OpDerivative` | `({ Input, Output, perSecs?=1, precision?, scale?=1 })` | slope between the last two input changes |
| `OpMean` | `({ Input, Output, periodSecs, clockSecs, precision?, backward?, deferred?, scale?, triggerOnUnchanged? })` | time-weighted mean |
| `OpMovingAvg` | `({ Input, Output, periodSecs, clockSecs, windowType })` | causal windowed mean of a step signal |

- `OpAutoOnOff` and `OpFollowSwitch` / `OpSchmittTrig` throw in the constructor if the written state is not writable.
- `OpIfThenElse`: `IfThenElseOpts = { IF: {ioState, op, value}, THEN: {ioState, value}, ELSE?: {ioState, value},
  CONDS: {ioState, cond, op, value}[] }`; exported with the type `IfThenElseOpts`. Every IF / CONDS state triggers.
- `OpMean`: `clockSecs <= 0` is event mode (writes a changed output on each input change), `> 0` clock mode (writes
  every tick, aligned to local-time multiples of the interval). `backward` selects the timestamp convention (default
  forward: a sample is valid from its own ts to the next). `deferred` (clock mode): a tick is computed at the next
  input sample. `precision` is a snap step (`Math.round(v*scale/precision)*precision`), not a number of
  decimals. Start-up seeds the window from history.
- `OpDerivative`: writes at now on every input change; nothing for the first sample or non-advancing time. Feed a
  downstream `OpMean` with `backward: true`; with `precision` also with `triggerOnUnchanged: true`, and log the output
  with `changesOnly: false`.
- `OpMovingAvg`: `windowType` is `'rect' | 'hann' | 'hamming' | 'blackman' | 'nuttall'`; `clockSecs <= 0` is event
  mode; output delay `periodSecs/2`.
- `OpBiQuadFilter`: writes only when the change exceeds `minDelta`.
