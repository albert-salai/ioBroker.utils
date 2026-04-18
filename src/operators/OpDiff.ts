import { IoState }	from '../io-state';
import { OpSumN }	from './OpSumN';


/* Computes `input1 - input2` and writes the result to `output`. */
export class OpDiff extends OpSumN {
	constructor(input1: IoState<number>, input2: IoState<number>, output: IoState<number>) {
		super([ input1, input2 ], output, [ 1, -1 ]);
	}
}
