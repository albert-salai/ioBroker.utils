// adapter lifecycle: connects to ioBroker, owns the object/state subscription loop
export { IoAdapter, dateStr, valStr }	from './io-adapter';
export type { ValType, StateChange }	from './io-adapter';

// execution engine: orchestrates operators and drives the reactive state loop
export { IoEngine }						from './io-engine';

// state wrapper: tracks current value and signals changes to the engine
export { IoState }						from './io-state';
export type { AnyState }				from './io-state';

// operator: reads/writes IoState values and batches mutations into transactions
export { IoOperator }					from './io-operator';

// timer: thin adapter over ioBroker's setTimeout/clearTimeout — caller owns destroy()
export { Timer }						from './io-timer';
export type { TimerOpts, SetTimer, ClearTimer, TimerNow }	from './io-timer';

// math/signal utilities: IIR filter, parabola fit, Magnus saturation, Newton-Raphson, RLS
export { sortBy, parabola, Magnus, IIR, newtonRaphson, RLS }	from './io-util';
