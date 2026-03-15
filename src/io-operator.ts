import { IoAdapter, dateStr, valStr }		from './io-adapter';
import { AnyState }							from './io-state';
import { Timer }							from './io-timer';


/** Reactive operator: subclasses implement execute() to respond to input state changes.
 *  Caller (IoEngine) owns the exec() call lifecycle; subclasses own init() and execute(). */
export abstract class IoOperator {
	private static				online								= true;
	private						initialized							= false;
	protected		readonly	logf								= IoAdapter.logf;
	public			readonly	inputs:		readonly AnyState[];	// trigger execute() on change; registered in state.inputFor
	protected		readonly	outputs:	readonly AnyState[];	// written in execute(); registered in state.outputFrom
	protected		readonly	others:		readonly AnyState[];	// read but not subscribed; must be initialized before first exec()

	public static setOnline(isOnline: boolean): void	{ IoOperator.online = isOnline;	}
	public static isOnline(): boolean					{ return IoOperator.online;		}

	constructor(inputs: readonly AnyState[], outputs: readonly AnyState[], others: readonly AnyState[]) {
		this.logf		= IoAdapter.logf;
		this.others		= others;
		this.inputs		= inputs;
		this.outputs	= outputs;

		for (const input  of this.inputs  )	{ input .inputFor  .push(this); }
		for (const output of this.outputs )	{ output.outputFrom.push(this); }
	}

	/** Override to perform async setup before the first execute(). Return false to defer init to the next trigger. */
	protected init(): Promise<boolean> | boolean { return true; }

	protected abstract execute(trigger: AnyState): Promise<void> | void;

	/** Called by IoEngine when a triggering input state changes.
	 *  Resolves after execute() completes. If init() returns false, execute() is skipped
	 *  and init() will be retried on the next trigger. */
	public async exec(trigger: AnyState): Promise<void> {
		if (! this.initialized) {
			// guard: all states must have been fetched (ts > 0) before first execute
			const notInitialized = this.inputs.concat(this.outputs, this.others).filter(state => (state.ts <= 0));
			if (notInitialized.length > 0) {
				for (const state of notInitialized) {
					this.logf.error('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'init()', 'no init', state.stateId,  dateStr(state.ts ), valStr(state.val ));
				}
				throw new Error(`${this.constructor.name}: exec(): some states not initialized`);
			}

			// warn if any input carries a future timestamp (clock skew / bad data)
			for (const input of this.inputs) {
				if (input.ts > Timer.now()) {
					this.logf.warn('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'init()', 'invalid ts', input.stateId, dateStr(input.ts), valStr(input.val));
				}
			}

			this.initialized = await this.init();
		}

		// skip execute if init() deferred (initialized remains false until next trigger)
		if (this.initialized) {
			await this.execute(trigger);
		}
	}
}
