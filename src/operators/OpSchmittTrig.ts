import { IoState }		from '../io-state';
import { IoOperator }	from '../io-operator';
import type { AnyState }	from '../io-state';


/*
 * Hysteresis comparator: switches a boolean Output ON/OFF relative to a moving TargetInput.
 *
 * Output turns ON  when CurrInput ≤ TargetInput − lowerBound.
 * Output turns OFF when CurrInput >  TargetInput + upperBound.
 * While CurrInput is between the two thresholds the Output is unchanged (hysteresis band).
 *
 * Both CurrInput and TargetInput trigger execution, so the output is re-evaluated
 * whenever either changes.
 */
export class OpSchmittTrig extends IoOperator {
	private CurrInput:		IoState<number >;
	private TargetInput:	IoState<number >;
	private Output:			IoState<boolean>;
	private	lowerBound:		number;
	private	upperBound:		number;

	/*
	 * `lowerBound`: switch Output ON  if CurrInput <= TargetInput - lowerBound.
	 * `upperBound`: switch Output OFF if CurrInput >  TargetInput + upperBound.
	 */
	constructor({ CurrInput, TargetInput, Output, lowerBound, upperBound }: {
		CurrInput:		IoState<number >,
		TargetInput:	IoState<number >,
		Output:			IoState<boolean>,
		lowerBound?:	number,
		upperBound?:	number,
	}) {
		super( [ CurrInput, TargetInput ], [ Output ], []);
		if (! Output.writable)	throw new Error(`${this.constructor.name}: constructor(): ${Output.stateId}: must be writable`);

		this.CurrInput		= CurrInput;
		this.TargetInput	= TargetInput;
		this.Output			= Output;
		this.lowerBound		= lowerBound ?? 0;
		this.upperBound		= upperBound ?? 0;
	}

	/* Switches Output ON/OFF based on hysteresis around TargetInput ± bounds. */
	protected override async execute(_trigger: AnyState): Promise<void> {
		if (this.CurrInput.val <= this.TargetInput.val - this.lowerBound) {
			await this.Output.write(true );			// switch Output ON  if CurrInput <= TargetInput - lowerBound

		} else if (this.CurrInput.val > this.TargetInput.val + this.upperBound) {
			await this.Output.write(false);			// switch Output OFF if CurrInput >  TargetInput + upperBound
		}
	}
}
