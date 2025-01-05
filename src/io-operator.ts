import { IoAdapter }		from './io-adapter';
import { AnyState }			from './io-state';


// ~~~~~~~~~~
// IoOperator
// ~~~~~~~~~~
export class IoOperator {
	private static	readonly	allOperators:	IoOperator[]	= [];
	private static				started_						= false;
	protected					execUnchanged_					= false;		// execute operators even if val has not changed
	protected		readonly	logf							= IoAdapter.logf;
	protected		readonly	inputs:							readonly AnyState[];
	protected		readonly	outputs:						readonly AnyState[];
	protected		readonly	others:							readonly AnyState[];

	/**
	 *
	 * @param adapter
	 * @param inputs
	 * @param outputs
	 */
	constructor(inputs: readonly AnyState[], outputs: readonly AnyState[], others: readonly AnyState[]) {
		IoOperator.allOperators.push(this);
		this.logf		= IoAdapter.logf;
		this.inputs		= inputs;
		this.outputs	= outputs;
		this.others		= others;

		// register 'this' operator to its input and output states
		for (const input   of this.inputs  )	{ input  .inputFor  .push(this); }
		for (const output  of this.outputs )	{ output .outputFrom.push(this); }
	}

	/**
	 *
	 */
	public static async opInit(): Promise<void> {
		IoAdapter.logf.debug('%-15s %-15s %-10s %-50s', this.name, 'opInit()', '...', '');
		for (const operator of IoOperator.allOperators) {
			await  operator.opInit();
		}
	}

	/**
	 *
	 * @returns
	 */
	public static setStarted(): void {
		IoOperator.started_ = true;
	}

	/**
	 *
	 * @returns
	 */
	public static started(): boolean {
		return IoOperator.started_;
	}

	public execUnchanged(): boolean {
		return this.execUnchanged_;
	}

	protected opInit(): Promise<void> {
		this.inputs.forEach((input, idx) => {
			this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'opInit()', `input [${idx.toString()}]`, input.stateId);
		});
		this.outputs.forEach((output, idx) => {
			this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'opInit()', `output[${idx.toString()}]`, output.stateId);
		});
		return Promise.resolve();
	}

	/**
	 *
	 * @param trigger
	 */
	public execute(trigger: AnyState): Promise<void> {
		throw new Error(`${this.constructor.name}: execute() not implemented (trigger ${trigger.stateId})`);
	}
}
