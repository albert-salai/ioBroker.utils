/** 
 * io-adapter — Core adapter class and utilities for managing ioBroker adapter instances.
 * Exports: IoAdapter (main class), dateStr, valStr (formatting utilities)
 * Types: AdapterOptions, ValType, StateChange, HistoryOpts, IoStateOpts
 */
export { IoAdapter, dateStr, valStr }							from './io-adapter';
export type { AdapterOptions, ValType, StateChange,
			  HistoryOpts, IoStateOpts }						from './io-adapter';

/** 
 * io-engine — Engine for executing and managing ioBroker operations and workflows.
 * Exports: IoEngine (main execution engine class)
 */
export { IoEngine }												from './io-engine';

/** 
 * io-state — State management for ioBroker objects and their value changes.
 * Exports: IoStates (collection manager), IoState (individual state wrapper)
 * Types: AnyState (union type for all state types)
 */
export { IoStates, IoState }									from './io-state';
export type { AnyState }										from './io-state';

/** 
 * io-operator — Operator for performing state operations and transactions.
 * Exports: IoOperator (main operator class for state manipulation)
 */
export { IoOperator }											from './io-operator';

/** 
 * io-sql — Database abstraction for SQL-based state history querying and caching.
 * Exports: IoSql (main SQL interface class)
 * Types: IoWriteCacheVal (cached write value), SqlQueryOpts (query options), SqlHistoryRow (history record)
 */
export { IoSql }												from './io-sql';
export type { IoWriteCacheVal, SqlQueryOpts, SqlHistoryRow }	from './io-sql';

/** 
 * io-timer — Timer utilities for scheduling and managing time-based operations.
 * Exports: Timer (main timer class)
 * Types: SetTimer (setup function), ClearTimer (cleanup function), TimerNow (current time getter), TimerOpts (timer options)
 */
export { Timer }												from './io-timer';
export type { SetTimer, ClearTimer, TimerNow, TimerOpts }		from './io-timer';

/** 
 * io-util — Utility functions for data processing, filtering, and mathematical operations.
 * Exports: sortBy (sorting function), parabola (curve fitting), Magnus (Magnus formula for saturation),
 *          IIR (infinite impulse response filter), RLS (recursive least squares), newtonRaphson (root finding)
 */
export { sortBy, parabola, Magnus, IIR, RLS, newtonRaphson }	from './io-util';
