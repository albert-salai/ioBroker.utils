import { IoState }		from '../io-state';
import { IoOperator }	from '../io-operator';
import type { AnyState }	from '../io-state';


/*
 * Computes a weighted sum of N numeric inputs and writes the result to a single output.
 * `output = Σ scale[i] * inputs[i]`. Scale defaults to all-ones (plain sum).
 */
export class OpSumN extends IoOperator {
	private output:		IoState<number>;
	private scale:		number[];

	/*
	 * `inputs`: array of numeric input states; all trigger execution.
	 * `output`: numeric output state to write the weighted sum to.
	 * `scale`: per-input scale factors (length must match `inputs`); defaults to all 1.
	 */
	constructor(inputs: IoState<number>[], output: IoState<number>, scale?: number[]) {
		super(inputs, [ output ], []);
		this.output = output;

		// default scale
		this.scale = scale ?? Array<number>(this.inputStates.length).fill(1);

		// check scale length
		if (this.scale.length !== this.inputStates.length) {
			throw new Error(`${this.constructor.name}: constructor(): invalid number of scale factors #${String(this.scale.length)}`);
		}
	}

	/* Recomputes and writes the weighted sum whenever any input changes. */
	protected override async execute(_trigger: AnyState): Promise<void> {
		const sum = this.inputStates.reduce((sum, input, idx) => {
			return sum + (this.scale[idx] ?? 0)*(input.val as number);
		}, 0);

		if (Number.isFinite(sum)) {
			await this.output.write(sum);
		}
	}
}
