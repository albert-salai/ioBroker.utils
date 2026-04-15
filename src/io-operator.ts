import { IoAdapter }		from './io-adapter';
import { AnyState }		from './io-state';


/*
 * Reactive operator: subclasses implement execute() to respond to input state changes.
 * Caller (IoEngine) owns the onTrigger() call lifecycle; subclasses own setup() and execute().
 */
export abstract class IoOperator {
	private						ready								= false;
	protected		readonly	logf								= IoAdapter.logf;
	public			readonly	inputStates:	readonly AnyState[];	// trigger execute() on change; registered in state.triggerOperators
	protected		readonly	outputStates:	readonly AnyState[];	// written in execute(); registered in state.writtenByOperators
	protected		readonly	watchedStates:	readonly AnyState[];	// read but not subscribed; must be ready before first onTrigger()

	/* Registers this operator in triggerOperators/writtenByOperators of the relevant states. */
	constructor(inputStates: readonly AnyState[], outputStates: readonly AnyState[], watchedStates: readonly AnyState[]) {
		this.watchedStates	= watchedStates;
		this.inputStates	= inputStates;
		this.outputStates	= outputStates;

		for (const input  of this.inputStates  )	{ input .triggerOperators  .push(this); }
		for (const output of this.outputStates )	{ output.writtenByOperators.push(this); }
	}

	/* Override to perform async setup before the first execute(). Return false to defer setup to the next trigger. */
	protected setup(): Promise<boolean> | boolean { return true; }

	/* Invoked on each trigger. Precondition: all states are ready (ts > 0). May be async or sync. */
	protected abstract execute(trigger: AnyState): Promise<void> | void;

	/*
	 * Called by IoState.onStateChange() when a triggering input state changes.
	 * Resolves after execute() completes. If setup() returns false, execute() is skipped
	 * and setup() will be retried on the next trigger.
	 */
	public async onTrigger(trigger: AnyState): Promise<void> {
		// get ready
		if (! this.ready) {
			this.ready = await this.setup();
		}

		// execute if ready
		if (this.ready) {
			await this.execute(trigger);
		}
	}
}
