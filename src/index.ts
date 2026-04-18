// adapter lifecycle: connects to ioBroker, owns the object/state subscription loop
export { IoAdapter, dateStr, valStr }	from './io-adapter';
export type { ValType, StateChange, HistoryOpts, IoStateOpts }	from './io-adapter';

// execution engine: orchestrates operators and drives the reactive state loop
export { IoEngine }				from './io-engine';
export { optimizeSql }			from './io-history-engine';

// state wrapper: tracks current value and signals changes to the engine
export { IoState, IoStates }	from './io-state';
export type { AnyState }		from './io-state';

// operator: reads/writes IoState values and batches mutations into transactions
export { IoOperator }			from './io-operator';

// timer: thin adapter over ioBroker's setTimeout/clearTimeout — caller must call clearTimer() to cancel
export { IoTimer }				from './io-timer';
export type { TimerOpts }		from './io-timer';

// math/signal utilities: IIR filter, parabola fit, Magnus saturation, Newton-Raphson, RLS
export { sortBy, parabola, Magnus, IIR, newtonRaphson, RLS }	from './io-util';

// generic reactive operators
export { OpAutoOnOff }							from './operators/OpAutoOnOff';
export { OpBiQuadFilter }						from './operators/OpBiQuadFilter';
export { OpDewpoint }							from './operators/OpDewpoint';
export { OpDiff }								from './operators/OpDiff';
export { OpFollowSwitch }						from './operators/OpFollowSwitch';
export { OpIfThenElse, type IfThenElseOpts }	from './operators/OpIfThenElse';
export { OpLowerBound }							from './operators/OpLowerBound';
export { OpMean }								from './operators/OpMean';
export { OpMovingAvg }							from './operators/OpMovingAvg';
export { OpOnOffDelay }							from './operators/OpOnOffDelay';
export { OpPartPress }							from './operators/OpPartPress';
export { OpSchmittTrig }						from './operators/OpSchmittTrig';
export { OpSumN }								from './operators/OpSumN';
