/**
 * io-adapter — Core adapter class and utilities for managing ioBroker adapter instances.
 * Exports: IoAdapter (main class), dateStr, valStr (formatting utilities)
 * Types: ValType, StateChange
 */
export { IoAdapter, dateStr, valStr }	from './io-adapter';
export type { ValType, StateChange }	from './io-adapter';

/**
 * io-engine — Engine for executing and managing ioBroker operations and workflows.
 * Exports: IoEngine (main execution engine class)
 */
export { IoEngine }						from './io-engine';

/**
 * io-state — State management for ioBroker objects and their value changes.
 * Exports: IoState (individual state wrapper)
 * Types: AnyState (union type for all state types)
 */
export { IoState }						from './io-state';
export type { AnyState }				from './io-state';

/**
 * io-operator — Operator for performing state operations and transactions.
 * Exports: IoOperator (main operator class for state manipulation)
 */
export { IoOperator }					from './io-operator';

/**
 * io-timer — Timer utilities for scheduling and managing time-based operations.
 * Exports: Timer (main timer class)
 */
export { Timer }						from './io-timer';
export type { TimerOpts, SetTimer, ClearTimer, TimerNow }	from './io-timer';

/**
 * io-util — Utility functions for data processing, filtering, and mathematical operations.
 * Exports: sortBy (sorting function), parabola (curve fitting), Magnus (Magnus formula for saturation),
 *          IIR (infinite impulse response filter), newtonRaphson (root finding)
 */
export { sortBy, parabola, Magnus, IIR, newtonRaphson, RLS }	from './io-util';
