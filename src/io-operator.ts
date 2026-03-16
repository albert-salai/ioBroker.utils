import { IoAdapter, dateStr, valStr }		from './io-adapter';
import { AnyState }							from './io-state';
import { Timer }							from './io-timer';


/** Reactive operator: subclasses implement execute() to respond to input state changes.
 *  Caller (IoEngine) owns the onTrigger() call lifecycle; subclasses own setup() and execute(). */
export abstract class IoOperator {
	private static				live								= true;
	private						initialized							= false;
	protected		readonly	logf								= IoAdapter.logf;
	public			readonly	inputStates:	readonly AnyState[];	// trigger execute() on change; registered in state.triggerOperators
	protected		readonly	outputStates:	readonly AnyState[];	// written in execute(); registered in state.writtenByOperators
	protected		readonly	watchedStates:	readonly AnyState[];	// read but not subscribed; must be initialized before first onTrigger()

	public static setLive(v: boolean): void	{ IoOperator.live = v;		}
	public static isLive(): boolean			{ return IoOperator.live;	}

	constructor(inputStates: readonly AnyState[], outputStates: readonly AnyState[], watchedStates: readonly AnyState[]) {
		this.watchedStates	= watchedStates;
		this.inputStates	= inputStates;
		this.outputStates	= outputStates;

		for (const input  of this.inputStates  )	{ input .triggerOperators  .push(this); }
		for (const output of this.outputStates )	{ output.writtenByOperators.push(this); }
	}

	/** Override to perform async setup before the first execute(). Return false to defer setup to the next trigger. */
	protected setup(): Promise<boolean> | boolean { return true; }

	protected abstract execute(trigger: AnyState): Promise<void> | void;

	/** Called by IoState.onStateChange() when a triggering input state changes.
	 *  Resolves after execute() completes. If setup() returns false, execute() is skipped
	 *  and setup() will be retried on the next trigger. */
	public async onTrigger(trigger: AnyState): Promise<void> {
		if (! this.initialized) {
			// guard: all states must have been fetched (ts > 0) before first execute
			const notInitialized = this.inputStates.concat(this.outputStates, this.watchedStates).filter(state => (state.ts <= 0));
			if (notInitialized.length > 0) {
				for (const state of notInitialized) {
					this.logf.error('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'setup()', 'no init', state.stateId,  dateStr(state.ts ), valStr(state.val ));
				}
				throw new Error(`${this.constructor.name}: onTrigger(): some states not initialized`);
			}

			// warn if any input carries a future timestamp (clock skew / bad data)
			for (const input of this.inputStates) {
				if (input.ts > Timer.now()) {
					this.logf.warn('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'setup()', 'invalid ts', input.stateId, dateStr(input.ts), valStr(input.val));
				}
			}

			this.initialized = await this.setup();
		}

		// skip execute if setup() deferred (initialized remains false until next trigger)
		if (this.initialized) {
			await this.execute(trigger);
		}
	}
}
