import { IoState }		from '../io-state';
import { IoOperator }	from '../io-operator';
import { IIR }		from '../io-util';
import { IoTimer }		from '../io-timer';
import type { AnyState }	from '../io-state';


/*
 * Applies a clock-driven biquad (2nd-order IIR) low-pass filter to a numeric input.
 *
 * The filter coefficients are derived from a Butterworth-style design parameterised by
 * the group-delay ratio `tauGr` (dimensionless, > 1). The filter is clocked at a fixed
 * interval (`clockSecs`); the input is sampled at each tick and the filtered value is
 * written to Output only when the change exceeds `minDelta`.
 *
 * `execute()` is intentionally empty — the filter runs entirely on the clock timer.
 */
export class OpBiQuadFilter extends IoOperator {
	private Input:			IoState<number>;
	private Output:			IoState<number>;
	private clockMs:		number;
	private minDelta:		number;
	private filter:			IIR;

	/*
	 * `tauGr`: group-delay ratio (dimensionless, > 1); larger values give a smoother but slower
	 * response. Controls Butterworth-style pole placement via
	 * `cos_om0 = (tauGr²−1)/(tauGr²+0.5)` and `alpha = tauGr*(1−cos_om0)`. This
	 * parametrisation exposes a single perceptual knob (delay ratio) rather than a raw cutoff
	 * frequency, which is easier to tune when the desired smoothing level is known qualitatively.
	 * `minDelta`: minimum change before Output is written; suppresses noise-driven writes (default 0).
	 */
	constructor({ Input: src, Output: dst, clockSecs, tauGr, minDelta }: {
		Input:			IoState<number>,
		Output:			IoState<number>,
		clockSecs:		number,
		tauGr:			number,
		minDelta?:		number
	}) {
		super([ src ], [ dst ], []);

		this.Input		= src;
		this.Output		= dst;
		this.clockMs	= clockSecs*1000;
		this.minDelta	= minDelta ?? 0;

		// phase: derive biquad coefficients from group-delay ratio
		const cos_om0	= (tauGr*tauGr - 1.0)/(tauGr*tauGr + 0.5);
		const alpha		=  tauGr*(1.0 - cos_om0);
		this.filter = new IIR({
			'b': [ (1 - cos_om0)/2,		 1 - cos_om0,		(1 - cos_om0)/2	],
			'a': [ (1 + alpha  ),		-2 * cos_om0,		(1 - alpha  )	],
		});
		this.logf.debug('%-15s %-15s %-10s %s\n\tb: %s\n\ta: %s', this.constructor.name, 'constructor()', 'tau_gr', JSON.stringify(tauGr), JSON.stringify(this.filter.b), JSON.stringify(this.filter.a));
	}

	/* Starts the fixed-interval clock timer, aligned to the next clock boundary. */
	protected override setup(): boolean {
		// start timer
		const intervalMs = this.clockMs;
		const timeoutMs  = intervalMs - (IoTimer.now() % intervalMs);			// wait for time slice
		IoTimer.setTimer({ name: this.constructor.name, timeoutMs, intervalMs, cb: async () => {
			await this.step();
		}});

		return true;
	}

	/* No-op: this operator is driven by the clock timer, not by input changes. */
	protected override async execute(_trigger: AnyState): Promise<void> { /* empty */ }

	/* Advances the IIR filter by one sample and writes Output if the change exceeds minDelta. */
	private async step(): Promise<void> {
		const dstVal = this.filter.next(this.Input.val);
		if (Math.abs(dstVal - this.Output.val) >= this.minDelta) {
			await this.Output.write(dstVal);
		}
	}
}
