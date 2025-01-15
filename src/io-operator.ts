import { IoAdapter, dateStr, valStr }		from './io-adapter';
import { AnyState }							from './io-state';


// ~~~~~~~~~~
// IoOperator
// ~~~~~~~~~~
export abstract class IoOperator {
	private static				online							= true;
	private						initialized						= false;
	public			readonly	inputs:							readonly AnyState[];
	protected		readonly	outputs:						readonly AnyState[];
	protected		readonly	others:							readonly AnyState[];
	protected		readonly	logf							= IoAdapter.logf;

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
		for (const output  of this.outputs )	{ output .outputFrom.push(this ); }
		for (const input   of this.inputs  )	{ input  .inputFor  .push(this ); }
	}

	/**
	 *
	 * @returns
	 */
	protected init(): Promise<void> {		// called before first execute()
		return Promise.resolve();
	}

	/**
	 *
	 * @param trigger
	 */
	protected abstract execute(trigger: AnyState): Promise<void>;


	/**
	 *
	 * @param trigger
	 */
	public async exec(trigger: AnyState): Promise<void> {
		//this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'exec()', 'trigger', trigger.stateId,  dateStr(trigger.ts), valStr(trigger.val));

		// init
		if (! this.initialized) {
			// debug log
			this.inputs.forEach((input, idx) => {
				if (input.ts > 0)	{ this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'init()', `input [${idx.toString()}]`, input.stateId,  dateStr(input.ts ), valStr(input.val )); }
				else				{ throw new Error(`${this.constructor.name}: exec(): ${input.stateId} not initilized`); }
			});
			this.outputs.forEach((output, idx) => {
				if (output.ts > 0)	{ this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'init()', `output[${idx.toString()}]`, output.stateId, dateStr(output.ts), valStr(output.val)); }
				else				{ throw new Error(`${this.constructor.name}: exec(): ${output.stateId} not initilized`); }
			});
			this.others.forEach((other, idx) => {
				if (other.ts > 0)	{ this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'init()', `other [${idx.toString()}]`, other.stateId,  dateStr(other.ts ), valStr(other.val )); }
				else				{ throw new Error(`${this.constructor.name}: exec(): ${other.stateId} not initilized`); }
			});

			await this.init();
			this.initialized = true;
		}

		// execute
		await this.execute(trigger);
	}
}
