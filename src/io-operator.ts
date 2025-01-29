import { IoAdapter, dateStr, valStr }		from './io-adapter';
import { AnyState }							from './io-state';


// ~~~~~~~~~~
// IoOperator
// ~~~~~~~~~~
export abstract class IoOperator {
	private static				online								= true;
	private						initialized							= false;
	protected		readonly	logf								= IoAdapter.logf;
	public			readonly	inputs:		readonly AnyState[];	// will trigger execute()
	protected		readonly	outputs:	readonly AnyState[];	// may be written in execute()
	protected		readonly	others:		readonly AnyState[];	// may be read in execute()

	// IoOperator.setOnline(), IoOperator.isOnline()
	public static setOnline(isOnline: boolean): void	{ IoOperator.online = isOnline;	}
	public static isOnline(): boolean					{ return IoOperator.online;		}

	/**
	 *
	 * @param adapter
	 * @param inputs
	 * @param outputs
	 */
	constructor(inputs: readonly AnyState[], outputs: readonly AnyState[], others: readonly AnyState[]) {
		this.logf		= IoAdapter.logf;
		this.others		= others;
		this.inputs		= inputs;
		this.outputs	= outputs;

		// register 'this' operator to its input and output states
		for (const input  of this.inputs  )	{ input .inputFor  .push(this); }
		for (const output of this.outputs )	{ output.outputFrom.push(this); }
	}

	/**
	 *
	 * @returns
	 */
	protected init(): Promise<boolean> | boolean {		// called before first execute()
		return true;									// resolves to true if initialization is complete
	}


	/**
	 *
	 * @param trigger
	 */
	protected abstract execute(trigger: AnyState): Promise<void> | void;


	/**
	 *
	 * @param trigger
	 */
	public async exec(trigger: AnyState): Promise<void> {
		//this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'exec()', 'trigger', trigger.stateId,  dateStr(trigger.ts), valStr(trigger.val));

		// init
		if (! this.initialized) {
			// debug log
			/*
			this.inputs .forEach((input,  idx) => { this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'init()', `input [${idx.toString()}]`, input .stateId, dateStr(input .ts), valStr(input .val)); });
			this.outputs.forEach((output, idx) => { this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'init()', `output[${idx.toString()}]`, output.stateId, dateStr(output.ts), valStr(output.val)); });
			this.others .forEach((other,  idx) => { this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'init()', `other [${idx.toString()}]`, other .stateId, dateStr(other .ts), valStr(other .val)); });
			*/

			// ensure all state are initialized
			const notInitialized = this.inputs.concat(this.outputs, this.others).filter(state => (state.ts <= 0));
			if (notInitialized.length > 0) {
				for (const state of notInitialized) {
					this.logf.error('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'init()', 'no init', state.stateId,  dateStr(state.ts ), valStr(state.val ));
				}
				throw new Error(`${this.constructor.name}: exec(): some states not initilized`);
			}

			this.initialized = await this.init();
		}

		// execute
		if (this.initialized) {
			await this.execute(trigger);
		}
	}
}
